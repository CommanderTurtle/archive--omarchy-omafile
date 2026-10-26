'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Model = require('./load.js')('Model.js');

function functions(file, names, state) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const c = vm.createContext({ Model, ...state });
  c.root = c;
  c.pane = c;
  for (const name of names) {
    const match = source.match(new RegExp('^  function ' + name + '\\([^]*?^  }', 'm'));
    assert.ok(match, name);
    vm.runInContext(match[0], c);
  }
  return c;
}

function timer() {
  return {
    running: false, interval: 0, starts: 0,
    start() { this.running = true; this.starts++; },
    restart() { this.start(); },
    stop() { this.running = false; }
  };
}

function service() {
  return functions('Service.qml', ['handleLine', 'flushProgress', 'releasePending', 'transferActive',
    'directoryTransferring', 'updateTransfer', 'cancelTransfer', 'trimTransferHistory'], {
    _pending: {}, _progressPending: {}, _transferOwners: {}, transfers: [],
    progressTimer: timer(), seenTimer: timer(), cancel() {}
  });
}

test('progress bursts retain only the newest absolute snapshot per live request', () => {
  const c = service();
  const updates = [];
  c._pending[1] = { onData: m => updates.push(m) };
  c._pending[2] = { onData: m => updates.push(m) };
  for (let bytes = 0; bytes < 10000; bytes++)
    c.handleLine(JSON.stringify({ id: 1, t: 'progress', bytes }));
  c.handleLine(JSON.stringify({ id: 2, t: 'progress', bytes: 42 }));
  c.handleLine(JSON.stringify({ id: 999, t: 'progress', bytes: 1 }));
  assert.equal(updates.length, 0);
  assert.equal(c.progressTimer.starts, 1);
  assert.equal(Object.keys(c._progressPending).length, 2);
  c.flushProgress();
  assert.deepEqual(updates.map(m => [m.id, m.bytes]), [[1, 9999], [2, 42]]);
  assert.equal(Object.keys(c._progressPending).length, 0);
});

test('done, error, and conflict are immediate and flush progress before changing state', () => {
  for (const type of ['done', 'error', 'conflict']) {
    const c = service();
    const seen = [];
    c._pending[1] = {
      onData: m => seen.push(m.t), onDone: m => seen.push(m.t), onError: m => seen.push(m.t)
    };
    c.handleLine('{"id":1,"t":"progress","bytes":7}');
    c.handleLine(JSON.stringify({ id: 1, t: type }));
    c.flushProgress();
    assert.deepEqual(seen, ['progress', type]);
    if (type !== 'conflict') assert.equal(c._pending[1], undefined);
  }
});

test('cancelled requests cannot deliver buffered progress or keep conflict owners alive', () => {
  const c = service();
  let seen = 0;
  c._pending[1] = { onData: () => seen++ };
  c.handleLine('{"id":1,"t":"progress"}');
  c.releasePending(1);
  c.flushProgress();
  assert.equal(seen, 0);
  c._transferOwners[2] = {};
  c.transfers = Array.from({ length: 70 }, (_, i) => ({ id: i + 2, state: 'running' }));
  for (const t of c.transfers.slice()) c.cancelTransfer(t.id);
  assert.equal(c.transfers.length, 50, 'cancellation also enforces the existing finished-history limit');
  assert.equal(c._transferOwners[2], undefined);
  assert.ok(c.transfers.every(t => t.state === 'cancelled'));
});

test('only directories touched by live transfers are deferred, including move sources and real paths', () => {
  const c = service();
  c.transfers = [
    { id: 1, state: 'running', op: 'copy', dest: '/dest', from: '/read-only-source' },
    { id: 2, state: 'paused', op: 'move', dest: '/other', sourceDirs: ['/one', '/two'] },
    { id: 3, state: 'done', op: 'extract', dest: '/finished' }
  ];
  for (const dir of ['/dest', '/dest/child', '/dest/./child/..', '/one', '/two/child', '/other'])
    assert.equal(c.directoryTransferring(dir, ''), true, dir);
  for (const dir of ['/dest-sibling', '/read-only-source', '/finished', '/', 'recent:'])
    assert.equal(c.directoryTransferring(dir, ''), false, dir);
  assert.equal(c.directoryTransferring('/alias', '/dest'), true);
  assert.equal(c.directoryTransferring('/dest', ''), true);
  c.transfers[0].state = 'failed';
  assert.equal(c.directoryTransferring('/dest', ''), false);
});

function pane() {
  const c = functions('components/PaneView.qml', ['noteChanges', 'scheduleChanges', 'transferBusy', 'applyChanges'], {
    path: '/dest', realPath: '', _changedNames: Object.create(null), _changedNameCount: 0,
    _changedAll: false, _lastChangeApplied: 0, loading: false, searching: false, virtualView: false,
    refreshTimer: timer(), busy: false, refreshes: 0, patches: []
  });
  c.service = { directoryTransferring: dir => c.busy && dir === '/dest' };
  c.refresh = () => c.refreshes++;
  c.patchEntries = names => c.patches.push(Array.from(names));
  c.fire = () => { c.refreshTimer.stop(); c.applyChanges(); };
  return c;
}

test('10,000 changes during a transfer trigger no model work and one reconciliation afterward', () => {
  const c = pane();
  c.busy = true;
  for (let i = 0; i < 10000; i++) c.noteChanges({ names: ['file-' + i] });
  assert.equal(c.refreshTimer.starts, 0);
  assert.equal(Object.keys(c._changedNames).length, 0);
  c.fire();
  assert.equal(c.refreshes, 0);
  assert.equal(c.patches.length, 0);
  c.busy = false;
  c.scheduleChanges(); // runningTransferIdsChanged, also on failure/cancel/helper exit
  assert.equal(c.refreshTimer.starts, 1);
  c.fire();
  assert.equal(c.refreshes, 1);
  c.scheduleChanges();
  assert.equal(c.refreshTimer.starts, 1);
});

test('a transfer beginning after a timer was scheduled does not consume pending changes', () => {
  const c = pane();
  c.noteChanges({ names: [], dirty: true });
  c.busy = true;
  c.fire();
  assert.equal(c._changedAll, true);
  assert.equal(c.refreshes, 0);
  c.busy = false;
  c.scheduleChanges();
  c.fire();
  assert.equal(c.refreshes, 1);
});

test('small changes stay incremental; combined batches, not only individual messages, are bounded', () => {
  const c = pane();
  c.noteChanges({ names: ['one.txt', '__proto__', 'constructor'] });
  c.fire();
  assert.deepEqual(c.patches, [['one.txt', '__proto__', 'constructor']]);
  assert.equal(c.refreshes, 0);
  for (let i = 0; i < 10000; i++) c.noteChanges({ names: ['file-' + i] });
  assert.equal(c._changedAll, true);
  assert.equal(Object.keys(c._changedNames).length, 0);
  c.fire();
  assert.equal(c.refreshes, 1);
});

test('changes received during a listing survive until it completes', () => {
  const c = pane();
  c.loading = true;
  c.noteChanges({ names: ['new.txt'] });
  c.fire();
  assert.equal(c.patches.length, 0);
  c.loading = false;
  c.scheduleChanges();
  c.fire();
  assert.deepEqual(c.patches, [['new.txt']]);
});

test('unrelated panes keep updating and manual refresh remains outside the automatic gate', () => {
  const c = pane();
  c.busy = true;
  c.path = '/unrelated';
  c.noteChanges({ names: ['new.txt'] });
  c.fire();
  assert.deepEqual(c.patches, [['new.txt']]);
  c.path = '/dest';
  c.refresh();
  assert.equal(c.refreshes, 1);
  const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'PaneView.qml'), 'utf8');
  assert.match(source, /onRunningTransferIdsChanged\(\) \{ pane.scheduleChanges\(\) \}/);
  assert.match(source, /onLoadingChanged: if \(!loading\) scheduleChanges\(\)/);
  assert.match(source, /onPathChanged:\s*\{\s*refreshTimer.stop\(\)/);
});

test('operation-completion refresh consumes already queued notifications, without a redundant scan', () => {
  const c = pane();
  // Use the real refresh entry point with a fake helper, rather than the counter.
  const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'PaneView.qml'), 'utf8');
  vm.runInContext(source.match(/^  function refresh\([^]*?^  }/m)[0], c);
  c._softId = 0;
  c._generation = 1;
  c.service.listDirectory = () => { c.refreshes++; return 4; };
  c.noteChanges({ names: [], dirty: true });
  assert.equal(c.refreshTimer.running, true);
  c.refresh();
  assert.equal(c.refreshTimer.running, false);
  assert.equal(c.refreshes, 1);
  c.scheduleChanges();
  assert.equal(c.refreshTimer.running, false);
  c.noteChanges({ names: ['written-after-refresh.txt'] });
  assert.equal(c.refreshTimer.running, true, 'later writes are still reconciled');
});

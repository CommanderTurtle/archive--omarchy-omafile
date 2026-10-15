'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function service() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'Service.qml'), 'utf8');
  const written = [];
  const shellCalls = [];
  const c = vm.createContext({ pickRequest: null, pluginId: 'xyzlab.omafile' });
  c.root = c;
  for (const name of ['beginPick', 'finishPick', 'cancelPick']) {
    const match = source.match(new RegExp('^  function ' + name + '\\([^]*?^  }', 'm'));
    vm.runInContext(match[0], c);
  }
  c.writePickResult = (file, result) => written.push(JSON.parse(JSON.stringify({ file, result })));
  c.shell = {
    summon: (...args) => shellCalls.push(['summon', ...args]),
    hide: (...args) => shellCalls.push(['hide', ...args])
  };
  return { c, written, shellCalls };
}

test('a pick request never summons or hides the main window', () => {
  const { c, written, shellCalls } = service();
  assert.equal(c.beginPick(JSON.stringify({ mode: 'save', result: '/run/a.json' })), 'ok');
  assert.equal(c.pickRequest.result, '/run/a.json');
  c.cancelPick('/run/a.json');
  assert.equal(c.pickRequest, null);
  c.beginPick(JSON.stringify({ mode: 'save', result: '/run/b.json' }));
  c.finishPick({ ok: true, paths: ['/tmp/x'] }, c.pickRequest);
  assert.deepEqual(written, [{ file: '/run/b.json', result: { ok: true, paths: ['/tmp/x'] } }]);
  assert.deepEqual(shellCalls, []);
});

test('a second app cannot cancel or replace a file chooser that is already open', () => {
  const { c, written } = service();
  assert.equal(c.beginPick(JSON.stringify({ mode: 'open', result: '/run/first.json' })), 'ok');
  const first = c.pickRequest;
  assert.match(c.beginPick(JSON.stringify({ mode: 'open', result: '/run/second.json' })), /^error/);
  assert.equal(c.pickRequest, first, 'the open chooser keeps its request');
  assert.deepEqual(written, [], 'nothing is answered on its behalf');
  c.cancelPick('/run/second.json');
  assert.equal(c.pickRequest, first, 'a cancel for the refused request does nothing');
  c.finishPick({ ok: true, paths: ['/tmp/a'] }, first);
  assert.deepEqual(written, [{ file: '/run/first.json', result: { ok: true, paths: ['/tmp/a'] } }]);
  assert.equal(c.beginPick(JSON.stringify({ mode: 'open', result: '/run/second.json' })), 'ok', 'the next request is accepted once it closes');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function service() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'Service.qml'), 'utf8');
  const requests = [];
  const c = vm.createContext({ _clipboardRevision: 0, _clipboardWritePending: false, clipboard: { mode: '', paths: [] }, clipboardPathLimit: 3 });
  c.root = c;
  for (const match of source.matchAll(/^  function \w+\([^]*?^  }/gm)) vm.runInContext(match[0], c);
  c.request = (payload, handlers) => { requests.push({ payload, handlers }); return requests.length; };
  const cutBody = source.match(/readonly property var cutPaths: \{([^]*?)^  }/m)[1];
  const marks = () => JSON.parse(JSON.stringify(vm.runInContext('(function () {' + cutBody + '})()', c)));
  return { c, requests, marks };
}

test('cut markers use upstream clipset and clear after clipboard ownership changes', () => {
  const { c, requests, marks } = service();
  c.setClipboard('cut', ['/tmp/file']);
  assert.equal(requests[0].payload.op, 'clipset');
  assert.equal(c._clipboardWritePending, true);
  assert.deepEqual(marks(), { '/tmp/file': true });
  requests[0].handlers.onDone({});
  assert.equal(c._clipboardWritePending, false);
  c.readSystemClipboard(() => {});
  assert.equal(requests[1].payload.op, 'clipget');
  requests[1].handlers.onDone({ mode: 'copy', paths: [] });
  assert.deepEqual(marks(), {});
});

test('old clipboard reads cannot restore markers after a clear or newer copy', () => {
  const { c, requests, marks } = service();
  c.setClipboard('cut', ['/old']);
  c.readSystemClipboard(() => {});
  c.clearClipboard();
  requests[1].handlers.onDone({ mode: 'cut', paths: ['/old'] });
  assert.deepEqual(marks(), {});
  c.setClipboard('cut', ['/new']);
  requests[0].handlers.onDone({});
  assert.equal(c._clipboardWritePending, true);
  assert.deepEqual(marks(), { '/new': true });
});

test('clipget forwards image metadata through the existing callback', () => {
  const { c, requests } = service();
  let result;
  c.readSystemClipboard(value => { result = value; });
  requests[0].handlers.onDone({ mode: 'copy', paths: [], image: 'image/png' });
  assert.equal(result.image, 'image/png');
});

test('a huge clipboard file list is capped before the shell keeps it', () => {
  const { c, requests } = service();
  let result;
  c.readSystemClipboard(value => { result = value; });
  requests[0].handlers.onDone({ mode: 'copy', paths: ['/a', '/b', '/c', '/d', '/e'] });
  assert.deepEqual(JSON.parse(JSON.stringify(result.paths)), ['/a', '/b', '/c']);
});

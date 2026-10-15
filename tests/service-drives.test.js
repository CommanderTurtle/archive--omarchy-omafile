'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function service() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'Service.qml'), 'utf8');
  const c = vm.createContext({ JSON, _drivesPending: false });
  let drives = [];
  let assigned = 0;
  Object.defineProperty(c, 'drives', { get: () => drives, set: (v) => { drives = v; assigned++; } });
  c.root = c;
  const match = source.match(/^  function refreshDrives\([^]*?^  }/m);
  vm.runInContext(match[0], c);
  let reply = [];
  c.request = (payload, handlers) => {
    handlers.onData({ t: 'drives', drives: reply });
    if (!c.holdReply) handlers.onDone({});
    else c.held = handlers;
  };
  return { c, setReply: (list) => { reply = list; }, assigned: () => assigned };
}

test('an unchanged drive list is not reassigned, so the sidebar is not rebuilt mid drag', () => {
  const s = service();
  s.setReply([{ path: '/dev/sdb1', mount: '/run/media/me/Stick' }]);
  s.c.refreshDrives();
  assert.equal(s.assigned(), 1);
  s.setReply([{ path: '/dev/sdb1', mount: '/run/media/me/Stick' }]);
  s.c.refreshDrives();
  assert.equal(s.assigned(), 1, 'same drives, no change');
  s.setReply([{ path: '/dev/sdb1', mount: '' }]);
  s.c.refreshDrives();
  assert.equal(s.assigned(), 2, 'a real change still updates');
});

test('a drive poll is skipped while the previous one is still running', () => {
  const s = service();
  let asked = 0;
  const real = s.c.request;
  s.c.request = (payload, handlers) => { asked++; s.c.held = handlers; };
  s.c.refreshDrives();
  s.c.refreshDrives();
  assert.equal(asked, 1, 'a hung poll does not stack another one');
  s.c.held.onDone({});
  s.c.refreshDrives();
  assert.equal(asked, 2);
  s.c.request = real;
});

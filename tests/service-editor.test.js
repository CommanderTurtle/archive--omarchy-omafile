'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const loadModule = require('./load.js');

function service(settings, found) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'Service.qml'), 'utf8');
  const launched = [];
  const asked = [];
  const c = vm.createContext({});
  c.root = c;
  c.Model = loadModule('Model.js');
  c.Qt = { callLater: (fn) => fn() };
  c.Quickshell = { execDetached: (argv) => launched.push(Array.prototype.slice.call(argv)) };
  c.editorChoice = settings.editorChoice || '';
  c.editorCommand = settings.editor || '';
  c.omarchyEditor = 'nvim';
  c.request = (payload, h) => {
    asked.push(Array.prototype.slice.call(payload.names));
    const map = {};
    for (const name of payload.names) map[name] = found[name] === true;
    h.onData({ t: 'defaults', found: map });
    h.onDone({});
    return 1;
  };
  for (const name of ['checkProgram', 'editorPlan', 'launchEditor', 'setOmarchyEditor']) {
    const match = source.match(new RegExp('^  function ' + name + '\\([^]*?^  }', 'm'));
    vm.runInContext(match[0], c);
  }
  return { c, launched, asked };
}

function plan(c) {
  let out = null;
  c.editorPlan((p) => { out = JSON.parse(JSON.stringify(p)); });
  return out;
}

test('with nothing chosen Omafile asks, and Omarchy\'s default needs no check', () => {
  assert.deepEqual(plan(service({}, {}).c), { ask: true, error: '' });
  const omarchy = service({ editorChoice: 'omarchy', editor: 'code' }, {});
  assert.deepEqual(plan(omarchy.c), { mode: 'omarchy' });
  assert.deepEqual(omarchy.asked, [], 'Omarchy picks its own fallback, so nothing is looked up');
});

test('your own editor is used only when its program exists', () => {
  const ok = service({ editorChoice: 'own', editor: 'code --new-window' }, { code: true });
  assert.deepEqual(plan(ok.c), { mode: 'own', command: 'code --new-window' });
  assert.deepEqual(ok.asked, [['code']]);
  assert.deepEqual(plan(service({ editor: '-e nano' }, { nano: true }).c), { ask: true, error: '-e nano' },
    'a setting from before the choice existed is still checked');
});

test('Omarchy\'s editor, a window editor and a terminal editor each launch the right way', () => {
  const { c, launched } = service({}, {});
  c.launchEditor({ mode: 'omarchy' }, ['/a.txt', '/b.txt']);
  c.launchEditor({ mode: 'own', command: 'code' }, ['/a.txt']);
  c.launchEditor({ mode: 'own', command: 'nano -w' }, ['/a b.txt']);
  c.launchEditor({ mode: 'own', command: 'code' }, []);
  assert.deepEqual(launched, [
    ['omarchy-launch-editor', '/a.txt', '/b.txt'],
    ['setsid', 'uwsm-app', '--', 'sh', '-c', 'code "$@"', 'omafile', '/a.txt'],
    ['omarchy-launch-tui', '--app-id=org.omarchy.nano', 'sh', '-c', 'nano -w "$@"', 'omafile', '/a b.txt']
  ]);
});

test('only editors Omarchy knows can become its default', () => {
  const { c, launched } = service({}, {});
  assert.equal(c.setOmarchyEditor('zeditor'), true);
  assert.equal(c.omarchyEditor, 'zeditor');
  assert.equal(c.setOmarchyEditor('nano'), false);
  assert.equal(c.setOmarchyEditor('evil; rm -rf ~'), false);
  assert.deepEqual(launched, [['omarchy-default-editor', 'zeditor']]);
});

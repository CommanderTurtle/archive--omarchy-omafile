'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const loadModule = require('./load.js');

function service(handlers, apps) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'Service.qml'), 'utf8');
  const launched = [];
  const opened = [];
  const c = vm.createContext({});
  c.root = c;
  c.Model = loadModule('Model.js');
  c.Quickshell = { execDetached: (argv) => launched.push(Array.prototype.slice.call(argv)) };
  c.DesktopEntries = { byId: (id) => apps[id] || null };
  c.openExternally = (file) => opened.push(file);
  c.request = (payload, h) => {
    if (handlers[payload.path] === undefined) h.onError({ message: 'no type' });
    else {
      h.onData({ t: 'opener', mime: 'x/y', handler: handlers[payload.path] });
      h.onDone({});
    }
    return 1;
  };
  for (const name of ['openExternallyFiles', 'requestHandler', 'appCommand', 'launchByHandler', 'openWith']) {
    const match = source.match(new RegExp('^  function ' + name + '\\([^]*?^  }', 'm'));
    vm.runInContext(match[0], c);
  }
  return { c, launched, opened };
}

test('files with the same default app open in one launch of that app', () => {
  const { c, launched, opened } = service(
    { '/p/a.png': 'imv.desktop', '/p/b.png': 'imv.desktop', '/p/c.mp3': 'mpv.desktop' },
    { imv: { command: ['imv', '%F'] }, mpv: { command: ['mpv', '%f'] } });
  c.openExternallyFiles(['/p/a.png', '/p/c.mp3', '/p/b.png']);
  assert.deepEqual(launched, [['imv', '/p/a.png', '/p/b.png'], ['mpv', '/p/c.mp3']]);
  assert.deepEqual(opened, []);
});

test('a file with no known app, or an app that is gone, falls back to gio open', () => {
  const { c, launched, opened } = service(
    { '/p/a.png': 'imv.desktop', '/p/b.png': 'imv.desktop', '/p/x': '', '/p/y': 'gone.desktop' },
    { imv: { command: ['imv', '%F'] } });
  c.openExternallyFiles(['/p/a.png', '/p/x', '/p/y', '/p/z', '/p/b.png']);
  assert.deepEqual(launched, [['imv', '/p/a.png', '/p/b.png']]);
  assert.deepEqual(opened, ['/p/x', '/p/y', '/p/z']);
});

test('a terminal app is launched through the terminal', () => {
  const { c, launched } = service(
    { '/p/a.txt': 'nvim.desktop', '/p/b.txt': 'nvim.desktop' },
    { nvim: { command: ['nvim', '%F'], runInTerminal: true } });
  c.openExternallyFiles(['/p/a.txt', '/p/b.txt']);
  assert.deepEqual(launched, [['xdg-terminal-exec', 'nvim', '/p/a.txt', '/p/b.txt']]);
});

test('a single file keeps opening through gio open', () => {
  const { c, launched, opened } = service({ '/p/a.png': 'imv.desktop' }, { imv: { command: ['imv', '%F'] } });
  c.openExternallyFiles(['/p/a.png']);
  assert.deepEqual(launched, []);
  assert.deepEqual(opened, ['/p/a.png']);
});

test('the launch command comes from the raw Exec line, because the parsed command has its field codes stripped', () => {
  const { c, launched } = service(
    { '/p/a.png': 'imv.desktop', '/p/b.png': 'imv.desktop' },
    { imv: { command: ['imv'], execString: 'imv %F' } });
  c.openExternallyFiles(['/p/a.png', '/p/b.png']);
  assert.deepEqual(launched, [['imv', '/p/a.png', '/p/b.png']]);
});

test('an Exec line that does not parse falls back to the parsed command', () => {
  const { c, launched } = service(
    { '/p/a.png': 'odd.desktop', '/p/b.png': 'odd.desktop' },
    { odd: { command: ['odd'], execString: 'odd "unterminated %F' } });
  c.openExternallyFiles(['/p/a.png', '/p/b.png']);
  assert.deepEqual(launched, [['odd', '/p/a.png'], ['odd', '/p/b.png']]);
});

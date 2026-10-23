'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'components/Browser.qml'), 'utf8');
function method(name) {
  const match = source.match(new RegExp('^  function ' + name + '\\([^]*?^  }', 'm'));
  assert.ok(match, name);
  return match[0];
}

test('opening or copying a Linkoder result never kills another encoder job', () => {
  assert.ok(!source.includes('lnkrkill'));
  const helper = fs.readFileSync(path.join(root, 'bin/omafile-helper'), 'utf8');
  assert.ok(!helper.includes('pkill'));
  const calls = [];
  const c = {service: {request: (args, handlers) => { calls.push(args); handlers.onDone(); }},
    Quickshell: {execDetached: args => calls.push(args)}, statusText: ''};
  vm.createContext(c);
  vm.runInContext(method('lnkrOpen'), c);
  c.lnkrOpen('https://a.shel.sh/#abc', 'safe');
  assert.equal(calls.length, 1);
  c.lnkrOpen('https://a.shel.sh/#' + 'x'.repeat(125000), 'safe');
  assert.equal(calls[1].op, 'lnkrclipboard');
  assert.equal(c.statusText, 'Ln.kr: safe copied');
});

test('video and picture transcode calls preserve native axes and count successful interactive outputs', () => {
  const sent = [];
  const c = {root: null, activePane: () => ({refresh: () => {}}),
    transcodeIsVideo: false, transcodeFormat: 'avif', transcodeTier: 'high', transcodeResolution: '2160',
    transcodeAxis: 'codec', Model: {formatCount: n => String(n)},
    service: {transcodeQualityPaths: (p, f, q, r, done) => { sent.push([p, f, q, r]); done({files: 1, outputs: []}); }}};
  c.root = c;
  vm.createContext(c); vm.runInContext(method('transcodeNow'), c);
  c.transcodeNow([{path: '/photo.png'}]);
  assert.deepEqual(Array.from(sent[0].slice(1)), ['avif', 'high', '']);
  assert.equal(c.statusText, 'Transcoded 1');
  c.transcodeAxis = 'resolution'; c.transcodeNow([{path: '/photo.png'}]);
  assert.deepEqual(Array.from(sent[1].slice(1)), ['', '', '2160']);
});

test('window tracing is opt-in and never changes visibility or aborts the shell', () => {
  const service = fs.readFileSync(path.join(root, 'Service.qml'), 'utf8');
  assert.ok(service.includes('Quickshell.env("OMAFILE_TRACE") === "1"'));
  const trace = service.match(/^  function trace\([^]*?^  }/m)[0];
  const messages = [];
  const c = {traceEnabled: false, console: {warn: m => messages.push(m)}};
  vm.createContext(c); vm.runInContext(trace, c);
  c.trace('test', {slot: 1}); assert.equal(messages.length, 0);
  c.traceEnabled = true; c.trace('test', {slot: 1}); assert.equal(messages.length, 1);
  const window = fs.readFileSync(path.join(root, 'Window.qml'), 'utf8');
  for (const event of ['host-close', 'window-close', 'hide-request', 'window-visible', 'window-destroyed'])
    assert.ok(window.includes('"' + event + '"'));
});

test('full-resolution previews request isolated original-size output, not raw shell decoding', () => {
  const load = require('./load.js'), model = load('Model.js');
  assert.equal(model.previewSide('auto', 3800), 4096);
  assert.equal(model.previewSide('8192', 100), 8192);
  const full = source.slice(source.indexOf('id: previewFullImage'), source.indexOf('id: previewFlick'));
  assert.ok(full.includes('original: true'));
  assert.ok(!full.includes('previewEntry.path'));
  const thumb = fs.readFileSync(path.join(root, 'components/ThumbImage.qml'), 'utf8');
  assert.ok(thumb.includes('original ? "preview-original"'));
});

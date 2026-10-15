'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');

var root = path.join(__dirname, '..');

function qmlFiles() {
  var out = [];
  ['.', 'components'].forEach(function (dir) {
    fs.readdirSync(path.join(root, dir)).forEach(function (name) {
      if (name.endsWith('.qml')) out.push(path.join(dir, name));
    });
  });
  return out;
}

function withoutStrings(line) {
  return line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

function inputBlocks(source) {
  var lines = source.split('\n');
  var blocks = [];
  for (var i = 0; i < lines.length; i++) {
    var match = /(^|[\s:])(TextInput|TextField|TextEdit)\s*\{\s*$/.exec(lines[i]);
    if (!match) continue;
    var depth = 0;
    var readOnly = '';
    for (var j = i; j < lines.length; j++) {
      var clean = withoutStrings(lines[j]);
      var bound = /^\s*readOnly:\s*(.+?)\s*$/.exec(clean);
      if (j > i && depth === 1 && bound) readOnly = bound[1];
      for (var k = 0; k < clean.length; k++) {
        if (clean[k] === '{') depth++;
        else if (clean[k] === '}') depth--;
      }
      if (depth === 0) break;
    }
    blocks.push({ line: i + 1, type: match[2], readOnly: readOnly });
  }
  return blocks;
}

test('every text input is permanently read only, so Qt never reads the clipboard for it', function () {
  var wrong = [];
  var seen = 0;
  qmlFiles().forEach(function (file) {
    inputBlocks(fs.readFileSync(path.join(root, file), 'utf8')).forEach(function (block) {
      seen++;
      if (block.readOnly !== 'true') wrong.push(file + ':' + block.line + ' ' + block.type + ' readOnly: ' + (block.readOnly || 'missing'));
    });
  });
  assert.ok(seen > 0, 'found text inputs to check');
  assert.deepEqual(wrong, []);
});

test('editable fields go through the safe field components', function () {
  var raw = [];
  qmlFiles().forEach(function (file) {
    if (file === path.join('components', 'EditField.qml') || file === path.join('components', 'EditInput.qml')) return;
    inputBlocks(fs.readFileSync(path.join(root, file), 'utf8')).forEach(function (block) {
      if (block.type !== 'TextEdit') raw.push(file + ':' + block.line + ' ' + block.type);
    });
  });
  assert.deepEqual(raw, []);
});

test('shell inputs with their own editable text field are never used', function () {
  var used = [];
  qmlFiles().forEach(function (file) {
    fs.readFileSync(path.join(root, file), 'utf8').split('\n').forEach(function (line, index) {
      if (/\b(SearchableDropdown|NumberField)\b/.test(line)) used.push(file + ':' + (index + 1));
    });
  });
  assert.deepEqual(used, []);
});

test('the checker spots a missing or always editable binding', function () {
  var blocks = inputBlocks('Item {\n  TextField {\n    text: "{a}"\n  }\n  TextInput {\n    readOnly: !visible\n    Item { readOnly: false }\n  }\n}\n');
  assert.deepEqual(blocks.map(function (b) { return b.readOnly; }), ['', '!visible']);
});

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

test('the shell only decodes images and audio the helper made, never the original file', function () {
  var allowed = ['Util.fileUrl(cachedPath)', 'Util.fileUrl(String(m.path || ""))'];
  var found = [];
  qmlFiles().forEach(function (file) {
    fs.readFileSync(path.join(root, file), 'utf8').split('\n').forEach(function (line, index) {
      var re = /Util\.fileUrl\([^()]*(?:\([^()]*\))?[^()]*\)/g;
      var match;
      while ((match = re.exec(line)) !== null) {
        if (allowed.indexOf(match[0]) < 0) found.push(file + ':' + (index + 1) + ' ' + match[0]);
      }
      if (/source:\s*[^\n]*(entry|previewEntry)\.path/.test(line)) found.push(file + ':' + (index + 1) + ' ' + line.trim());
    });
  });
  assert.deepEqual(found, []);
});

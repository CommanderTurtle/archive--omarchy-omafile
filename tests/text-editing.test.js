'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var loadModule = require('./load.js');

var Editing = loadModule('TextEditing.js');

var keys = {
  ControlModifier: 1, ShiftModifier: 2, AltModifier: 4, MetaModifier: 8,
  Key_V: 86, Key_X: 88, Key_Z: 90, Key_Y: 89, Key_Insert: 1000, Key_Backspace: 1001, Key_Delete: 1002,
  Normal: 0
};

function field(text, cursor, selStart, selEnd) {
  var f = {
    text: text, cursorPosition: cursor === undefined ? text.length : cursor,
    selectionStart: 0, selectionEnd: 0, echoMode: 0, visible: true, activeFocus: true,
    editUndo: [], editRedo: [], copied: null, parent: null, clipboardSource: null,
    insert: function (pos, s) {
      this.text = this.text.slice(0, pos) + s + this.text.slice(pos);
      if (this.cursorPosition >= pos) this.cursorPosition += s.length;
      this.selectionStart = this.selectionEnd = this.cursorPosition;
    },
    remove: function (a, b) {
      this.text = this.text.slice(0, a) + this.text.slice(b);
      if (this.cursorPosition > a) this.cursorPosition = Math.max(a, this.cursorPosition - (b - a));
      this.selectionStart = this.selectionEnd = this.cursorPosition;
    },
    copy: function () { this.copied = this.text.slice(this.selectionStart, this.selectionEnd); }
  };
  f.selectionStart = selStart === undefined ? f.cursorPosition : selStart;
  f.selectionEnd = selEnd === undefined ? f.cursorPosition : selEnd;
  return f;
}

function press(f, key, mods, text) {
  return Editing.handleKey(f, { key: key || 0, modifiers: mods || 0, text: text || '' }, keys);
}

test('typing replaces the selection and control characters are ignored', function () {
  var f = field('hello world', 0, 0, 5);
  assert.equal(press(f, 0, 0, 'J'), true);
  assert.equal(f.text, 'J world');
  assert.equal(press(f, 0, 0, '\u0007'), false);
  assert.equal(press(f, 0, keys.ControlModifier, 'a'), false);
});

test('backspace and delete step over surrogate pairs and whole words with ctrl', function () {
  var f = field('a😀');
  press(f, keys.Key_Backspace);
  assert.equal(f.text, 'a');
  f = field('my-file name');
  press(f, keys.Key_Backspace, keys.ControlModifier);
  assert.equal(f.text, 'my-file ');
  f = field('one two', 0);
  press(f, keys.Key_Delete, keys.ControlModifier);
  assert.equal(f.text, ' two');
});

test('cut copies then removes, undo and redo restore the text', function () {
  var f = field('abcdef', 4, 2, 4);
  press(f, keys.Key_X, keys.ControlModifier);
  assert.equal(f.copied, 'cd');
  assert.equal(f.text, 'abef');
  press(f, keys.Key_Z, keys.ControlModifier);
  assert.equal(f.text, 'abcdef');
  press(f, keys.Key_Y, keys.ControlModifier);
  assert.equal(f.text, 'abef');
});

test('cut never copies a password', function () {
  var f = field('secret', 6, 0, 6);
  f.echoMode = 2;
  press(f, keys.Key_X, keys.ControlModifier);
  assert.equal(f.copied, null);
  assert.equal(f.text, 'secret');
});

test('paste reads through the clipboard source and ignores late answers', function () {
  var pending = [];
  var source = { readClipboardText: function (cb) { pending.push(cb); } };
  var f = field('ab', 1);
  f.clipboardSource = source;
  assert.equal(press(f, keys.Key_V, keys.ControlModifier), true);
  pending.shift()('X\r\nY');
  assert.equal(f.text, 'aX Yb');
  press(f, keys.Key_Insert, keys.ShiftModifier);
  f.text = 'changed';
  pending.shift()('Z');
  assert.equal(f.text, 'changed', 'an answer for an older state is dropped');
  press(f, keys.Key_V, keys.ControlModifier);
  f.activeFocus = false;
  pending.shift()('Z');
  assert.equal(f.text, 'changed', 'a field that lost focus is left alone');
});

test('paste finds the service on a parent', function () {
  var asked = 0;
  var f = field('');
  f.parent = { parent: { service: { readClipboardText: function () { asked++; } } } };
  press(f, keys.Key_V, keys.ControlModifier);
  assert.equal(asked, 1);
});

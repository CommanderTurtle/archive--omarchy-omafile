'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var loadModule = require('./load.js');

var Editing = loadModule('EditorEditing.js');

var keys = {
  ControlModifier: 1, ShiftModifier: 2, AltModifier: 4, MetaModifier: 8,
  Key_A: 65, Key_C: 67, Key_V: 86, Key_X: 88, Key_Y: 89, Key_Z: 90, Key_Insert: 100,
  Key_Return: 101, Key_Enter: 102, Key_Tab: 103, Key_Backtab: 104, Key_Backspace: 105, Key_Delete: 106
};

function editor(text, cursor, selStart, selEnd) {
  var ed = {
    text: '', model: '', cursorPosition: 0, selectionStart: 0, selectionEnd: 0, visible: true, activeFocus: true,
    copied: null, clipboard: '', parent: null, locked: false, history: null,
    insert: function (pos, s) {
      this.text = this.text.slice(0, pos) + s + this.text.slice(pos);
      this.cursorPosition = pos + s.length;
      this.selectionStart = this.selectionEnd = this.cursorPosition;
    },
    remove: function (a, b) {
      this.text = this.text.slice(0, a) + this.text.slice(b);
      this.cursorPosition = a;
      this.selectionStart = this.selectionEnd = a;
    },
    select: function (a, b) { this.selectionStart = Math.min(a, b); this.selectionEnd = Math.max(a, b); this.cursorPosition = b; },
    deselect: function () { this.selectionStart = this.selectionEnd = this.cursorPosition; },
    copy: function () { this.copied = this.model.slice(this.selectionStart, this.selectionEnd); }
  };
  ed.clipboardSource = { readClipboardText: function (cb, limit) { ed.pasteLimit = limit; cb(ed.clipboard); } };
  Editing.load(ed, text);
  if (selStart !== undefined) ed.select(selStart, selEnd);
  else { ed.cursorPosition = cursor === undefined ? text.length : cursor; ed.deselect(); }
  return ed;
}

function press(ed, key, mods, text) {
  return Editing.handleKey(ed, { key: key || 0, modifiers: mods || 0, text: text || '' }, keys);
}

function type(ed, text) {
  for (var i = 0; i < text.length; i++) press(ed, 0, 0, text.charAt(i));
}

test('typing, Enter and deleting keep the shown text and the saved copy the same', function () {
  var ed = editor('', 0);
  type(ed, 'hello');
  press(ed, keys.Key_Return);
  type(ed, 'world');
  assert.equal(ed.model, 'hello\nworld');
  assert.equal(ed.text, ed.model);
  press(ed, keys.Key_Backspace);
  press(ed, keys.Key_Backspace, keys.ControlModifier);
  assert.equal(ed.model, 'hello\n');
  ed.cursorPosition = 0; ed.deselect();
  press(ed, keys.Key_Delete, keys.ControlModifier);
  assert.equal(ed.model, '\n');
  assert.equal(ed.text, ed.model);
});

test('the saved copy keeps characters the display would change', function () {
  var ed = editor('a b', 3);
  type(ed, '!');
  assert.equal(ed.model, 'a b!', 'a no-break space survives an edit');
});

test('Enter keeps the indentation of the line', function () {
  var ed = editor('def f():\n    x = 1', 18);
  press(ed, keys.Key_Return);
  type(ed, 'y');
  assert.equal(ed.model, 'def f():\n    x = 1\n    y');
});

test('Tab indents with the file\'s own indentation, and indents or outdents a selection', function () {
  assert.equal(Editing.indentUnit('a\n  b\n    c\n'), '  ');
  assert.equal(Editing.indentUnit('a\n\tb\n\tc\n  d'), '\t');
  assert.equal(Editing.indentUnit('no indent here'), '    ');
  var ed = editor('one\n  two\nthree', 0);
  press(ed, keys.Key_Tab);
  assert.equal(ed.model, '  one\n  two\nthree');
  ed.select(0, ed.model.length);
  press(ed, keys.Key_Tab);
  assert.equal(ed.model, '    one\n    two\n  three');
  assert.equal(ed.selectionEnd - ed.selectionStart, ed.model.length, 'the lines stay selected');
  press(ed, keys.Key_Backtab);
  press(ed, keys.Key_Tab, keys.ShiftModifier);
  assert.equal(ed.model, 'one\ntwo\nthree');
  var tabbed = editor('\tx\n\ty', 0, 0, 5);
  press(tabbed, keys.Key_Backtab);
  assert.equal(tabbed.model, 'x\ny');
});

test('undo takes back a word at a time and redo puts it back', function () {
  var ed = editor('', 0);
  type(ed, 'one two');
  assert.equal(ed.historyDepth, 2, 'each word is one step');
  press(ed, keys.Key_Z, keys.ControlModifier);
  assert.equal(ed.model, 'one ');
  press(ed, keys.Key_Z, keys.ControlModifier);
  assert.equal(ed.model, '');
  press(ed, keys.Key_Z, keys.ControlModifier | keys.ShiftModifier);
  press(ed, keys.Key_Y, keys.ControlModifier);
  assert.equal(ed.model, 'one two');
  assert.equal(ed.text, ed.model);
  var del = editor('abcdef', 6);
  press(del, keys.Key_Backspace); press(del, keys.Key_Backspace); press(del, keys.Key_Backspace);
  press(del, keys.Key_Z, keys.ControlModifier);
  assert.equal(del.model, 'abcdef', 'a run of deletes undoes in one go');
});

test('the file counts as changed until it is back at the saved text', function () {
  var ed = editor('base', 4);
  assert.equal(ed.historyDepth, ed.savedDepth);
  type(ed, ' one');
  assert.notEqual(ed.historyDepth, ed.savedDepth);
  Editing.markSaved(ed, Editing.seal(ed));
  assert.equal(ed.historyDepth, ed.savedDepth, 'saving makes it clean');
  type(ed, 'x');
  assert.equal(ed.model, 'base onex', 'typing after a save is a new step');
  assert.notEqual(ed.historyDepth, ed.savedDepth);
  press(ed, keys.Key_Z, keys.ControlModifier);
  assert.equal(ed.historyDepth, ed.savedDepth, 'undo back to the saved text is clean');
  press(ed, keys.Key_Z, keys.ControlModifier);
  type(ed, 'z');
  press(ed, keys.Key_Z, keys.ControlModifier);
  assert.notEqual(ed.historyDepth, ed.savedDepth, 'once the saved text cannot be reached again it stays changed');
});

test('a save that finished after more typing marks only what was sent', function () {
  var ed = editor('', 0);
  type(ed, 'abc');
  var mark = Editing.seal(ed);
  type(ed, 'd');
  Editing.markSaved(ed, mark);
  assert.notEqual(ed.historyDepth, ed.savedDepth, 'the typing after the save is still unsaved');
  press(ed, keys.Key_Z, keys.ControlModifier);
  assert.equal(ed.historyDepth, ed.savedDepth);
});

test('cut, copy, paste and select all work on the saved copy', function () {
  var ed = editor('alpha beta', 0, 0, 5);
  press(ed, keys.Key_C, keys.ControlModifier);
  assert.equal(ed.copied, 'alpha');
  press(ed, keys.Key_X, keys.ControlModifier);
  assert.equal(ed.model, ' beta');
  ed.clipboard = 'one\r\ntwo\rthree';
  press(ed, keys.Key_V, keys.ControlModifier);
  assert.equal(ed.model, 'one\ntwo\nthree beta', 'pasted line endings become newlines');
  assert.equal(ed.pasteLimit, 1024 * 1024, 'the editor can paste up to 1 MB');
  press(ed, keys.Key_A, keys.ControlModifier);
  assert.equal(ed.selectionEnd - ed.selectionStart, ed.model.length);
});

test('a paste that would make a line too long to edit smoothly is refused', function () {
  var refused = 0;
  var ed = editor('short line\nnext', 5);
  ed.pasteRefused = function () { refused++; };
  ed.clipboard = 'x'.repeat(20001);
  press(ed, keys.Key_V, keys.ControlModifier);
  assert.equal(refused, 1);
  assert.equal(ed.model, 'short line\nnext');
  ed.clipboard = 'a\n' + 'y'.repeat(19990) + '\nb';
  press(ed, keys.Key_V, keys.ControlModifier);
  assert.equal(refused, 1, 'long lines are fine up to the limit');
  assert.equal(ed.model.split('\n').length, 4);
});

test('a read only file can be selected and copied but never changed', function () {
  var touched = 0;
  var ed = editor('locked text', 0, 0, 6);
  ed.locked = true;
  ed.lockedTouched = function () { touched++; };
  assert.equal(press(ed, 0, 0, 'x'), true);
  press(ed, keys.Key_Backspace);
  press(ed, keys.Key_V, keys.ControlModifier);
  press(ed, keys.Key_Return);
  assert.equal(ed.model, 'locked text');
  assert.equal(touched, 4);
  press(ed, keys.Key_C, keys.ControlModifier);
  assert.equal(ed.copied, 'locked');
});

test('navigation keys are left to Qt', function () {
  var ed = editor('abc', 0);
  assert.equal(press(ed, 999, 0, ''), false);
  assert.equal(press(ed, keys.Key_Return, keys.ControlModifier), false);
});

test('find wraps around, ignores case for lower case searches, and finds backwards', function () {
  var text = 'Alpha beta ALPHA alpha';
  assert.equal(Editing.find(text, 'alpha', 0, false), 0);
  assert.equal(Editing.find(text, 'alpha', 1, false), 11);
  assert.equal(Editing.find(text, 'Alpha', 1, false), 0, 'a capital letter makes the search exact, and it wraps');
  assert.equal(Editing.find(text, 'alpha', 17, true), 11);
  assert.equal(Editing.find(text, 'alpha', 0, true), 17, 'searching back from the start wraps to the end');
  assert.equal(Editing.find(text, 'a.b', 0, false), -1, 'the search is plain text, not a pattern');
  assert.equal(Editing.find(text, '', 0, false), -1);
});

test('lineColumn counts from one', function () {
  assert.deepEqual(JSON.parse(JSON.stringify(Editing.lineColumn('ab\ncd\nef', 4))), { line: 2, column: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(Editing.lineColumn('', 0))), { line: 1, column: 1 });
});

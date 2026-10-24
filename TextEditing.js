var historyLimit = 100;

function isHighSurrogate(code) {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code) {
  return code >= 0xDC00 && code <= 0xDFFF;
}

function printable(text) {
  if (!text) return false;
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function singleLine(text) {
  return String(text || '').replace(/\r\n|\r|\n|\t/g, ' ');
}

function concealed(field, keys) {
  return field.echoMode !== keys.Normal;
}

function remember(field, keys) {
  if (concealed(field, keys)) return;
  var undo = field.editUndo || [];
  undo.push({ text: field.text, cursor: field.cursorPosition });
  if (undo.length > historyLimit) undo.shift();
  field.editUndo = undo;
  field.editRedo = [];
}

function restore(field, from, to) {
  var stack = field[from] || [];
  if (stack.length === 0) return;
  var state = stack.pop();
  var other = field[to] || [];
  other.push({ text: field.text, cursor: field.cursorPosition });
  field[from] = stack;
  field[to] = other;
  field.text = state.text;
  field.cursorPosition = Math.min(state.cursor, field.text.length);
}

function removeSelection(field) {
  var start = field.selectionStart;
  var end = field.selectionEnd;
  if (end <= start) return false;
  field.remove(start, end);
  field.cursorPosition = start;
  return true;
}

function insertText(field, text, keys) {
  var clean = singleLine(text);
  if (clean === '' && field.selectionStart === field.selectionEnd) return;
  remember(field, keys);
  removeSelection(field);
  field.insert(field.cursorPosition, clean);
}

function previousStop(text, pos) {
  if (pos >= 2 && isLowSurrogate(text.charCodeAt(pos - 1)) && isHighSurrogate(text.charCodeAt(pos - 2))) return pos - 2;
  return Math.max(0, pos - 1);
}

function nextStop(text, pos) {
  if (pos + 1 < text.length && isHighSurrogate(text.charCodeAt(pos)) && isLowSurrogate(text.charCodeAt(pos + 1))) return pos + 2;
  return Math.min(text.length, pos + 1);
}

function wordStart(text, pos) {
  var i = pos;
  while (i > 0 && /\s/.test(text.charAt(i - 1))) i--;
  while (i > 0 && !/[\s\/._-]/.test(text.charAt(i - 1))) i--;
  if (i === pos && i > 0) i--;
  return i;
}

function wordEnd(text, pos) {
  var i = pos;
  while (i < text.length && /\s/.test(text.charAt(i))) i++;
  while (i < text.length && !/[\s\/._-]/.test(text.charAt(i))) i++;
  if (i === pos && i < text.length) i++;
  return i;
}

function deleteBack(field, word, keys) {
  remember(field, keys);
  if (removeSelection(field)) return;
  var pos = field.cursorPosition;
  if (pos <= 0) return;
  var from = word ? wordStart(field.text, pos) : previousStop(field.text, pos);
  field.remove(from, pos);
}

function deleteForward(field, word, keys) {
  remember(field, keys);
  if (removeSelection(field)) return;
  var pos = field.cursorPosition;
  if (pos >= field.text.length) return;
  var to = word ? wordEnd(field.text, pos) : nextStop(field.text, pos);
  field.remove(pos, to);
}

function findClipboard(item) {
  for (var p = item; p; p = p.parent) {
    if (p.service && typeof p.service.readClipboardText === 'function') return p.service;
  }
  return null;
}

function paste(field, keys) {
  var source = field.clipboardSource || findClipboard(field);
  if (!source) return;
  var expected = field.text;
  source.readClipboardText(function (text) {
    if (!field || !field.visible || !field.activeFocus || field.text !== expected) return;
    insertText(field, text, keys);
  });
}

function handleKey(field, event, keys) {
  var mods = event.modifiers;
  var ctrl = (mods & keys.ControlModifier) !== 0;
  var shift = (mods & keys.ShiftModifier) !== 0;
  var alt = (mods & keys.AltModifier) !== 0;
  var meta = (mods & keys.MetaModifier) !== 0;
  var key = event.key;
  if ((ctrl && !alt && key === keys.Key_V) || (shift && !ctrl && key === keys.Key_Insert)) {
    paste(field, keys);
    return true;
  }
  if (ctrl && !alt && key === keys.Key_X) {
    if (field.selectionEnd > field.selectionStart && !concealed(field, keys)) {
      field.copy();
      remember(field, keys);
      removeSelection(field);
    }
    return true;
  }
  if (ctrl && !alt && ((key === keys.Key_Z && shift) || key === keys.Key_Y)) {
    if (!concealed(field, keys)) restore(field, 'editRedo', 'editUndo');
    return true;
  }
  if (ctrl && !alt && key === keys.Key_Z) {
    if (!concealed(field, keys)) restore(field, 'editUndo', 'editRedo');
    return true;
  }
  if (key === keys.Key_Backspace) {
    deleteBack(field, ctrl, keys);
    return true;
  }
  if (key === keys.Key_Delete && !shift) {
    deleteForward(field, ctrl, keys);
    return true;
  }
  if (key === keys.Key_Delete && shift) {
    if (field.selectionEnd > field.selectionStart && !concealed(field, keys)) field.copy();
    remember(field, keys);
    removeSelection(field);
    return true;
  }
  if (!ctrl && !meta && !alt && printable(event.text)) {
    insertText(field, event.text, keys);
    return true;
  }
  return false;
}

var historyLimit = 2000;
var historyChars = 16 * 1024 * 1024;
var pasteLimit = 1024 * 1024;
var lineLimit = 20000;

function state(ed) {
  if (!ed.history) ed.history = { undo: [], redo: [], saved: 0, chars: 0, revision: 0 };
  return ed.history;
}

function publish(ed) {
  var h = state(ed);
  ed.historyDepth = h.undo.length;
  ed.savedDepth = h.saved;
  ed.revision = h.revision;
}

function load(ed, text) {
  ed.model = String(text || '');
  ed.text = ed.model;
  ed.history = { undo: [], redo: [], saved: 0, chars: 0, revision: 0 };
  ed.indentUnit = indentUnit(ed.model);
  publish(ed);
}

function seal(ed) {
  var h = state(ed);
  var top = h.undo.length ? h.undo[h.undo.length - 1] : null;
  if (top) top.sealed = true;
  return { depth: h.undo.length, top: top };
}

function markSaved(ed, mark) {
  var h = state(ed);
  var at = mark ? mark.depth : h.undo.length;
  var top = mark ? mark.top : (h.undo.length ? h.undo[h.undo.length - 1] : null);
  var current = at > 0 && at <= h.undo.length ? h.undo[at - 1] : null;
  h.saved = at <= h.undo.length && current === top ? at : -1;
  publish(ed);
}

function setCursor(ed, start, end) {
  if (end !== undefined && end !== start) ed.select(start, end);
  else {
    ed.deselect();
    ed.cursorPosition = start;
  }
}

function replace(ed, start, end, text, kind) {
  var h = state(ed);
  var model = ed.model;
  var removed = end > start ? model.slice(start, end) : '';
  if (removed === '' && text === '') return false;
  var last = h.undo.length ? h.undo[h.undo.length - 1] : null;
  var now = Date.now();
  var merged = false;
  if (last && !last.sealed && h.redo.length === 0 && kind && last.kind === kind && now - last.time < 2000) {
    if (kind === 'type' && removed === '' && last.start + last.inserted.length === start
        && !(/\s$/.test(last.inserted) && /^\S/.test(text))) {
      last.inserted += text;
      merged = true;
    } else if (kind === 'back' && text === '' && last.inserted === '' && end === last.start) {
      last.start = start;
      last.removed = removed + last.removed;
      merged = true;
    } else if (kind === 'del' && text === '' && last.inserted === '' && start === last.start) {
      last.removed += removed;
      merged = true;
    }
  }
  if (merged) last.time = now;
  else {
    if (h.redo.length > 0 && h.saved > h.undo.length) h.saved = -1;
    h.undo.push({ kind: kind || '', start: start, removed: removed, inserted: text, time: now,
      before: [ed.selectionStart, ed.selectionEnd] });
  }
  h.redo = [];
  h.chars += removed.length + text.length;
  while ((h.undo.length > historyLimit || h.chars > historyChars) && h.undo.length > 1) {
    var dropped = h.undo.shift();
    h.chars -= dropped.removed.length + dropped.inserted.length;
    h.saved = h.saved > 0 ? h.saved - 1 : -1;
  }
  h.revision++;
  ed.model = model.slice(0, start) + text + model.slice(end);
  if (end > start) ed.remove(start, end);
  if (text !== '') ed.insert(start, text);
  setCursor(ed, start + text.length);
  publish(ed);
  return true;
}

function apply(ed, start, oldLength, text) {
  ed.model = ed.model.slice(0, start) + text + ed.model.slice(start + oldLength);
  if (oldLength > 0) ed.remove(start, start + oldLength);
  if (text !== '') ed.insert(start, text);
}

function undo(ed) {
  var h = state(ed);
  if (h.undo.length === 0) return false;
  var op = h.undo.pop();
  apply(ed, op.start, op.inserted.length, op.removed);
  h.redo.push(op);
  h.revision++;
  setCursor(ed, op.before[0], op.before[1]);
  publish(ed);
  return true;
}

function redo(ed) {
  var h = state(ed);
  if (h.redo.length === 0) return false;
  var op = h.redo.pop();
  apply(ed, op.start, op.removed.length, op.inserted);
  op.sealed = true;
  h.undo.push(op);
  h.revision++;
  setCursor(ed, op.start + op.inserted.length);
  publish(ed);
  return true;
}

function isHighSurrogate(code) {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code) {
  return code >= 0xDC00 && code <= 0xDFFF;
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
  while (i > 0 && /[ \t]/.test(text.charAt(i - 1))) i--;
  if (i > 0 && text.charAt(i - 1) === '\n') return i === pos ? i - 1 : i;
  while (i > 0 && /\w/.test(text.charAt(i - 1))) i--;
  if (i === pos && i > 0) i--;
  return i;
}

function wordEnd(text, pos) {
  var i = pos;
  while (i < text.length && /[ \t]/.test(text.charAt(i))) i++;
  if (i < text.length && text.charAt(i) === '\n') return i === pos ? i + 1 : i;
  while (i < text.length && /\w/.test(text.charAt(i))) i++;
  if (i === pos && i < text.length) i++;
  return i;
}

function lineStart(text, pos) {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

function lineEnd(text, pos) {
  var i = text.indexOf('\n', pos);
  return i < 0 ? text.length : i;
}

function indentUnit(text) {
  var source = String(text || '');
  var tabs = 0;
  var spaced = 0;
  var smallest = 0;
  var lines = 0;
  var at = 0;
  while (at < source.length && lines < 5000) {
    var end = source.indexOf('\n', at);
    if (end < 0) end = source.length;
    if (source.charAt(at) === '\t') tabs++;
    else if (source.charAt(at) === ' ') {
      var n = 0;
      while (source.charAt(at + n) === ' ') n++;
      if (at + n < end) {
        spaced++;
        if (n >= 2 && (smallest === 0 || n < smallest)) smallest = n;
      }
    }
    at = end + 1;
    lines++;
  }
  if (tabs > spaced) return '\t';
  var width = smallest === 0 ? 4 : Math.min(8, smallest);
  return '        '.slice(0, width);
}

function outdented(line, unit) {
  if (line.charAt(0) === '\t') return line.slice(1);
  var width = unit === '\t' ? 4 : unit.length;
  var n = 0;
  while (n < width && line.charAt(n) === ' ') n++;
  return line.slice(n);
}

function shiftLines(ed, outdent) {
  var unit = ed.indentUnit || '    ';
  var text = ed.model;
  var s = ed.selectionStart;
  var e = ed.selectionEnd;
  var several = e > s && text.slice(s, e).indexOf('\n') >= 0;
  if (!several && !outdent) return replace(ed, s, e, unit, 'indent');
  var first = lineStart(text, s);
  var last = e > s && text.charAt(e - 1) === '\n' ? e - 1 : e;
  var stop = lineEnd(text, last);
  var block = text.slice(first, stop);
  var lines = block.split('\n');
  for (var i = 0; i < lines.length; i++)
    lines[i] = outdent ? outdented(lines[i], unit) : (lines[i] === '' ? '' : unit + lines[i]);
  var changed = lines.join('\n');
  if (changed === block) return false;
  var caret = ed.cursorPosition;
  replace(ed, first, stop, changed, 'indent');
  if (several) ed.select(first, first + changed.length);
  else setCursor(ed, Math.max(first, Math.min(first + changed.length, caret - (block.length - changed.length))));
  return true;
}

function newline(ed) {
  var text = ed.model;
  var s = ed.selectionStart;
  var lead = /^[ \t]*/.exec(text.slice(lineStart(text, s), s))[0];
  return replace(ed, s, ed.selectionEnd, '\n' + lead, 'type');
}

function typable(text) {
  if (!text) return false;
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function findClipboard(item) {
  for (var p = item; p; p = p.parent) {
    if (p.service && typeof p.service.readClipboardText === 'function') return p.service;
  }
  return null;
}

function paste(ed) {
  var source = ed.clipboardSource || findClipboard(ed);
  if (!source) return;
  var revision = state(ed).revision;
  source.readClipboardText(function (text) {
    if (!ed || !ed.visible || !ed.activeFocus || state(ed).revision !== revision) return;
    var clean = String(text || '').replace(/\r\n?/g, '\n');
    if (clean === '') return;
    var model = ed.model;
    var lines = clean.split('\n');
    var before = ed.selectionStart - lineStart(model, ed.selectionStart);
    var after = lineEnd(model, ed.selectionEnd) - ed.selectionEnd;
    var longest = lines.length === 1 ? before + lines[0].length + after
      : Math.max(before + lines[0].length, lines[lines.length - 1].length + after);
    for (var i = 1; i < lines.length - 1; i++) longest = Math.max(longest, lines[i].length);
    if (longest > lineLimit) {
      if (typeof ed.pasteRefused === 'function') ed.pasteRefused();
      return;
    }
    replace(ed, ed.selectionStart, ed.selectionEnd, clean, 'paste');
  }, pasteLimit);
}

function selected(ed) {
  return ed.selectionEnd > ed.selectionStart;
}

function handleKey(ed, event, keys) {
  var mods = event.modifiers;
  var ctrl = (mods & keys.ControlModifier) !== 0;
  var shift = (mods & keys.ShiftModifier) !== 0;
  var alt = (mods & keys.AltModifier) !== 0;
  var meta = (mods & keys.MetaModifier) !== 0;
  var key = event.key;
  var text = ed.model;
  if (ctrl && !alt && key === keys.Key_A) {
    ed.select(0, text.length);
    return true;
  }
  if (ctrl && !alt && (key === keys.Key_C || key === keys.Key_Insert)) {
    if (selected(ed)) ed.copy();
    return true;
  }
  var editing = (ctrl && !alt && (key === keys.Key_X || key === keys.Key_V || key === keys.Key_Z || key === keys.Key_Y))
    || (shift && !ctrl && key === keys.Key_Insert)
    || key === keys.Key_Return || key === keys.Key_Enter || key === keys.Key_Tab || key === keys.Key_Backtab
    || key === keys.Key_Backspace || key === keys.Key_Delete
    || (!ctrl && !meta && !alt && typable(event.text));
  if (!editing) return false;
  if (ed.locked) {
    if (typeof ed.lockedTouched === 'function') ed.lockedTouched();
    return true;
  }
  if (ctrl && !alt && key === keys.Key_X) {
    if (selected(ed)) {
      ed.copy();
      replace(ed, ed.selectionStart, ed.selectionEnd, '', 'cut');
    }
    return true;
  }
  if ((ctrl && !alt && key === keys.Key_V) || (shift && !ctrl && key === keys.Key_Insert)) {
    paste(ed);
    return true;
  }
  if (ctrl && !alt && ((key === keys.Key_Z && shift) || key === keys.Key_Y)) {
    redo(ed);
    return true;
  }
  if (ctrl && !alt && key === keys.Key_Z) {
    undo(ed);
    return true;
  }
  if (key === keys.Key_Return || key === keys.Key_Enter) {
    if (ctrl || alt || meta) return false;
    newline(ed);
    return true;
  }
  if (key === keys.Key_Backtab || (key === keys.Key_Tab && shift)) {
    shiftLines(ed, true);
    return true;
  }
  if (key === keys.Key_Tab) {
    if (ctrl || alt || meta) return false;
    shiftLines(ed, false);
    return true;
  }
  if (key === keys.Key_Backspace) {
    if (selected(ed)) replace(ed, ed.selectionStart, ed.selectionEnd, '', 'cut');
    else {
      var pos = ed.cursorPosition;
      if (pos > 0) replace(ed, ctrl ? wordStart(text, pos) : previousStop(text, pos), pos, '', 'back');
    }
    return true;
  }
  if (key === keys.Key_Delete) {
    if (selected(ed)) {
      if (shift) ed.copy();
      replace(ed, ed.selectionStart, ed.selectionEnd, '', 'cut');
    } else {
      var at = ed.cursorPosition;
      if (at < text.length) replace(ed, at, ctrl ? wordEnd(text, at) : nextStop(text, at), '', 'del');
    }
    return true;
  }
  replace(ed, ed.selectionStart, ed.selectionEnd, event.text, 'type');
  return true;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function find(text, query, from, backwards) {
  var needle = String(query || '');
  if (!needle || !text) return -1;
  var flags = needle === needle.toLowerCase() ? 'gi' : 'g';
  var pattern = new RegExp(escapeRegExp(needle), flags);
  var match;
  if (!backwards) {
    pattern.lastIndex = Math.max(0, from);
    match = pattern.exec(text);
    if (match) return match.index;
    pattern.lastIndex = 0;
    match = pattern.exec(text);
    return match ? match.index : -1;
  }
  var best = -1;
  var lastSeen = -1;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index < from) best = match.index;
    lastSeen = match.index;
    pattern.lastIndex = match.index + 1;
  }
  return best >= 0 ? best : lastSeen;
}

function lineColumn(text, pos) {
  var line = 1;
  var at = text.indexOf('\n');
  while (at >= 0 && at < pos) {
    line++;
    at = text.indexOf('\n', at + 1);
  }
  return { line: line, column: pos - lineStart(text, pos) + 1 };
}

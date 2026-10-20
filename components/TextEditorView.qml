import QtQuick 6.11
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "../Model.js" as Model
import "../EditorEditing.js" as Editing
import "../Icons.js" as Icons

Rectangle {
  id: view
  objectName: "textEditorView"

  property var service: null
  property string home: ""
  property bool open: false
  property string path: ""
  property string name: ""
  property var identity: null
  property bool crlf: false
  property bool bom: false
  property bool writable: true
  property bool loading: false
  property string loadError: ""
  property string notice: ""
  property bool noticeIsError: false
  property bool saving: false
  property bool wrap: true
  property string prompt: ""
  property bool conflictDeleted: false
  property bool closeAfterSave: false
  property bool findOpen: false
  property int loadToken: 0
  property string position: "Line 1, column 1"
  readonly property bool ready: open && !loading && loadError === ""
  readonly property bool dirty: ready && textArea.historyDepth !== textArea.savedDepth
  readonly property var editKeys: ({
    ControlModifier: Qt.ControlModifier, ShiftModifier: Qt.ShiftModifier,
    AltModifier: Qt.AltModifier, MetaModifier: Qt.MetaModifier,
    Key_A: Qt.Key_A, Key_C: Qt.Key_C, Key_V: Qt.Key_V, Key_X: Qt.Key_X, Key_Y: Qt.Key_Y, Key_Z: Qt.Key_Z,
    Key_Insert: Qt.Key_Insert, Key_Return: Qt.Key_Return, Key_Enter: Qt.Key_Enter, Key_Tab: Qt.Key_Tab,
    Key_Backtab: Qt.Key_Backtab, Key_Backspace: Qt.Key_Backspace, Key_Delete: Qt.Key_Delete
  })

  signal closed()
  signal savedFile(string path)

  anchors.fill: parent
  visible: open
  color: Util.alpha(Color.background, 0.7)

  function openFile(filePath, displayName) {
    open = true
    path = String(filePath)
    name = String(displayName || Model.basename(filePath))
    loading = true
    loadError = ""
    notice = ""
    prompt = ""
    findOpen = false
    closeAfterSave = false
    identity = null
    Editing.load(textArea, "")
    var token = ++loadToken
    if (!service) return
    service.readText(path, function (m) {
      if (token !== view.loadToken) return
      view.path = String(m.path || filePath)
      view.identity = { ino: m.ino, dev: m.dev, mtimeNs: m.mtimeNs, size: m.size }
      view.crlf = m.crlf === true
      view.bom = m.bom === true
      view.writable = m.writable !== false
      Editing.load(textArea, String(m.text || ""))
      if (textArea.length !== textArea.model.length) {
        Editing.load(textArea, "")
        view.loading = false
        view.loadError = "Could not open " + view.name + ": it has characters the editor cannot show exactly"
        closeButton.forceActiveFocus()
        return
      }
      textArea.cursorPosition = 0
      flick.contentX = 0
      flick.contentY = 0
      view.loading = false
      view.updatePosition()
      textArea.forceActiveFocus()
    }, function (m) {
      if (token !== view.loadToken) return
      view.loading = false
      var why = String((m && m.message) || "it could not be read")
      view.loadError = "Could not open " + view.name + ": " + why
      closeButton.forceActiveFocus()
    })
  }

  function focusEditor() {
    if (prompt !== "") return
    if (findOpen) findField.forceActiveFocus()
    else if (ready) textArea.forceActiveFocus()
    else closeButton.forceActiveFocus()
  }

  function say(text, error) {
    notice = text
    noticeIsError = error === true
    noticeTimer.restart()
  }

  function save(force) {
    if (!service || !ready || saving) return
    if (!writable) {
      say("This file is read only for you", true)
      return
    }
    if (textArea.length !== textArea.model.length) {
      say("Not saved: the editor lost track of the text. Copy your changes and reopen the file", true)
      return
    }
    saving = true
    notice = "Saving"
    noticeIsError = false
    var mark = Editing.seal(textArea)
    var target = path
    var token = loadToken
    service.writeText(target, textArea.model, identity, force === true, crlf, bom, function (m) {
      view.saving = false
      if (token !== view.loadToken) return
      view.identity = { ino: m.ino, dev: m.dev, mtimeNs: m.mtimeNs, size: m.size }
      Editing.markSaved(textArea, mark)
      view.say("Saved", false)
      view.savedFile(target)
      if (view.closeAfterSave) view.finishClose()
    }, function (m) {
      view.saving = false
      if (token !== view.loadToken) return
      if (m && m.code === "ECONFLICT") {
        view.conflictDeleted = m.message === "deleted"
        view.prompt = "conflict"
        return
      }
      view.closeAfterSave = false
      view.say("Could not save: " + String((m && m.message) || "unknown error"), true)
    })
  }

  function requestClose() {
    if (prompt !== "") return
    if (dirty) {
      prompt = "unsaved"
      return
    }
    finishClose()
  }

  function finishClose() {
    loadToken++
    open = false
    prompt = ""
    closeAfterSave = false
    findOpen = false
    Editing.load(textArea, "")
    closed()
  }

  function reload() {
    prompt = ""
    openFile(path, name)
  }

  function ensureVisible(r) {
    if (flick.contentX > r.x) flick.contentX = r.x
    else if (flick.contentX + flick.width < r.x + r.width + Style.space(8))
      flick.contentX = r.x + r.width + Style.space(8) - flick.width
    if (flick.contentY > r.y) flick.contentY = r.y
    else if (flick.contentY + flick.height < r.y + r.height)
      flick.contentY = r.y + r.height - flick.height
  }

  function updatePosition() {
    var at = Editing.lineColumn(textArea.model, textArea.cursorPosition)
    position = "Line " + at.line + ", column " + at.column
  }

  function page(delta, extend) {
    var r = textArea.cursorRectangle
    var target = textArea.positionAt(r.x, r.y + r.height / 2 + delta * Math.max(r.height, flick.height - r.height))
    if (extend) textArea.moveCursorSelection(target, TextEdit.SelectCharacters)
    else textArea.cursorPosition = target
  }

  function openFind() {
    findOpen = true
    var picked = textArea.selectedText
    if (picked && picked.indexOf("\n") < 0) findField.text = textArea.model.slice(textArea.selectionStart, textArea.selectionEnd)
    Qt.callLater(function () {
      findField.forceActiveFocus()
      findField.selectAll()
    })
  }

  function closeFind() {
    findOpen = false
    textArea.forceActiveFocus()
  }

  function findNext(backwards) {
    var query = String(findField.text || "")
    if (query === "") return
    var from = backwards ? textArea.selectionStart : textArea.selectionEnd
    var at = Editing.find(textArea.model, query, from, backwards)
    if (at < 0) {
      say("Not found", true)
      return
    }
    textArea.select(at, at + query.length)
    ensureVisible(textArea.positionToRectangle(at))
  }

  function handleKey(event) {
    var ctrl = (event.modifiers & Qt.ControlModifier) !== 0
    var shift = (event.modifiers & Qt.ShiftModifier) !== 0
    var alt = (event.modifiers & Qt.AltModifier) !== 0
    if (ctrl && !alt && event.key === Qt.Key_S) { save(false); return true }
    if (ctrl && !alt && event.key === Qt.Key_F) { openFind(); return true }
    if (event.key === Qt.Key_F3) { findNext(shift); return true }
    if (event.key === Qt.Key_Escape) { requestClose(); return true }
    if (ctrl && !alt && (event.key === Qt.Key_W || event.key === Qt.Key_Q)) { requestClose(); return true }
    if (alt && !ctrl && event.key === Qt.Key_Z) { wrap = !wrap; return true }
    if (!ctrl && !alt && (event.key === Qt.Key_PageDown || event.key === Qt.Key_PageUp)) {
      view.page(event.key === Qt.Key_PageDown ? 1 : -1, shift)
      return true
    }
    return Editing.handleKey(textArea, event, editKeys)
  }

  MouseArea {
    anchors.fill: parent
    acceptedButtons: Qt.LeftButton | Qt.RightButton
    onClicked: view.focusEditor()
  }

  Timer {
    id: noticeTimer
    interval: 4000
    onTriggered: if (!view.saving) view.notice = ""
  }

  Timer {
    id: positionTimer
    interval: 120
    onTriggered: view.updatePosition()
  }

  FontMetrics {
    id: metrics
    font: textArea.font
  }

  Rectangle {
    id: card
    objectName: "textEditorCard"
    anchors.centerIn: parent
    width: Math.max(Style.space(320), parent.width - Style.space(60))
    height: Math.max(Style.space(220), parent.height - Style.space(60))
    color: Color.popups.background
    border.width: Math.max(1, Style.space(1))
    border.color: Color.popups.border
    radius: Style.cornerRadius

    MouseArea { anchors.fill: parent; onClicked: view.focusEditor() }

    Item {
      id: header
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.margins: Style.space(12)
      height: Style.space(40)

      Column {
        anchors.left: parent.left
        anchors.right: buttons.left
        anchors.rightMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)

        Text {
          textFormat: Text.PlainText
          objectName: "textEditorTitle"
          width: parent.width
          text: (view.dirty ? "● " : "") + view.name
          color: Color.popups.text
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          elide: Text.ElideMiddle
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          text: Model.collapseTilde(Model.dirname(view.path), view.home)
          color: Util.alpha(Color.popups.text, 0.5)
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          elide: Text.ElideMiddle
        }
      }

      Row {
        id: buttons
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(6)

        Button {
          text: "Find"
          bordered: true
          enabled: view.ready
          opacity: enabled ? 1 : 0.4
          onClicked: view.openFind()
        }

        Button {
          objectName: "textEditorWrap"
          text: view.wrap ? "Wrap on" : "Wrap off"
          bordered: true
          onClicked: {
            view.wrap = !view.wrap
            view.focusEditor()
          }
        }

        Button {
          objectName: "textEditorSave"
          text: view.saving ? "Saving" : "Save"
          bordered: true
          selected: view.dirty
          enabled: view.ready && view.writable && !view.saving
          opacity: enabled ? 1 : 0.4
          onClicked: view.save(false)
        }

        Button {
          id: closeButton
          objectName: "textEditorClose"
          iconText: Icons.actionGlyph("close")
          tooltipText: "Close"
          onClicked: view.requestClose()
          Keys.onEscapePressed: view.requestClose()
        }
      }
    }

    Rectangle {
      id: findBar
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: header.bottom
      anchors.leftMargin: Style.space(12)
      anchors.rightMargin: Style.space(12)
      height: view.findOpen ? Style.space(34) : 0
      visible: view.findOpen
      color: "transparent"

      Row {
        anchors.fill: parent
        spacing: Style.space(6)

        EditField {
          id: findField
          objectName: "textEditorFind"
          width: parent.width - nextButton.width - previousButton.width - doneButton.width - Style.space(18)
          anchors.verticalCenter: parent.verticalCenter
          placeholderText: "Find"
          keyFilter: function (event) {
            if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && (event.modifiers & Qt.ShiftModifier)) {
              view.findNext(true)
              return true
            }
            if (event.key === Qt.Key_F3) {
              view.findNext((event.modifiers & Qt.ShiftModifier) !== 0)
              return true
            }
            return false
          }
          onAccepted: view.findNext(false)
          Keys.onEscapePressed: view.closeFind()
        }

        Button {
          id: previousButton
          anchors.verticalCenter: parent.verticalCenter
          text: "Previous"
          bordered: true
          onClicked: view.findNext(true)
        }

        Button {
          id: nextButton
          anchors.verticalCenter: parent.verticalCenter
          text: "Next"
          bordered: true
          onClicked: view.findNext(false)
        }

        Button {
          id: doneButton
          anchors.verticalCenter: parent.verticalCenter
          iconText: Icons.actionGlyph("close")
          tooltipText: "Close find"
          onClicked: view.closeFind()
        }
      }
    }

    Rectangle {
      id: editorPage
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: findBar.bottom
      anchors.bottom: statusBar.top
      anchors.margins: Style.space(12)
      color: Util.alpha(Color.foreground, 0.03)
      border.width: Math.max(1, Style.space(1))
      border.color: Util.alpha(Color.foreground, textArea.activeFocus ? 0.25 : 0.1)
      radius: Style.cornerRadius
      clip: true

      Flickable {
        id: flick
        anchors.fill: parent
        anchors.margins: Style.space(8)
        visible: view.ready
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        contentWidth: view.wrap ? width : Math.max(width, textArea.contentWidth + Style.space(12))
        contentHeight: Math.max(height, textArea.contentHeight + Style.space(12))

        ScrollBar.vertical: ScrollHandle {}
        ScrollBar.horizontal: ScrollHandle {}

        TextEdit {
          id: textArea
          objectName: "textEditorText"
          property var model: ""
          property var history: null
          property int historyDepth: 0
          property int savedDepth: 0
          property int revision: 0
          property string indentUnit: "    "
          property bool locked: !view.writable
          property var clipboardSource: view.service

          function lockedTouched() { view.say("This file is read only for you", true) }
          function pasteRefused() { view.say("Not pasted: it would make a line over 20,000 characters", true) }

          width: view.wrap ? flick.width : Math.max(flick.width, contentWidth + Style.space(12))
          readOnly: true
          selectByMouse: true
          selectByKeyboard: true
          persistentSelection: true
          textFormat: TextEdit.PlainText
          wrapMode: view.wrap ? TextEdit.Wrap : TextEdit.NoWrap
          color: Color.popups.text
          selectionColor: Util.alpha(Color.accent, 0.35)
          selectedTextColor: Color.popups.text
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
          tabStopDistance: Math.max(1, metrics.averageCharacterWidth * 4)

          Keys.onPressed: function (event) {
            if (view.handleKey(event)) event.accepted = true
          }
          onCursorRectangleChanged: {
            if (activeFocus) view.ensureVisible(cursorRectangle)
            positionTimer.restart()
          }

          Rectangle {
            id: caret
            objectName: "textEditorCaret"
            property bool lit: true
            visible: textArea.activeFocus && lit && textArea.selectionStart === textArea.selectionEnd
            x: textArea.cursorRectangle.x
            y: textArea.cursorRectangle.y
            width: Math.max(1, Style.space(2))
            height: textArea.cursorRectangle.height
            color: Color.accent

            Timer {
              interval: 530
              repeat: true
              running: textArea.activeFocus
              onTriggered: caret.lit = !caret.lit
              onRunningChanged: caret.lit = true
            }

            Connections {
              target: textArea
              function onCursorPositionChanged() { caret.lit = true }
            }
          }
        }
      }

      Text {
        textFormat: Text.PlainText
        objectName: "textEditorMessage"
        anchors.centerIn: parent
        width: parent.width - Style.space(40)
        visible: !view.ready
        horizontalAlignment: Text.AlignHCenter
        text: view.loading ? "Opening" : view.loadError
        color: view.loadError !== "" ? Color.urgent : Util.alpha(Color.popups.text, 0.6)
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        wrapMode: Text.Wrap
      }
    }

    Item {
      id: statusBar
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      anchors.leftMargin: Style.space(12)
      anchors.rightMargin: Style.space(12)
      height: Style.space(30)

      Text {
        textFormat: Text.PlainText
        objectName: "textEditorPosition"
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        visible: view.ready
        text: view.position + "   UTF-8" + (view.bom ? " with BOM" : "") + "   " + (view.crlf ? "Windows line endings" : "Unix line endings")
          + (view.writable ? "" : "   Read only")
        color: Util.alpha(Color.popups.text, 0.5)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }

      Text {
        textFormat: Text.PlainText
        objectName: "textEditorNotice"
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        text: view.notice
        color: view.noticeIsError ? Color.urgent : Util.alpha(Color.popups.text, 0.7)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
    }

    Rectangle {
      anchors.fill: parent
      visible: view.prompt !== ""
      color: Util.alpha(Color.popups.background, 0.75)
      radius: Style.cornerRadius

      MouseArea { anchors.fill: parent }

      Rectangle {
        objectName: "textEditorPrompt"
        anchors.centerIn: parent
        width: Math.min(parent.width - Style.space(40), Style.space(420))
        height: promptColumn.implicitHeight + Style.space(28)
        color: Color.popups.background
        border.width: Math.max(1, Style.space(1))
        border.color: Color.popups.border
        radius: Style.cornerRadius

        Column {
          id: promptColumn
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          anchors.margins: Style.space(14)
          spacing: Style.space(12)

          Text {
            textFormat: Text.PlainText
            objectName: "textEditorPromptText"
            width: parent.width
            text: view.prompt === "unsaved" ? "Save the changes to " + view.name + " before closing?"
              : (view.conflictDeleted ? view.name + " was deleted since you opened it. Save it again, or keep editing?"
                : view.name + " changed on disk since you opened it. Overwrite it with your version, or load the new one and lose your changes?")
            color: Color.popups.text
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.Wrap
          }

          Row {
            anchors.right: parent.right
            spacing: Style.space(8)

            Button {
              text: "Cancel"
              bordered: true
              onClicked: {
                view.prompt = ""
                view.closeAfterSave = false
                view.focusEditor()
              }
            }

            Button {
              objectName: "textEditorDiscard"
              visible: view.prompt === "unsaved" || (view.prompt === "conflict" && !view.conflictDeleted)
              text: view.prompt === "unsaved" ? "Don't save" : "Load theirs"
              bordered: true
              onClicked: {
                if (view.prompt === "unsaved") view.finishClose()
                else view.reload()
              }
            }

            Button {
              objectName: "textEditorConfirm"
              text: view.prompt === "unsaved" ? "Save" : (view.conflictDeleted ? "Save again" : "Overwrite")
              bordered: true
              selected: true
              onClicked: {
                var forced = view.prompt === "conflict"
                if (view.prompt === "unsaved") view.closeAfterSave = true
                view.prompt = ""
                view.save(forced)
              }
            }
          }
        }
      }
    }
  }
}

import QtQuick 6.11
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "../Model.js" as Model
import "../Icons.js" as Icons

Rectangle {
  id: view
  objectName: "duplicatesView"

  property var service: null
  property string home: ""
  property bool thumbnails: true
  property bool open: false
  property string target: ""
  property string root: ""
  property bool hidden: false
  property var groups: []
  property int groupIndex: 0
  property int rightIndex: 1
  property bool searching: false
  property string phase: ""
  property int scanned: 0
  property int compared: 0
  property int comparing: 0
  property string current: ""
  property bool truncated: false
  property string error: ""
  property string notice: ""
  property bool noticeIsError: false
  property int requestId: 0
  property int token: 0
  property bool trashing: false
  property var keepCandidate: null
  readonly property var group: groups.length > 0 ? groups[Math.max(0, Math.min(groupIndex, groups.length - 1))] : null
  readonly property var items: group ? group.items : []
  readonly property var leftItem: items.length > 0 ? items[0] : null
  readonly property var rightItem: items.length > 1 ? items[Math.max(1, Math.min(rightIndex, items.length - 1))] : null
  readonly property int extraCopies: {
    var n = 0
    for (var i = 0; i < groups.length; i++) n += groups[i].items.length - 1
    return n
  }
  readonly property real freeable: {
    var bytes = 0
    for (var i = 0; i < groups.length; i++) bytes += groups[i].size * (groups[i].items.length - 1)
    return bytes
  }

  signal closed()
  signal reveal(string path)
  signal openPath(string path)

  anchors.fill: parent
  visible: open
  color: Util.alpha(Color.background, 0.7)

  function start(file, folder, withHidden) {
    if (searching) stop()
    open = true
    target = String(file || "")
    root = String(folder)
    hidden = withHidden === true
    groups = []
    groupIndex = 0
    rightIndex = 1
    error = ""
    notice = ""
    truncated = false
    scanned = 0
    compared = 0
    comparing = 0
    current = root
    phase = "looking"
    keepCandidate = null
    searching = true
    if (!service) return
    var mine = ++token
    requestId = service.findDuplicates(root, target, hidden, function (m) {
      if (mine !== view.token) return
      view.phase = String(m.phase || "")
      view.scanned = Number(m.files) || 0
      view.compared = Number(m.done) || 0
      view.comparing = Number(m.total) || 0
      if (m.current) view.current = String(m.current)
    }, function (m) {
      if (mine !== view.token) return
      view.searching = false
      view.groups = m.groups || []
      view.scanned = Number(m.scanned) || view.scanned
      view.truncated = m.truncated === true
    }, function (m) {
      if (mine !== view.token) return
      view.searching = false
      if (m && m.code === "ECANCELED") return
      view.error = "Could not look for duplicates: " + String((m && m.message) || "unknown error")
    })
  }

  function stop() {
    if (!searching) return
    token++
    if (service && requestId) service.cancel(requestId)
    searching = false
    notice = "Stopped"
    noticeIsError = false
  }

  function close() {
    stop()
    open = false
    keepCandidate = null
    groups = []
    closed()
  }

  function rootChoices() {
    var out = []
    if (target === "") return [{ label: Model.collapseTilde(root, home), value: root }]
    var folder = Model.dirname(target)
    out.push({ label: "This folder and its subfolders", value: folder })
    if (home && folder !== home && Model.isWithin(target, home)) out.push({ label: "Your home folder", value: home })
    var known = false
    for (var i = 0; i < out.length; i++) if (out[i].value === root) known = true
    if (!known) out.push({ label: Model.collapseTilde(root, home), value: root })
    return out
  }

  function entryFor(item) {
    if (!item) return null
    return Model.decodeEntry([Model.basename(item.path), "f", item.size, item.mtime, 420, null], Model.dirname(item.path))
  }

  function title() {
    if (target !== "") return "Copies of " + Model.basename(target)
    return "Duplicates in " + (Model.basename(root) || root)
  }

  function subtitle() {
    if (error !== "") return error
    if (searching) {
      if (phase === "comparing" && comparing > 0)
        return "Comparing " + Model.formatCount(comparing, "file", "files") + " byte for byte, " + compared + " done"
      return "Looking through " + Model.formatCount(scanned, "file", "files") + " in " + Model.collapseTilde(current, home)
    }
    if (groups.length === 0) return (notice === "Stopped" ? "Stopped. " : "") + "No duplicates found in " + Model.collapseTilde(root, home)
    var line = target !== ""
      ? Model.formatCount(extraCopies, "other copy", "other copies") + " found"
      : Model.formatCount(groups.length, "file has", "files have") + " copies"
    line += ". Removing the extra copies would free " + Model.formatSize(freeable)
    if (truncated) line += ". Stopped early because the folder is very large"
    return line
  }

  function tagFor(item) {
    if (!group || items.length < 2) return ""
    var newest = true
    var oldest = true
    for (var i = 0; i < items.length; i++) {
      if (items[i].mtime > item.mtime) newest = false
      if (items[i].mtime < item.mtime) oldest = false
    }
    if (newest === oldest) return ""
    return newest ? "Newest" : "Oldest"
  }

  function without(paths) {
    var gone = ({})
    for (var p = 0; p < paths.length; p++) gone[paths[p]] = true
    var keptGroups = []
    for (var g = 0; g < groups.length; g++) {
      var keep = groups[g].items.filter(function (it) { return gone[it.path] !== true })
      if (keep.length > 1) keptGroups.push({ size: groups[g].size, items: keep })
    }
    var at = groupIndex
    groups = keptGroups
    groupIndex = Math.max(0, Math.min(at, groups.length - 1))
    rightIndex = Math.max(1, Math.min(rightIndex, items.length - 1))
  }

  function say(text, isError) {
    notice = text
    noticeIsError = isError === true
    noticeTimer.restart()
  }

  function itemFor(path) {
    for (var g = 0; g < groups.length; g++)
      for (var i = 0; i < groups[g].items.length; i++)
        if (groups[g].items[i].path === path) return groups[g].items[i]
    return null
  }

  function unchanged(found, item) {
    return found && !found.error && found.kind === "f" && item && Number(found.size) === Number(item.size)
      && Number(found.mtime) === Number(item.mtime)
      && (item.ino === undefined || (Number(found.inode) === Number(item.ino) && Number(found.dev) === Number(item.dev)))
  }

  function trashPaths(paths, done, keep) {
    if (!service || trashing || paths.length === 0) return
    trashing = true
    var check = keep ? paths.concat([keep]) : paths
    var mine = token
    service.statPaths(check, function (found) {
      if (mine !== view.token) {
        view.trashing = false
        return
      }
      for (var i = 0; i < found.length; i++) {
        if (!view.unchanged(found[i], view.itemFor(String(found[i].path)))) {
          view.trashing = false
          view.say(Model.basename(String(found[i].path)) + " changed since the search, so nothing was moved. Search again first", true)
          return
        }
      }
      view.moveToTrash(paths, done)
    })
  }

  function moveToTrash(paths, done) {
    service.trashPaths(paths, function (m) {
      view.trashing = false
      var results = (m && m.results) || []
      var moved = []
      var failed = []
      for (var i = 0; i < results.length; i++) {
        if (results[i].ok) moved.push(String(results[i].path || paths[i]))
        else failed.push(String(results[i].message || "could not be moved"))
      }
      if (results.length === 0) moved = paths
      view.without(moved)
      if (failed.length > 0) view.say("Could not move " + Model.formatCount(failed.length, "copy", "copies") + " to the trash: " + failed[0], true)
      else view.say(done || ("Moved " + Model.formatCount(moved.length, "copy", "copies") + " to the trash. Ctrl+Z after closing undoes this"), false)
    }, function (m) {
      view.trashing = false
      view.say("Could not move to the trash: " + String((m && m.message) || ""), true)
    })
  }

  function trashItem(item) {
    if (item) trashPaths([item.path], "Moved " + Model.basename(item.path) + " to the trash")
  }

  function askKeepOnly(item) {
    if (item) keepCandidate = item
  }

  function keepOnly() {
    var item = keepCandidate
    keepCandidate = null
    if (!item) return
    var others = items.filter(function (it) { return it.path !== item.path }).map(function (it) { return it.path })
    trashPaths(others, "Kept " + Model.basename(item.path) + " and moved " + Model.formatCount(others.length, "other copy", "other copies") + " to the trash", item.path)
  }

  function stepRight(delta) {
    if (items.length < 3) return
    var next = rightIndex + delta
    if (next < 1) next = items.length - 1
    if (next >= items.length) next = 1
    rightIndex = next
  }

  function stepGroup(delta) {
    if (groups.length < 2) return
    groupIndex = Math.max(0, Math.min(groups.length - 1, groupIndex + delta))
    rightIndex = 1
    groupList.positionViewAtIndex(groupIndex, ListView.Contain)
  }

  function handleKey(event) {
    if (keepCandidate) {
      if (event.key === Qt.Key_Escape) keepCandidate = null
      else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) keepOnly()
      return true
    }
    if (event.key === Qt.Key_Escape) { close(); return true }
    if (event.key === Qt.Key_Right) { stepRight(1); return true }
    if (event.key === Qt.Key_Left) { stepRight(-1); return true }
    if (event.key === Qt.Key_Down) { stepGroup(1); return true }
    if (event.key === Qt.Key_Up) { stepGroup(-1); return true }
    if (event.key === Qt.Key_Delete) { trashItem(rightItem); return true }
    return true
  }

  Component.onDestruction: stop()

  Timer {
    id: noticeTimer
    interval: 6000
    onTriggered: view.notice = ""
  }

  MouseArea {
    anchors.fill: parent
    acceptedButtons: Qt.LeftButton | Qt.RightButton
  }

  component CopyCard: Rectangle {
    id: cardRoot
    property var item: null
    property string side: ""
    readonly property var entry: view.entryFor(item)
    color: Util.alpha(Color.foreground, 0.04)
    border.width: Math.max(1, Style.space(1))
    border.color: Util.alpha(Color.foreground, 0.12)
    radius: Style.cornerRadius

    Column {
      anchors.fill: parent
      anchors.margins: Style.space(10)
      spacing: Style.space(6)

      Item {
        width: parent.width
        height: Math.max(Style.space(60), parent.height - details.height - actions.height - Style.space(12))

        ThumbImage {
          id: cardThumb
          anchors.fill: parent
          service: view.service
          active: view.open && cardRoot.entry !== null
          entry: active ? cardRoot.entry : null
          generated: active && view.thumbnails && view.service && view.service.thumbExts
            && view.service.thumbExts[cardRoot.entry.ext] === true
          requestSize: 512
          sourceSize.width: 512
          sourceSize.height: 512
        }

        Text {
          textFormat: Text.PlainText
          anchors.centerIn: parent
          visible: !cardThumb.visible
          text: Icons.glyphFor(cardRoot.entry)
          color: Util.alpha(Color.popups.text, 0.6)
          font.family: Style.font.family
          font.pixelSize: Style.font.displayLarge * 2
        }
      }

      Column {
        id: details
        width: parent.width
        spacing: Style.space(2)

        Row {
          width: parent.width
          spacing: Style.space(6)

          Text {
            textFormat: Text.PlainText
            width: Math.min(implicitWidth, parent.width - tag.width - Style.space(6))
            text: cardRoot.item ? Model.basename(cardRoot.item.path) : ""
            color: Color.popups.text
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            elide: Text.ElideMiddle
          }

          Text {
            id: tag
            textFormat: Text.PlainText
            anchors.verticalCenter: parent.verticalCenter
            text: cardRoot.item ? view.tagFor(cardRoot.item) : ""
            color: Color.accent
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          text: cardRoot.item ? Model.collapseTilde(Model.dirname(cardRoot.item.path), view.home) : ""
          color: Util.alpha(Color.popups.text, 0.6)
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          elide: Text.ElideMiddle
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          text: cardRoot.item ? Model.formatSize(cardRoot.item.size) + "   Modified " + Model.formatFullDate(cardRoot.item.mtime) : ""
          color: Util.alpha(Color.popups.text, 0.6)
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }

      Flow {
        id: actions
        width: parent.width
        spacing: Style.space(6)

        Button {
          text: "Open"
          bordered: true
          onClicked: if (cardRoot.item) view.openPath(cardRoot.item.path)
        }

        Button {
          text: "Show in folder"
          bordered: true
          onClicked: if (cardRoot.item) view.reveal(cardRoot.item.path)
        }

        Button {
          objectName: "duplicateTrash-" + cardRoot.side
          text: "Move to trash"
          bordered: true
          enabled: !view.trashing
          onClicked: view.trashItem(cardRoot.item)
        }

        Button {
          objectName: "duplicateKeep-" + cardRoot.side
          text: "Keep only this"
          bordered: true
          enabled: !view.trashing
          onClicked: view.askKeepOnly(cardRoot.item)
        }
      }
    }
  }

  Rectangle {
    id: card
    objectName: "duplicatesCard"
    anchors.centerIn: parent
    width: Math.max(Style.space(360), parent.width - Style.space(60))
    height: Math.max(Style.space(260), parent.height - Style.space(60))
    color: Color.popups.background
    border.width: Math.max(1, Style.space(1))
    border.color: Color.popups.border
    radius: Style.cornerRadius

    MouseArea { anchors.fill: parent }

    Item {
      id: header
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.margins: Style.space(12)
      height: Style.space(44)

      Column {
        anchors.left: parent.left
        anchors.right: headerButtons.left
        anchors.rightMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)

        Text {
          textFormat: Text.PlainText
          objectName: "duplicatesTitle"
          width: parent.width
          text: view.title()
          color: Color.popups.text
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          elide: Text.ElideMiddle
        }

        Text {
          textFormat: Text.PlainText
          objectName: "duplicatesSummary"
          width: parent.width
          text: view.subtitle()
          color: view.error !== "" ? Color.urgent : Util.alpha(Color.popups.text, 0.6)
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          elide: Text.ElideMiddle
        }
      }

      Row {
        id: headerButtons
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(6)

        Dropdown {
          objectName: "duplicatesRoot"
          width: Style.space(230)
          anchors.verticalCenter: parent.verticalCenter
          visible: view.target !== "" && view.rootChoices().length > 1
          showLabel: false
          value: view.root
          options: view.open ? view.rootChoices() : []
          onChanged: function (v) { if (v !== view.root) view.start(view.target, v, view.hidden) }
        }

        Button {
          objectName: "duplicatesHidden"
          anchors.verticalCenter: parent.verticalCenter
          text: "Hidden files"
          bordered: true
          selected: view.hidden
          onClicked: view.start(view.target, view.root, !view.hidden)
        }

        Button {
          anchors.verticalCenter: parent.verticalCenter
          visible: view.searching
          text: "Stop"
          bordered: true
          onClicked: view.stop()
        }

        Button {
          objectName: "duplicatesClose"
          anchors.verticalCenter: parent.verticalCenter
          iconText: Icons.actionGlyph("close")
          tooltipText: "Close"
          onClicked: view.close()
        }
      }
    }

    Item {
      id: body
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: header.bottom
      anchors.bottom: footer.top
      anchors.margins: Style.space(12)

      Text {
        textFormat: Text.PlainText
        anchors.centerIn: parent
        width: parent.width - Style.space(40)
        visible: view.groups.length === 0
        horizontalAlignment: Text.AlignHCenter
        text: view.searching ? "Looking for files with the same contents" : view.subtitle()
        color: view.error !== "" ? Color.urgent : Util.alpha(Color.popups.text, 0.6)
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        wrapMode: Text.Wrap
      }

      ListView {
        id: groupList
        objectName: "duplicateGroups"
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        width: view.groups.length > 1 ? Math.min(Style.space(280), parent.width * 0.32) : 0
        visible: view.groups.length > 1
        clip: true
        model: view.groups
        spacing: Style.space(2)

        ScrollBar.vertical: ScrollHandle {}

        delegate: Rectangle {
          required property var modelData
          required property int index
          width: groupList.width - Style.space(8)
          height: Style.space(44)
          radius: Style.cornerRadius
          color: index === view.groupIndex ? Util.alpha(Color.accent, 0.18)
            : (groupHover.hovered ? Util.alpha(Color.foreground, 0.08) : "transparent")

          HoverHandler { id: groupHover }

          Column {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.leftMargin: Style.space(8)
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: Model.basename(modelData.items[0].path)
              color: Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
              elide: Text.ElideMiddle
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: modelData.items.length + " copies, " + Model.formatSize(modelData.size) + " each"
              color: Util.alpha(Color.popups.text, 0.55)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }

          MouseArea {
            anchors.fill: parent
            onClicked: {
              view.groupIndex = index
              view.rightIndex = 1
            }
          }
        }
      }

      Item {
        id: compare
        anchors.left: groupList.right
        anchors.leftMargin: groupList.visible ? Style.space(12) : 0
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        visible: view.group !== null

        Row {
          id: cards
          width: parent.width
          height: Math.max(Style.space(200), parent.height - copyList.height - Style.space(10))
          spacing: Style.space(10)

          CopyCard {
            objectName: "duplicateLeft"
            side: "left"
            width: (cards.width - cards.spacing) / 2
            height: cards.height
            item: view.leftItem
          }

          CopyCard {
            objectName: "duplicateRight"
            side: "right"
            width: (cards.width - cards.spacing) / 2
            height: cards.height
            item: view.rightItem
          }
        }

        ListView {
          id: copyList
          objectName: "duplicateCopies"
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          height: Math.min(Style.space(150), Math.max(Style.space(30), count * Style.space(30)))
          clip: true
          model: view.items
          spacing: Style.space(1)

          ScrollBar.vertical: ScrollHandle {}

          delegate: Rectangle {
            required property var modelData
            required property int index
            width: copyList.width - Style.space(8)
            height: Style.space(28)
            radius: Style.cornerRadius
            color: index === view.rightIndex || index === 0 ? Util.alpha(Color.accent, index === 0 ? 0.08 : 0.18)
              : (copyHover.hovered ? Util.alpha(Color.foreground, 0.08) : "transparent")

            HoverHandler { id: copyHover }

            Text {
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.right: copyDate.left
              anchors.leftMargin: Style.space(8)
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              text: (index === 0 ? "Left   " : (index === view.rightIndex ? "Right  " : "       "))
                + Model.collapseTilde(modelData.path, view.home)
              color: Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              elide: Text.ElideMiddle
            }

            Text {
              id: copyDate
              textFormat: Text.PlainText
              anchors.right: parent.right
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              text: Model.formatFullDate(modelData.mtime)
              color: Util.alpha(Color.popups.text, 0.55)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }

            MouseArea {
              anchors.fill: parent
              onClicked: if (index > 0) view.rightIndex = index
            }
          }
        }
      }
    }

    Item {
      id: footer
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      anchors.leftMargin: Style.space(12)
      anchors.rightMargin: Style.space(12)
      height: Style.space(28)

      Text {
        textFormat: Text.PlainText
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        text: view.items.length > 2 ? "Left and Right arrows show the other copies. Delete moves the right one to the trash."
          : (view.group ? "Delete moves the right copy to the trash." : "")
        color: Util.alpha(Color.popups.text, 0.45)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }

      Text {
        textFormat: Text.PlainText
        objectName: "duplicatesNotice"
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        text: view.notice === "Stopped" ? "" : view.notice
        color: view.noticeIsError ? Color.urgent : Util.alpha(Color.popups.text, 0.7)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
    }

    Rectangle {
      anchors.fill: parent
      visible: view.keepCandidate !== null
      color: Util.alpha(Color.popups.background, 0.75)
      radius: Style.cornerRadius

      MouseArea { anchors.fill: parent }

      Rectangle {
        objectName: "duplicatesConfirm"
        anchors.centerIn: parent
        width: Math.min(parent.width - Style.space(40), Style.space(420))
        height: confirmColumn.implicitHeight + Style.space(28)
        color: Color.popups.background
        border.width: Math.max(1, Style.space(1))
        border.color: Color.popups.border
        radius: Style.cornerRadius

        Column {
          id: confirmColumn
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          anchors.margins: Style.space(14)
          spacing: Style.space(12)

          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: view.keepCandidate
              ? "Keep " + Model.collapseTilde(view.keepCandidate.path, view.home) + " and move the "
                + Model.formatCount(view.items.length - 1, "other copy", "other copies") + " to the trash?"
              : ""
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
              onClicked: view.keepCandidate = null
            }

            Button {
              objectName: "duplicatesConfirmKeep"
              text: "Move to trash"
              bordered: true
              selected: true
              onClicked: view.keepOnly()
            }
          }
        }
      }
    }
  }
}

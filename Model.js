var maxDisplayLength = 160

function boundedText(value) {
  value = String(value || "")
  if (value.length <= maxDisplayLength) return value
  var end = maxDisplayLength - 1
  // Do not cut an emoji or other astral character in half.
  var last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return value.slice(0, end) + "…"
}

function appId(window) {
  if (!window) return ""
  if (window.wayland && window.wayland.appId) return String(window.wayland.appId)
  var ipc = window.lastIpcObject || {}
  return String(ipc.class || ipc.initialClass || "")
}

function label(window) {
  return boundedText(window && window.title ? window.title : (appId(window) || "Untitled"))
}

function detail(window) {
  if (!window) return ""
  var value = appId(window)
  if (window.tab) value = (hostOf(window.tab.url) || window.tab.url || value) + (window.tab.active ? "" : " · tab")
  if (window.workspace) value += (value ? " · " : "") + "ws " + String(window.workspace.id)
  return boundedText(value)
}

// ListView rows must not retain compositor-owned QObjects after a window closes.
function windowSnapshot(window) {
  return {
    address: String(window.address || ""),
    title: String(window.title || ""),
    activated: !!window.activated,
    workspace: window.workspace ? { id: window.workspace.id } : null,
    lastIpcObject: { class: appId(window), focusHistoryID: historyRank(window) }
  }
}

function windowForAddress(values, address) {
  var key = addressKey(address)
  if (!key) return null
  for (var i = 0; i < values.length; i++)
    if (addressKey(values[i]) === key) return values[i]
  return null
}

function normalizedAppIdentity(value) {
  return String(value || "").toLowerCase().replace(/\.desktop$/, "").replace(/[^a-z0-9]/g, "")
}

// Window app IDs and .desktop IDs are not always identical (for example,
// "code" vs "visual-studio-code"). Prefer exact matches, then use a small,
// deterministic fuzzy match across the desktop ID, name, and icon name.
function desktopEntryForWindow(window, entries) {
  var needle = normalizedAppIdentity(appId(window))
  if (!needle) return null
  var values = entries && typeof entries.slice === "function" ? entries : []
  var best = null
  var bestScore = 0
  for (var i = 0; i < values.length; i++) {
    var entry = values[i]
    if (!entry) continue
    var id = normalizedAppIdentity(entry.id)
    var name = normalizedAppIdentity(entry.name)
    var icon = normalizedAppIdentity(entry.icon)
    var score = 0
    if (needle === id) score = 120
    else if (needle === name || needle === icon) score = 110
    else if (needle.length >= 4 && (id.indexOf(needle) >= 0 || name.indexOf(needle) >= 0 || icon.indexOf(needle) >= 0)) score = 80
    else if (id.length >= 4 && needle.indexOf(id) >= 0) score = 70
    if (score > bestScore) {
      bestScore = score
      best = entry
    }
  }
  return best
}

// Hyprland's focusHistoryID is a rank in the compositor's global focus-history
// list: 0 = currently focused, 1 = most recent before that, ascending = older.
// Transient/popup windows not meaningfully in that history can report null or
// an empty string. Number(null) === 0 and Number("") === 0, so we must guard
// before coercion — otherwise such windows are ranked 0 (treated as current)
// and surface above genuinely recent ones.
function historyRank(window) {
  var ipc = window && window.lastIpcObject ? window.lastIpcObject : {}
  var raw = ipc.focusHistoryID
  if (raw === null || raw === undefined) return 1000000
  // "" and " " both coerce to 0; discard empty/whitespace values (transient
  // windows not meaningfully in the focus history).
  if (typeof raw !== "number" && String(raw).trim() === "") return 1000000
  var rank = Number(raw)
  return isFinite(rank) && rank >= 0 ? rank : 1000000
}

// Addresses arrive as "0x55..." on toplevels but bare "55..." in the
// activewindowv2 event payload; normalise before comparing.
function normalizeAddress(raw) {
  var key = addressKey(raw)
  return key ? "0x" + key : ""
}

function isCurrent(window) {
  return !!(window && window.activated) || historyRank(window) === 0
}

function focusRank(window) {
  return isCurrent(window) ? -1 : historyRank(window)
}

function addressKey(value) {
  var raw = value && typeof value === "object" ? value.address : value
  if (raw === null || raw === undefined) return ""
  var key = String(raw).trim().toLowerCase().replace(/^0x/, "")
  return /^[0-9a-f]+$/.test(key) ? key : ""
}

function promoteAddress(values, address) {
  var key = addressKey(address)
  var source = values && typeof values.slice === "function" ? values : []
  if (!key) return source.slice()
  var result = [key]
  for (var i = 0; i < source.length; i++) {
    var candidate = addressKey(source[i])
    if (candidate && candidate !== key) result.push(candidate)
  }
  return result
}

function addressesByHistory(clients) {
  var source = clients && typeof clients.slice === "function" ? clients.slice() : []
  source.sort(function(left, right) {
    return historyRank({ lastIpcObject: left }) - historyRank({ lastIpcObject: right })
  })
  var result = []
  for (var i = 0; i < source.length; i++) {
    var key = addressKey(source[i])
    if (key && result.indexOf(key) === -1) result.push(key)
  }
  return result
}

// Quickshell creates a toplevel for any title/focus/urgent event naming an
// unknown address and only drops it on `closewindow`, so windows that never
// got `openwindow` (or events racing a close) linger as workspace-less ghosts.
// Every window Hyprland actually manages has a workspace.
function managedWindows(values) {
  var source = values && typeof values.filter === "function" ? values : []
  return source.filter(function(window) { return !!(window && window.workspace) })
}

// Accept a caller-supplied rank function or authoritative MRU addresses.
function sortedWindows(values, rankFn) {
  var source = values && typeof values.slice === "function" ? values.slice() : []
  var mru = {}
  var order = rankFn && typeof rankFn.slice === "function" ? rankFn : []
  for (var m = 0; m < order.length; m++) mru[addressKey(order[m])] = m
  var decorated = []
  for (var i = 0; i < source.length; i++) {
    var key = addressKey(source[i])
    var rank = typeof rankFn === "function" ? rankFn(source[i]) :
      (key && mru[key] !== undefined ? mru[key] : 1000000 + focusRank(source[i]))
    decorated.push({ value: source[i], index: i, rank: rank })
  }
  decorated.sort(function(left, right) {
    return left.rank - right.rank || left.index - right.index
  })
  var result = []
  for (var j = 0; j < decorated.length; j++) result.push(decorated[j].value)
  return result
}

// --- Browser tabs -----------------------------------------------------------
// The OmaSwitch Tabs extension (browser-bridge/) reports, per browser window,
// its most recently used tabs. A browser window row is replaced by one row per
// tab, and every row is ordered by when it was last in use, so tabs and other
// windows interleave the way Edge's Alt+Tab does on Windows.

// Entries per browser (Edge, Chrome, ...), summed over all its windows and
// profiles: every window still shows once (its visible tab), and the most
// recent background tabs fill the rest of the quota.
var tabsPerBrowser = 5

// Hyprland class -> `browser` value the extension reports. PWAs use other
// classes (msedge-*, chrome-*) and stay plain windows.
function browserKind(window) {
  var id = appId(window).toLowerCase()
  if (id === "microsoft-edge" || id === "microsoft-edge-beta" || id === "microsoft-edge-dev") return "edge"
  if (id === "google-chrome" || id === "google-chrome-beta" || id === "google-chrome-unstable") return "chrome"
  if (id === "chromium" || id === "brave-browser") return "chromium"
  return ""
}

function isTabRow(row) {
  return !!(row && row.tab)
}

// Rows for tabs that are not the window's visible tab: the window preview and
// its OCR text show a different page, so only their own title/URL can match.
function isHiddenTab(row) {
  return isTabRow(row) && !row.tab.active
}

function hostOf(url) {
  var match = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#]+)/i.exec(String(url || ""))
  return match ? match[1].replace(/^www\./, "") : ""
}

function titleMatches(windowTitle, tabTitle) {
  var w = String(windowTitle || ""), t = String(tabTitle || "")
  if (!t) return 0
  if (w === t) return 2
  return w.indexOf(t + " - ") === 0 ? 1 : 0
}

// Focus events of the same window seen by Hyprland and by the extension land
// within this many ms of each other.
var focusMatchWindow = 3000

// Pair each Hyprland browser window with one of the extension's windows:
// 1. active tab title == toplevel title (Edge) or a prefix of it followed by
//    " - " (Chrome, Edge profiles: "<tab> - Personal - Microsoft Edge");
// 2. windows the user named (title is the name, not the tab) by matching the
//    time each one last gained focus in Hyprland and in the browser;
// 3. if one window and one candidate of a browser remain, they belong together.
// Each extension window is used once.
function matchBrowserWindows(rows, snapshots, windowFocusedAt) {
  var candidates = []
  var source = snapshots && typeof snapshots.slice === "function" ? snapshots : []
  for (var s = 0; s < source.length; s++) {
    var snap = source[s] || {}
    var windows = snap.windows && typeof snap.windows.slice === "function" ? snap.windows : []
    for (var w = 0; w < windows.length; w++) {
      var tabs = windows[w] && windows[w].tabs && typeof windows[w].tabs.slice === "function" ? windows[w].tabs : []
      var active = null
      for (var t = 0; t < tabs.length; t++) if (tabs[t] && tabs[t].active) active = tabs[t]
      if (active) candidates.push({ browser: String(snap.browser || ""), cmd: String(snap.cmd || ""), tabs: tabs, active: active,
        focusedAt: Number(windows[w].focusedAt) || 0, used: false })
    }
  }
  var result = {}
  for (var pass = 2; pass >= 1; pass--) {
    for (var i = 0; i < rows.length; i++) {
      var key = addressKey(rows[i])
      var kind = browserKind(rows[i])
      if (!kind || !key || result[key]) continue
      for (var c = 0; c < candidates.length; c++) {
        var cand = candidates[c]
        if (cand.used || cand.browser !== kind) continue
        if (titleMatches(rows[i].title, cand.active.title) !== pass) continue
        cand.used = true
        result[key] = cand
        break
      }
    }
  }

  var focusedAt = windowFocusedAt || {}
  var pairs = []
  for (var r = 0; r < rows.length; r++) {
    var rowKey = addressKey(rows[r])
    var rowKind = browserKind(rows[r])
    var seen = rowKey ? Number(focusedAt[rowKey]) || 0 : 0
    if (!rowKind || !rowKey || result[rowKey] || !seen) continue
    for (var k = 0; k < candidates.length; k++) {
      var other = candidates[k]
      if (other.used || other.browser !== rowKind || !other.focusedAt) continue
      var gap = Math.abs(other.focusedAt - seen)
      if (gap <= focusMatchWindow) pairs.push({ key: rowKey, cand: other, gap: gap })
    }
  }
  pairs.sort(function(left, right) { return left.gap - right.gap })
  for (var p = 0; p < pairs.length; p++) {
    if (result[pairs[p].key] || pairs[p].cand.used) continue
    pairs[p].cand.used = true
    result[pairs[p].key] = pairs[p].cand
  }

  var leftRows = {}, leftCands = {}
  for (var lr = 0; lr < rows.length; lr++) {
    var lk = addressKey(rows[lr]), lb = browserKind(rows[lr])
    if (lb && lk && !result[lk]) (leftRows[lb] = leftRows[lb] || []).push(lk)
  }
  for (var lc = 0; lc < candidates.length; lc++)
    if (!candidates[lc].used) (leftCands[candidates[lc].browser] = leftCands[candidates[lc].browser] || []).push(candidates[lc])
  for (var b in leftRows) {
    if (leftRows[b].length === 1 && leftCands[b] && leftCands[b].length === 1) {
      leftCands[b][0].used = true
      result[leftRows[b][0]] = leftCands[b][0]
    }
  }
  return result
}

// rows: window snapshots in MRU order (rows[0] focused).
// windowUsedAt: addressKey -> ms when that window last lost focus.
// limit: entries per browser (see tabsPerBrowser).
// windowFocusedAt: addressKey -> ms when that window last gained focus.
// Returns rows ordered by last use, browser windows expanded into tab rows.
function expandBrowserTabs(rows, snapshots, windowUsedAt, limit, windowFocusedAt) {
  var source = rows && typeof rows.slice === "function" ? rows : []
  var usedAt = windowUsedAt || {}
  var perBrowser = limit > 0 ? limit : tabsPerBrowser
  var hidden = {}
  var windowsByBrowser = {}
  var matches = matchBrowserWindows(source, snapshots, windowFocusedAt)
  // Windows with no recorded focus time (focused before the shell started)
  // are older than anything recorded; their background tabs then stay
  // grouped right below them instead of sinking to the end of the list.
  var oldest = Infinity
  for (var uk in usedAt) if (typeof usedAt[uk] === "number") oldest = Math.min(oldest, usedAt[uk])
  for (var mk in matches)
    for (var mt = 0; mt < matches[mk].tabs.length; mt++) {
      var seen = Number(matches[mk].tabs[mt] && matches[mk].tabs[mt].usedAt)
      if (seen > 0) oldest = Math.min(oldest, seen)
    }
  if (!isFinite(oldest)) oldest = 1e15
  var items = []
  var previous = Infinity
  for (var i = 0; i < source.length; i++) {
    var row = source[i]
    var key = addressKey(row)
    var time
    if (i === 0 && isCurrent(row)) time = Infinity
    else if (key && typeof usedAt[key] === "number") time = usedAt[key]
    else time = Math.min(previous, oldest) - 1
    // Keep the compositor's MRU order authoritative between windows.
    if (time >= previous) time = previous - 1
    previous = time

    var match = key ? matches[key] : null
    if (!match) {
      items.push({ row: row, time: time, order: items.length })
      continue
    }
    windowsByBrowser[match.browser] = (windowsByBrowser[match.browser] || 0) + 1
    if (!hidden[match.browser]) hidden[match.browser] = []
    for (var t = 0; t < match.tabs.length; t++) {
      var tab = match.tabs[t]
      if (!tab || typeof tab.id !== "number") continue
      var item = {
        row: Object.assign({}, row, {
          title: String(tab.title || ""),
          tab: { id: tab.id, active: !!tab.active, url: String(tab.url || ""), cmd: match.cmd, browser: match.browser }
        }),
        time: tab.active ? time : Math.min(Number(tab.usedAt) || 0, time - 0.5),
        order: items.length + hidden[match.browser].length / 1000
      }
      if (tab.active) items.push(item)
      else hidden[match.browser].push(item)
    }
  }
  for (var browser in hidden) {
    var room = Math.max(0, perBrowser - windowsByBrowser[browser])
    hidden[browser].sort(function(left, right) { return right.time - left.time })
    items = items.concat(hidden[browser].slice(0, room))
  }
  items.sort(function(left, right) {
    if (left.time !== right.time) return left.time > right.time ? -1 : 1
    return left.order - right.order
  })
  return items.map(function(item) { return item.row })
}

// Tab-id write to the host FIFO; the path must be the host's own file.
function tabActivateCommand(row, runtimeDir) {
  if (!isTabRow(row) || row.tab.active) return null
  var dir = String(runtimeDir || "")
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(dir) || /(^|\/)\.\.(\/|$)/.test(dir)) return null
  var cmd = String(row.tab.cmd || "")
  var prefix = dir.replace(/\/$/, "") + "/omaswitch-tabs/"
  if (cmd.indexOf(prefix) !== 0 || !/^[a-z]+-[0-9]+\.cmd$/.test(cmd.slice(prefix.length))) return null
  if (!(Number.isInteger(row.tab.id) && row.tab.id >= 0)) return null
  return ["timeout", "1", "sh", "-c", "printf '%s\\n' \"$1\" > \"$2\"", "sh", String(row.tab.id), cmd]
}

function rowKey(row) {
  return addressKey(row) + (isTabRow(row) ? "#" + row.tab.id : "")
}

function filteredWindows(values, query, ocrTextByAddress) {
  var q = String(query || "").trim().toLowerCase()
  if (!q) return values.slice()
  return values.filter(function(window) {
    if (metadataMatches(window, q)) return true
    return !isHiddenTab(window) && ocrText(ocrTextByAddress, window).toLowerCase().indexOf(q) !== -1
  })
}

function metadataMatches(window, q) {
  var metadata = String(window && window.title || "") + " " + appId(window)
  if (isTabRow(window)) metadata += " " + window.tab.url
  if (window && window.workspace) metadata += " ws " + String(window.workspace.id)
  return metadata.toLowerCase().indexOf(q) !== -1
}

function ocrEntry(ocrByAddress, window) {
  var key = addressKey(window)
  return key && ocrByAddress ? ocrByAddress[key] : null
}

function ocrText(ocrByAddress, window) {
  var entry = ocrEntry(ocrByAddress, window)
  return entry ? String(typeof entry === "string" ? entry : entry.text || "") : ""
}

// Parse `tesseract ... tsv`: Tesseract's page layout analysis groups words into
// block/paragraph/line; boxes are normalised to 0..1 of the captured image.
function parseOcrTsv(tsv) {
  var rows = String(tsv || "").split("\n")
  var pageW = 0, pageH = 0, words = 0
  var lines = {}, order = []
  for (var i = 1; i < rows.length && words < 4000; i++) {
    var c = rows[i].split("	")
    if (c.length < 12) continue
    var level = Number(c[0])
    if (level === 1) { pageW = Number(c[8]); pageH = Number(c[9]); continue }
    var word = c.slice(11).join("\t").trim()
    if (level !== 5 || !word || !(pageW > 0) || !(pageH > 0)) continue
    var id = c[2] + "." + c[3] + "." + c[4]
    if (!lines[id]) { lines[id] = []; order.push(id) }
    lines[id].push({ text: word, x: Number(c[6]) / pageW, y: Number(c[7]) / pageH,
                     w: Number(c[8]) / pageW, h: Number(c[9]) / pageH })
    words++
  }
  var result = order.map(function(id) { return lines[id] })
  var text = result.map(function(line) {
    return line.map(function(w) { return w.text }).join(" ")
  }).join("\n")
  return { text: text.slice(0, 12000), lines: result }
}

// Boxes for OCR-only matches; metadata matches already explain themselves.
function ocrHighlights(window, query, ocrByAddress) {
  var q = String(query || "").trim().toLowerCase()
  var entry = ocrEntry(ocrByAddress, window)
  if (!q || !entry || !entry.lines || isHiddenTab(window) || metadataMatches(window, q)) return []
  var boxes = []
  for (var i = 0; i < entry.lines.length && boxes.length < 24; i++) {
    // Lowercase per word before measuring spans: toLowerCase() can change
    // length (for example "İ" becomes two code units), which would shift
    // every later span away from the match index.
    var line = entry.lines[i], lower = "", spans = []
    for (var j = 0; j < line.length; j++) {
      if (j) lower += " "
      var word = line[j].text.toLowerCase()
      spans.push({ start: lower.length, end: lower.length + word.length })
      lower += word
    }
    for (var at = lower.indexOf(q); at !== -1 && boxes.length < 24; at = lower.indexOf(q, at + q.length)) {
      var x1 = 1, y1 = 1, x2 = 0, y2 = 0
      for (var k = 0; k < line.length; k++) {
        if (spans[k].end <= at || spans[k].start >= at + q.length) continue
        x1 = Math.min(x1, line[k].x); y1 = Math.min(y1, line[k].y)
        x2 = Math.max(x2, line[k].x + line[k].w); y2 = Math.max(y2, line[k].y + line[k].h)
      }
      if (x2 > x1 && y2 > y1) boxes.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 })
    }
  }
  return boxes
}

// Build the shell command that focuses a window AND moves to its workspace.
// Native toplevel activate does not always switch the visible workspace, so
// the switch is requested explicitly: prefer Omarchy's Lua dispatcher form
// (hl.dsp.focus), fall back to the plain focuswindow syntax for stock
// Hyprland. Lua hl.dsp.focus does not raise, so a floating window could gain
// focus while staying behind others; raise it as a click would.
// Returns null when the compositor has not reported an address yet.
function focusCommand(window) {
  var address = normalizeAddress(window && window.address)
  if (!address) return null
  var selector = "window = 'address:" + address + "'"
  return "if hyprctl dispatch \"hl.dsp.focus({ " + selector + " })\" >/dev/null 2>&1; then " +
    "hyprctl dispatch \"hl.dsp.window.alter_zorder({ mode = 'top', " + selector + " })\"; " +
    "else hyprctl dispatch focuswindow \"address:" + address + "\"; fi"
}

if (typeof module !== "undefined") module.exports = {
  appId: appId,
  label: label,
  detail: detail,
  windowSnapshot: windowSnapshot,
  windowForAddress: windowForAddress,
  normalizedAppIdentity: normalizedAppIdentity,
  desktopEntryForWindow: desktopEntryForWindow,
  parseOcrTsv: parseOcrTsv,
  ocrHighlights: ocrHighlights,
  addressKey: addressKey,
  promoteAddress: promoteAddress,
  addressesByHistory: addressesByHistory,
  isCurrent: isCurrent,
  historyRank: historyRank,
  normalizeAddress: normalizeAddress,
  managedWindows: managedWindows,
  sortedWindows: sortedWindows,
  filteredWindows: filteredWindows,
  focusCommand: focusCommand,
  browserKind: browserKind,
  isTabRow: isTabRow,
  hostOf: hostOf,
  matchBrowserWindows: matchBrowserWindows,
  expandBrowserTabs: expandBrowserTabs,
  tabActivateCommand: tabActivateCommand,
  rowKey: rowKey
}

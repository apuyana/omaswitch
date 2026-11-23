// OmaSwitch Tabs: keeps a "last used" time per tab and streams the most
// recently used tabs of every normal browser window to the native host
// (browser-bridge/omaswitch-tab-host), which hands them to the switcher.
// The host sends back {activate: tabId} when a tab is picked in Alt+Tab.
//
// Thumbnails: a background tab cannot be screenshotted, so each tab is
// captured while it is the visible one (on activation, page load and window
// focus) and the image is kept by the host for the switcher's preview.

const HOST = "com.apuyana.omaswitch_tabs"
const TABS_PER_WINDOW = 5
const MAX_TITLE = 300

// tabId -> ms when the tab stopped being the active tab of its window.
// The active tab of each window is "in use" and carries no time here.
let usedAt = {}
let activeByWindow = {}
// windowId -> ms when the window last gained focus. The switcher pairs it with
// Hyprland's focus events for windows whose title is not the tab title
// (windows given a custom name in the browser).
let focusedAt = {}
let port = null
let sendTimer = null
let reconnectDelay = 1000
const THUMB_WIDTH = 1280
const CAPTURE_DELAY = 700
const CAPTURE_GAP = 600 // captureVisibleTab allows ~2 calls per second
let captureTimers = {}
let lastCapture = 0

const brand = (() => {
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || []
  const names = brands.map((b) => b.brand)
  if (names.some((n) => /edge/i.test(n))) return "edge"
  if (names.some((n) => /chrome/i.test(n))) return "chrome"
  return "chromium"
})()

async function restore() {
  try {
    const saved = await chrome.storage.session.get(["usedAt", "activeByWindow", "focusedAt"])
    usedAt = saved.usedAt || {}
    activeByWindow = saved.activeByWindow || {}
    focusedAt = saved.focusedAt || {}
  } catch (e) {}
}

function persist() {
  chrome.storage.session.set({ usedAt, activeByWindow, focusedAt }).catch(() => {})
}

function markActive(windowId, tabId) {
  const previous = activeByWindow[windowId]
  if (previous !== undefined && previous !== tabId) usedAt[previous] = Date.now()
  activeByWindow[windowId] = tabId
  delete usedAt[tabId]
  persist()
}

async function snapshot() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] })
  return {
    browser: brand,
    updated: Date.now(),
    windows: windows.map((w) => {
      const tabs = w.tabs.map((t) => ({
        id: t.id,
        active: !!t.active,
        title: String(t.title || t.url || "").slice(0, MAX_TITLE),
        url: String(t.url || "").slice(0, 2048),
        // Fallback for tabs never deactivated while we were running.
        usedAt: t.active ? null : (usedAt[t.id] || t.lastAccessed || 0)
      }))
      tabs.sort((a, b) => (b.active - a.active) || (b.usedAt - a.usedAt))
      return { id: w.id, focused: !!w.focused, focusedAt: focusedAt[w.id] || 0, incognito: !!w.incognito, tabs: tabs.slice(0, TABS_PER_WINDOW) }
    }).filter((w) => !w.incognito)
  }
}

function scheduleSend() {
  if (sendTimer) clearTimeout(sendTimer)
  sendTimer = setTimeout(async () => {
    sendTimer = null
    if (!port) return
    try { port.postMessage(await snapshot()) } catch (e) {}
  }, 150)
}

function scheduleCapture(windowId, delay) {
  if (windowId === undefined || windowId === chrome.windows.WINDOW_ID_NONE) return
  clearTimeout(captureTimers[windowId])
  captureTimers[windowId] = setTimeout(() => {
    delete captureTimers[windowId]
    capture(windowId)
  }, delay === undefined ? CAPTURE_DELAY : delay)
}

async function capture(windowId) {
  if (!port) return
  const wait = lastCapture + CAPTURE_GAP - Date.now()
  if (wait > 0) return scheduleCapture(windowId, wait)
  lastCapture = Date.now()
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId })
    if (!tab || tab.incognito || tab.status !== "complete") return
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 70 })
    // The capture is of whatever is visible now; drop it if the tab changed.
    const [still] = await chrome.tabs.query({ active: true, windowId })
    if (!still || still.id !== tab.id) return
    const data = await shrink(dataUrl)
    if (port && data) port.postMessage({ browser: brand, thumb: { tabId: tab.id, data } })
  } catch (e) {
    // Restricted pages (edge://, the store, PDFs) cannot be captured.
  }
}

async function shrink(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, THUMB_WIDTH / bitmap.width)
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 })
  const bytes = new Uint8Array(await out.arrayBuffer())
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

async function activate(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true })
    await chrome.windows.update(tab.windowId, { focused: true })
  } catch (e) {}
}

function connect() {
  try {
    port = chrome.runtime.connectNative(HOST)
  } catch (e) {
    port = null
    setTimeout(connect, reconnectDelay)
    return
  }
  port.onMessage.addListener((message) => {
    reconnectDelay = 1000
    if (message && Number.isInteger(message.activate)) activate(message.activate)
  })
  port.onDisconnect.addListener(() => {
    port = null
    // Host missing or crashed: back off so a missing install stays quiet.
    setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 60000)
  })
  scheduleSend()
  chrome.windows.getAll({ windowTypes: ["normal"] }).then((ws) => ws.forEach((w) => scheduleCapture(w.id)))
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => { markActive(windowId, tabId); scheduleSend(); scheduleCapture(windowId) })
chrome.tabs.onRemoved.addListener((tabId, info) => {
  delete usedAt[tabId]
  if (port) port.postMessage({ browser: brand, forget: tabId })
  if (activeByWindow[info.windowId] === tabId) delete activeByWindow[info.windowId]
  persist()
  scheduleSend()
})
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.title || change.url) scheduleSend()
  if (change.status === "complete" && tab.active) scheduleCapture(tab.windowId)
})
chrome.tabs.onCreated.addListener(scheduleSend)
chrome.tabs.onAttached.addListener(scheduleSend)
chrome.tabs.onDetached.addListener(scheduleSend)
chrome.windows.onRemoved.addListener((windowId) => {
  delete activeByWindow[windowId]
  delete focusedAt[windowId]
  persist()
  scheduleSend()
})
chrome.windows.onCreated.addListener(scheduleSend)
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    focusedAt[windowId] = Date.now()
    persist()
    scheduleCapture(windowId)
  }
  scheduleSend()
})

restore().then(async () => {
  const active = await chrome.tabs.query({ active: true })
  for (const t of active) if (activeByWindow[t.windowId] === undefined) activeByWindow[t.windowId] = t.id
  connect()
})

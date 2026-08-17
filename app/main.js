"use strict";
/* ══════════════ BabyBump 主进程 ══════════════ */
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, Notification, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const os = require("os");

// 调试支持：BB_DEBUG_PORT=9222 npx electron .（必须在 ready 前设置）
const dbgPort = process.env.BB_DEBUG_PORT;
if (dbgPort) {
  app.commandLine.appendSwitch("remote-debugging-port", dbgPort);
  app.commandLine.appendSwitch("remote-allow-origins", "*");
}

const DATA_FILE = () => path.join(app.getPath("userData"), "babybump-data.json");
const DEFAULT_STATE = { records: [], settings: {} };

let mainWindow = null;
let tray = null;
let miniWindow = null;
let isQuitting = false;
let miniPosSaveTimer = null;

/* ── 数据持久化（JSON 文件，替代 localStorage） ── */
function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE(), "utf-8");
    const s = JSON.parse(raw);
    if (!s.records || !Array.isArray(s.records)) throw new Error("bad shape");
    if (!s.settings || typeof s.settings !== "object") s.settings = {};
    return s;
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}
function saveState(s) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE()), { recursive: true });
    fs.writeFileSync(DATA_FILE(), JSON.stringify(s));
    return true;
  } catch (e) {
    console.error("saveState failed:", e);
    return false;
  }
}

/* ── i18n 国际化 ── */
const LOCALES_DIR = path.join(__dirname, "locales");
let currentLocale = null;

function loadLocale(lang) {
  const file = path.join(LOCALES_DIR, `${lang}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    return null;
  }
}

function getLocale() {
  if (currentLocale) return currentLocale;
  const settings = loadState().settings;
  const lang = settings.lang || app.getLocale().split("-")[0] || "zh";
  currentLocale = loadLocale(lang) || loadLocale("zh") || {};
  return currentLocale;
}

function t(key, params = {}) {
  const locale = getLocale();
  const keys = key.split(".");
  let value = locale;
  for (const k of keys) {
    if (value && typeof value === "object") value = value[k];
    else { value = undefined; break; }
  }
  if (value === undefined) return key;
  if (typeof value !== "string") return key;
  // 插值替换 {key}
  return value.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`);
}

function setLocale(lang) {
  currentLocale = loadLocale(lang) || loadLocale("zh") || {};
  const state = loadState();
  state.settings.lang = lang;
  saveState(state);
  // 重建托盘菜单
  if (tray) tray.setContextMenu(buildTrayMenu());
  // 通知渲染进程语言已变更
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("locale:changed", { lang, locale: currentLocale });
  }
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.webContents.send("locale:changed", { lang, locale: currentLocale });
  }
}

function getAvailableLocales() {
  try {
    const files = fs.readdirSync(LOCALES_DIR);
    return files.filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));
  } catch (e) {
    return ["zh", "en"];
  }
}

/* ── 手机端 PWA 同步服务：仅局域网可访问，使用持久化配对令牌 ── */
const SYNC_PORT = 18765;
let syncServer = null;
function syncToken() {
  const crypto = require("crypto");
  const state = loadState();
  if (!state.settings.syncToken) {
    state.settings.syncToken = crypto.randomBytes(18).toString("hex");
    saveState(state);
  }
  return state.settings.syncToken;
}
function lanAddress() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}
function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-BabyBump-Token", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
  res.end(data);
}
function mergeSyncState(incoming) {
  const current = loadState();
  const byId = new Map(current.records.map(r => [String(r.id), r]));
  for (const record of Array.isArray(incoming.records) ? incoming.records : []) {
    if (record && record.id != null && !byId.has(String(record.id))) byId.set(String(record.id), record);
  }
  current.records = [...byId.values()].sort((a, b) => a.ts - b.ts);
  if (incoming.settings && typeof incoming.settings === "object") {
    const localOnly = ["syncToken", "windowBounds", "miniPos", "mode"];
    for (const [key, value] of Object.entries(incoming.settings)) {
      if (!localOnly.includes(key)) current.settings[key] = value;
    }
  }
  saveState(current);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("sync:changed", current);
  return current;
}
function syncPayload(state) {
  const settings = { ...(state.settings || {}) };
  for (const key of ["syncToken", "windowBounds", "miniPos", "mode"]) delete settings[key];
  return { records: Array.isArray(state.records) ? state.records : [], settings };
}
function startSyncServer() {
  syncServer = http.createServer((req, res) => {
    if (req.method === "OPTIONS") return jsonResponse(res, 204, {});
    const token = req.headers["x-babybump-token"] || new URL(req.url, `http://${req.headers.host}`).searchParams.get("token");
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/info" && req.method === "GET") return jsonResponse(res, 200, syncInfo());
      if (url.pathname.startsWith("/api/locale/") && req.method === "GET") {
        const lang = url.pathname.split("/")[3] || "zh";
        const locale = loadLocale(lang) || loadLocale("zh") || {};
        return jsonResponse(res, 200, locale);
      }
      if (token !== syncToken()) return jsonResponse(res, 401, { error: "配对码无效" });
      if (url.pathname === "/api/state" && req.method === "GET") return jsonResponse(res, 200, syncPayload(loadState()));
      if (url.pathname === "/api/state" && req.method === "POST") {
        let raw = "";
        req.on("data", chunk => { raw += chunk; });
        req.on("end", () => {
          try { jsonResponse(res, 200, syncPayload(mergeSyncState(JSON.parse(raw)))); }
          catch (e) { jsonResponse(res, 400, { error: "数据格式无效" }); }
        });
        return;
      }
      return jsonResponse(res, 404, { error: "接口不存在" });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const file = path.join(__dirname, "pwa", "index.html");
      return fs.createReadStream(file).on("error", () => jsonResponse(res, 404, { error: "PWA 不存在" })).pipe(res);
    }
    const safe = path.normalize(url.pathname).replace(/^([.][.][/\\])+/, "");
    const file = path.join(__dirname, "pwa", safe);
    if (!file.startsWith(path.join(__dirname, "pwa"))) return jsonResponse(res, 403, { error: "禁止访问" });
    fs.createReadStream(file).on("error", () => jsonResponse(res, 404, { error: "文件不存在" })).pipe(res);
  });
  syncServer.listen(SYNC_PORT, "0.0.0.0", () => console.log(`PWA sync server: http://${lanAddress()}:${SYNC_PORT}/`));
}
function syncInfo() {
  const token = syncToken();
  const host = lanAddress();
  return { url: `http://${host}:${SYNC_PORT}/?token=${token}`, token, port: SYNC_PORT, host };
}

/* ── 窗口 ── */
let winBoundsSaveTimer = null;

function createWindow() {
  const saved = loadState().settings.windowBounds;
  const opts = {
    width: saved && saved.width >= 860 ? saved.width : 1120,
    height: saved && saved.height >= 620 ? saved.height : 780,
    minWidth: 860,
    minHeight: 620,
    title: "BabyBump · 胎动记录",
    icon: path.join(__dirname, "assets", "icon.png"),
    backgroundColor: "#FAF7F2",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  };
  // 恢复位置（需在当前屏幕可见范围内）
  if (saved && typeof saved.x === "number" && typeof saved.y === "number") {
    const onScreen = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return saved.x < a.x + a.width - 80 && saved.y < a.y + a.height - 60 &&
             saved.x + 80 > a.x && saved.y + 40 > a.y;
    });
    if (onScreen) {
      opts.x = saved.x;
      opts.y = saved.y;
    }
  }
  mainWindow = new BrowserWindow(opts);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // 位置/大小变化 → 节流保存（下次启动恢复）
  const saveBounds = () => {
    if (winBoundsSaveTimer || !mainWindow) return;
    winBoundsSaveTimer = setTimeout(() => {
      winBoundsSaveTimer = null;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const b = mainWindow.getBounds();
      const s = loadState();
      s.settings.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      saveState(s);
    }, 400);
  };
  mainWindow.on("move", saveBounds);
  mainWindow.on("resize", saveBounds);

  // 关闭主窗口 = 切换到迷你模式（记住，下次启动直接进 mini）
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      switchToMini();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

/* ── 迷你圆窗（置顶小圆钮，点击即记录） ── */
function createMiniWindow() {
  const pos = loadState().settings.miniPos;
  const opts = {
    width: 120,
    height: 120,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  };
  if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
    opts.x = pos.x;
    opts.y = pos.y;
  }
  miniWindow = new BrowserWindow(opts);
  miniWindow.loadFile(path.join(__dirname, "renderer", "mini.html"));
  miniWindow.setAlwaysOnTop(true, "floating");
  // 拖拽后记住位置（节流保存）
  miniWindow.on("move", () => {
    if (miniPosSaveTimer) return;
    miniPosSaveTimer = setTimeout(() => {
      miniPosSaveTimer = null;
      if (!miniWindow) return;
      const [x, y] = miniWindow.getPosition();
      const s = loadState();
      s.settings.miniPos = { x, y };
      saveState(s);
    }, 400);
  });
  miniWindow.on("closed", () => { miniWindow = null; });
}

function showMini() {
  setMode("mini");
  if (!miniWindow) createMiniWindow();
  if (mainWindow) mainWindow.hide();
  miniWindow.show();
  // 同步今日计数 + 孕周
  miniWindow.webContents.send("mini:init", {
    todayCount: todayCount(),
    weekText: weekTextOf(loadState().settings)
  });
}

function todayCount() {
  const state = loadState();
  return state.records.filter(r => isToday(r.ts) && r.weight > 0).length;
}

/* ── 托盘 ── */
function buildTrayMenu() {
  const isSpace = loadState().settings.shortcut === "space";
  const recordItem = {
    label: t("tray.record"),
    click: () => recordFromOutside()
  };
  // 空格 = 应用内快捷键，未注册全局，托盘不显示加速键标签
  if (!isSpace) recordItem.accelerator = getShortcutLabel();
  return Menu.buildFromTemplate([
    { label: t("tray.fullMode"), type: "radio", checked: getMode() === "full", click: () => switchToFull() },
    { label: t("tray.miniMode"), type: "radio", checked: getMode() === "mini", click: () => switchToMini() },
    { type: "separator" },
    recordItem,
    { label: t("tray.startSession"), click: () => { switchToFull(); mainWindow.webContents.send("action:start-session"); } },
    { type: "separator" },
    {
      label: t("tray.remindSettings"),
      click: () => switchToFull("settings")
    },
    { type: "separator" },
    { label: t("tray.quit"), click: () => { isQuitting = true; app.quit(); } }
  ]);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "assets", "trayTemplate.png"));
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip(t("app.title"));
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => {
    if (getMode() === "mini") switchToFull(); else switchToMini();
  });
}

function showWindow(view) {
  setMode("full");
  if (miniWindow) miniWindow.hide();
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (view) mainWindow.webContents.send("nav:" + view);
}

/* ── 模式管理：完整版 / 迷你模式 互斥 ── */
function getMode() {
  const s = loadState().settings;
  return s.mode === "mini" ? "mini" : "full";
}
function setMode(m) {
  const s = loadState();
  if (s.settings.mode !== m) {
    s.settings.mode = m;
    saveState(s);
  }
}
function switchToMini() {
  showMini();
  // 通知托盘菜单刷新勾选状态
  if (tray) tray.setContextMenu(buildTrayMenu());
}
function switchToFull(view) {
  showWindow(view);
  if (tray) tray.setContextMenu(buildTrayMenu());
}

/* ── 全局快捷键 & 外部记录 ── */
const SHORTCUT_MAP = {
  "space": null,               // 空格：仅应用内（renderer 处理）
  "cmd": "CommandOrControl+K",
  "ctrl": "Control+Shift+K"
};
function getShortcut() {
  const s = loadState().settings;
  const mapped = SHORTCUT_MAP[s.shortcut];
  return mapped || "CommandOrControl+Shift+K";
}
function getShortcutLabel() {
  return getShortcut();
}
/* UI 显示用：CommandOrControl+Shift+K → ⌘ / Ctrl + Shift + K（macOS 上显示 ⌘） */
function getShortcutDisplay() {
  const sc = getShortcut();
  return sc.replace("CommandOrControl", process.platform === "darwin" ? "⌘" : "Ctrl")
           .split("+").join(" + ");
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  // 空格是应用内快捷键，不注册全局
  const s = loadState().settings;
  if (s.shortcut === "space") return;
  const sc = getShortcut();
  try {
    globalShortcut.register(sc, () => recordFromOutside());
  } catch (e) {
    console.error("shortcut register failed:", sc, e);
  }
}

function recordFromOutside() {
  const r = doRecord("tray");
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send("external:record", { ts: r.ts, weight: r.weight });
  }
}

/* 统一的记录逻辑：托盘 / 全局快捷键 / 迷你窗共用 */
function doRecord(src = "tray") {
  const now = Date.now();
  const state = loadState();

  // 合并规则与 renderer 一致：1 分钟内连续点击计 1 次
  const mergeMs = (parseInt(state.settings.mergeSec ?? 60, 10)) * 1000;
  const todayRecs = state.records.filter(r => isToday(r.ts));
  const prev = todayRecs.length ? todayRecs[todayRecs.length - 1] : null;
  const weight = prev && state.settings.mergeSec !== 0 && (now - prev.ts) < mergeMs ? 0 : 1;

  state.records.push({ id: now + Math.random(), ts: now, weight, src });
  saveState(state);

  // 系统通知（业务结果导向，一行话）
  if (Notification.isSupported()) {
    const n = new Notification({
      title: weight ? t("mini.recorded") + " · " + fmtTime(now) : t("mini.merged"),
      body: weight ? "" : t("mini.mergedBody")
    });
    n.show();
  }
  return { ts: now, weight, todayCount: todayCount() };
}

/* ── IPC ── */
ipcMain.handle("data:load", () => loadState());
ipcMain.handle("data:save", (e, state) => {
  const ok = saveState(state);
  // 快捷键变更后重新注册全局快捷键
  try { registerShortcut(); } catch (err) { console.error("re-register shortcut failed:", err); }
  return ok;
});
ipcMain.handle("app:shortcut", () => getShortcutDisplay());
ipcMain.handle("app:info", () => ({
  version: app.getVersion(),
  platform: process.platform,
  dataFile: DATA_FILE()
}));
ipcMain.handle("sync:info", () => syncInfo());
ipcMain.handle("locale:get", () => ({ lang: loadState().settings.lang || "zh", locale: getLocale() }));
ipcMain.handle("locale:set", (_e, lang) => { setLocale(lang); return { lang, locale: getLocale() }; });
ipcMain.handle("locale:list", () => getAvailableLocales());
ipcMain.handle("mini:record", () => {
  const r = doRecord("mini");
  // 同步主窗口 UI
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send("external:record", { ts: r.ts, weight: r.weight });
  }
  // 回传迷你窗：记录结果 + 今日计数
  return { weight: r.weight, todayCount: r.todayCount };
});
ipcMain.handle("app:mode", () => getMode());
ipcMain.handle("app:switch-mode", (e, mode) => {
  if (mode === "mini") switchToMini();
  else switchToFull();
  return getMode();
});
// 迷你窗拖拽：renderer 计算目标位置后请求移动
ipcMain.handle("mini:move", (e, { x, y }) => {
  if (miniWindow && typeof x === "number" && typeof y === "number") {
    miniWindow.setPosition(Math.round(x), Math.round(y));
  }
});
ipcMain.handle("mini:get-pos", () => {
  if (!miniWindow) return null;
  const [x, y] = miniWindow.getPosition();
  return { x, y };
});

/* ── App 生命周期 ── */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // 重复启动遵循当前模式：mini 唤起 mini，full 唤起完整版
    if (getMode() === "mini") switchToMini(); else switchToFull();
  });

  app.whenReady().then(() => {
    startSyncServer();
    createTray();
    registerShortcut();
    // 记住上次模式：mini 只开 mini，full 只开完整版
    if (getMode() === "mini") {
      showMini();
    } else {
      createWindow();
    }

    app.on("activate", () => {
      if (getMode() === "mini") {
        showMini();
      } else if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        showWindow();
      }
    });
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    if (syncServer) syncServer.close();
  });

  // macOS: 关闭所有窗口不退出；显式退出才真正退出
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => { isQuitting = true; });
}

/* ── helpers ── */
function isToday(ts) {
  const d = new Date(ts), t = new Date();
  return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
}
function fmtTime(ts) {
  return new Date(ts).toTimeString().slice(0, 5);
}
function weekTextOf(settings) {
  if (!settings || !settings.dueDate) return "";
  const due = new Date(String(settings.dueDate) + "T00:00:00");
  if (isNaN(due.getTime())) return "";
  const lmp = new Date(due);
  lmp.setDate(lmp.getDate() - 280); // 预产期 = 末次月经 + 280 天
  const days = Math.floor((Date.now() - lmp.getTime()) / 86400000);
  if (days < 0) return "孕早期";
  if (days > 294) return "已过预产期";
  return `孕 ${Math.floor(days / 7)} 周 + ${days % 7} 天`;
}

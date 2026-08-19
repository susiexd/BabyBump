"use strict";
/* ══════════════ BabyBump preload：安全桥接 ══════════════ */
const { contextBridge, ipcRenderer } = require("electron");

const api = {
  // 数据
  load: () => ipcRenderer.invoke("data:load"),
  save: (state) => ipcRenderer.invoke("data:save", state),
  // 应用信息
  shortcut: () => ipcRenderer.invoke("app:shortcut"),
  info: () => ipcRenderer.invoke("app:info"),
  // 模式（完整版 / 迷你模式）
  getMode: () => ipcRenderer.invoke("app:mode"),
  switchMode: (mode) => ipcRenderer.invoke("app:switch-mode", mode),
  // 同步
  syncInfo: () => ipcRenderer.invoke("sync:info"),
  // i18n
  localeGet: () => ipcRenderer.invoke("locale:get"),
  localeSet: (lang) => ipcRenderer.invoke("locale:set", lang),
  localeList: () => ipcRenderer.invoke("locale:list"),
  onLocaleChanged: (cb) => ipcRenderer.on("locale:changed", (_e, payload) => cb(payload)),
  // 主题
  getTheme: () => ipcRenderer.invoke("theme:get"),
  setTheme: (payload) => ipcRenderer.invoke("theme:set", payload),
  onThemeChanged: (cb) => ipcRenderer.on("theme:changed", (_e, payload) => cb(payload)),
  onSyncChanged: (cb) => ipcRenderer.on("sync:changed", (_e, state) => cb(state)),
  onExternalRecord: (cb) => ipcRenderer.on("external:record", (_e, payload) => cb(payload)),
  onStartSession: (cb) => ipcRenderer.on("action:start-session", () => cb()),
  onNav: (cb) => {
    ipcRenderer.on("nav:settings", () => cb("settings"));
    ipcRenderer.on("nav:history", () => cb("history"));
    ipcRenderer.on("nav:today", () => cb("today"));
  },
  // 迷你窗
  miniRecord: () => ipcRenderer.invoke("mini:record"),
  onMiniResult: (cb) => ipcRenderer.on("mini:result", (_e, payload) => cb(payload)),
  onMiniInit: (cb) => ipcRenderer.on("mini:init", (_e, payload) => cb(payload)),
  // 迷你窗拖拽
  miniMove: (x, y) => ipcRenderer.invoke("mini:move", { x, y }),
  miniGetPos: () => ipcRenderer.invoke("mini:get-pos")
};

contextBridge.exposeInMainWorld("babybump", api);

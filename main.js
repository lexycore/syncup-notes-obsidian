"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => SyncUpNotesPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian2 = require("obsidian");

// src/folders.ts
function parentFolders(path) {
  const parts = path.split("/").filter((part) => part.length > 0);
  const folders = [];
  let current = "";
  for (const part of parts.slice(0, -1)) {
    current = current ? `${current}/${part}` : part;
    folders.push(current);
  }
  return folders;
}

// src/plan.ts
var MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
var IGNORED = /* @__PURE__ */ new Set([".obsidian", ".git", "node_modules"]);
var ORDER = {
  "delete-remote": 0,
  "delete-local": 1,
  download: 2,
  upload: 3,
  "skip-large": 4,
  unchanged: 5,
  forget: 6
};
function ignored(path) {
  return path.split("/").some((part) => IGNORED.has(part));
}
var DIVERGE_MIN = 20;
function pathsDiffer(local, remote) {
  const locals = new Set(local.filter((file) => !ignored(file.path)).map((file) => file.path));
  const remotes = new Set(remote.filter((file) => !ignored(file.path)).map((file) => file.path));
  const smaller = Math.min(locals.size, remotes.size);
  if (smaller < DIVERGE_MIN) return false;
  let shared = 0;
  for (const path of locals) if (remotes.has(path)) shared += 1;
  return shared / smaller < 0.5;
}
function deleteCount(actions) {
  return actions.filter((action) => action.type === "delete-local" || action.type === "delete-remote").length;
}
function planSync(input) {
  const locals = new Map(input.local.filter((file) => !ignored(file.path)).map((file) => [file.path, file]));
  const remotes = new Map(input.remote.filter((file) => !ignored(file.path)).map((file) => [file.path, file]));
  const paths = /* @__PURE__ */ new Set([...locals.keys(), ...remotes.keys(), ...Object.keys(input.baseline)]);
  const actions = [];
  for (const path of paths) {
    const action = decide(path, locals.get(path), remotes.get(path), input.baseline[path]);
    if (action) actions.push(action);
  }
  actions.sort((a, b) => ORDER[a.type] - ORDER[b.type] || a.path.localeCompare(b.path));
  return actions;
}
function decide(path, local, remote, prior) {
  if (!local && !remote) return prior ? { type: "forget", path } : null;
  if (!prior) return firstSight(path, local, remote);
  const localChanged = local !== void 0 && (local.size !== prior.size || local.mtime !== prior.mtime);
  const remoteChanged = remote !== void 0 && remote.etag !== prior.etag;
  if (local && remote) {
    if (!localChanged && !remoteChanged) return unchanged(path, local, remote);
    if (localChanged && !remoteChanged) return uploadOrSkip(path, local);
    if (!localChanged && remoteChanged) return { type: "download", path };
    return newer(local, remote) === "local" ? uploadOrSkip(path, local) : { type: "download", path };
  }
  if (local) return localChanged ? uploadOrSkip(path, local) : { type: "delete-local", path };
  return remote && remoteChanged ? { type: "download", path } : { type: "delete-remote", path };
}
function firstSight(path, local, remote) {
  if (local && remote) {
    if (local.size === remote.size) return unchanged(path, local, remote);
    return newer(local, remote) === "local" ? uploadOrSkip(path, local) : { type: "download", path };
  }
  if (local) return uploadOrSkip(path, local);
  return { type: "download", path };
}
function uploadOrSkip(path, local) {
  return local.size > MAX_UPLOAD_BYTES ? { type: "skip-large", path } : { type: "upload", path };
}
function unchanged(path, local, remote) {
  return { type: "unchanged", path, etag: remote.etag, size: local.size, mtime: local.mtime };
}
function newer(local, remote) {
  return Math.floor(local.mtime / 1e3) >= Math.floor(remote.mtime / 1e3) ? "local" : "remote";
}

// src/settings.ts
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
  server: "https://syncup.ru/webdav/",
  username: "",
  password: "",
  folder: "",
  intervalMinutes: 1,
  syncOnStartup: true,
  syncOnSave: true,
  baseline: {}
};
var SyncUpSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Server").setDesc("WebDAV address of the SyncUp vault.").addText((text) => text.setPlaceholder(DEFAULT_SETTINGS.server).setValue(this.plugin.settings.server).onChange(async (value) => {
      this.plugin.settings.server = value.trim() || DEFAULT_SETTINGS.server;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Email").setDesc("The SyncUp account email.").addText((text) => text.setPlaceholder("you@example.com").setValue(this.plugin.settings.username).onChange(async (value) => {
      this.plugin.settings.username = value.trim();
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Application password").setDesc("The password shown once when WebDAV is turned on. It stays on this device.").addText((text) => {
      text.inputEl.type = "password";
      text.setValue(this.plugin.settings.password).onChange(async (value) => {
        this.plugin.settings.password = value;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("Remote folder").setDesc("Server folder this vault mirrors. Leave it empty only when the vault is the whole WebDAV root.").addText((text) => text.setPlaceholder("folder").setValue(this.plugin.settings.folder).onChange(async (value) => {
      this.plugin.settings.folder = cleanFolder(value);
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Sync every").setDesc("Minutes between syncs while Obsidian is open. 0 turns the timer off.").addText((text) => text.setValue(String(this.plugin.settings.intervalMinutes)).onChange(async (value) => {
      const minutes = Number(value);
      this.plugin.settings.intervalMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Sync on startup").addToggle((toggle) => toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
      this.plugin.settings.syncOnStartup = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Sync on save").addToggle((toggle) => toggle.setValue(this.plugin.settings.syncOnSave).onChange(async (value) => {
      this.plugin.settings.syncOnSave = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Sync now").addButton((button) => button.setButtonText("Sync").setCta().onClick(() => void this.plugin.sync()));
  }
};
function cleanFolder(value) {
  return value.split("/").map((part) => part.trim()).filter((part) => part && part !== "." && part !== "..").join("/");
}

// src/webdav.ts
var AuthError = class extends Error {
  constructor() {
    super("unauthorized");
    this.name = "AuthError";
  }
};
var QuotaError = class extends Error {
  constructor() {
    super("quota");
    this.name = "QuotaError";
  }
};
var TooLargeError = class extends Error {
  constructor() {
    super("too large");
    this.name = "TooLargeError";
  }
};
var WebDav = class {
  constructor(http, config) {
    this.http = http;
    this.config = config;
  }
  async list() {
    const response = await this.request("PROPFIND", folderUrl(this.config), { Depth: "infinity" });
    return filesFromPropfind(new TextDecoder().decode(response.body), prefixPath(this.config));
  }
  async put(path, body) {
    const response = await this.request("PUT", fileUrl(this.config, path), {}, body);
    return { etag: cleanEtag(header(response.headers, "etag")) };
  }
  async get(path) {
    const response = await this.request("GET", fileUrl(this.config, path));
    return { body: response.body, etag: cleanEtag(header(response.headers, "etag")) };
  }
  async remove(path) {
    await this.request("DELETE", fileUrl(this.config, path));
  }
  async request(method, url, extra = {}, body) {
    const response = await this.http({
      method,
      url,
      headers: { Authorization: basicAuth(this.config.username, this.config.password), ...extra },
      body
    });
    if (response.status === 401 || response.status === 403) throw new AuthError();
    if (response.status === 507) throw new QuotaError();
    if (response.status === 413) throw new TooLargeError();
    if (response.status >= 400) throw new Error(`webdav ${response.status}`);
    return response;
  }
};
function filesFromPropfind(xml, prefix) {
  const root = prefix.replace(/\/+$/, "");
  const files = [];
  for (const block of tagBlocks(xml, "response")) {
    if (isCollection(block)) continue;
    const href = tagText(block, "href");
    const path = vaultPath(href, root);
    if (!path) continue;
    files.push({
      path,
      size: Number(tagText(block, "getcontentlength")) || 0,
      mtime: Date.parse(tagText(block, "getlastmodified")) || 0,
      etag: cleanEtag(tagText(block, "getetag"))
    });
  }
  return files;
}
function fileUrl(config, path) {
  const base = config.server.replace(/\/+$/, "");
  const parts = [...config.folder.split("/"), ...path.split("/")].filter(Boolean).map(encodeURIComponent);
  return `${base}/${parts.join("/")}`;
}
function folderUrl(config) {
  const url = fileUrl(config, "");
  return url.endsWith("/") ? url : `${url}/`;
}
function prefixPath(config) {
  const pathname = new URL(config.server).pathname.replace(/\/+$/, "");
  const folder = config.folder.split("/").filter(Boolean);
  return [pathname, ...folder].filter(Boolean).join("/");
}
function vaultPath(href, root) {
  let path = href.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (path !== root && !path.startsWith(`${root}/`)) return null;
  const rel = path.slice(root.length).replace(/^\/+/, "").replace(/\/+$/, "");
  return rel || null;
}
function isCollection(block) {
  return /<(?:[\w-]+:)?collection\b/i.test(block);
}
function tagBlocks(xml, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "gi");
  return [...xml.matchAll(re)].map((match) => match[1]);
}
function tagText(xml, tag) {
  const match = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "i"));
  return match ? unescapeXml(match[1].trim()) : "";
}
function unescapeXml(value) {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function cleanEtag(value) {
  let etag = value.trim();
  if (etag.toLowerCase().startsWith("w/")) etag = etag.slice(2).trim();
  if (etag.startsWith('"') && etag.endsWith('"') && etag.length >= 2) etag = etag.slice(1, -1);
  return etag;
}
function header(headers, name) {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found ? found[1] : "";
}
function basicAuth(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

// src/sync.ts
async function execute(actions, io, baseline, progress) {
  const next = { ...baseline };
  const skipped = [];
  const errors = [];
  const work = actions.filter((action) => action.type !== "unchanged" && action.type !== "forget");
  let done = 0;
  for (const action of actions) {
    if (action.type === "unchanged") {
      next[action.path] = { size: action.size, mtime: action.mtime, etag: action.etag };
      continue;
    }
    if (action.type === "forget") {
      delete next[action.path];
      continue;
    }
    done += 1;
    progress?.({ done, total: work.length, action });
    await yieldToUI();
    try {
      await apply(action, io, next);
      if (action.type === "skip-large") skipped.push(action.path);
    } catch (error) {
      if (error instanceof AuthError) return { baseline: next, skipped, errors, abort: "auth" };
      if (error instanceof QuotaError) return { baseline: next, skipped, errors, abort: "quota" };
      errors.push(`${action.type} ${action.path}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }
  return { baseline: next, skipped, errors };
}
async function apply(action, io, baseline) {
  switch (action.type) {
    case "upload": {
      const body = await io.read(action.path);
      const put = await io.put(action.path, body);
      const stat = await io.stat(action.path);
      baseline[action.path] = { size: stat.size, mtime: stat.mtime, etag: put.etag };
      return;
    }
    case "download": {
      const got = await io.get(action.path);
      const stat = await io.write(action.path, got.body);
      baseline[action.path] = { size: stat.size, mtime: stat.mtime, etag: got.etag };
      return;
    }
    case "delete-local":
      await io.removeLocal(action.path);
      delete baseline[action.path];
      return;
    case "delete-remote":
      await io.removeRemote(action.path);
      delete baseline[action.path];
      return;
    default:
      return;
  }
}
function yieldToUI() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// src/main.ts
var SAVE_DELAY_MS = 2e3;
var SyncUpNotesPlugin = class extends import_obsidian2.Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULT_SETTINGS, baseline: {} };
    this.statusEl = null;
    this.saveTimer = null;
    this.intervalTimer = null;
    this.applying = false;
    this.running = false;
    this.queued = false;
  }
  async onload() {
    await this.loadSettings();
    this.statusEl = this.addStatusBarItem();
    this.setStatus("SyncUp");
    this.addSettingTab(new SyncUpSettingTab(this.app, this));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.sync() });
    this.registerEvent(this.app.vault.on("create", () => this.onVaultChange()));
    this.registerEvent(this.app.vault.on("modify", () => this.onVaultChange()));
    this.registerEvent(this.app.vault.on("delete", () => this.onVaultChange()));
    this.registerEvent(this.app.vault.on("rename", () => this.onVaultChange()));
    this.armInterval();
    if (this.settings.syncOnStartup) void this.sync();
  }
  onunload() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    if (this.intervalTimer !== null) window.clearInterval(this.intervalTimer);
  }
  async loadSettings() {
    const stored = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...stored ?? {}, baseline: stored?.baseline ?? {} };
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.armInterval();
  }
  armInterval() {
    if (this.intervalTimer !== null) window.clearInterval(this.intervalTimer);
    const minutes = this.settings.intervalMinutes;
    if (minutes <= 0) {
      this.intervalTimer = null;
      return;
    }
    this.intervalTimer = window.setInterval(() => void this.sync(), minutes * 6e4);
  }
  sync() {
    if (this.running) {
      this.queued = true;
      return Promise.resolve();
    }
    this.running = true;
    return this.syncOnce().catch((error) => {
      this.setStatus("SyncUp \xB7 failed");
      new import_obsidian2.Notice(`SyncUp Notes: ${failureText(error)}`);
    }).finally(() => {
      this.running = false;
      if (this.queued) {
        this.queued = false;
        void this.sync();
      }
    });
  }
  async syncOnce() {
    if (!this.settings.username || !this.settings.password) {
      this.setStatus("SyncUp \xB7 sign in");
      return;
    }
    this.setStatus("SyncUp \xB7 listing");
    const dav = new WebDav((request) => this.http(request), this.settings);
    const remote = await dav.list();
    const local = this.localFiles();
    if (pathsDiffer(local, remote)) {
      this.setStatus("SyncUp \xB7 paths differ");
      new import_obsidian2.Notice("SyncUp Notes: this vault and the server folder don't match, so nothing was changed.");
      return;
    }
    const actions = planSync({ local, remote, baseline: this.settings.baseline });
    const deletes = deleteCount(actions);
    if (deletes > 25) {
      this.setStatus(`SyncUp \xB7 held ${deletes} deletes`);
      new import_obsidian2.Notice(`SyncUp Notes: stopped before deleting ${deletes} files.`);
      return;
    }
    const before = JSON.stringify(this.settings.baseline);
    const result = await execute(actions, this.vaultIO(dav), this.settings.baseline, (update) => this.showProgress(update));
    this.settings.baseline = result.baseline;
    if (JSON.stringify(result.baseline) !== before) await this.saveData(this.settings);
    if (result.abort === "auth") {
      this.setStatus("SyncUp \xB7 failed");
      new import_obsidian2.Notice("SyncUp Notes: check the email and application password");
      return;
    }
    if (result.abort === "quota") {
      this.setStatus("SyncUp \xB7 storage full");
      new import_obsidian2.Notice("SyncUp Notes: storage is full");
      return;
    }
    if (result.errors.length > 0) {
      this.setStatus("SyncUp \xB7 failed");
      new import_obsidian2.Notice(`SyncUp Notes: ${result.errors[0]}`);
      return;
    }
    if (result.skipped.length > 0) {
      this.setStatus(`SyncUp \xB7 skipped ${result.skipped.length} large`);
      return;
    }
    this.setStatus("SyncUp \xB7 up to date");
  }
  localFiles() {
    return this.app.vault.getFiles().map((file) => ({ path: file.path, size: file.stat.size, mtime: file.stat.mtime }));
  }
  vaultIO(dav) {
    return {
      read: (path) => this.readFile(path),
      write: (path, body) => this.writeFile(path, body),
      removeLocal: (path) => this.removeFile(path),
      put: (path, body) => dav.put(path, body),
      get: (path) => dav.get(path),
      removeRemote: (path) => dav.remove(path),
      stat: async (path) => this.statFile(path)
    };
  }
  async readFile(path) {
    const file = this.file(path);
    return new Uint8Array(await this.app.vault.readBinary(file));
  }
  async writeFile(path, body) {
    const data = copyBuffer(body);
    this.applying = true;
    try {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof import_obsidian2.TFile) await this.app.vault.modifyBinary(existing, data);
      else {
        await this.ensureParents(path);
        await this.app.vault.createBinary(path, data);
      }
    } finally {
      this.applying = false;
    }
    return this.statFile(path);
  }
  async removeFile(path) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!(existing instanceof import_obsidian2.TFile)) return;
    this.applying = true;
    try {
      await this.app.vault.trash(existing, true);
    } finally {
      this.applying = false;
    }
  }
  async ensureParents(path) {
    for (const folder of parentFolders(path)) {
      const existing = this.app.vault.getAbstractFileByPath(folder);
      if (existing instanceof import_obsidian2.TFolder) continue;
      if (existing) throw new Error(`not a folder: ${folder}`);
      try {
        await this.app.vault.createFolder(folder);
      } catch (error) {
        const created = this.app.vault.getAbstractFileByPath(folder);
        if (created instanceof import_obsidian2.TFolder) continue;
        throw error;
      }
    }
  }
  statFile(path) {
    const file = this.file(path);
    return { size: file.stat.size, mtime: file.stat.mtime };
  }
  file(path) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!(existing instanceof import_obsidian2.TFile)) throw new Error(`missing ${path}`);
    return existing;
  }
  async http(request) {
    const response = await (0, import_obsidian2.requestUrl)({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body ? copyBuffer(request.body) : void 0,
      throw: false
    });
    return { status: response.status, headers: response.headers, body: new Uint8Array(response.arrayBuffer) };
  }
  onVaultChange() {
    if (this.applying || !this.settings.syncOnSave) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.sync();
    }, SAVE_DELAY_MS);
  }
  showProgress(update) {
    const name = update.action.path.split("/").pop() ?? update.action.path;
    this.setStatus(`SyncUp \xB7 ${update.done}/${update.total} ${name}`);
  }
  setStatus(text) {
    if (this.statusEl) this.statusEl.setText(text);
  }
};
function copyBuffer(body) {
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return copy.buffer;
}
function failureText(error) {
  if (error instanceof AuthError) return "check the email and application password";
  if (error instanceof QuotaError) return "storage is full";
  if (error instanceof TooLargeError) return "a file is over 64 MB";
  return error instanceof Error ? error.message : "sync failed";
}

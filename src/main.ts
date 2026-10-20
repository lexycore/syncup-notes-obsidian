import { Notice, Platform, Plugin, TFile, TFolder, requestUrl } from "obsidian";

interface ExplorerItem {
	file?: object;
	collapsed?: boolean;
	setCollapsed?(collapsed: boolean): void;
}
import { keptBytes, partialMetaPath, partialPath, pullChunks } from "./chunks";
import { parentFolders } from "./folders";
import { deleteCount, MAX_TRANSFER_ATTEMPTS, nextOverLimit, overLimitNotice, pathsDiffer, planSync, type BaselineEntry, type LocalFile, type TransferAttempt } from "./plan";
import { SyncUpSettingTab, DEFAULT_SETTINGS, type SyncUpSettings } from "./settings";
import { desktopModules, forgetPartialMeta, partialFile, preparePartial, streamDownload, streamUpload, vaultFile, type NodeModules } from "./stream";
import { execute, type SyncIO, type SyncProgress } from "./sync";
import { encodeView, openFolders, parseView, snapshot, syncFolders, VIEW_PATH, type FolderToggle, type ViewState } from "./viewstate";
import { AuthError, QuotaError, TooLargeError, WebDav, type HttpRequest, type HttpResponse } from "./webdav";

const SAVE_DELAY_MS = 2000;

export default class SyncUpNotesPlugin extends Plugin {
	settings: SyncUpSettings = { ...DEFAULT_SETTINGS, baseline: {}, retries: {} };
	private serverResume = false;
	private statusEl: HTMLElement | null = null;
	private saveTimer: number | null = null;
	private intervalTimer: number | null = null;
	private applying = false;
	private running = false;
	private queued = false;
	private viewReady = false;
	private applyingView = false;
	private publishingView = false;
	private lastSnapshot = "";
	private lastWritten = 0;
	private lastApplied = 0;
	private holdPublishUntil = 0;

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
		this.app.workspace.onLayoutReady(() => {
			this.registerInterval(window.setInterval(() => void this.publishExplorer(), 1000));
		});
		if (this.settings.syncOnStartup) void this.sync();
	}

	onunload() {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		if (this.intervalTimer !== null) window.clearInterval(this.intervalTimer);
	}

	async loadSettings() {
		const stored = await this.loadData();
		this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}), baseline: stored?.baseline ?? {}, retries: stored?.retries ?? {} };
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
		this.intervalTimer = window.setInterval(() => void this.sync(), minutes * 60_000);
	}

	sync(): Promise<void> {
		if (this.running) {
			this.queued = true;
			return Promise.resolve();
		}
		this.running = true;
		return this.syncOnce()
			.catch((error: unknown) => {
				this.setStatus("SyncUp · failed");
				new Notice(`SyncUp Notes: ${failureText(error)}`);
			})
			.finally(() => {
				this.running = false;
				if (this.queued) {
					this.queued = false;
					void this.sync();
				}
			});
	}

	private async syncOnce() {
		if (!this.settings.username || !this.settings.password) {
			this.setStatus("SyncUp · sign in");
			return;
		}
		let aligned = false;
		try {
			aligned = await this.syncVault();
		} finally {
			if (aligned) {
				await this.pullView();
				this.viewReady = true;
			}
		}
	}

	private async syncVault(): Promise<boolean> {
		this.setStatus("SyncUp · listing");
		const dav = new WebDav((request) => this.http(request), this.settings);
		const listing = await dav.list();
		this.serverResume = listing.resume;
		const remote = listing.files;
		const local = this.localFiles();
		if (pathsDiffer(local, remote)) {
			this.setStatus("SyncUp · paths differ");
			new Notice("SyncUp Notes: this vault and the server folder don't match, so nothing was changed.");
			return false;
		}
		const actions = planSync({
			local,
			remote,
			baseline: this.settings.baseline,
			fileLimit: listing.fileLimit,
			attempts: this.settings.retries,
			overLimit: this.settings.overLimit,
		});
		const deletes = deleteCount(actions);
		if (deletes > 25) {
			this.setStatus(`SyncUp · held ${deletes} deletes`);
			new Notice(`SyncUp Notes: stopped before deleting ${deletes} files.`);
			return true;
		}
		const before = JSON.stringify(this.settings.baseline);
		const beforeLimit = JSON.stringify(this.settings.overLimit ?? null);
		const result = await execute(actions, this.vaultIO(dav), this.settings.baseline, (update) => this.showProgress(update), async (baseline) => {
			this.settings.baseline = baseline;
			await this.saveData(this.settings);
		});
		this.settings.baseline = result.baseline;
		const parked = actions.filter((action) => action.type === "parked").map((action) => action.path);
		const remembered = nextOverLimit(result.fileLimit ?? listing.fileLimit, parked, result.skipped, this.settings.overLimit);
		if (remembered) this.settings.overLimit = remembered;
		if (JSON.stringify(result.baseline) !== before || JSON.stringify(this.settings.overLimit ?? null) !== beforeLimit) await this.saveData(this.settings);
		if (result.abort === "auth") {
			this.setStatus("SyncUp · failed");
			new Notice("SyncUp Notes: check the email and application password");
			return true;
		}
		if (result.abort === "quota") {
			this.setStatus("SyncUp · storage full");
			new Notice("SyncUp Notes: storage is full");
			return true;
		}
		if (result.conflicts.length === 1) {
			const name = result.conflicts[0].split("/").pop() || result.conflicts[0];
			new Notice(`SyncUp Notes: kept your edit as ${name}`);
		} else if (result.conflicts.length > 1) {
			new Notice(`SyncUp Notes: kept ${result.conflicts.length} edits next to the newer server copies`);
		}
		if (result.skipped.length > 0) {
			const limit = result.fileLimit ?? listing.fileLimit;
			new Notice(`SyncUp Notes: ${overLimitNotice(result.skipped, limit)}`);
		}
		const paused = this.noteFailures(result.failed, result.transferred);
		if (result.errors.length > 0 && !paused) {
			this.setStatus("SyncUp · failed");
			new Notice(`SyncUp Notes: ${result.errors[0]}`);
			return true;
		}
		this.setStatus("SyncUp · up to date");
		return true;
	}

	private localFiles(): LocalFile[] {
		return this.app.vault.getFiles().map((file) => ({ path: file.path, size: file.stat.size, mtime: file.stat.mtime }));
	}

	private vaultIO(dav: WebDav): SyncIO {
		const root = this.streamRoot();
		return {
			read: (path) => this.readFile(path),
			write: (path, body) => this.writeFile(path, body),
			removeLocal: (path) => this.removeFile(path),
			put: (path, body, match) => dav.put(path, body, match),
			get: (path) => dav.get(path),
			removeRemote: (path) => dav.remove(path),
			move: (from, to) => dav.move(from, to),
			stat: async (path) => this.statFile(path),
			streamPut: root ? (path, match) => this.streamPut(dav, root, path, match) : undefined,
			streamGet: root ? (path, file) => this.streamGet(dav, root, path, file) : undefined,
			pull: root ? undefined : (path, file) => this.pullFile(dav, path, file),
		};
	}

	private streamRoot(): { modules: NodeModules; base: string } | null {
		if (!Platform.isDesktopApp) return null;
		const adapter = this.app.vault.adapter as { getBasePath?: () => string };
		if (typeof adapter.getBasePath !== "function") return null;
		const modules = desktopModules();
		if (!modules) return null;
		return { modules, base: adapter.getBasePath() };
	}

	private async streamPut(dav: WebDav, root: { modules: NodeModules; base: string }, vaultPath: string, match?: string): Promise<{ etag: string }> {
		const headers: Record<string, string> = { Authorization: dav.authHeader() };
		if (match) headers["If-Match"] = `"${match}"`;
		const etag = await streamUpload(root.modules, vaultFile(root.modules, root.base, vaultPath), dav.fileURL(vaultPath), headers, this.serverResume);
		return { etag };
	}

	private async streamGet(dav: WebDav, root: { modules: NodeModules; base: string }, vaultPath: string, file: { etag: string; size: number }): Promise<{ size: number; mtime: number; etag: string }> {
		this.applying = true;
		const partial = partialFile(root.modules, root.base, vaultPath);
		try {
			const offset = preparePartial(root.modules, partial, file.etag, file.size);
			const etag = await streamDownload(
				root.modules,
				vaultFile(root.modules, root.base, vaultPath),
				partial,
				dav.fileURL(vaultPath),
				{ Authorization: dav.authHeader() },
				offset,
			);
			forgetPartialMeta(root.modules, partial);
			for (let attempt = 0; attempt < 50; attempt++) {
				const found = this.app.vault.getAbstractFileByPath(vaultPath);
				if (found instanceof TFile) return { size: found.stat.size, mtime: found.stat.mtime, etag };
				await new Promise((resolve) => window.setTimeout(resolve, 100));
			}
			throw new Error(`missing ${vaultPath}`);
		} finally {
			this.applying = false;
		}
	}

	private async pullFile(dav: WebDav, vaultPath: string, file: { etag: string; size: number }): Promise<{ size: number; mtime: number; etag: string }> {
		const adapter = this.app.vault.adapter;
		if (typeof adapter.appendBinary !== "function") throw new Error("update Obsidian to resume a large download");
		const partial = partialPath(vaultPath);
		const metaPath = partialMetaPath(vaultPath);
		await this.adapterParents(partial);
		const meta = await readPartialMeta(adapter, metaPath);
		const have = (await adapter.stat(partial))?.size ?? 0;
		const offset = keptBytes(meta, have, file.etag, file.size);
		if (offset === 0 && have > 0) await adapter.remove(partial);
		await adapter.write(metaPath, JSON.stringify({ etag: file.etag, size: file.size, offset }));
		await pullChunks({
			size: file.size,
			offset,
			fetchRange: (start, end) => dav.getRange(vaultPath, start, end),
			writeAt: async (at, body) => {
				const bytes = copyBuffer(body);
				if (at === 0) await adapter.writeBinary(partial, bytes);
				else await adapter.appendBinary(partial, bytes);
				await adapter.write(metaPath, JSON.stringify({ etag: file.etag, size: file.size, offset: at + body.byteLength }));
			},
		});
		this.applying = true;
		try {
			await this.ensureParents(vaultPath);
			if (await adapter.exists(vaultPath)) await adapter.remove(vaultPath);
			await adapter.rename(partial, vaultPath);
				if (await adapter.exists(metaPath)) await adapter.remove(metaPath);
		} finally {
			this.applying = false;
		}
		for (let attempt = 0; attempt < 50; attempt++) {
			const found = this.app.vault.getAbstractFileByPath(vaultPath);
			if (found instanceof TFile) return { size: found.stat.size, mtime: found.stat.mtime, etag: file.etag };
			await new Promise((resolve) => window.setTimeout(resolve, 100));
		}
		throw new Error(`missing ${vaultPath}`);
	}

	private async adapterParents(path: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		for (const folder of parentFolders(path)) {
			if (await adapter.exists(folder)) continue;
			try {
				await adapter.mkdir(folder);
			} catch (error) {
				if (await adapter.exists(folder)) continue;
				throw error;
			}
		}
	}

	private async readFile(path: string): Promise<Uint8Array> {
		const file = this.file(path);
		return new Uint8Array(await this.app.vault.readBinary(file));
	}

	private async writeFile(path: string, body: Uint8Array): Promise<{ size: number; mtime: number }> {
		const data = copyBuffer(body);
		this.applying = true;
		try {
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, data);
			else {
				await this.ensureParents(path);
				await this.app.vault.createBinary(path, data);
			}
		} finally {
			this.applying = false;
		}
		return this.statFile(path);
	}

	private async removeFile(path: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (!(existing instanceof TFile)) return;
		this.applying = true;
		try {
			await this.app.vault.trash(existing, true);
		} finally {
			this.applying = false;
		}
	}

	private async ensureParents(path: string): Promise<void> {
		for (const folder of parentFolders(path)) {
			const existing = this.app.vault.getAbstractFileByPath(folder);
			if (existing instanceof TFolder) continue;
			if (existing) throw new Error(`not a folder: ${folder}`);
			try {
				await this.app.vault.createFolder(folder);
			} catch (error) {
				const created = this.app.vault.getAbstractFileByPath(folder);
				if (created instanceof TFolder) continue;
				throw error;
			}
		}
	}

	private statFile(path: string): { size: number; mtime: number } {
		const file = this.file(path);
		return { size: file.stat.size, mtime: file.stat.mtime };
	}

	private file(path: string): TFile {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (!(existing instanceof TFile)) throw new Error(`missing ${path}`);
		return existing;
	}

	private async http(request: HttpRequest): Promise<HttpResponse> {
		const response = await requestUrl({
			url: request.url,
			method: request.method,
			headers: request.headers,
			body: request.body ? copyBuffer(request.body) : undefined,
			throw: false,
		});
		return { status: response.status, headers: response.headers, body: new Uint8Array(response.arrayBuffer) };
	}

	private async pullView() {
		let text: string;
		try {
			const got = await this.dav().get(VIEW_PATH);
			text = new TextDecoder().decode(got.body);
		} catch (error) {
			if (missing(error)) return;
			throw error;
		}
		const state = parseView(text);
		if (!state || state.updated <= this.lastApplied || state.updated === this.lastWritten) return;
		await this.applyView(state);
		await this.writeLocalView(text);
	}

	private async applyView(state: ViewState) {
		this.applyingView = true;
		this.holdPublishUntil = Date.now() + 600;
		try {
			syncFolders(this.folders(), state.expanded);
			await this.openNote(state.file);
			this.lastApplied = state.updated;
			this.lastWritten = state.updated;
		} finally {
			this.applyingView = false;
		}
		const timer = window.setTimeout(() => {
			if (this.lastApplied !== state.updated) return;
			syncFolders(this.folders(), state.expanded);
			const file = this.app.workspace.getActiveFile()?.path || state.file;
			this.lastSnapshot = snapshot(openFolders(this.folders()), file);
		}, 250);
		this.register(() => window.clearTimeout(timer));
	}

	private async publishExplorer() {
		if (!this.viewReady || this.applyingView || this.publishingView || Date.now() < this.holdPublishUntil) return;
		const expanded = openFolders(this.folders());
		const file = this.app.workspace.getActiveFile()?.path ?? "";
		const snap = snapshot(expanded, file);
		if (snap === this.lastSnapshot) return;
		const next: ViewState = { v: 1, expanded, file, updated: Date.now() };
		try {
			await this.writeView(next);
		} catch {
			return;
		}
		this.lastSnapshot = snap;
		this.lastWritten = next.updated;
		this.lastApplied = next.updated;
	}

	private folders(): FolderToggle[] {
		const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
		const items = (leaf?.view as { fileItems?: Record<string, ExplorerItem> } | undefined)?.fileItems;
		if (!items) return [];
		const folders: FolderToggle[] = [];
		for (const item of Object.values(items)) {
			const setCollapsed = item?.setCollapsed;
			if (!(item?.file instanceof TFolder) || typeof setCollapsed !== "function") continue;
			folders.push({
				path: item.file.path,
				collapsed: !!item.collapsed,
				setCollapsed: (collapsed) => setCollapsed(collapsed),
			});
		}
		return folders;
	}

	private async openNote(path: string) {
		if (!path) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		if (this.app.workspace.getActiveFile()?.path === path) return;
		const leaf = this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf(false);
		await leaf.openFile(file, { active: false });
	}

	private dav(): WebDav {
		return new WebDav((request) => this.http(request), this.settings);
	}

	private async writeView(state: ViewState) {
		const text = encodeView(state);
		this.publishingView = true;
		try {
			await this.writeLocalView(text);
			await this.dav().put(VIEW_PATH, new TextEncoder().encode(text));
		} finally {
			this.publishingView = false;
		}
	}

	private async writeLocalView(text: string) {
		const adapter = this.app.vault.adapter;
		this.applying = true;
		try {
			if (!(await adapter.exists(".syncup"))) await adapter.mkdir(".syncup");
			await adapter.write(VIEW_PATH, text);
		} finally {
			this.applying = false;
		}
	}

	private onVaultChange() {
		if (this.applying || !this.settings.syncOnSave) return;
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.sync();
		}, SAVE_DELAY_MS);
	}

	private noteFailures(failed: { path: string; key: string }[], transferred: string[]): boolean {
		const retries: Record<string, TransferAttempt> = { ...this.settings.retries };
		let changed = false;
		let paused = false;
		let retrying = false;
		for (const path of transferred) {
			if (!retries[path]) continue;
			delete retries[path];
			changed = true;
		}
		for (const fail of failed) {
			const prior = retries[fail.path];
			const attempts = prior && prior.key === fail.key ? prior.attempts + 1 : 1;
			retries[fail.path] = { attempts, key: fail.key };
			changed = true;
			if (attempts < MAX_TRANSFER_ATTEMPTS) {
				retrying = true;
				continue;
			}
			paused = true;
			const name = fail.path.split("/").pop() || fail.path;
			new Notice(`SyncUp Notes: stopped retrying ${name} after ${MAX_TRANSFER_ATTEMPTS} failed attempts. It will try again when the file changes.`);
		}
		if (changed) {
			this.settings.retries = retries;
			void this.saveSettings();
		}
		return paused && !retrying;
	}

	private showProgress(update: SyncProgress) {
		const name = update.action.path.split("/").pop() ?? update.action.path;
		this.setStatus(`SyncUp · ${update.done}/${update.total} ${name}`);
	}

	private setStatus(text: string) {
		if (this.statusEl) this.statusEl.setText(text);
	}
}

async function readPartialMeta(adapter: { exists(path: string): Promise<boolean>; read(path: string): Promise<string> }, path: string): Promise<{ etag?: string; size?: number } | null> {
	try {
		if (!(await adapter.exists(path))) return null;
		const parsed = JSON.parse(await adapter.read(path)) as { etag?: string; size?: number };
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function copyBuffer(body: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(body.byteLength);
	copy.set(body);
	return copy.buffer;
}

function missing(error: unknown): boolean {
	return error instanceof Error && error.message === "webdav 404";
}

function failureText(error: unknown): string {
	if (error instanceof AuthError) return "check the email and application password";
	if (error instanceof QuotaError) return "storage is full";
	if (error instanceof TooLargeError) return "a file is too large for the server";
	return error instanceof Error ? error.message : "sync failed";
}

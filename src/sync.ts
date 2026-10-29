import { CHUNK_BYTES } from "./chunks.ts";
import { MAX_UPLOAD_BYTES, transferKey, type Action, type BaselineEntry } from "./plan.ts";
import { AuthError, ConflictError, QuotaError, TooLargeError } from "./webdav.ts";

export interface SyncIO {
	read(path: string): Promise<Uint8Array>;
	write(path: string, body: Uint8Array): Promise<{ size: number; mtime: number }>;
	removeLocal(path: string): Promise<void>;
	put(path: string, body: Uint8Array, match?: string): Promise<{ etag: string }>;
	get(path: string): Promise<{ body: Uint8Array; etag: string }>;
	streamPut?(path: string, match?: string): Promise<{ etag: string }>;
	streamGet?(path: string, file: { etag: string; size: number }): Promise<{ size: number; mtime: number; etag: string }>;
	pull?(path: string, file: { etag: string; size: number }): Promise<{ size: number; mtime: number; etag: string }>;
	removeRemote(path: string): Promise<void>;
	move(from: string, to: string): Promise<void>;
	stat(path: string): Promise<{ size: number; mtime: number }>;
}

export interface SyncProgress {
	done: number;
	total: number;
	action: Action;
}

const SAVED = new Set<Action["type"]>(["upload", "download", "conflict", "delete-local", "delete-remote", "move", "forget"]);

export class SyncYield extends Error {
	constructor() {
		super("yield");
		this.name = "SyncYield";
	}
}

export async function execute(
	actions: Action[],
	io: SyncIO,
	baseline: Record<string, BaselineEntry>,
	progress?: (update: SyncProgress) => void,
	checkpoint?: (baseline: Record<string, BaselineEntry>) => Promise<void>,
	pause?: () => boolean,
): Promise<{
	baseline: Record<string, BaselineEntry>;
	skipped: string[];
	errors: string[];
	failed: { path: string; key: string }[];
	transferred: string[];
	fileLimit?: number;
	conflicts: string[];
	abort?: "auth" | "quota";
	yielded?: boolean;
}> {
	const next = { ...baseline };
	const skipped: string[] = [];
	const errors: string[] = [];
	const failed: { path: string; key: string }[] = [];
	const transferred: string[] = [];
	const conflicts: string[] = [];
	let fileLimit: number | undefined;
	const work = actions.filter((action) => action.type !== "unchanged" && action.type !== "forget" && action.type !== "paused" && action.type !== "parked");
	let done = 0;
	for (const action of actions) {
		if (action.type === "unchanged") {
			next[action.path] = { size: action.size, mtime: action.mtime, etag: action.etag };
			continue;
		}
		if (action.type === "forget") {
			delete next[action.path];
			if (checkpoint) await checkpoint(next);
			continue;
		}
		if (action.type === "paused" || action.type === "parked") continue;
		if (pause?.()) return { baseline: next, skipped, errors, failed, transferred, fileLimit, conflicts, yielded: true };
		done += 1;
		progress?.({ done, total: work.length, action });
		await yieldToUI();
		try {
			await apply(action, io, next, conflicts);
			if (action.type === "upload" || action.type === "download") transferred.push(action.path);
			if (action.type === "skip-large") skipped.push(action.path);
			if (SAVED.has(action.type) && checkpoint) await checkpoint(next);
		} catch (error) {
			if (error instanceof SyncYield) return { baseline: next, skipped, errors, failed, transferred, fileLimit, conflicts, yielded: true };
			if (error instanceof AuthError) return { baseline: next, skipped, errors, failed, transferred, fileLimit, conflicts, abort: "auth" };
			if (error instanceof QuotaError) return { baseline: next, skipped, errors, failed, transferred, fileLimit, conflicts, abort: "quota" };
			if (error instanceof TooLargeError && error.limit > 0) {
				skipped.push(action.path);
				fileLimit = error.limit;
				continue;
			}
			errors.push(`${action.type} ${action.path}: ${error instanceof Error ? error.message : "failed"}`);
			if (action.type === "upload" || action.type === "download") failed.push({ path: action.path, key: transferKey(action.type, action) });
		}
	}
	return { baseline: next, skipped, errors, failed, transferred, fileLimit, conflicts };
}

async function apply(action: Action, io: SyncIO, baseline: Record<string, BaselineEntry>, conflicts: string[]): Promise<void> {
	switch (action.type) {
		case "upload": {
			if ((action.size ?? 0) > MAX_UPLOAD_BYTES && !io.streamPut) {
				throw new Error("open the desktop app to upload files over 64 MB");
			}
			if (io.streamPut && (action.size ?? 0) > MAX_UPLOAD_BYTES) {
				try {
					const put = await io.streamPut(action.path, action.match);
					const stat = await io.stat(action.path);
					baseline[action.path] = { size: stat.size, mtime: stat.mtime, etag: put.etag };
				} catch (error) {
					if (!(error instanceof ConflictError) || !action.match) throw error;
					await keepLocalCopy(action.path, await io.read(action.path), io, baseline, conflicts);
				}
				return;
			}
			const body = await io.read(action.path);
			try {
				const put = await io.put(action.path, body, action.match);
				const stat = await io.stat(action.path);
				baseline[action.path] = { size: stat.size, mtime: stat.mtime, etag: put.etag };
			} catch (error) {
				if (!(error instanceof ConflictError) || !action.match) throw error;
				await keepLocalCopy(action.path, body, io, baseline, conflicts);
			}
			return;
		}
		case "conflict": {
			await keepLocalCopy(action.path, await io.read(action.path), io, baseline, conflicts);
			return;
		}
		case "download": {
			if (io.streamGet) {
				baseline[action.path] = await io.streamGet(action.path, { etag: action.etag ?? "", size: action.size ?? 0 });
				return;
			}
			if (io.pull && (action.size ?? 0) > CHUNK_BYTES) {
				baseline[action.path] = await io.pull(action.path, { etag: action.etag ?? "", size: action.size ?? 0 });
				return;
			}
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
		case "move":
			await io.move(action.from, action.path);
			for (const file of action.files) {
				delete baseline[file.from];
				if (!file.changed) baseline[file.path] = { size: file.size, mtime: file.mtime, etag: file.etag };
			}
			return;
		default:
			return;
	}
}

async function keepLocalCopy(path: string, localBody: Uint8Array, io: SyncIO, baseline: Record<string, BaselineEntry>, conflicts: string[]): Promise<void> {
	let server: { body: Uint8Array; etag: string } | null = null;
	try {
		server = await io.get(path);
	} catch (error) {
		if (!gone(error)) throw error;
	}
	if (server) {
		const choice = draftChoice(localBody, server.body, baseline[path]?.size ?? 0);
		if (choice === "same") {
			const stat = await io.stat(path);
			baseline[path] = { size: stat.size, mtime: stat.mtime, etag: server.etag };
			return;
		}
		if (choice === "local") {
			const put = await io.put(path, localBody);
			const stat = await io.stat(path);
			baseline[path] = { size: stat.size, mtime: stat.mtime, etag: put.etag };
			return;
		}
		if (choice === "server") {
			const written = await io.write(path, server.body);
			baseline[path] = { size: written.size, mtime: written.mtime, etag: server.etag };
			return;
		}
	}
	const copy = await unusedCopy(path, io);
	const saved = await io.write(copy, localBody);
	const put = await io.put(copy, localBody);
	baseline[copy] = { size: saved.size, mtime: saved.mtime, etag: put.etag };
	conflicts.push(copy);
	if (!server) {
		await io.removeLocal(path);
		delete baseline[path];
		return;
	}
	const written = await io.write(path, server.body);
	baseline[path] = { size: written.size, mtime: written.mtime, etag: server.etag };
}

async function unusedCopy(path: string, io: SyncIO): Promise<string> {
	for (let n = 1; n < 50; n++) {
		const candidate = conflictName(path, n);
		try {
			await io.stat(candidate);
		} catch {
			return candidate;
		}
	}
	throw new Error(`conflict name for ${path}`);
}

function conflictName(path: string, n: number): string {
	const slash = path.lastIndexOf("/");
	const dir = slash === -1 ? "" : path.slice(0, slash + 1);
	const base = slash === -1 ? path : path.slice(slash + 1);
	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const ext = dot > 0 ? base.slice(dot) : "";
	const suffix = n === 1 ? " (conflict)" : ` (conflict ${n})`;
	return `${dir}${stem}${suffix}${ext}`;
}

export function incomingReplacesEditor(editor: Uint8Array, incoming: Uint8Array): boolean {
	return !sameBytes(editor, incoming) && embeds(editor, incoming);
}

function draftChoice(local: Uint8Array, server: Uint8Array, baselineSize: number): "local" | "server" | "same" | "conflict" {
	if (sameBytes(local, server)) return "same";
	if (embeds(server, local) && local.length >= server.length && local.length >= baselineSize) return "local";
	if (embeds(local, server) && server.length >= local.length && local.length >= baselineSize) return "server";
	return "conflict";
}

function embeds(draft: Uint8Array, later: Uint8Array): boolean {
	if (draft.length > later.length) return false;
	let shared = 0;
	const end = draft.length;
	while (shared < end && draft[shared] === later[shared]) shared += 1;
	if (shared === draft.length) return true;
	return indexOfBytes(later, draft.subarray(shared), shared) >= 0;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
	if (needle.length === 0) return from;
	const last = haystack.length - needle.length;
	for (let start = from; start <= last; start += 1) {
		let matched = true;
		for (let offset = 0; offset < needle.length; offset += 1) {
			if (haystack[start + offset] !== needle[offset]) {
				matched = false;
				break;
			}
		}
		if (matched) return start;
	}
	return -1;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
	return true;
}

function gone(error: unknown): boolean {
	return error instanceof Error && error.message === "webdav 404";
}

function yieldToUI(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

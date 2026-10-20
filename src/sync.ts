import { MAX_UPLOAD_BYTES, transferKey, type Action, type BaselineEntry } from "./plan.ts";
import { AuthError, QuotaError, TooLargeError } from "./webdav.ts";

export interface SyncIO {
	read(path: string): Promise<Uint8Array>;
	write(path: string, body: Uint8Array): Promise<{ size: number; mtime: number }>;
	removeLocal(path: string): Promise<void>;
	put(path: string, body: Uint8Array): Promise<{ etag: string }>;
	get(path: string): Promise<{ body: Uint8Array; etag: string }>;
	streamPut?(path: string): Promise<{ etag: string }>;
	streamGet?(path: string, file: { etag: string; size: number }): Promise<{ size: number; mtime: number; etag: string }>;
	removeRemote(path: string): Promise<void>;
	stat(path: string): Promise<{ size: number; mtime: number }>;
}

export interface SyncProgress {
	done: number;
	total: number;
	action: Action;
}

export async function execute(
	actions: Action[],
	io: SyncIO,
	baseline: Record<string, BaselineEntry>,
	progress?: (update: SyncProgress) => void,
): Promise<{
	baseline: Record<string, BaselineEntry>;
	skipped: string[];
	errors: string[];
	failed: { path: string; key: string }[];
	transferred: string[];
	fileLimit?: number;
	abort?: "auth" | "quota";
}> {
	const next = { ...baseline };
	const skipped: string[] = [];
	const errors: string[] = [];
	const failed: { path: string; key: string }[] = [];
	const transferred: string[] = [];
	let fileLimit: number | undefined;
	const work = actions.filter((action) => action.type !== "unchanged" && action.type !== "forget" && action.type !== "paused");
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
		if (action.type === "paused") continue;
		done += 1;
		progress?.({ done, total: work.length, action });
		await yieldToUI();
		try {
			await apply(action, io, next);
			if (action.type === "upload" || action.type === "download") transferred.push(action.path);
			if (action.type === "skip-large") skipped.push(action.path);
		} catch (error) {
			if (error instanceof AuthError) return { baseline: next, skipped, errors, failed, transferred, fileLimit, abort: "auth" };
			if (error instanceof QuotaError) return { baseline: next, skipped, errors, failed, transferred, fileLimit, abort: "quota" };
			if (error instanceof TooLargeError && error.limit > 0) {
				skipped.push(action.path);
				fileLimit = error.limit;
				continue;
			}
			errors.push(`${action.type} ${action.path}: ${error instanceof Error ? error.message : "failed"}`);
			if (action.type === "upload" || action.type === "download") failed.push({ path: action.path, key: transferKey(action.type, action) });
		}
	}
	return { baseline: next, skipped, errors, failed, transferred, fileLimit };
}

async function apply(action: Action, io: SyncIO, baseline: Record<string, BaselineEntry>): Promise<void> {
	switch (action.type) {
		case "upload": {
			if ((action.size ?? 0) > MAX_UPLOAD_BYTES && !io.streamPut) {
				throw new Error("open the desktop app to upload files over 64 MB");
			}
			if (io.streamPut && (action.size ?? 0) > MAX_UPLOAD_BYTES) {
				const put = await io.streamPut(action.path);
				const stat = await io.stat(action.path);
				baseline[action.path] = { size: stat.size, mtime: stat.mtime, etag: put.etag };
				return;
			}
			const body = await io.read(action.path);
			const put = await io.put(action.path, body);
			const stat = await io.stat(action.path);
			baseline[action.path] = { size: stat.size, mtime: stat.mtime, etag: put.etag };
			return;
		}
		case "download": {
			if (io.streamGet) {
				baseline[action.path] = await io.streamGet(action.path, { etag: action.etag ?? "", size: action.size ?? 0 });
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
		default:
			return;
	}
}

function yieldToUI(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

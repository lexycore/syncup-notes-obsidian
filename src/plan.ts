export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

const IGNORED = new Set([".obsidian", ".git", ".syncup", "node_modules"]);

export interface LocalFile {
	path: string;
	size: number;
	mtime: number;
}

export interface RemoteFile {
	path: string;
	size: number;
	mtime: number;
	etag: string;
}

export interface BaselineEntry {
	size: number;
	mtime: number;
	etag: string;
}

export type Action =
	| { type: "upload"; path: string; size?: number }
	| { type: "download"; path: string; size?: number }
	| { type: "delete-local"; path: string }
	| { type: "delete-remote"; path: string }
	| { type: "skip-large"; path: string }
	| { type: "unchanged"; path: string; etag: string; size: number; mtime: number }
	| { type: "forget"; path: string };

const ORDER: Record<Action["type"], number> = {
	"delete-remote": 0,
	"delete-local": 1,
	download: 2,
	upload: 3,
	"skip-large": 4,
	unchanged: 5,
	forget: 6,
};

export function ignored(path: string): boolean {
	return path.split("/").some((part) => IGNORED.has(part));
}

const DIVERGE_MIN = 20;

export function pathsDiffer(local: LocalFile[], remote: RemoteFile[]): boolean {
	const locals = new Set(local.filter((file) => !ignored(file.path)).map((file) => file.path));
	const remotes = new Set(remote.filter((file) => !ignored(file.path)).map((file) => file.path));
	const smaller = Math.min(locals.size, remotes.size);
	if (smaller < DIVERGE_MIN) return false;
	let shared = 0;
	for (const path of locals) if (remotes.has(path)) shared += 1;
	return shared / smaller < 0.5;
}

export function deleteCount(actions: Action[]): number {
	return actions.filter((action) => action.type === "delete-local" || action.type === "delete-remote").length;
}

export function planSync(input: {
	local: LocalFile[];
	remote: RemoteFile[];
	baseline: Record<string, BaselineEntry>;
	fileLimit?: number;
}): Action[] {
	const locals = new Map(input.local.filter((file) => !ignored(file.path)).map((file) => [file.path, file]));
	const remotes = new Map(input.remote.filter((file) => !ignored(file.path)).map((file) => [file.path, file]));
	const paths = new Set<string>([...locals.keys(), ...remotes.keys(), ...Object.keys(input.baseline)]);
	const actions: Action[] = [];
	for (const path of paths) {
		const action = decide(path, locals.get(path), remotes.get(path), input.baseline[path], input.fileLimit);
		if (action) actions.push(action);
	}
	actions.sort((a, b) => ORDER[a.type] - ORDER[b.type] || a.path.localeCompare(b.path));
	return actions;
}

function decide(
	path: string,
	local?: LocalFile,
	remote?: RemoteFile,
	prior?: BaselineEntry,
	fileLimit?: number,
): Action | null {
	if (!local && !remote) return prior ? { type: "forget", path } : null;
	if (!prior) return firstSight(path, local, remote, fileLimit);
	const localChanged = local !== undefined && (local.size !== prior.size || local.mtime !== prior.mtime);
	const remoteChanged = remote !== undefined && remote.etag !== prior.etag;
	if (local && remote) {
		if (!localChanged && !remoteChanged) return unchanged(path, local, remote);
		if (localChanged && !remoteChanged) return uploadOrSkip(path, local, fileLimit);
		if (!localChanged && remoteChanged) return download(remote);
		return newer(local, remote) === "local" ? uploadOrSkip(path, local, fileLimit) : download(remote);
	}
	if (local) return localChanged ? uploadOrSkip(path, local, fileLimit) : { type: "delete-local", path };
	return remote && remoteChanged ? download(remote) : { type: "delete-remote", path };
}

function firstSight(path: string, local?: LocalFile, remote?: RemoteFile, fileLimit?: number): Action {
	if (local && remote) {
		if (local.size === remote.size) return unchanged(path, local, remote);
		return newer(local, remote) === "local" ? uploadOrSkip(path, local, fileLimit) : download(remote);
	}
	if (local) return uploadOrSkip(path, local, fileLimit);
	if (remote) return download(remote);
	return { type: "download", path };
}

function download(remote: RemoteFile): Action {
	return { type: "download", path: remote.path, size: remote.size };
}

function uploadOrSkip(path: string, local: LocalFile, fileLimit?: number): Action {
	if (fileLimit !== undefined && local.size > fileLimit) return { type: "skip-large", path };
	return { type: "upload", path, size: local.size };
}

export function overLimitNotice(paths: string[], fileLimit?: number): string {
	const cap = fileLimit ? `the ${formatBytes(fileLimit)} limit on your plan` : "the limit on your plan";
	if (paths.length === 1) {
		const name = paths[0].split("/").pop() || paths[0];
		return `${name} is larger than ${cap}`;
	}
	return `${paths.length} files are larger than ${cap}`;
}

export function formatBytes(value: number): string {
	const gib = 1024 ** 3;
	const mib = 1024 ** 2;
	if (value >= gib && value % gib === 0) return `${value / gib} GB`;
	if (value >= mib) {
		const mb = value / mib;
		return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
	}
	return `${value} B`;
}

function unchanged(path: string, local: LocalFile, remote: RemoteFile): Action {
	return { type: "unchanged", path, etag: remote.etag, size: local.size, mtime: local.mtime };
}

function newer(local: LocalFile, remote: RemoteFile): "local" | "remote" {
	return Math.floor(local.mtime / 1000) >= Math.floor(remote.mtime / 1000) ? "local" : "remote";
}

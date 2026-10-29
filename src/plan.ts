export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_TRANSFER_ATTEMPTS = 5;

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

export interface TransferAttempt {
	attempts: number;
	key: string;
}

export interface OverLimit {
	limit: number;
	paths: string[];
}

export interface MovedFile {
	from: string;
	path: string;
	etag: string;
	size: number;
	mtime: number;
	changed: boolean;
}

export interface RecordedRename {
	from: string;
	to: string;
}

export type Action =
	| { type: "upload"; path: string; size?: number; mtime?: number; match?: string }
	| { type: "download"; path: string; size?: number; etag?: string }
	| { type: "conflict"; path: string; etag: string; size?: number }
	| { type: "delete-local"; path: string }
	| { type: "delete-remote"; path: string }
	| { type: "move"; from: string; path: string; files: MovedFile[] }
	| { type: "skip-large"; path: string }
	| { type: "parked"; path: string }
	| { type: "paused"; path: string }
	| { type: "unchanged"; path: string; etag: string; size: number; mtime: number }
	| { type: "forget"; path: string };

const ORDER: Record<Action["type"], number> = {
	move: 0,
	upload: 1,
	conflict: 2,
	download: 3,
	"delete-remote": 4,
	"delete-local": 5,
	"skip-large": 6,
	parked: 7,
	unchanged: 8,
	paused: 9,
	forget: 10,
};

export function transferKey(op: "upload" | "download", file: { size?: number; mtime?: number; etag?: string }): string {
	if (op === "download") return `download:${file.etag ?? ""}:${file.size ?? 0}`;
	return `upload:${file.size ?? 0}:${file.mtime ?? 0}`;
}

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
	attempts?: Record<string, TransferAttempt>;
	overLimit?: OverLimit;
	renames?: RecordedRename[];
}): Action[] {
	const locals = new Map(input.local.filter((file) => !ignored(file.path)).map((file) => [file.path, file]));
	const remotes = new Map(input.remote.filter((file) => !ignored(file.path)).map((file) => [file.path, file]));
	const paths = new Set<string>([...locals.keys(), ...remotes.keys(), ...Object.keys(input.baseline)]);
	const parked = input.overLimit && input.fileLimit === input.overLimit.limit ? new Set(input.overLimit.paths) : undefined;
	const actions: Action[] = [];
	for (const path of paths) {
		const action = decide(path, locals.get(path), remotes.get(path), input.baseline[path], input.fileLimit, parked);
		if (action) actions.push(pauseTransfer(action, input.attempts));
	}
	const renamed = rewriteRenames(actions, locals, remotes, input.baseline, foldRenames(input.renames ?? []));
	renamed.sort((a, b) => ORDER[a.type] - ORDER[b.type] || actionSize(a) - actionSize(b) || a.path.localeCompare(b.path));
	return renamed;
}

function decide(
	path: string,
	local?: LocalFile,
	remote?: RemoteFile,
	prior?: BaselineEntry,
	fileLimit?: number,
	parked?: Set<string>,
): Action | null {
	if (!local && !remote) return prior ? { type: "forget", path } : null;
	if (!prior) return firstSight(path, local, remote, fileLimit, parked);
	const localChanged = local !== undefined && (local.size !== prior.size || local.mtime !== prior.mtime);
	const remoteChanged = remote !== undefined && remote.etag !== prior.etag;
	if (local && remote) {
		if (!localChanged && !remoteChanged) return unchanged(path, local, remote);
		if (localChanged && !remoteChanged) return uploadOrSkip(path, local, fileLimit, parked, prior.etag);
		if (!localChanged && remoteChanged) return download(remote);
		return { type: "conflict", path, etag: remote.etag, size: remote.size };
	}
	if (local) return localChanged ? uploadOrSkip(path, local, fileLimit, parked, prior.etag) : { type: "delete-local", path };
	return remote && remoteChanged ? download(remote) : { type: "delete-remote", path };
}

function firstSight(path: string, local?: LocalFile, remote?: RemoteFile, fileLimit?: number, parked?: Set<string>): Action {
	if (local && remote) {
		if (local.size === remote.size) return unchanged(path, local, remote);
		return newer(local, remote) === "local" ? uploadOrSkip(path, local, fileLimit, parked) : download(remote);
	}
	if (local) return uploadOrSkip(path, local, fileLimit, parked);
	if (remote) return download(remote);
	return { type: "download", path };
}

function download(remote: RemoteFile): Action {
	return { type: "download", path: remote.path, size: remote.size, etag: remote.etag };
}

function uploadOrSkip(path: string, local: LocalFile, fileLimit?: number, parked?: Set<string>, match?: string): Action {
	if (fileLimit !== undefined && local.size > fileLimit) {
		return parked?.has(path) ? { type: "parked", path } : { type: "skip-large", path };
	}
	const upload: Action = { type: "upload", path, size: local.size, mtime: local.mtime };
	if (!match || upload.type !== "upload") return upload;
	return { ...upload, match };
}

function pauseTransfer(action: Action, attempts?: Record<string, TransferAttempt>): Action {
	if ((action.type !== "upload" && action.type !== "download") || !attempts) return action;
	const key = transferKey(action.type, action);
	const prior = attempts[action.path];
	if (prior && prior.key === key && prior.attempts >= MAX_TRANSFER_ATTEMPTS) return { type: "paused", path: action.path };
	return action;
}

export function nextOverLimit(limit: number | undefined, parked: string[], skipped: string[], prior?: OverLimit): OverLimit | undefined {
	if (limit === undefined) return prior;
	const paths = [...new Set([...parked, ...skipped])].sort();
	return { limit, paths };
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

function rewriteRenames(
	actions: Action[],
	local: Map<string, LocalFile>,
	remote: Map<string, RemoteFile>,
	baseline: Record<string, BaselineEntry>,
	renames: RecordedRename[],
): Action[] {
	const hinted = hintedMoves(renames, local, remote, baseline);
	const removed = actions.filter((action) => action.type === "delete-remote" && remote.has(action.path) && baseline[action.path]).map((action) => action.path);
	const added = actions.filter((action) => action.type === "upload" && !remote.has(action.path) && !baseline[action.path]).map((action) => action.path);
	if (removed.length === 0 || added.length === 0) return finishRenames(actions, hinted);
	const moves = directoryMoves(removed, added, local, remote, baseline);
	const usedFrom = new Set<string>(hinted.moves.flatMap((move) => move.files.map((file) => file.from)));
	const usedTo = new Set<string>(hinted.moves.flatMap((move) => move.files.map((file) => file.path)));
	for (const move of moves) {
		for (const file of move.files) {
			usedFrom.add(file.from);
			usedTo.add(file.path);
		}
	}
	for (const move of fileMoves(removed, added, local, remote, baseline, usedFrom, usedTo)) moves.push(move);
	for (const move of moves) {
		for (const file of move.files) usedTo.add(file.path);
	}
	if (moves.length === 0 && hinted.moves.length === 0) return actions;
	return finishRenames(actions, { moves: hinted.moves.concat(moves), leftovers: hinted.leftovers }, usedFrom, usedTo);
}

function finishRenames(
	actions: Action[],
	hinted: { moves: Extract<Action, { type: "move" }>[]; leftovers: Set<string> },
	usedFrom = new Set<string>(hinted.moves.flatMap((move) => move.files.map((file) => file.from))),
	usedTo = new Set<string>(hinted.moves.flatMap((move) => move.files.map((file) => file.path))),
): Action[] {
	if (hinted.moves.length === 0) return actions;
	const kept = actions.filter((action) => {
		if (action.type === "unchanged" && hinted.leftovers.has(action.path)) return false;
		if (action.type === "delete-remote" && usedFrom.has(action.path)) return false;
		if (action.type !== "upload" || !usedTo.has(action.path)) return true;
		return hinted.moves.some((move) => move.files.some((file) => file.path === action.path && file.changed));
	});
	const deletes = [...hinted.leftovers].map((path): Action => ({ type: "delete-local", path }));
	return kept.concat(hinted.moves, deletes);
}

export function rememberRename(renames: RecordedRename[], from: string, to: string): RecordedRename[] {
	if (!from || !to || from === to) return foldRenames(renames);
	return foldRenames([...renames, { from, to }]);
}

export function retainRenames(input: {
	renames: RecordedRename[];
	actions: Action[];
	succeeded: boolean;
	local: LocalFile[];
	remote: RemoteFile[];
	baseline: Record<string, BaselineEntry>;
}): RecordedRename[] {
	const local = new Map(input.local.map((file) => [file.path, file]));
	const remote = new Map(input.remote.map((file) => [file.path, file]));
	return foldRenames(input.renames).filter((hint) => {
		if (!hintedMove(hint, local, remote, input.baseline)) return false;
		const planned = input.actions.some((action) => action.type === "move" && action.files.some((file) => file.from === hint.from && file.path === hint.to));
		return !(planned && input.succeeded);
	});
}

function foldRenames(renames: RecordedRename[]): RecordedRename[] {
	const latest = new Map<string, string>();
	for (const hint of renames) {
		if (!hint.from || !hint.to || hint.from === hint.to) continue;
		let origin = hint.from;
		for (const [start, dest] of latest) {
			if (dest !== hint.from) continue;
			origin = start;
			latest.delete(start);
			break;
		}
		latest.set(origin, hint.to);
	}
	return [...latest].filter(([from, to]) => from !== to).map(([from, to]) => ({ from, to }));
}

function hintedMoves(
	renames: RecordedRename[],
	local: Map<string, LocalFile>,
	remote: Map<string, RemoteFile>,
	baseline: Record<string, BaselineEntry>,
): { moves: Extract<Action, { type: "move" }>[]; leftovers: Set<string> } {
	const moves: Extract<Action, { type: "move" }>[] = [];
	const leftovers = new Set<string>();
	for (const hint of renames) {
		const move = hintedMove(hint, local, remote, baseline);
		if (!move) continue;
		moves.push(move.action);
		if (move.leftover) leftovers.add(hint.from);
	}
	return { moves, leftovers };
}

function hintedMove(
	hint: RecordedRename,
	local: Map<string, LocalFile>,
	remote: Map<string, RemoteFile>,
	baseline: Record<string, BaselineEntry>,
): { action: Extract<Action, { type: "move" }>; leftover: boolean } | null {
	const prior = baseline[hint.from];
	const onServer = remote.get(hint.from);
	const destination = local.get(hint.to);
	const source = local.get(hint.from);
	if (!prior || !onServer || !destination || hint.from === hint.to) return null;
	if (onServer.etag !== prior.etag || remote.has(hint.to) || baseline[hint.to]) return null;
	if (source && (source.size !== prior.size || source.mtime !== prior.mtime)) return null;
	const file: MovedFile = {
		from: hint.from,
		path: hint.to,
		etag: prior.etag,
		size: destination.size,
		mtime: destination.mtime,
		changed: destination.size !== onServer.size,
	};
	return { leftover: source !== undefined, action: { type: "move", from: hint.from, path: hint.to, files: [file] } };
}

function directoryMoves(
	removed: string[],
	added: string[],
	local: Map<string, LocalFile>,
	remote: Map<string, RemoteFile>,
	baseline: Record<string, BaselineEntry>,
): Extract<Action, { type: "move" }>[] {
	const removedSet = new Set(removed);
	const byName = new Map<string, string[]>();
	for (const path of added) {
		const name = baseName(path);
		const list = byName.get(name) ?? [];
		list.push(path);
		byName.set(name, list);
	}
	const groups = new Map<string, { from: string; to: string }>();
	for (const oldPath of removed) {
		const prior = remote.get(oldPath);
		if (!prior) continue;
		for (const newPath of byName.get(baseName(oldPath)) ?? []) {
			const next = local.get(newPath);
			if (!next || next.size !== prior.size) continue;
			const split = splitPrefix(oldPath, newPath);
			if (!split) continue;
			groups.set(`${split.from}\0${split.to}`, split);
		}
	}
	const accepted: Extract<Action, { type: "move" }>[] = [];
	const candidates = [...groups.values()].sort((a, b) => a.from.length - b.from.length);
	for (const candidate of candidates) {
		if (accepted.some((done) => candidate.from === done.from || candidate.from.startsWith(`${done.from}/`))) continue;
		const files = movedFiles(candidate.from, candidate.to, removedSet, local, remote, baseline);
		if (!files) continue;
		accepted.push({ type: "move", from: candidate.from, path: candidate.to, files });
	}
	return accepted;
}

function movedFiles(
	from: string,
	to: string,
	removed: Set<string>,
	local: Map<string, LocalFile>,
	remote: Map<string, RemoteFile>,
	baseline: Record<string, BaselineEntry>,
): MovedFile[] | null {
	if (pathsUnder(local.keys(), from).length > 0 || pathsUnder(remote.keys(), to).length > 0) return null;
	const under = pathsUnder(remote.keys(), from);
	if (under.length === 0) return null;
	const files: MovedFile[] = [];
	for (const oldPath of under) {
		if (!removed.has(oldPath)) return null;
		const rel = oldPath.slice(from.length + 1);
		const newPath = `${to}/${rel}`;
		const loc = local.get(newPath);
		const prior = remote.get(oldPath);
		const remembered = baseline[oldPath];
		if (!loc || !prior || !remembered) return null;
		files.push({
			from: oldPath,
			path: newPath,
			etag: remembered.etag,
			size: loc.size,
			mtime: loc.mtime,
			changed: loc.size !== prior.size,
		});
	}
	return files;
}

function fileMoves(
	removed: string[],
	added: string[],
	local: Map<string, LocalFile>,
	remote: Map<string, RemoteFile>,
	baseline: Record<string, BaselineEntry>,
	usedFrom: Set<string>,
	usedTo: Set<string>,
): Extract<Action, { type: "move" }>[] {
	const left = removed.filter((path) => !usedFrom.has(path));
	const right = added.filter((path) => !usedTo.has(path));
	const bySize = (paths: string[], sizeOf: (path: string) => number) => {
		const groups = new Map<number, string[]>();
		for (const path of paths) {
			const size = sizeOf(path);
			const list = groups.get(size) ?? [];
			list.push(path);
			groups.set(size, list);
		}
		return groups;
	};
	const oldBySize = bySize(left, (path) => remote.get(path)?.size ?? -1);
	const newBySize = bySize(right, (path) => local.get(path)?.size ?? -2);
	const moves: Extract<Action, { type: "move" }>[] = [];
	for (const [size, oldPaths] of oldBySize) {
		const newPaths = newBySize.get(size);
		if (size < 0 || oldPaths.length !== 1 || !newPaths || newPaths.length !== 1) continue;
		const oldPath = oldPaths[0];
		const newPath = newPaths[0];
		const loc = local.get(newPath);
		const remembered = baseline[oldPath];
		if (!loc || !remembered || remote.has(newPath)) continue;
		const file: MovedFile = { from: oldPath, path: newPath, etag: remembered.etag, size: loc.size, mtime: loc.mtime, changed: false };
		moves.push({ type: "move", from: oldPath, path: newPath, files: [file] });
		usedFrom.add(oldPath);
	}
	return moves;
}

function pathsUnder(paths: Iterable<string>, prefix: string): string[] {
	const root = `${prefix}/`;
	const under: string[] = [];
	for (const path of paths) if (path.startsWith(root)) under.push(path);
	return under;
}

function splitPrefix(oldPath: string, newPath: string): { from: string; to: string } | null {
	const oldParts = oldPath.split("/");
	const newParts = newPath.split("/");
	let oldEnd = oldParts.length - 1;
	let newEnd = newParts.length - 1;
	while (oldEnd >= 0 && newEnd >= 0 && oldParts[oldEnd] === newParts[newEnd]) {
		oldEnd -= 1;
		newEnd -= 1;
	}
	if (oldEnd === oldParts.length - 1 || oldEnd < 0 || newEnd < 0) return null;
	const from = oldParts.slice(0, oldEnd + 1).join("/");
	const to = newParts.slice(0, newEnd + 1).join("/");
	if (!from || !to || from === to) return null;
	return { from, to };
}

function actionSize(action: Action): number {
	if (action.type === "upload" || action.type === "download" || action.type === "conflict") return action.size ?? 0;
	if (action.type === "move") return action.files.reduce((sum, file) => sum + file.size, 0);
	return 0;
}

function baseName(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? path : path.slice(slash + 1);
}

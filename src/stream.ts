import { AuthError, ConflictError, QuotaError, TooLargeError, cleanEtag, limitBytes } from "./webdav.ts";

declare function require(id: string): unknown;

interface Fs {
	statSync(file: string): { size: number };
	mkdirSync(dir: string, options: { recursive: boolean }): void;
	readFileSync(file: string, encoding: "utf8"): string;
	writeFileSync(file: string, data: string): void;
	createReadStream(file: string, options?: { start?: number }): Readable;
	createWriteStream(file: string, options?: { flags?: string }): Writable;
	renameSync(from: string, to: string): void;
	rmSync(file: string, options?: { force?: boolean }): void;
}

interface Path {
	sep: string;
	resolve(...parts: string[]): string;
	dirname(file: string): string;
	join(...parts: string[]): string;
}

interface Readable {
	pipe(dest: Writable): void;
	on(event: "error", cb: (error: Error) => void): void;
	on(event: "end", cb: () => void): void;
	resume(): void;
}

interface Writable {
	on(event: "error", cb: (error: Error) => void): void;
	on(event: "finish", cb: () => void): void;
	destroy(error?: Error): void;
	end(): void;
}

interface Incoming extends Readable {
	statusCode?: number;
	headers: Record<string, string | string[] | undefined>;
}

interface ClientRequest extends Writable {
	destroy(error?: Error): void;
}

interface Http {
	request(url: URL, options: { method: string; headers: Record<string, string> }, cb: (res: Incoming) => void): ClientRequest;
}

export interface NodeModules {
	fs: Fs;
	http: Http;
	https: Http;
	path: Path;
}

export function desktopModules(): NodeModules | null {
	try {
		return {
			fs: require("fs") as Fs,
			http: require("http") as Http,
			https: require("https") as Http,
			path: require("path") as Path,
		};
	} catch {
		return null;
	}
}

export function vaultFile(modules: NodeModules, base: string, vaultPath: string): string {
	const root = modules.path.resolve(base);
	const parts = vaultPath.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("invalid path");
	const full = modules.path.resolve(root, ...parts);
	if (full !== root && !full.startsWith(root + modules.path.sep)) throw new Error("invalid path");
	return full;
}

export function partialFile(modules: NodeModules, base: string, vaultPath: string): string {
	// One encoded filename exceeds NAME_MAX once the vault path contains Cyrillic.
	// Mirror the vault path so each component stays as short as the real file.
	const staging = modules.path.join(modules.path.resolve(base), ".syncup", "partial");
	return vaultFile(modules, staging, vaultPath);
}

export function partialMeta(partial: string): string {
	return `${partial}.meta`;
}

export function preparePartial(modules: NodeModules, partial: string, etag: string, size: number): number {
	const offset = keptOffset(modules, partial, etag, size);
	if (offset === 0) {
		try {
			modules.fs.rmSync(partial, { force: true });
		} catch {
			// Nothing to discard.
		}
		try {
			modules.fs.rmSync(partialMeta(partial), { force: true });
		} catch {
			// Nothing to discard.
		}
	}
	modules.fs.mkdirSync(modules.path.dirname(partial), { recursive: true });
	modules.fs.writeFileSync(partialMeta(partial), JSON.stringify({ etag, size }));
	return offset;
}

export function forgetPartialMeta(modules: NodeModules, partial: string): void {
	try {
		modules.fs.rmSync(partialMeta(partial), { force: true });
	} catch {
		// The resume note is already gone.
	}
}

function keptOffset(modules: NodeModules, partial: string, etag: string, size: number): number {
	if (!etag || size <= 0) return 0;
	let have = 0;
	try {
		have = modules.fs.statSync(partial).size;
	} catch {
		return 0;
	}
	let meta: { etag?: string; size?: number };
	try {
		meta = JSON.parse(modules.fs.readFileSync(partialMeta(partial), "utf8")) as { etag?: string; size?: number };
	} catch {
		return 0;
	}
	if (meta.etag !== etag || meta.size !== size || have <= 0 || have >= size) return 0;
	return have;
}

export async function streamUpload(modules: NodeModules, file: string, url: string, headers: Record<string, string>, resume = false): Promise<string> {
	const size = modules.fs.statSync(file).size;
	const target = new URL(url);
	const client = target.protocol === "https:" ? modules.https : modules.http;
	let offset = 0;
	if (resume && size > 0) {
		const probed = await uploadOffset(client, target, headers, size);
		if (probed.etag) return probed.etag;
		offset = probed.offset > 0 && probed.offset < size ? probed.offset : 0;
	}
	const length = size - offset;
	const putHeaders: Record<string, string> = { ...headers, "Content-Length": String(length) };
	if (resume && size > 0) putHeaders["Content-Range"] = `bytes ${offset}-${Math.max(offset, size - 1)}/${size}`;
	return new Promise((resolve, reject) => {
		const req = client.request(target, { method: "PUT", headers: putHeaders }, (res) => {
			settle(res, resolve, reject);
		});
		req.on("error", reject);
		const body = modules.fs.createReadStream(file, offset > 0 ? { start: offset } : undefined);
		body.on("error", (error) => {
			req.destroy(error);
			reject(error);
		});
		body.pipe(req);
	});
}

function uploadOffset(client: Http, target: URL, headers: Record<string, string>, size: number): Promise<{ offset: number; etag?: string }> {
	return new Promise((resolve, reject) => {
		const req = client.request(
			target,
			{ method: "PUT", headers: { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": "0" } },
			(res) => {
				const status = res.statusCode ?? 0;
				const offset = Number(oneHeader(res.headers, "x-syncup-offset"));
				const etag = cleanEtag(oneHeader(res.headers, "etag"));
				res.on("end", () => {
					if (status >= 400) {
						reject(statusError(status, res.headers) ?? new Error(`webdav ${status}`));
						return;
					}
					if ((status === 200 || status === 201) && etag) {
						resolve({ offset: size, etag });
						return;
					}
					resolve({ offset: Number.isSafeInteger(offset) && offset > 0 ? offset : 0 });
				});
				res.resume();
			},
		);
		req.on("error", reject);
		req.end();
	});
}

export function streamDownload(modules: NodeModules, dest: string, partial: string, url: string, headers: Record<string, string>, offset = 0): Promise<string> {
	modules.fs.mkdirSync(modules.path.dirname(partial), { recursive: true });
	modules.fs.mkdirSync(modules.path.dirname(dest), { recursive: true });
	const target = new URL(url);
	const client = target.protocol === "https:" ? modules.https : modules.http;
	const getHeaders = offset > 0 ? { ...headers, Range: `bytes=${offset}-` } : headers;
	return new Promise<string>((resolve, reject) => {
		const req = client.request(target, { method: "GET", headers: getHeaders }, (res) => {
			const status = res.statusCode ?? 0;
			const failed = statusError(status, res.headers);
			if (failed) {
				res.resume();
				reject(failed);
				return;
			}
			const rewrite = offset === 0 || status === 200;
			const out = modules.fs.createWriteStream(partial, { flags: rewrite ? "w" : "a" });
			res.on("error", reject);
			out.on("error", reject);
			out.on("finish", () => {
				try {
					modules.fs.renameSync(partial, dest);
					resolve(cleanEtag(oneHeader(res.headers, "etag")));
				} catch (error) {
					reject(error instanceof Error ? error : new Error("rename failed"));
				}
			});
			res.pipe(out);
		});
		req.on("error", reject);
		req.end();
	});
}

function settle(res: Incoming, resolve: (etag: string) => void, reject: (error: Error) => void): void {
	const failed = statusError(res.statusCode ?? 0, res.headers);
	res.on("error", reject);
	res.on("end", () => {
		if (failed) reject(failed);
		else resolve(cleanEtag(oneHeader(res.headers, "etag")));
	});
	res.resume();
}

function statusError(status: number, headers?: Record<string, string | string[] | undefined>): Error | null {
	if (status === 401 || status === 403) return new AuthError();
	if (status === 507) return new QuotaError();
	if (status === 412) return new ConflictError();
	if (status === 413) return new TooLargeError(limitBytes(oneHeader(headers ?? {}, "x-syncup-file-limit")));
	if (status >= 400) return new Error(`webdav ${status}`);
	return null;
}

function oneHeader(headers: Record<string, string | string[] | undefined>, name: string): string {
	const value = headers[name] ?? headers[name.toLowerCase()];
	if (Array.isArray(value)) return value[0] ?? "";
	return value ?? "";
}

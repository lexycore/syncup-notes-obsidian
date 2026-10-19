import { AuthError, QuotaError, TooLargeError, cleanEtag, limitBytes } from "./webdav.ts";

declare function require(id: string): unknown;

interface Fs {
	statSync(file: string): { size: number };
	mkdirSync(dir: string, options: { recursive: boolean }): void;
	createReadStream(file: string): Readable;
	createWriteStream(file: string): Writable;
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
	return modules.path.join(modules.path.resolve(base), ".syncup", "partial", encodeURIComponent(vaultPath));
}

export function streamUpload(modules: NodeModules, file: string, url: string, headers: Record<string, string>): Promise<string> {
	const size = modules.fs.statSync(file).size;
	const target = new URL(url);
	const client = target.protocol === "https:" ? modules.https : modules.http;
	return new Promise((resolve, reject) => {
		const req = client.request(target, { method: "PUT", headers: { ...headers, "Content-Length": String(size) } }, (res) => {
			settle(res, resolve, reject);
		});
		req.on("error", reject);
		const body = modules.fs.createReadStream(file);
		body.on("error", (error) => {
			req.destroy(error);
			reject(error);
		});
		body.pipe(req);
	});
}

export function streamDownload(modules: NodeModules, dest: string, partial: string, url: string, headers: Record<string, string>): Promise<string> {
	modules.fs.mkdirSync(modules.path.dirname(partial), { recursive: true });
	modules.fs.mkdirSync(modules.path.dirname(dest), { recursive: true });
	const target = new URL(url);
	const client = target.protocol === "https:" ? modules.https : modules.http;
	return new Promise<string>((resolve, reject) => {
		const req = client.request(target, { method: "GET", headers }, (res) => {
			const failed = statusError(res.statusCode ?? 0, res.headers);
			if (failed) {
				res.resume();
				reject(failed);
				return;
			}
			const out = modules.fs.createWriteStream(partial);
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
	}).finally(() => {
		try {
			modules.fs.rmSync(partial, { force: true });
		} catch {
			// Renamed into the vault, or it was never created.
		}
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
	if (status === 413) return new TooLargeError(limitBytes(oneHeader(headers ?? {}, "x-syncup-file-limit")));
	if (status >= 400) return new Error(`webdav ${status}`);
	return null;
}

function oneHeader(headers: Record<string, string | string[] | undefined>, name: string): string {
	const value = headers[name] ?? headers[name.toLowerCase()];
	if (Array.isArray(value)) return value[0] ?? "";
	return value ?? "";
}

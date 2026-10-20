export interface HttpRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: Uint8Array;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	body: Uint8Array;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

export class AuthError extends Error {
	constructor() {
		super("unauthorized");
		this.name = "AuthError";
	}
}

export class QuotaError extends Error {
	constructor() {
		super("quota");
		this.name = "QuotaError";
	}
}

export class TooLargeError extends Error {
	readonly limit: number;

	constructor(limit = 0) {
		super("too large");
		this.name = "TooLargeError";
		this.limit = limit;
	}
}

export interface RemoteListing {
	files: RemoteFile[];
	fileLimit?: number;
	resume: boolean;
}

export interface WebDavConfig {
	server: string;
	folder: string;
	username: string;
	password: string;
}

export interface RemoteFile {
	path: string;
	size: number;
	mtime: number;
	etag: string;
}

export class WebDav {
	private readonly http: HttpClient;
	private readonly config: WebDavConfig;

	constructor(http: HttpClient, config: WebDavConfig) {
		this.http = http;
		this.config = config;
	}

	async list(): Promise<RemoteListing> {
		const response = await this.request("PROPFIND", folderUrl(this.config), { Depth: "infinity" });
		const limit = limitBytes(header(response.headers, "x-syncup-file-limit"));
		return {
			files: filesFromPropfind(new TextDecoder().decode(response.body), prefixPath(this.config)),
			fileLimit: limit || undefined,
			resume: header(response.headers, "x-syncup-resume") === "1",
		};
	}

	async put(path: string, body: Uint8Array): Promise<{ etag: string }> {
		const response = await this.request("PUT", fileUrl(this.config, path), {}, body);
		return { etag: cleanEtag(header(response.headers, "etag")) };
	}

	async get(path: string): Promise<{ body: Uint8Array; etag: string }> {
		const response = await this.request("GET", fileUrl(this.config, path));
		return { body: response.body, etag: cleanEtag(header(response.headers, "etag")) };
	}

	async remove(path: string): Promise<void> {
		await this.request("DELETE", fileUrl(this.config, path));
	}

	fileURL(path: string): string {
		return fileUrl(this.config, path);
	}

	authHeader(): string {
		return basicAuth(this.config.username, this.config.password);
	}

	private async request(method: string, url: string, extra: Record<string, string> = {}, body?: Uint8Array): Promise<HttpResponse> {
		const response = await this.http({
			method,
			url,
			headers: { Authorization: basicAuth(this.config.username, this.config.password), ...extra },
			body,
		});
		if (response.status === 401 || response.status === 403) throw new AuthError();
		if (response.status === 507) throw new QuotaError();
		if (response.status === 413) throw new TooLargeError(limitBytes(header(response.headers, "x-syncup-file-limit")));
		if (response.status >= 400) throw new Error(`webdav ${response.status}`);
		return response;
	}
}

export function filesFromPropfind(xml: string, prefix: string): RemoteFile[] {
	const root = prefix.replace(/\/+$/, "");
	const files: RemoteFile[] = [];
	for (const block of tagBlocks(xml, "response")) {
		if (isCollection(block)) continue;
		const href = tagText(block, "href");
		const path = vaultPath(href, root);
		if (!path) continue;
		files.push({
			path,
			size: Number(tagText(block, "getcontentlength")) || 0,
			mtime: Date.parse(tagText(block, "getlastmodified")) || 0,
			etag: cleanEtag(tagText(block, "getetag")),
		});
	}
	return files;
}

function fileUrl(config: WebDavConfig, path: string): string {
	const base = config.server.replace(/\/+$/, "");
	const parts = [...config.folder.split("/"), ...path.split("/")].filter(Boolean).map(encodeURIComponent);
	return `${base}/${parts.join("/")}`;
}

function folderUrl(config: WebDavConfig): string {
	const url = fileUrl(config, "");
	return url.endsWith("/") ? url : `${url}/`;
}

function prefixPath(config: WebDavConfig): string {
	const pathname = new URL(config.server).pathname.replace(/\/+$/, "");
	const folder = config.folder.split("/").filter(Boolean);
	return [pathname, ...folder].filter(Boolean).join("/");
}

function vaultPath(href: string, root: string): string | null {
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

function isCollection(block: string): boolean {
	return /<(?:[\w-]+:)?collection\b/i.test(block);
}

function tagBlocks(xml: string, tag: string): string[] {
	const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "gi");
	return [...xml.matchAll(re)].map((match) => match[1]);
}

function tagText(xml: string, tag: string): string {
	const match = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "i"));
	return match ? unescapeXml(match[1].trim()) : "";
}

function unescapeXml(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

export function cleanEtag(value: string): string {
	let etag = value.trim();
	if (etag.toLowerCase().startsWith("w/")) etag = etag.slice(2).trim();
	if (etag.startsWith('"') && etag.endsWith('"') && etag.length >= 2) etag = etag.slice(1, -1);
	return etag;
}

export function limitBytes(raw: string): number {
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function header(headers: Record<string, string>, name: string): string {
	const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
	return found ? found[1] : "";
}

function basicAuth(username: string, password: string): string {
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `Basic ${btoa(binary)}`;
}

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { partialFile, streamDownload, streamUpload, vaultFile, type NodeModules } from "./stream.ts";

const modules = { fs, http, https: http, path } as unknown as NodeModules;

test("a vault path cannot escape the vault directory", () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "syncup-vault-"));
	assert.equal(vaultFile(modules, base, "notes/a.md"), path.join(base, "notes", "a.md"));
	const vaultPath = "Импульс/speakers/Олег Маковельский/2026-08-26/Impulse - Олег Дмитрий.mp4";
	const partial = partialFile(modules, base, vaultPath);
	assert.equal(partial, path.join(base, ".syncup", "partial", ...vaultPath.split("/")));
	assert.ok(Buffer.byteLength(path.basename(partial)) <= 255);
	assert.throws(() => vaultFile(modules, base, "../outside.txt"));
	assert.throws(() => partialFile(modules, base, "../outside.txt"));
	fs.rmSync(base, { recursive: true, force: true });
});

test("desktop upload and download stream the file without buffering it in the caller", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncup-stream-"));
	const source = path.join(dir, "source.bin");
	const dest = path.join(dir, "vault", "video.bin");
	const partial = path.join(dir, "vault", ".syncup", "partial", "video.bin");
	const payload = Buffer.from("large-enough");
	fs.writeFileSync(source, payload);
	const server = http.createServer((req, res) => {
		if (req.method === "PUT") {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => {
				assert.equal(Buffer.concat(chunks).toString(), payload.toString());
				res.setHeader("etag", '"abc"');
				res.statusCode = 201;
				res.end();
			});
			return;
		}
		res.setHeader("etag", '"abc"');
		res.end(payload);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	const url = `http://127.0.0.1:${address.port}/video.bin`;
	try {
		assert.equal(await streamUpload(modules, source, url, { Authorization: "Basic eA==" }), "abc");
		assert.equal(await streamDownload(modules, dest, partial, url, {}), "abc");
		assert.equal(fs.readFileSync(dest).toString(), payload.toString());
		assert.equal(fs.existsSync(partial), false);
	} finally {
		server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a download continues from the bytes already on disk", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncup-resume-"));
	const dest = path.join(dir, "vault", "clip.mp4");
	const partial = path.join(dir, "vault", ".syncup", "partial", "clip.mp4");
	const payload = Buffer.from("helloworld");
	fs.mkdirSync(path.dirname(partial), { recursive: true });
	fs.writeFileSync(partial, payload.subarray(0, 5));
	const server = http.createServer((req, res) => {
		assert.equal(req.headers.range, "bytes=5-");
		res.statusCode = 206;
		res.setHeader("etag", '"abc"');
		res.setHeader("Content-Range", "bytes 5-9/10");
		res.end(payload.subarray(5));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	try {
		const etag = await streamDownload(modules, dest, partial, `http://127.0.0.1:${address.port}/clip.mp4`, {}, 5);
		assert.equal(etag, "abc");
		assert.equal(fs.readFileSync(dest).toString(), "helloworld");
	} finally {
		server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed download leaves the partial file in place", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncup-keep-"));
	const dest = path.join(dir, "vault", "clip.mp4");
	const partial = path.join(dir, "vault", ".syncup", "partial", "clip.mp4");
	fs.mkdirSync(path.dirname(partial), { recursive: true });
	fs.writeFileSync(partial, "abcd");
	const server = http.createServer((_req, res) => {
		res.statusCode = 500;
		res.end("nope");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	try {
		await assert.rejects(streamDownload(modules, dest, partial, `http://127.0.0.1:${address.port}/clip.mp4`, {}, 4));
		assert.equal(fs.readFileSync(partial).toString(), "abcd");
	} finally {
		server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("an upload continues from the offset the server kept", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncup-upload-"));
	const source = path.join(dir, "clip.mp4");
	const payload = Buffer.from("helloworld");
	fs.writeFileSync(source, payload);
	const server = http.createServer((req, res) => {
		if (req.headers["content-range"] === "bytes */10") {
			res.setHeader("x-syncup-offset", "5");
			res.statusCode = 204;
			res.end();
			return;
		}
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			assert.equal(req.headers["content-range"], "bytes 5-9/10");
			assert.equal(Buffer.concat(chunks).toString(), "world");
			res.setHeader("etag", '"abc"');
			res.statusCode = 201;
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	try {
		assert.equal(await streamUpload(modules, source, `http://127.0.0.1:${address.port}/clip.mp4`, {}, true), "abc");
	} finally {
		server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

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
	assert.equal(path.dirname(partialFile(modules, base, "notes/a.md")), path.join(base, ".syncup", "partial"));
	assert.throws(() => vaultFile(modules, base, "../outside.txt"));
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

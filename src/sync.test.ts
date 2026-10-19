import assert from "node:assert/strict";
import test from "node:test";
import { MAX_UPLOAD_BYTES, type Action, type BaselineEntry } from "./plan.ts";
import { execute, type SyncIO } from "./sync.ts";
import { QuotaError, TooLargeError } from "./webdav.ts";

test("an upload records the server etag and the local mtime", async () => {
	const baseline: Record<string, BaselineEntry> = {};
	const io = fake({
		read: async () => new Uint8Array([1, 2, 3]),
		put: async () => ({ etag: "sha" }),
		stat: async () => ({ size: 3, mtime: 5_000 }),
	});
	const result = await execute([{ type: "upload", path: "a.md" }], io, baseline);
	assert.deepEqual(result.baseline["a.md"], { size: 3, mtime: 5_000, etag: "sha" });
	assert.deepEqual(result.errors, []);
});

test("a large upload streams from disk instead of reading the whole file", async () => {
	let read = false;
	const io = fake({
		streamPut: async () => ({ etag: "stream" }),
		stat: async () => ({ size: 9, mtime: 3 }),
		read: async () => {
			read = true;
			return new Uint8Array();
		},
	});
	const result = await execute([{ type: "upload", path: "big.bin", size: MAX_UPLOAD_BYTES + 1 }], io, {});
	assert.equal(read, false);
	assert.equal(result.baseline["big.bin"].etag, "stream");
});

test("a download writes the body and keeps the new local mtime", async () => {
	const io = fake({
		get: async () => ({ body: new Uint8Array([4]), etag: "new" }),
		write: async () => ({ size: 1, mtime: 8_000 }),
	});
	const result = await execute([{ type: "download", path: "a.md" }], io, { "a.md": { size: 3, mtime: 1, etag: "old" } });
	assert.deepEqual(result.baseline["a.md"], { size: 1, mtime: 8_000, etag: "new" });
});

test("one file error does not stop the next file", async () => {
	const seen: string[] = [];
	const io = fake({
		read: async (path) => {
			seen.push(path);
			if (path === "bad.md") throw new Error("disk");
			return new Uint8Array([1]);
		},
		put: async () => ({ etag: "ok" }),
		stat: async () => ({ size: 1, mtime: 2 }),
	});
	const actions: Action[] = [{ type: "upload", path: "bad.md" }, { type: "upload", path: "ok.md" }];
	const result = await execute(actions, io, {});
	assert.deepEqual(seen, ["bad.md", "ok.md"]);
	assert.equal(result.errors.length, 1);
	assert.equal(result.baseline["ok.md"].etag, "ok");
});

test("a full storage error keeps files already uploaded", async () => {
	const io = fake({
		read: async () => new Uint8Array([1]),
		put: async (path) => {
			if (path === "b.md") throw new QuotaError();
			return { etag: "ok" };
		},
		stat: async () => ({ size: 1, mtime: 2 }),
	});
	const result = await execute(
		[{ type: "upload", path: "a.md" }, { type: "upload", path: "b.md" }, { type: "upload", path: "c.md" }],
		io,
		{},
	);
	assert.equal(result.abort, "quota");
	assert.equal(result.baseline["a.md"].etag, "ok");
	assert.equal(result.baseline["c.md"], undefined);
});

test("a file over the plan limit is skipped and the next file still uploads", async () => {
	const io = fake({
		streamPut: async (path) => {
			if (path === "talk.mp4") throw new TooLargeError(512 * 1024 * 1024);
			return { etag: "stream" };
		},
		put: async () => ({ etag: "ok" }),
		stat: async () => ({ size: 2, mtime: 3 }),
	});
	const result = await execute(
		[
			{ type: "upload", path: "talk.mp4", size: 732 * 1024 * 1024 },
			{ type: "upload", path: "ok.md", size: 2 },
		],
		io,
		{},
	);
	assert.deepEqual(result.skipped, ["talk.mp4"]);
	assert.equal(result.fileLimit, 512 * 1024 * 1024);
	assert.equal(result.baseline["ok.md"].etag, "ok");
	assert.equal(result.errors.length, 0);
});

function fake(impl: Partial<SyncIO>): SyncIO {
	return {
		read: async () => new Uint8Array(),
		write: async () => ({ size: 0, mtime: 0 }),
		removeLocal: async () => {},
		put: async () => ({ etag: "" }),
		get: async () => ({ body: new Uint8Array(), etag: "" }),
		removeRemote: async () => {},
		stat: async () => ({ size: 0, mtime: 0 }),
		...impl,
	};
}

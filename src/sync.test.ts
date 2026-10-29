import assert from "node:assert/strict";
import test from "node:test";
import { MAX_UPLOAD_BYTES, type Action, type BaselineEntry } from "./plan.ts";
import { execute, incomingReplacesEditor, type SyncIO } from "./sync.ts";
import { ConflictError, QuotaError, TooLargeError } from "./webdav.ts";

test("a change during a sync stops the run so the new plan can start", async () => {
	const seen: string[] = [];
	let queued = false;
	const io = fake({
		read: async () => new Uint8Array([1]),
		put: async (path) => {
			seen.push(path);
			queued = true;
			return { etag: "e" };
		},
		stat: async () => ({ size: 1, mtime: 2 }),
	});
	const result = await execute(
		[{ type: "upload", path: "a.md", size: 1 }, { type: "upload", path: "b.md", size: 1 }],
		io,
		{},
		undefined,
		undefined,
		() => queued,
	);
	assert.deepEqual(seen, ["a.md"]);
	assert.equal(result.yielded, true);
	assert.equal(result.baseline["a.md"].etag, "e");
	assert.equal(result.baseline["b.md"], undefined);
});

test("each finished file is saved before the next one starts", async () => {
	const seen: string[] = [];
	const io = fake({
		read: async () => new Uint8Array([1]),
		put: async () => ({ etag: "e" }),
		stat: async () => ({ size: 1, mtime: 2 }),
	});
	await execute(
		[{ type: "upload", path: "a.md", size: 1 }, { type: "upload", path: "b.md", size: 1 }],
		io,
		{},
		undefined,
		(baseline) => {
			seen.push(Object.keys(baseline).sort().join(","));
			return Promise.resolve();
		},
	);
	assert.deepEqual(seen, ["a.md", "a.md,b.md"]);
});

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

test("a desktop download streams instead of buffering the file", async () => {
	let streamed = false;
	const io = fake({
		streamGet: async (_path, file) => {
			streamed = file.etag === "e" && file.size === 4;
			return { size: 4, mtime: 2, etag: "e" };
		},
		get: async () => {
			throw new Error("buffered");
		},
	});
	const result = await execute([{ type: "download", path: "a.md", size: 4, etag: "e" }], io, {});
	assert.equal(streamed, true);
	assert.equal(result.baseline["a.md"].etag, "e");
	assert.deepEqual(result.failed, []);
	assert.deepEqual(result.transferred, ["a.md"]);
});

test("a move drops the old baseline entry and keeps the etag on the new path", async () => {
	let moved = "";
	const io = fake({
		move: async (from, to) => {
			moved = `${from} -> ${to}`;
		},
	});
	const result = await execute(
		[{
			type: "move",
			from: "_Archive/Ref",
			path: "_Archive/Reforma",
			files: [
				{ from: "_Archive/Ref/a.md", path: "_Archive/Reforma/a.md", etag: "a", size: 4, mtime: 8, changed: false },
				{ from: "_Archive/Ref/b.md", path: "_Archive/Reforma/b.md", etag: "b", size: 9, mtime: 8, changed: true },
			],
		}],
		io,
		{ "_Archive/Ref/a.md": { size: 4, mtime: 2, etag: "a" }, "_Archive/Ref/b.md": { size: 5, mtime: 2, etag: "b" } },
	);
	assert.equal(moved, "_Archive/Ref -> _Archive/Reforma");
	assert.equal(result.baseline["_Archive/Ref/a.md"], undefined);
	assert.deepEqual(result.baseline["_Archive/Reforma/a.md"], { size: 4, mtime: 8, etag: "a" });
	assert.equal(result.baseline["_Archive/Reforma/b.md"], undefined);
});

test("a conflict that inserts into the same note stays one file", async () => {
	const server = new TextEncoder().encode("Видели когда-нибудь System Design ");
	const local = new TextEncoder().encode("Видели когда-нибудь воркшоп по System Design про ML");
	const puts: string[] = [];
	const io = fake({
		read: async () => local,
		get: async () => ({ body: server, etag: "server" }),
		put: async (path) => {
			puts.push(path);
			return { etag: "local" };
		},
		write: async () => {
			throw new Error("conflict copy");
		},
		stat: async () => ({ size: local.length, mtime: 9 }),
	});
	const result = await execute([{ type: "conflict", path: "note.md", etag: "server" }], io, {
		"note.md": { size: server.length, mtime: 1, etag: "old" },
	});
	assert.deepEqual(puts, ["note.md"]);
	assert.deepEqual(result.conflicts, []);
	assert.equal(result.baseline["note.md"].etag, "local");
	assert.deepEqual(result.errors, []);
});

test("a conflict keeps the longer server draft and does not add a copy", async () => {
	const local = new TextEncoder().encode("Видели когда-нибудь System Design ");
	const server = new TextEncoder().encode("Видели когда-нибудь воркшоп по System Design про ML");
	const writes: string[] = [];
	const io = fake({
		read: async () => local,
		get: async () => ({ body: server, etag: "server" }),
		put: async () => {
			throw new Error("uploaded a copy");
		},
		write: async (path) => {
			writes.push(path);
			return { size: server.length, mtime: 9 };
		},
	});
	const result = await execute([{ type: "conflict", path: "note.md", etag: "server" }], io, {
		"note.md": { size: local.length, mtime: 1, etag: "old" },
	});
	assert.deepEqual(writes, ["note.md"]);
	assert.deepEqual(result.conflicts, []);
	assert.equal(result.baseline["note.md"].etag, "server");
	assert.deepEqual(result.errors, []);
});

test("a conflict keeps both sides when the local note shrank", async () => {
	const local = new TextEncoder().encode("hello\n");
	const server = new TextEncoder().encode("hello world\n");
	const writes: string[] = [];
	const io = fake({
		read: async () => local,
		get: async () => ({ body: server, etag: "server" }),
		put: async (path) => {
			assert.equal(path, "note (conflict).md");
			return { etag: "copy" };
		},
		write: async (path) => {
			writes.push(path);
			return { size: 1, mtime: 9 };
		},
		stat: async (path) => {
			if (path.includes("conflict")) throw new Error("missing");
			return { size: 1, mtime: 1 };
		},
	});
	const result = await execute([{ type: "conflict", path: "note.md", etag: "server" }], io, {
		"note.md": { size: server.length, mtime: 1, etag: "old" },
	});
	assert.deepEqual(writes, ["note (conflict).md", "note.md"]);
	assert.deepEqual(result.conflicts, ["note (conflict).md"]);
});

test("an open editor takes the incoming text only when it is an older draft", () => {
	const older = new TextEncoder().encode("System Design ");
	const incoming = new TextEncoder().encode("воркшоп по System Design ");
	const ahead = new TextEncoder().encode("воркшоп по System Design про ML");
	assert.equal(incomingReplacesEditor(older, incoming), true);
	assert.equal(incomingReplacesEditor(incoming, incoming), false);
	assert.equal(incomingReplacesEditor(ahead, incoming), false);
});

test("a conflict keeps the local edit beside the newer server file", async () => {
	const writes: string[] = [];
	const io = fake({
		read: async () => new Uint8Array([1, 1]),
		get: async () => ({ body: new Uint8Array([2]), etag: "server" }),
		write: async (path) => {
			writes.push(path);
			return { size: 1, mtime: 9 };
		},
		put: async (path, _body, match) => {
			assert.equal(match, undefined);
			assert.equal(path, "Note (conflict).md");
			return { etag: "copy" };
		},
		stat: async (path) => {
			if (path.includes("conflict")) throw new Error("missing");
			return { size: 1, mtime: 1 };
		},
	});
	const result = await execute([{ type: "conflict", path: "Note.md", etag: "server" }], io, {
		"Note.md": { size: 1, mtime: 1, etag: "old" },
	});
	assert.deepEqual(writes, ["Note (conflict).md", "Note.md"]);
	assert.equal(result.baseline["Note.md"].etag, "server");
	assert.equal(result.baseline["Note (conflict).md"].etag, "copy");
	assert.deepEqual(result.conflicts, ["Note (conflict).md"]);
	assert.deepEqual(result.errors, []);
});

test("a stale upload is refused and cannot replace the server file", async () => {
	const io = fake({
		read: async () => new Uint8Array([9]),
		put: async (path, _body, match) => {
			if (path === "a.md") {
				assert.equal(match, "old");
				throw new ConflictError();
			}
			return { etag: "copy" };
		},
		get: async () => ({ body: new Uint8Array([2]), etag: "new" }),
		write: async () => ({ size: 1, mtime: 4 }),
		stat: async (path) => {
			if (path.includes("conflict")) throw new Error("missing");
			return { size: 1, mtime: 4 };
		},
	});
	const result = await execute([{ type: "upload", path: "a.md", match: "old" }], io, {});
	assert.equal(result.baseline["a.md"].etag, "new");
	assert.equal(result.baseline["a (conflict).md"].etag, "copy");
	assert.deepEqual(result.errors, []);
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
		move: async () => {},
		stat: async () => ({ size: 0, mtime: 0 }),
		...impl,
	};
}

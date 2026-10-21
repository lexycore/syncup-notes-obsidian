import assert from "node:assert/strict";
import test from "node:test";
import { CHUNK_BYTES, keptBytes, pullChunks } from "./chunks.ts";

test("a partial file resumes only when it is the same remote file", () => {
	assert.equal(keptBytes({ etag: "e", size: 100, offset: 40 }, 40, "e", 100), 40);
	assert.equal(keptBytes({ etag: "e", size: 100, offset: 40 }, 40, "other", 100), 0);
	assert.equal(keptBytes({ etag: "e", size: 100, offset: 40 }, 0, "e", 100), 0);
	assert.equal(keptBytes(null, 40, "e", 100), 0);
});

test("a download stops between ranges when a note change is waiting", async () => {
	let calls = 0;
	const done = await pullChunks({
		size: CHUNK_BYTES * 2,
		offset: 0,
		fetchRange: async (_start, end) => {
			calls += 1;
			return new Uint8Array(end - _start + 1);
		},
		writeAt: async () => {},
		stop: () => calls >= 1,
	});
	assert.equal(done, false);
	assert.equal(calls, 1);
});

test("a download is stored one range at a time and continues from the saved offset", async () => {
	const ranges: string[] = [];
	const stored: number[] = [];
	await pullChunks({
		size: CHUNK_BYTES + 3,
		offset: CHUNK_BYTES,
		fetchRange: async (start, end) => {
			ranges.push(`${start}-${end}`);
			return new Uint8Array(end - start + 1);
		},
		writeAt: async (offset, body) => {
			stored.push(offset + body.byteLength);
		},
	});
	assert.deepEqual(ranges, [`${CHUNK_BYTES}-${CHUNK_BYTES + 2}`]);
	assert.deepEqual(stored, [CHUNK_BYTES + 3]);
});

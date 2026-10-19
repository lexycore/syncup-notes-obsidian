import assert from "node:assert/strict";
import test from "node:test";
import { MAX_UPLOAD_BYTES, deleteCount, pathsDiffer, planSync, type BaselineEntry, type LocalFile, type RemoteFile } from "./plan.ts";

const local = (path: string, size: number, mtime: number): LocalFile => ({ path, size, mtime });
const remote = (path: string, size: number, mtime: number, etag: string): RemoteFile => ({ path, size, mtime, etag });
const base = (size: number, mtime: number, etag: string): BaselineEntry => ({ size, mtime, etag });

function types(actions: { type: string; path: string }[]) {
	return actions.map((action) => `${action.type} ${action.path}`);
}

test("the view file is not uploaded, downloaded, or deleted", () => {
	const actions = planSync({
		local: [local(".syncup/view.json", 10, 1), local("a.md", 3, 1)],
		remote: [remote(".syncup/view.json", 12, 2, "new")],
		baseline: { ".syncup/view.json": base(10, 1, "old") },
	});
	assert.deepEqual(types(actions), ["upload a.md", "forget .syncup/view.json"]);
});

test("first sync copies missing files and does not delete", () => {
	const actions = planSync({
		local: [local("a.md", 3, 1_000), local(".obsidian/plugins/x", 1, 1), local("notes/.git/config", 1, 1)],
		remote: [remote("b.md", 4, 2_000, "bbb")],
		baseline: {},
	});
	assert.deepEqual(types(actions), ["download b.md", "upload a.md"]);
});

test("first sync treats equal sizes as already stored", () => {
	const actions = planSync({
		local: [local("a.md", 3, 5_000)],
		remote: [remote("a.md", 3, 9_000, "aaa")],
		baseline: {},
	});
	assert.deepEqual(actions, [{ type: "unchanged", path: "a.md", etag: "aaa", size: 3, mtime: 5_000 }]);
});

test("uploads when only the local file changed", () => {
	const baseline: Record<string, BaselineEntry> = { "a.md": base(3, 5_000, "aaa") };
	const actions = planSync({
		local: [local("a.md", 4, 6_000)],
		remote: [remote("a.md", 3, 9_000, "aaa")],
		baseline,
	});
	assert.deepEqual(types(actions), ["upload a.md"]);
});

test("downloads when only the remote file changed", () => {
	const actions = planSync({
		local: [local("a.md", 3, 5_000)],
		remote: [remote("a.md", 8, 1_000, "new")],
		baseline: { "a.md": base(3, 5_000, "aaa") },
	});
	assert.deepEqual(types(actions), ["download a.md"]);
});

test("newer side wins when both changed", () => {
	const baseline = { "a.md": base(3, 5_000, "aaa") };
	const localWins = planSync({
		local: [local("a.md", 9, 20_000)],
		remote: [remote("a.md", 8, 10_000, "new")],
		baseline,
	});
	const remoteWins = planSync({
		local: [local("a.md", 9, 10_000)],
		remote: [remote("a.md", 8, 20_000, "new")],
		baseline,
	});
	assert.deepEqual(types(localWins), ["upload a.md"]);
	assert.deepEqual(types(remoteWins), ["download a.md"]);
});

test("deletes the remote file when it was removed locally and the server copy is unchanged", () => {
	const actions = planSync({
		local: [],
		remote: [remote("gone.md", 3, 5_000, "aaa")],
		baseline: { "gone.md": base(3, 5_000, "aaa") },
	});
	assert.deepEqual(types(actions), ["delete-remote gone.md"]);
});

test("deletes the local file when it was removed on the server and the local copy is unchanged", () => {
	const actions = planSync({
		local: [local("gone.md", 3, 5_000)],
		remote: [],
		baseline: { "gone.md": base(3, 5_000, "aaa") },
	});
	assert.deepEqual(types(actions), ["delete-local gone.md"]);
});

test("forgets a file already removed on both sides", () => {
	const actions = planSync({
		local: [],
		remote: [],
		baseline: { "gone.md": base(3, 5_000, "aaa") },
	});
	assert.deepEqual(types(actions), ["forget gone.md"]);
});

test("keeps a local edit when the remote copy was deleted", () => {
	const actions = planSync({
		local: [local("a.md", 9, 8_000)],
		remote: [],
		baseline: { "a.md": base(3, 5_000, "aaa") },
	});
	assert.deepEqual(types(actions), ["upload a.md"]);
});

test("keeps a remote edit when the local copy was deleted", () => {
	const actions = planSync({
		local: [],
		remote: [remote("a.md", 9, 8_000, "new")],
		baseline: { "a.md": base(3, 5_000, "aaa") },
	});
	assert.deepEqual(types(actions), ["download a.md"]);
});

test("a vault and a server folder that barely overlap are left untouched", () => {
	const localFiles = Array.from({ length: 30 }, (_, i) => local(`notes/${i}.md`, 1, 1));
	const remoteFiles = Array.from({ length: 30 }, (_, i) => remote(`alkov/notes/${i}.md`, 1, 1, "e"));
	assert.equal(pathsDiffer(localFiles, remoteFiles), true);
	assert.equal(pathsDiffer([local("a.md", 1, 1)], remoteFiles), false);
});

test("counts files the sync would delete", () => {
	const actions = planSync({
		local: [local("keep.md", 3, 5_000), local("also.md", 1, 1)],
		remote: [],
		baseline: { "keep.md": base(3, 5_000, "aaa"), "also.md": base(1, 1, "bbb") },
	});
	assert.equal(deleteCount(actions), 2);
});

test("uploads a large file when large files are allowed", () => {
	const actions = planSync({
		local: [local("big.bin", MAX_UPLOAD_BYTES + 1, 1_000), local("ok.md", 2, 1_000)],
		remote: [],
		baseline: {},
		allowLarge: true,
	});
	assert.deepEqual(types(actions), ["upload big.bin", "upload ok.md"]);
});

test("skips an upload larger than 64 MiB and still syncs the rest", () => {
	const actions = planSync({
		local: [local("big.bin", MAX_UPLOAD_BYTES + 1, 1_000), local("ok.md", 2, 1_000)],
		remote: [],
		baseline: {},
	});
	assert.deepEqual(types(actions), ["upload ok.md", "skip-large big.bin"]);
});

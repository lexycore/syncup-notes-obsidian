import assert from "node:assert/strict";
import test from "node:test";
import { deleteCount, MAX_TRANSFER_ATTEMPTS, nextOverLimit, overLimitNotice, pathsDiffer, planSync, transferKey, type BaselineEntry, type LocalFile, type RemoteFile } from "./plan.ts";

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
	assert.deepEqual(types(actions), ["upload a.md", "download b.md"]);
});

test("first sync treats equal sizes as already stored", () => {
	const actions = planSync({
		local: [local("a.md", 3, 5_000)],
		remote: [remote("a.md", 3, 9_000, "aaa")],
		baseline: {},
	});
	assert.deepEqual(actions, [{ type: "unchanged", path: "a.md", etag: "aaa", size: 3, mtime: 5_000 }]);
});

test("a local note is sent before a large download", () => {
	const actions = planSync({
		local: [local("note.md", 20, 1)],
		remote: [remote("a-clip.mp4", 200_000_000, 1, "v"), remote("z-note.md", 10, 1, "o")],
		baseline: {},
	});
	assert.deepEqual(types(actions), ["upload note.md", "download z-note.md", "download a-clip.mp4"]);
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

test("both sides changed keeps the server file and does not use mtime", () => {
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
	assert.deepEqual(types(localWins), ["conflict a.md"]);
	assert.deepEqual(types(remoteWins), ["conflict a.md"]);
});

test("deletes the remote file when it was removed locally and the server copy is unchanged", () => {
	const actions = planSync({
		local: [],
		remote: [remote("gone.md", 3, 5_000, "aaa")],
		baseline: { "gone.md": base(3, 5_000, "aaa") },
	});
	assert.deepEqual(types(actions), ["delete-remote gone.md"]);
});

test("renaming a file moves it instead of deleting the old name", () => {
	const actions = planSync({
		local: [local("TG/tg-alkovpro/2026/2026-10/+2026-10-20-SyncUp-Notes.md", 120, 9_000)],
		remote: [remote("TG/tg-alkovpro/2026/2026-10/2026-10-20-SyncUp-Notes.md", 120, 5_000, "note")],
		baseline: { "TG/tg-alkovpro/2026/2026-10/2026-10-20-SyncUp-Notes.md": base(120, 5_000, "note") },
	});
	assert.equal(actions.length, 1);
	assert.equal(actions[0].type, "move");
	if (actions[0].type !== "move") return;
	assert.equal(actions[0].from, "TG/tg-alkovpro/2026/2026-10/2026-10-20-SyncUp-Notes.md");
	assert.equal(actions[0].path, "TG/tg-alkovpro/2026/2026-10/+2026-10-20-SyncUp-Notes.md");
	assert.equal(deleteCount(actions), 0);
});

test("renaming a folder moves the whole tree", () => {
	const actions = planSync({
		local: [local("_Archive/Reforma/a.md", 4, 8_000), local("_Archive/Reforma/sub/b.md", 5, 8_000), local("keep.md", 1, 1)],
		remote: [remote("_Archive/Ref/a.md", 4, 2_000, "a"), remote("_Archive/Ref/sub/b.md", 5, 2_000, "b"), remote("keep.md", 1, 1, "k")],
		baseline: {
			"_Archive/Ref/a.md": base(4, 2_000, "a"),
			"_Archive/Ref/sub/b.md": base(5, 2_000, "b"),
			"keep.md": base(1, 1, "k"),
		},
	});
	assert.equal(actions.filter((action) => action.type === "move").length, 1);
	const move = actions.find((action) => action.type === "move");
	assert.ok(move && move.type === "move");
	if (move?.type !== "move") return;
	assert.equal(move.from, "_Archive/Ref");
	assert.equal(move.path, "_Archive/Reforma");
	assert.deepEqual(move.files.map((file) => file.path).sort(), ["_Archive/Reforma/a.md", "_Archive/Reforma/sub/b.md"]);
	assert.equal(deleteCount(actions), 0);
	assert.deepEqual(types(actions).filter((line) => line.startsWith("upload") || line.startsWith("delete")), []);
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

test("uploads a video that fits the plan and skips one that does not", () => {
	const video = 732 * 1024 * 1024;
	const fits = planSync({
		local: [local("talk.mp4", video, 1_000), local("ok.md", 2, 1_000)],
		remote: [],
		baseline: {},
		fileLimit: 2 * 1024 * 1024 * 1024,
	});
	assert.deepEqual(types(fits), ["upload ok.md", "upload talk.mp4"]);
	const over = planSync({
		local: [local("talk.mp4", video, 1_000), local("ok.md", 2, 1_000)],
		remote: [],
		baseline: {},
		fileLimit: 512 * 1024 * 1024,
	});
	assert.deepEqual(types(over), ["upload ok.md", "skip-large talk.mp4"]);
	const quiet = planSync({
		local: [local("talk.mp4", video, 1_000), local("ok.md", 2, 1_000)],
		remote: [],
		baseline: {},
		fileLimit: 512 * 1024 * 1024,
		overLimit: { limit: 512 * 1024 * 1024, paths: ["talk.mp4"] },
	});
	assert.deepEqual(types(quiet), ["upload ok.md", "parked talk.mp4"]);
	const raised = planSync({
		local: [local("talk.mp4", video, 1_000)],
		remote: [],
		baseline: {},
		fileLimit: 2 * 1024 * 1024 * 1024,
		overLimit: { limit: 512 * 1024 * 1024, paths: ["talk.mp4"] },
	});
	assert.deepEqual(types(raised), ["upload talk.mp4"]);
	const stillOver = planSync({
		local: [local("talk.mp4", video, 1_000)],
		remote: [],
		baseline: {},
		fileLimit: 600 * 1024 * 1024,
		overLimit: { limit: 512 * 1024 * 1024, paths: ["talk.mp4"] },
	});
	assert.deepEqual(types(stillOver), ["skip-large talk.mp4"]);
	const smaller = planSync({
		local: [local("talk.mp4", 100, 2_000)],
		remote: [],
		baseline: {},
		fileLimit: 512 * 1024 * 1024,
		overLimit: { limit: 512 * 1024 * 1024, paths: ["talk.mp4"] },
	});
	assert.deepEqual(types(smaller), ["upload talk.mp4"]);
	const limit = 512 * 1024 * 1024;
	assert.deepEqual(nextOverLimit(limit, ["a.mp4"], ["b.mp4"], { limit, paths: ["a.mp4"] }), { limit, paths: ["a.mp4", "b.mp4"] });
	assert.deepEqual(nextOverLimit(undefined, [], [], { limit, paths: ["a.mp4"] }), { limit, paths: ["a.mp4"] });
	assert.equal(overLimitNotice(["Выступления/talk.mp4"], 512 * 1024 * 1024), "talk.mp4 is larger than the 512 MB limit on your plan");
	assert.equal(overLimitNotice(["a.mp4", "b.mp4"], 2 * 1024 * 1024 * 1024), "2 files are larger than the 2 GB limit on your plan");
});

test("a transfer pauses after repeated failures and resumes when the file changes", () => {
	const file = remote("clip.mp4", 10, 2_000, "v1");
	const key = transferKey("download", { etag: "v1", size: 10 });
	const again = planSync({
		local: [],
		remote: [file],
		baseline: {},
		attempts: { "clip.mp4": { attempts: MAX_TRANSFER_ATTEMPTS - 1, key } },
	});
	assert.deepEqual(types(again), ["download clip.mp4"]);
	const paused = planSync({
		local: [],
		remote: [file],
		baseline: {},
		attempts: { "clip.mp4": { attempts: MAX_TRANSFER_ATTEMPTS, key } },
	});
	assert.deepEqual(types(paused), ["paused clip.mp4"]);
	const changed = planSync({
		local: [],
		remote: [remote("clip.mp4", 10, 3_000, "v2")],
		baseline: {},
		attempts: { "clip.mp4": { attempts: MAX_TRANSFER_ATTEMPTS, key } },
	});
	assert.deepEqual(types(changed), ["download clip.mp4"]);
});

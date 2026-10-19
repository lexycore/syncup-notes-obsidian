import assert from "node:assert/strict";
import test from "node:test";
import { encodeView, openFolders, parseView, snapshot, syncFolders, type FolderToggle } from "./viewstate.ts";

test("parse keeps note paths and drops the view folder", () => {
	const state = parseView(JSON.stringify({
		v: 1,
		expanded: ["b", "a", ".syncup", "../x", "a"],
		file: "notes/hello.md",
		updated: 10,
	}));
	assert.deepEqual(state, { v: 1, expanded: ["a", "b"], file: "notes/hello.md", updated: 10 });
	assert.equal(parseView("{"), null);
	assert.equal(parseView(JSON.stringify({ file: ".syncup/view.json", updated: 1 }))?.file, "");
});

test("encode is stable", () => {
	assert.equal(
		encodeView({ v: 1, expanded: ["b", "a"], file: "a.md", updated: 3 }),
		JSON.stringify({ v: 1, expanded: ["a", "b"], file: "a.md", updated: 3 }),
	);
});

test("folders open from the root downward and a second pass is a no-op", () => {
	const folders = [
		toggle("2026/10", true),
		toggle("2026", true),
	];
	syncFolders(folders, ["2026", "2026/10"]);
	assert.deepEqual(folders.map((folder) => folder.collapsed), [false, false]);
	assert.deepEqual(openFolders(folders), ["2026", "2026/10"]);
	syncFolders(folders, ["2026"]);
	assert.equal(folders[0].collapsed, true);
	assert.equal(folders[1].collapsed, false);
	assert.equal(snapshot(["2026"], "a.md"), snapshot(["2026"], "a.md"));
});

function toggle(path: string, collapsed: boolean): FolderToggle {
	const folder = {
		path,
		collapsed,
		setCollapsed(next: boolean) {
			folder.collapsed = next;
		},
	};
	return folder;
}

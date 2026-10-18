import assert from "node:assert/strict";
import test from "node:test";
import { parentFolders } from "./folders.ts";

test("a file in the vault root has no parent folders", () => {
	assert.deepEqual(parentFolders("note.md"), []);
});

test("parent folders are created from the vault root downward", () => {
	assert.deepEqual(parentFolders("alkov/_Archive/Нетология/lesson.docx"), [
		"alkov",
		"alkov/_Archive",
		"alkov/_Archive/Нетология",
	]);
});

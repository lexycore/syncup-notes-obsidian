export const VIEW_PATH = ".syncup/view.json";

export interface ViewState {
	v: 1;
	expanded: string[];
	file: string;
	updated: number;
}

export interface FolderToggle {
	path: string;
	collapsed: boolean;
	setCollapsed(collapsed: boolean): void;
}

export function parseView(text: string): ViewState | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (!data || typeof data !== "object") return null;
	const raw = data as Record<string, unknown>;
	const expanded = Array.isArray(raw.expanded) ? raw.expanded.filter(isNotePath) : [];
	const file = typeof raw.file === "string" && (raw.file === "" || isNotePath(raw.file)) ? raw.file : "";
	const updated = typeof raw.updated === "number" && Number.isFinite(raw.updated) ? Math.max(0, Math.floor(raw.updated)) : 0;
	return { v: 1, expanded: uniqueSorted(expanded).slice(0, 400), file, updated };
}

export function encodeView(state: ViewState): string {
	return JSON.stringify({ v: 1, expanded: uniqueSorted(state.expanded), file: state.file, updated: state.updated });
}

export function syncFolders(folders: FolderToggle[], expanded: string[]): void {
	const want = new Set(expanded);
	const ordered = [...folders].sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
	for (const folder of ordered) {
		const collapsed = !want.has(folder.path);
		if (folder.collapsed !== collapsed) folder.setCollapsed(collapsed);
	}
}

export function openFolders(folders: FolderToggle[]): string[] {
	return uniqueSorted(folders.filter((folder) => !folder.collapsed).map((folder) => folder.path));
}

export function snapshot(expanded: string[], file: string): string {
	return `${file}\n${uniqueSorted(expanded).join("\n")}`;
}

function isNotePath(value: unknown): value is string {
	if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")) return false;
	if (value === ".syncup" || value.startsWith(".syncup/")) return false;
	return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function uniqueSorted(paths: string[]): string[] {
	return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

function depth(path: string): number {
	return path.split("/").length;
}

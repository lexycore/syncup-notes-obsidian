export function parentFolders(path: string): string[] {
	const parts = path.split("/").filter((part) => part.length > 0);
	const folders: string[] = [];
	let current = "";
	for (const part of parts.slice(0, -1)) {
		current = current ? `${current}/${part}` : part;
		folders.push(current);
	}
	return folders;
}

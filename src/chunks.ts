export const CHUNK_BYTES = 8 * 1024 * 1024;

export function partialPath(vaultPath: string): string {
	return `.syncup/partial/${vaultPath}`;
}

export function partialMetaPath(vaultPath: string): string {
	return `${partialPath(vaultPath)}.meta`;
}

export function keptBytes(meta: { etag?: string; size?: number } | null, have: number, etag: string, size: number): number {
	if (!meta || meta.etag !== etag || meta.size !== size) return 0;
	if (!Number.isSafeInteger(have) || have <= 0 || have > size) return 0;
	return have;
}

export async function pullChunks(input: {
	size: number;
	offset: number;
	fetchRange: (start: number, end: number) => Promise<Uint8Array>;
	writeAt: (offset: number, body: Uint8Array) => Promise<void>;
}): Promise<void> {
	let offset = input.offset;
	while (offset < input.size) {
		const end = Math.min(input.size - 1, offset + CHUNK_BYTES - 1);
		const body = await input.fetchRange(offset, end);
		const expected = end - offset + 1;
		if (body.byteLength !== expected) throw new Error(`short range ${offset}-${end}`);
		await input.writeAt(offset, body);
		offset += expected;
	}
}

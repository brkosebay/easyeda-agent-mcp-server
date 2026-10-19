// Default export folder (~/.easyeda-mcp/exports) for tools that save a file
// per call (pcb_export, sch_get_netlist). Without a sweep it grows forever:
// every Gerber/STEP/netlist an agent ever asked for stays on disk.
//
// exportsDir() creates the folder and prunes it — files older than maxAgeMs,
// then all but the newest (maxFiles - 1) so the file about to be written keeps
// the total at maxFiles. Best-effort: it never throws, and it only ever
// touches this folder, never a caller-supplied outputDir.

import { lstat, mkdir, readdir, unlink } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

export const EXPORTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const EXPORTS_MAX_FILES = 200;

/** Resolved lazily so HOME overrides (tests, sandboxes) take effect. */
export function defaultExportsDir(): string {
	return join(homedir(), '.easyeda-mcp', 'exports');
}

export async function exportsDir(opts: { maxAgeMs?: number; maxFiles?: number; now?: number } = {}): Promise<string> {
	const dir = defaultExportsDir();
	try {
		await mkdir(dir, { recursive: true });
		await sweepExports(dir, opts.maxAgeMs ?? EXPORTS_MAX_AGE_MS, opts.maxFiles ?? EXPORTS_MAX_FILES, opts.now ?? Date.now());
	} catch { /* best-effort — the caller's write reports any real failure */ }
	return dir;
}

async function sweepExports(dir: string, maxAgeMs: number, maxFiles: number, now: number): Promise<void> {
	const files: Array<{ path: string; mtimeMs: number }> = [];
	for (const name of await readdir(dir)) {
		const path = join(dir, name);
		try {
			const st = await lstat(path);
			if (st.isFile()) files.push({ path, mtimeMs: st.mtimeMs });
		} catch { /* vanished mid-sweep */ }
	}
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const keep = Math.max(0, maxFiles - 1);
	await Promise.all(files.map((f, i) =>
		now - f.mtimeMs > maxAgeMs || i >= keep ? unlink(f.path).catch(() => {}) : undefined,
	));
}

import { dirname, resolve } from 'path';

/** Directories a vendored tool (vendor/freerouting.jar, vendor/fastroute/...) may live under, nearest first. */
export function runtimeRootCandidates(): string[] {
	const argvEntry = process.argv[1] ? dirname(resolve(process.argv[1])) : '';
	const starts = uniqueStrings([
		resolve(process.cwd()),
		resolve(__dirname),
		argvEntry,
		dirname(process.execPath),
	].filter(Boolean));

	const roots: string[] = [];
	for (const start of starts) roots.push(...ancestorDirs(start, 6));
	return uniqueStrings(roots);
}

function ancestorDirs(start: string, limit: number): string[] {
	const dirs: string[] = [];
	let cur = resolve(start);
	for (let i = 0; i < limit; i++) {
		dirs.push(cur);
		const next = dirname(cur);
		if (next === cur) break;
		cur = next;
	}
	return dirs;
}

export function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values));
}

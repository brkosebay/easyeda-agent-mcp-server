// Runs every offline scripts/*-smoke.ts (no EasyEDA needed) and fails if any fails.
// Usage: npm run test:smoke [-- name-filter]
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Manual tools, not offline tests: fastroute-run needs a DSN, a rules file and the router binary.
const MANUAL = new Set(['fastroute-run-smoke.ts']);
const TIMEOUT_MS = 180_000;
const filter = process.argv[2];
const scripts = readdirSync(join(root, 'scripts'))
	.filter((f) => f.endsWith('-smoke.ts') && !MANUAL.has(f) && (!filter || f.includes(filter)))
	.sort();
// Keep tests away from the real daemon directory (~/.easyeda-mcp).
const daemonDir = mkdtempSync(join(tmpdir(), 'easyeda-smoke-'));

let failed = 0;
for (const file of scripts) {
	const started = Date.now();
	const { code, output } = await new Promise((resolve) => {
		const child = spawn('npx', ['ts-node', '--transpile-only', join('scripts', file)], {
			cwd: root,
			env: { ...process.env, EDA_DAEMON_DIR: daemonDir },
			shell: process.platform === 'win32',
		});
		let output = '';
		child.stdout.on('data', (d) => { output += d; });
		child.stderr.on('data', (d) => { output += d; });
		const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
		child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
	});
	const ok = code === 0;
	if (!ok) failed++;
	console.log(`${ok ? 'pass' : 'FAIL'} ${String(Date.now() - started).padStart(6)}ms ${file}`);
	if (!ok) console.log(output.trim().split('\n').slice(-15).map((l) => `    ${l}`).join('\n'));
}
console.log(`\n${scripts.length - failed}/${scripts.length} smoke tests passed`);
process.exit(failed ? 1 : 0);

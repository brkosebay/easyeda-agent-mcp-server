// Daemon auth — shared-secret token at ~/.easyeda-mcp/token (chmod 600).
// MCP clients read the same file (since they're spawned by the same user).
// Prevents random local processes from hijacking the daemon's extension WS.

import { promises as fs, existsSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
import { PATHS } from './protocol';

export async function readOrCreateToken(): Promise<string> {
	if (existsSync(PATHS.tokenfile)) {
		const buf = await fs.readFile(PATHS.tokenfile, 'utf-8');
		const token = buf.trim();
		if (token.length >= 32) return token;
	}
	await fs.mkdir(dirname(PATHS.tokenfile), { recursive: true, mode: 0o700 });
	const token = randomBytes(32).toString('hex');
	await fs.writeFile(PATHS.tokenfile, token, { mode: 0o600 });
	return token;
}

export function constantTimeEquals(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

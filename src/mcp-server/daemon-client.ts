// MCP-side daemon client — same public surface as `WebSocketBridge` so the
// existing 190+ tools work unchanged. Activated when EDA_DAEMON=1.
//
// Connects over UDS to ~/.easyeda-mcp/daemon.sock. If the daemon isn't
// running, auto-spawns it as a detached child process (LSP-style) and
// retries the connection.

import * as net from 'net';
import { spawn } from 'child_process';
import { promises as fs, existsSync, statSync } from 'fs';
import { resolve as resolvePath } from 'path';
import {
	PATHS,
	DAEMON_VERSION,
	LOCK_WAIT_BUDGET_MS,
	methodIsWrite,
	type AgentToDaemon,
	type DaemonToAgent,
	type InstanceInfo,
	type ClientInfo,
	type LeaseRequest,
} from '../daemon/protocol';
import { readOrCreateToken } from '../daemon/auth';
import { leaseContext } from './lease-context';

interface PendingRpc {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const DAEMON_BIN_PATH_ENV = 'EDA_DAEMON_BIN';

function inferDaemonBinPath(): string {
	if (process.env[DAEMON_BIN_PATH_ENV]) return process.env[DAEMON_BIN_PATH_ENV]!;
	// `dist/mcp-server/index.js` is the typical caller. Daemon is sibling.
	const here = require.main?.filename ?? __filename;
	return resolvePath(here, '..', '..', 'daemon', 'index.js');
}

export class DaemonClient {
	private socket?: net.Socket;
	private buf = '';
	private pending = new Map<string, PendingRpc>();
	private reqSeq = 0;
	private agentId = '';
	private connected = false;
	private connectingPromise: Promise<void> | null = null;
	private clientInfo: ClientInfo;
	private cachedInstances: InstanceInfo[] = [];
	private daemonPid?: number;
	private daemonStartedAt?: number;

	constructor() {
		this.clientInfo = { pid: process.pid, startedAt: Date.now() };
	}

	setClientInfo(info: { name?: string; version?: string }): void {
		this.clientInfo = { ...this.clientInfo, name: info.name, version: info.version };
		if (this.connected) void this.reannounceClientInfo();
	}

	getClientInfo(): ClientInfo { return { ...this.clientInfo }; }

	getPort(): number {
		// Compatibility shim — old tools call this. Returns the WS port the
		// daemon listens on, which is what the extension is connected to.
		return Number(process.env.EDA_WS_PORT) || 15168;
	}

	isDaemonConnected(): boolean { return this.connected; }
	isConnected(): boolean { return this.connected && this.cachedInstances.length > 0; }
	getConnectedCount(): number { return this.cachedInstances.length; }
	getConnectedInstances(): InstanceInfo[] { return [...this.cachedInstances]; }

	async refreshAllInstanceInfo(): Promise<void> {
		await this.connect();
		// refresh=true makes the daemon re-query each extension's open tabs /
		// active document / gate state instead of replaying connect-time data.
		this.cachedInstances = await this.requestInstanceList(true);
	}

	/**
	 * Identity of the daemon we are talking to, and whether it runs code older
	 * than the daemon binary on disk (it survives `npm run build`; kill it to
	 * pick up fixes — the next MCP request auto-spawns the new build).
	 */
	getDaemonInfo(): { pid?: number; startedAt?: string; binaryPath: string; binaryBuiltAt?: string; stale?: boolean; hint?: string } {
		const binaryPath = inferDaemonBinPath();
		let builtAtMs: number | undefined;
		try { builtAtMs = statSync(binaryPath).mtimeMs; } catch { /* missing binary */ }
		const startedAtMs = this.daemonStartedAt;
		// Pre-fix daemons do not report pid/startedAt at all — that alone
		// means the running daemon predates this build.
		const stale = startedAtMs === undefined ? this.connected : builtAtMs !== undefined && builtAtMs > startedAtMs;
		return {
			pid: this.daemonPid,
			startedAt: startedAtMs !== undefined ? new Date(startedAtMs).toISOString() : undefined,
			binaryPath,
			binaryBuiltAt: builtAtMs !== undefined ? new Date(builtAtMs).toISOString() : undefined,
			stale,
			hint: stale
				? `The running daemon predates the daemon build on disk. Kill it (kill $(cat ${PATHS.pidfile})); the next MCP request respawns the current build.`
				: undefined,
		};
	}

	notifyPeers(): void { /* no-op — daemon handles all peering */ }

	async stop(): Promise<void> {
		if (this.socket) { try { this.socket.end(); } catch {} this.socket = undefined; }
		this.connected = false;
		this.rejectAllPending(new Error('Daemon client shutting down'));
	}

	// ---- bridge API parity ----

	async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		await this.connect();
		const { instance_id, document, _timeoutMs, ...rest } = params as any;
		const id = 'r' + String(++this.reqSeq);
		const explicitTimeoutMs = typeof _timeoutMs === 'number' && _timeoutMs > 0 ? _timeoutMs : undefined;
		const timeoutMs = explicitTimeoutMs ?? 120_000;
		const forwardParams = explicitTimeoutMs != null
			? { ...rest, _timeoutMs: explicitTimeoutMs }
			: rest;
		// Write requests may wait up to LOCK_WAIT_BUDGET_MS in the daemon's
		// lock queue before the daemon-side timer even starts — budget for it.
		const lockBudgetMs = methodIsWrite(method) ? LOCK_WAIT_BUDGET_MS : 0;
		const lease = leaseContext.getStore();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Request "${method}" timed out after ${timeoutMs}ms (daemon-client)`));
			}, timeoutMs + lockBudgetMs + 5_000); // daemon will time out first
			this.pending.set(id, { resolve, reject, timer });
			this.sendRaw({
				type: 'rpc',
				id, method,
				instanceId: instance_id,
				document,
				timeoutMs,
				params: forwardParams,
				...(lease?.leaseId ? { leaseId: lease.leaseId } : {}),
				...(lease?.overrideLeases ? { overrideLeases: true } : {}),
			});
		});
	}

	/** Work-lease management — see src/daemon/lease-manager.ts. */
	async lease(request: Omit<LeaseRequest, 'type' | 'id'>): Promise<unknown> {
		await this.connect();
		const id = 'l' + String(++this.reqSeq);
		return this.sendAndWait<unknown>({ ...request, type: 'lease', id });
	}

	// ---- internals ----

	private async connect(): Promise<void> {
		if (this.connected) return;
		if (this.connectingPromise) return this.connectingPromise;

		this.connectingPromise = (async () => {
			let lastErr: Error | undefined;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					await this.tryConnectOnce();
					return;
				} catch (e: any) {
					lastErr = e;
					if (attempt === 0) {
						// Daemon may not be running — auto-spawn and retry
						try { await this.autoSpawnDaemon(); }
						catch (spawnErr: any) {
							// fall through and retry connection anyway in case race
						}
						// Wait briefly for daemon to bind
						await new Promise((r) => setTimeout(r, 1500));
					} else {
						await new Promise((r) => setTimeout(r, 800));
					}
				}
			}
			throw new Error(`DaemonClient: could not connect after retries: ${lastErr?.message}`);
		})();
		try { await this.connectingPromise; } finally { this.connectingPromise = null; }
	}

	private async autoSpawnDaemon(): Promise<void> {
		const bin = inferDaemonBinPath();
		if (!existsSync(bin)) {
			throw new Error(`Daemon binary not found at ${bin}. Set ${DAEMON_BIN_PATH_ENV} or run npm run compile.`);
		}
		const child = spawn(process.execPath, [bin], {
			detached: true,
			stdio: 'ignore',
			env: { ...process.env },
		});
		child.unref();
	}

	private tryConnectOnce(): Promise<void> {
		return new Promise((resolve, reject) => {
			const sock = net.createConnection(PATHS.socket);
			let settled = false;
			let authTimer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = (): void => {
				if (authTimer) clearTimeout(authTimer);
				sock.removeListener('error', onError);
				sock.removeListener('close', onHandshakeClose);
			};
			const fail = (e: Error): void => {
				if (settled) return;
				settled = true;
				cleanup();
				if (this.socket === sock) this.socket = undefined;
				this.pendingAuth?.reject(e);
				this.pendingAuth = null;
				this.rejectAllPending(e);
				try { sock.destroy(); } catch {}
				reject(e);
			};
			const onError = (e: Error) => fail(e);
			const onHandshakeClose = () => fail(new Error('daemon connection closed during handshake'));
			sock.once('error', onError);
			sock.once('close', onHandshakeClose);

			sock.once('connect', async () => {
				try {
					this.socket = sock;
					sock.removeListener('error', onError);
					sock.on('data', (c) => this.onData(c));
					sock.on('error', (e) => { /* logged elsewhere */ });

					const token = await readOrCreateToken();
					// Send auth — wait for auth_ok
					const authPromise = new Promise<void>((res, rej) => {
						authTimer = setTimeout(() => rej(new Error('auth timeout')), 10_000);
						this.pendingAuth = {
							resolve: () => {
								if (authTimer) clearTimeout(authTimer);
								res();
							},
							reject: (e) => {
								if (authTimer) clearTimeout(authTimer);
								rej(e);
							},
						};
					});
					this.sendRaw({
						type: 'auth', token, mcpVersion: DAEMON_VERSION,
						clientInfo: { name: this.clientInfo.name, version: this.clientInfo.version, pid: process.pid },
					});
					await authPromise;

					// subscribe to instance changes for free
					this.sendRaw({ type: 'subscribe', channel: 'instance_changes' });
					this.cachedInstances = await this.requestInstanceList();
					this.connected = true;
					settled = true;
					cleanup();
					sock.on('close', () => this.onClose());
					resolve();
				} catch (e: any) {
					fail(e instanceof Error ? e : new Error(String(e)));
				}
			});
		});
	}

	private pendingAuth: { resolve: () => void; reject: (e: Error) => void } | null = null;

	private sendRaw(msg: AgentToDaemon): void {
		if (!this.socket) return;
		try { this.socket.write(JSON.stringify(msg) + '\n'); }
		catch {}
	}

	private async reannounceClientInfo(): Promise<void> {
		if (!this.socket) return;
		try {
			const token = await readOrCreateToken();
			this.sendRaw({
				type: 'auth',
				token,
				mcpVersion: DAEMON_VERSION,
				clientInfo: { name: this.clientInfo.name, version: this.clientInfo.version, pid: process.pid },
			});
		} catch {
			// Non-critical; the next reconnect will announce the latest client info.
		}
	}

	private async requestInstanceList(refresh = false): Promise<InstanceInfo[]> {
		const id = String(++this.reqSeq);
		return this.sendAndWait<InstanceInfo[]>({ type: 'list_instances', id, ...(refresh ? { refresh: true } : {}) });
	}

	private async sendAndWait<T>(msg: AgentToDaemon & { id?: string }): Promise<T> {
		if (!('id' in msg) || !msg.id) throw new Error('sendAndWait requires id');
		return new Promise<T>((resolve, reject) => {
			const id = (msg as any).id as string;
			const t = setTimeout(() => { this.pending.delete(id); reject(new Error('daemon req timeout')); }, 30_000);
			this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer: t });
			this.sendRaw(msg);
		});
	}

	private onData(chunk: Buffer | string): void {
		this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
		let i;
		while ((i = this.buf.indexOf('\n')) >= 0) {
			const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
			if (!line.trim()) continue;
			let msg: DaemonToAgent;
			try { msg = JSON.parse(line); } catch { continue; }
			this.handleMessage(msg);
		}
	}

	private handleMessage(msg: DaemonToAgent): void {
		switch (msg.type) {
			case 'auth_ok':
				this.agentId = msg.agentId;
				this.daemonPid = msg.daemonPid;
				this.daemonStartedAt = msg.daemonStartedAt;
				this.pendingAuth?.resolve();
				this.pendingAuth = null;
				return;
			case 'auth_failed':
				this.pendingAuth?.reject(new Error(`Auth failed: ${msg.reason}`));
				this.pendingAuth = null;
				return;
			case 'rpc_response': {
				const p = this.pending.get(msg.id);
				if (!p) return;
				clearTimeout(p.timer);
				this.pending.delete(msg.id);
				if (msg.error) p.reject(new Error(msg.error));
				else p.resolve(msg.result);
				return;
			}
			case 'lease_response': {
				const p = this.pending.get(msg.id);
				if (!p) return;
				clearTimeout(p.timer);
				this.pending.delete(msg.id);
				if (msg.error) p.reject(new Error(msg.error));
				else p.resolve(msg.result);
				return;
			}
			case 'list_instances_response': {
				const p = this.pending.get(msg.id);
				if (!p) return;
				clearTimeout(p.timer);
				this.pending.delete(msg.id);
				p.resolve(msg.instances);
				return;
			}
			case 'instance_change':
				this.cachedInstances = msg.instances;
				return;
			case 'pong':
			case 'error':
				return;
		}
	}

	private onClose(): void {
		this.connected = false;
		this.socket = undefined;
		this.pendingAuth?.reject(new Error('daemon connection closed'));
		this.pendingAuth = null;
		this.rejectAllPending(new Error('daemon connection closed'));
	}

	private rejectAllPending(error: Error): void {
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(error);
		}
		this.pending.clear();
	}
}

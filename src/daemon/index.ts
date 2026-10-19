// EasyEDA MCP daemon — singleton-per-machine local service.
//
// Architecture (replaces today's per-MCP WebSocketServer in bridge.ts):
//
//   Codex / Claude / scripts        (N agent processes)
//         | stdio MCP
//         v
//   MCP server processes            (N — thin tool-schema layer)
//         | UDS @ ~/.easyeda-mcp/daemon.sock
//         v
//   easyeda-mcp daemon              (1 — owns extension WS, locks, registry)
//         | one WebSocket on a fixed port (default 15168)
//         v
//   EasyEDA Pro extension           (1 per browser/window)
//
// Auto-spawn: any MCP that finds the daemon not running spawns it as a
// detached child via `node dist/daemon/index.js --auto-spawn`. The daemon
// uses a lockfile to prevent multiple instances.
//
// Today's bridge.ts becomes a one-line conditional in src/mcp-server/index.ts:
// when EDA_DAEMON=1 we use src/mcp-server/daemon-client.ts (UDS client) which
// implements the same `WebSocketBridge` interface; existing tools see no
// difference.

import { WebSocketServer, WebSocket } from 'ws';
import * as net from 'net';
import { promises as fs, existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
import type { IncomingMessage } from 'http';

import {
	PATHS,
	DAEMON_VERSION,
	LOCK_WAIT_BUDGET_MS,
	methodIsWrite,
	type AgentToDaemon,
	type DaemonToAgent,
	type InstanceInfo,
	type LeaseRequest,
} from './protocol';
import { ADMIN_METHODS, canonicalDocumentId } from '../shared/method-classes';
import { LeaseManager, LeaseError, describe as describeLease, type Lease } from './lease-manager';
import { authenticateNativeSocket } from './native-auth';
import type { NativeAuthenticatedChannel } from '../shared/native-auth';
import { LockManager } from './lock-manager';
import { readOrCreateToken, constantTimeEquals } from './auth';

const DEFAULT_WS_PORT = Number(process.env.EDA_WS_PORT) || 15168;
const PEER_ORIGIN = 'http://easyeda-agent.internal';

const ALLOWED_ORIGIN_PATTERNS = [
	/^https?:\/\/([a-z0-9-]+\.)*easyeda\.com(:\d+)?$/,
	/^https?:\/\/([a-z0-9-]+\.)*lceda\.cn(:\d+)?$/,
	/^https?:\/\/client(:\d+)?$/,
	/^file:\/\//,
];

function isAllowedOrigin(origin: string | undefined): boolean {
	if (!origin) return false;
	if (process.env.EDA_WS_ALLOW_ALL_ORIGINS === '1') return true;
	if (origin === PEER_ORIGIN) return true;
	return ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin));
}

interface ExtensionConn {
	ws: WebSocket;
	channel: NativeAuthenticatedChannel;
	info: InstanceInfo;
	lastSeenAt: number;
	/** Set once the extension has answered a daemon ping (newer builds only). */
	answersPing: boolean;
	lastPongAt?: number;
	keepAliveTimer?: ReturnType<typeof setInterval>;
	/** Document of the last forwarded RPC — a change means EasyEDA switches tabs. */
	lastDocKey?: string;
	rpcCount: number;
	tabSwitches: number;
	infoWaiters: Map<string, (result: any) => void>;
	pending: Map<string, {
		agentId: string;
		mcpRequestId: string;
		timer: ReturnType<typeof setTimeout>;
		release: () => void;
		method: string;
		document: string;
		cacheKey?: string;
		cacheTtlMs?: number;
		writeLock: boolean;
		sentAt: number;
	}>;
}

// The extension drops the connection if it doesn't hear from us for
// DEAD_THRESHOLD_MS. Send a heartbeat every KEEP_ALIVE_MS to stay alive.
const KEEP_ALIVE_MS = 15_000;
// An extension that has proven it answers pings but then stays silent this
// long is a dead/zombie socket (EasyEDA closed, extension disabled without a
// clean close, laptop slept). Terminate it so agents fail fast and the next
// connection from that instance is accepted as the live one.
const EXTENSION_SILENCE_LIMIT_MS = Number(process.env.EDA_DAEMON_EXT_SILENCE_MS) || 90_000;
const INFO_REFRESH_TIMEOUT_MS = 3_000;
const DAEMON_STARTED_AT = Date.now();
const BOARD_CACHE_DEFAULT_TTL_MS = Number(process.env.EDA_DAEMON_BOARD_CACHE_TTL_MS) || 10_000;
const BOARD_CACHE_MAX_ENTRIES = Number(process.env.EDA_DAEMON_BOARD_CACHE_ENTRIES) || 16;
const BOARD_CACHE_MAX_BYTES = Number(process.env.EDA_DAEMON_BOARD_CACHE_BYTES) || 32 * 1024 * 1024;

// Pseudo-documents for cache versioning (real document ids are UUIDs).
const SCH_VERSION_DOC = '__sch__';
const INSTANCE_VERSION_DOC = '__instance__';

interface BoardCacheEntry {
	key: string;
	result: unknown;
	createdAt: number;
	expiresAt: number;
	lastAccessedAt: number;
	bytes: number;
}

const CACHEABLE_BOARD_METHODS = new Set([
	'pcb.extract.design',
	// N schematic reviewers then cost the extension one extract, not N.
	'sch.extract.design',
	'pcb.routing.presets',
	'pcb.context.routing',
	'pcb.context.netWorklist',
	'pcb.context.inspectArea',
	'pcb.context.keepouts',
	'pcb.context.obstacleMap',
]);

interface AgentConn {
	agentId: string;
	socket: net.Socket;
	authed: boolean;
	clientInfo: { name?: string; version?: string; pid?: number };
	subscriptions: Set<string>;
	lastActivityAt: number;
}

class Daemon {
	private wss?: WebSocketServer;
	private nativeToken = '';
	private uds?: net.Server;
	private extensions = new Map<string, ExtensionConn>(); // key = instanceId
	private agents = new Map<string, AgentConn>();         // key = agentId
	private locks = new LockManager();
	private requestSeq = 0;
	private extReqIndex = new Map<string, ExtensionConn>(); // bridge req id → ext conn
	private boardCache = new Map<string, BoardCacheEntry>();
	private boardDocVersions = new Map<string, number>();
	private boardCacheBytes = 0;
	private leases = new LeaseManager();

	async start(): Promise<void> {
		await fs.mkdir(PATHS.root, { recursive: true, mode: 0o700 });
		await this.acquireSingletonLock();

		const token = await readOrCreateToken();
		this.nativeToken = token;
		this.startUdsServer(token);
		this.startWsServer();

		await fs.writeFile(PATHS.pidfile, String(process.pid));
		this.log(`Daemon v${DAEMON_VERSION} started — uds=${PATHS.socket} ws=${DEFAULT_WS_PORT}`);

		const onShutdown = async () => {
			this.log('Shutting down...');
			try { this.uds?.close(); } catch {}
			try { this.wss?.close(); } catch {}
			try { await fs.unlink(PATHS.socket); } catch {}
			try { await fs.unlink(PATHS.pidfile); } catch {}
			try { await fs.unlink(PATHS.lockfile); } catch {}
			process.exit(0);
		};
		process.on('SIGINT', onShutdown);
		process.on('SIGTERM', onShutdown);
	}

	private async acquireSingletonLock(): Promise<void> {
		// Atomically create the lockfile; on EEXIST check the owner's liveness.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await fs.writeFile(PATHS.lockfile, String(process.pid), { flag: 'wx' });
				// We own the singleton — any leftover UDS sock is stale
				// (Linux won't bind if it exists).
				try { await fs.unlink(PATHS.socket); } catch {}
				return;
			} catch (e: any) {
				if (e?.code !== 'EEXIST') throw e;
			}
			// Lockfile exists — if its PID is still alive, another daemon owns
			// the socket; do NOT unlink anything, just bail out.
			try {
				const pidStr = await fs.readFile(PATHS.lockfile, 'utf-8');
				const pid = Number(pidStr.trim());
				if (Number.isFinite(pid) && pid > 0) {
					try { process.kill(pid, 0); throw new Error(`Daemon already running (pid ${pid})`); }
					catch (err: any) { if (err?.code !== 'ESRCH') throw err; }
				}
			} catch (e: any) {
				if (e?.message?.startsWith('Daemon already running')) throw e;
				// fall through — unreadable/garbage lockfile is treated as stale
			}
			// Stale lockfile — remove it and retry the atomic create once.
			try { await fs.unlink(PATHS.lockfile); } catch {}
		}
		throw new Error('Failed to acquire singleton lock (lockfile contention)');
	}

	// =========================================================================
	// UDS server — accepts MCP clients
	// =========================================================================
	private startUdsServer(token: string): void {
		this.uds = net.createServer((socket) => this.handleAgent(socket, token));
		this.uds.on('error', (err) => this.log(`UDS error: ${err.message}`));
		this.uds.listen(PATHS.socket, () => {
			void fs.chmod(PATHS.socket, 0o600).catch(() => {});
			this.log(`UDS listening at ${PATHS.socket}`);
		});
	}

	private handleAgent(socket: net.Socket, token: string): void {
		const agentId = randomBytes(8).toString('hex');
		const conn: AgentConn = {
			agentId,
			socket,
			authed: false,
			clientInfo: {},
			subscriptions: new Set(),
			lastActivityAt: Date.now(),
		};
		let buf = '';

		socket.on('data', (chunk) => {
			conn.lastActivityAt = Date.now();
			buf += chunk.toString('utf-8');
			let i;
			while ((i = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, i); buf = buf.slice(i + 1);
				if (!line.trim()) continue;
				let msg: AgentToDaemon;
				try { msg = JSON.parse(line); } catch { continue; }
				void this.dispatchAgentMessage(conn, msg, token).catch((err) => {
					const message = err instanceof Error ? err.message : String(err);
					this.log(`Agent ${agentId} message handling failed: ${message}`);
					if ((msg as any).id) {
						const type = msg.type === 'list_instances' ? 'list_instances_response' : msg.type === 'lease' ? 'lease_response' : 'rpc_response';
						this.writeAgent(conn, { type, id: (msg as any).id, error: message } as any);
					} else {
						this.writeAgent(conn, { type: 'error', error: message });
					}
				});
			}
		});

		socket.on('close', () => {
			this.locks.releaseAllForAgent(agentId);
			const dropped = this.leases.releaseWhere((l) => l.creatorAgentId === agentId);
			if (dropped.length) this.log(`Released ${dropped.length} work lease(s) of disconnected agent ${agentId}: ${dropped.map((l) => l.owner).join(', ')}`);
			this.agents.delete(agentId);
			this.log(`Agent ${agentId} disconnected (clientInfo=${conn.clientInfo.name})`);
		});

		socket.on('error', (err) => this.log(`Agent ${agentId} socket error: ${err.message}`));
	}

	private writeAgent(agent: AgentConn, msg: DaemonToAgent): void {
		try { agent.socket.write(JSON.stringify(msg) + '\n'); }
		catch { try { agent.socket.destroy(); } catch {} }
	}

	private async dispatchAgentMessage(agent: AgentConn, msg: AgentToDaemon, token: string): Promise<void> {
		if (msg.type === 'auth') {
			if (!constantTimeEquals(msg.token, token)) {
				this.writeAgent(agent, { type: 'auth_failed', reason: 'invalid token' });
				agent.socket.destroy();
				return;
			}
			agent.authed = true;
			agent.clientInfo = msg.clientInfo;
			this.agents.set(agent.agentId, agent);
			this.writeAgent(agent, { type: 'auth_ok', agentId: agent.agentId, daemonVersion: DAEMON_VERSION, daemonPid: process.pid, daemonStartedAt: DAEMON_STARTED_AT });
			this.log(`Agent ${agent.agentId} authed (${msg.clientInfo.name ?? 'unnamed'} pid=${msg.clientInfo.pid})`);
			// Push current instance state immediately
			this.writeAgent(agent, { type: 'instance_change', instances: this.snapshotInstances() });
			return;
		}
		if (!agent.authed) {
			this.writeAgent(agent, { type: 'error', error: 'not authenticated' });
			return;
		}
		switch (msg.type) {
			case 'ping': return this.writeAgent(agent, { type: 'pong', id: msg.id });
			case 'list_instances':
				if ((msg as any).refresh) await this.refreshAllInstanceInfo();
				return this.writeAgent(agent, { type: 'list_instances_response', id: msg.id, instances: this.snapshotInstances() });
			case 'subscribe':
				agent.subscriptions.add(msg.channel);
				return;
			case 'rpc': return this.handleRpc(agent, msg);
			case 'lease': return this.handleLease(agent, msg);
		}
	}

	private snapshotInstances(): InstanceInfo[] {
		const now = Date.now();
		return [...this.extensions.values()]
			.map((c) => {
				let oldestPendingMs: number | undefined;
				for (const p of c.pending.values()) {
					const age = now - p.sentAt;
					if (oldestPendingMs === undefined || age > oldestPendingMs) oldestPendingMs = age;
				}
				return {
					...c.info,
					health: {
						lastSeenMsAgo: now - c.lastSeenAt,
						answersPing: c.answersPing,
						pendingRequests: c.pending.size,
						oldestPendingMs,
					},
				};
			})
			.sort((a, b) => b.connectedAt - a.connectedAt);
	}

	private resolveExtension(instanceId?: string): ExtensionConn | null {
		if (instanceId) return this.extensions.get(instanceId) ?? null;
		if (this.extensions.size === 0) return null;
		if (this.extensions.size === 1) return [...this.extensions.values()][0];
		return null; // ambiguous — caller must specify
	}

	private async handleRpc(agent: AgentConn, msg: any): Promise<void> {
		const ext = this.resolveExtension(msg.instanceId);
		if (!ext) {
			this.writeAgent(agent, {
				type: 'rpc_response', id: msg.id,
				error: this.extensions.size === 0
					? 'EasyEDA Pro extension is not connected. Click "Connect Claude" in EasyEDA.'
					: `Multiple instances connected — pass instance_id (have: ${[...this.extensions.keys()].join(',')})`,
			});
			return;
		}

		const writeLock = methodIsWrite(msg.method) || msg.writeLock === true;
		const leaseCheck = this.checkLeases(ext, msg, writeLock);
		if ('error' in leaseCheck) {
			this.writeAgent(agent, { type: 'rpc_response', id: msg.id, error: leaseCheck.error });
			return;
		}
		const docParam: string | undefined = leaseCheck.document || ext.info.currentDocument;
		// Lock / cache / lease key is the bare UUID so `uuid` and `uuid@project`
		// (what the active-tab fallback reports) serialize as the same document.
		const document = docParam ? canonicalDocumentId(docParam) || '__no_doc__' : '__no_doc__';
		const params = { ...(msg.params || {}) };
		const cachePlan = !writeLock ? this.planBoardCacheLookup(ext.info.instanceId, document, msg.method, params) : undefined;
		if (cachePlan?.hit) {
			this.writeAgent(agent, { type: 'rpc_response', id: msg.id, result: cachePlan.hit.result });
			return;
		}

		let release: () => void;
		try {
			release = await this.locks.acquire(ext.info.instanceId, document, agent.agentId, { writeLock, timeoutMs: LOCK_WAIT_BUDGET_MS });
		} catch (e: any) {
			this.writeAgent(agent, { type: 'rpc_response', id: msg.id, error: `lock acquire failed: ${e?.message ?? e}` });
			return;
		}

		// Forward to extension. We bridge IDs: keep agent's id, generate a fresh extension-side id.
		const extId = String(++this.requestSeq);
		const timeoutMs = msg.timeoutMs ?? 120_000;
		const timer = setTimeout(() => {
			ext.pending.delete(extId);
			this.extReqIndex.delete(extId);
			release();
			this.writeAgent(agent, { type: 'rpc_response', id: msg.id, error: `Request "${msg.method}" timed out after ${timeoutMs}ms` });
		}, timeoutMs);

		ext.pending.set(extId, {
			agentId: agent.agentId,
			mcpRequestId: msg.id,
			timer,
			release,
			method: msg.method,
			document,
			cacheKey: cachePlan?.key,
			cacheTtlMs: cachePlan?.ttlMs,
			writeLock,
			sentAt: Date.now(),
		});
		this.extReqIndex.set(extId, ext);

		if (docParam && !params.document) params.document = docParam;
		ext.rpcCount++;
		if (document !== '__no_doc__') {
			if (ext.lastDocKey && ext.lastDocKey !== document) ext.tabSwitches++;
			ext.lastDocKey = document;
		}
		// Tell the extension our deadline so its operation gate can release a
		// request that is still stuck inside EasyEDA when we give up on it,
		// and skip requests whose caller already gave up while they queued.
		(params as any)._rpcTimeoutMs = timeoutMs;
		const frame = JSON.stringify({ id: extId, method: msg.method, params });
		try {
			await this.sendExtension(ext, JSON.parse(frame));
		} catch (e: any) {
			clearTimeout(timer);
			ext.pending.delete(extId);
			this.extReqIndex.delete(extId);
			release();
			this.writeAgent(agent, { type: 'rpc_response', id: msg.id, error: `failed to send to extension: ${e?.message ?? e}` });
		}
	}

	// =========================================================================
	// Work leases — see lease-manager.ts
	// =========================================================================

	/**
	 * Decide whether an RPC may run under the active leases, and which document
	 * it targets. With no leases anywhere this is a pass-through, so
	 * single-agent sessions never have to claim anything.
	 */
	private checkLeases(ext: ExtensionConn, msg: any, write: boolean): { document?: string; lease?: Lease } | { error: string } {
		const method: string = msg.method;
		const requested: string | undefined = msg.document ? String(msg.document) : undefined;
		const requestedKey = requested ? this.canonicalDoc(ext, requested) : undefined;
		const admin = ADMIN_METHODS.has(method);

		if (msg.leaseId) {
			const lease = this.leases.get(String(msg.leaseId));
			if (!lease) return { error: `Work lease ${msg.leaseId} is unknown or expired. Nothing was executed — ask the orchestrator for a fresh lease (work_lease claim).` };
			const deny = (why: string) => {
				lease.rejected++;
				return { error: `Work lease "${lease.owner}" (${lease.leaseId}): ${why} Nothing was executed.` };
			};
			if (lease.instanceId !== ext.info.instanceId) return deny(`it belongs to instance ${lease.instanceId}, not ${ext.info.instanceId}.`);
			if (admin) return deny(`${method} resets the operation queue shared by every agent; only the orchestrator (no lease) may run it.`);
			if (write && lease.mode === 'read') return deny(`read-only lease cannot run ${method}.`);
			if (write && lease.documents.length > 0) {
				if (requestedKey && !lease.documents.includes(requestedKey)) return deny(`it covers ${lease.documents.join(', ')}, not ${requestedKey}.`);
				if (!requestedKey && lease.documents.length > 1) return deny('it covers several documents — pass "document" explicitly.');
			}
			this.leases.touch(lease, write);
			// A lease pins its document: calls that omit `document` go to the
			// leased one, never to whatever tab another agent left active.
			return { lease, document: requested ?? lease.documents[0] };
		}

		const active = this.leases.active(ext.info.instanceId);
		if (active.length === 0 || msg.overrideLeases === true) return { document: requested };
		if (admin) {
			return { error: `${active.length} work lease(s) are active (${active.map((l) => l.owner).join(', ')}). ${method} affects every agent — release the leases first, or pass override_leases: true if you are the orchestrator and have checked the documents.` };
		}
		if (!write) return { document: requested };
		if (!requestedKey) {
			return { error: 'Work leases are active on this instance, so writes must name their "document" explicitly (the active tab may belong to another agent). Nothing was executed.' };
		}
		const holders = this.leases.writersOn(ext.info.instanceId, requestedKey);
		if (holders.length) {
			for (const h of holders) h.rejected++;
			return { error: `Document ${requestedKey} is reserved — ${holders.map((h) => describeLease(h)).join('; ')}. Reads are fine; writes must carry that lease (execute_tool "lease" argument). Nothing was executed.` };
		}
		return { document: requested };
	}

	/** Bare UUID for a document id, tab id (`uuid@project`) or unique open-tab title. */
	private canonicalDoc(ext: ExtensionConn | null, value: string): string {
		const key = canonicalDocumentId(value);
		const docs = ext?.info.documents ?? [];
		if (docs.some((d) => canonicalDocumentId(d.uuid) === key)) return key;
		const byTitle = docs.filter((d) => d.title?.trim().toLowerCase() === value.trim().toLowerCase());
		return byTitle.length === 1 ? canonicalDocumentId(byTitle[0].uuid) : key;
	}

	private handleLease(agent: AgentConn, msg: LeaseRequest): void {
		const reply = (result?: unknown, error?: string) => this.writeAgent(agent, { type: 'lease_response', id: msg.id, result, error });
		const noExtension = () => this.extensions.size === 0
			? 'EasyEDA Pro extension is not connected. Click "Connect Claude" in EasyEDA.'
			: `Multiple instances connected — pass instance_id (have: ${[...this.extensions.keys()].join(',')})`;
		try {
			switch (msg.action) {
				case 'claim': {
					const ext = this.resolveExtension(msg.instanceId);
					if (!ext) return reply(undefined, noExtension());
					const documents = (msg.documents ?? []).map((d) => this.canonicalDoc(ext, String(d))).filter(Boolean);
					const { lease, warnings } = this.leases.claim({
						instanceId: ext.info.instanceId,
						documents,
						mode: msg.mode ?? 'exclusive',
						owner: msg.owner ?? '',
						task: msg.task,
						scope: msg.scope,
						ttlMs: msg.ttlMs,
						creatorAgentId: agent.agentId,
					});
					const open = new Set((ext.info.documents ?? []).map((d) => canonicalDocumentId(d.uuid)));
					const notOpen = open.size ? documents.filter((d) => !open.has(d)) : [];
					if (notOpen.length) warnings.push(`Not an open tab: ${notOpen.join(', ')} — the extension opens it on first use. Check the UUID if that is unexpected.`);
					this.log(`Lease ${lease.leaseId} claimed: ${lease.mode} by "${lease.owner}" on ${documents.join(',') || '(read-only, any document)'}`);
					return reply({ ...this.leases.view(lease), warnings: warnings.length ? warnings : undefined });
				}
				case 'renew': {
					if (!msg.leaseId) return reply(undefined, 'leaseId is required.');
					return reply(this.leases.view(this.leases.renew(msg.leaseId, msg.ttlMs)));
				}
				case 'release': {
					const released = msg.all
						? this.leases.releaseWhere((l) => !msg.instanceId || l.instanceId === msg.instanceId)
						: msg.leaseId ? [this.leases.release(msg.leaseId)].filter((l): l is Lease => !!l) : undefined;
					if (!released) return reply(undefined, 'leaseId is required (or all: true).');
					if (released.length) this.log(`Released lease(s): ${released.map((l) => `${l.leaseId} (${l.owner}, ${l.writes} writes)`).join(', ')}`);
					return reply({
						released: released.map((l) => ({ leaseId: l.leaseId, owner: l.owner, writes: l.writes, rejected: l.rejected })),
						note: released.length ? undefined : 'Nothing to release (already expired or released).',
					});
				}
				case 'list':
					return reply({
						leases: this.leases.active(msg.instanceId).map((l) => this.leases.view(l)),
						// tabSwitches / rpcs: how often EasyEDA had to change the active
						// tab between consecutive calls — high ratios mean agents on
						// different documents are thrashing the editor.
						instances: [...this.extensions.values()].map((c) => ({ instanceId: c.info.instanceId, rpcs: c.rpcCount, tabSwitches: c.tabSwitches })),
					});
				default:
					return reply(undefined, `Unknown lease action ${JSON.stringify((msg as any).action)}.`);
			}
		} catch (e) {
			reply(undefined, e instanceof LeaseError ? e.message : `lease ${msg.action} failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// =========================================================================
	// WS server — accepts EasyEDA extensions
	// =========================================================================
	private startWsServer(): void {
		this.wss = new WebSocketServer({
			port: DEFAULT_WS_PORT, host: '127.0.0.1',
			verifyClient: (info: { origin: string; req: IncomingMessage }) => {
				if (isAllowedOrigin(info.origin)) return true;
				this.log(`WS rejected origin: ${info.origin || '(none)'}`);
				return false;
			},
		});
		this.wss.on('listening', () => this.log(`WS listening on 127.0.0.1:${DEFAULT_WS_PORT}`));
		this.wss.on('error', (e: NodeJS.ErrnoException) => {
			this.log(`WS server error: ${e.message}`);
			if (e.code === 'EADDRINUSE') {
				// Another process owns the WS port — we cannot serve extensions.
				// Release the singleton resources and exit rather than holding
				// the lock while broken.
				this.log(`WS port ${DEFAULT_WS_PORT} in use — exiting`);
				try { this.uds?.close(); } catch {}
				try { unlinkSync(PATHS.socket); } catch {}
				try { unlinkSync(PATHS.pidfile); } catch {}
				try { unlinkSync(PATHS.lockfile); } catch {}
				process.exit(1);
			}
		});
		this.wss.on('connection', (ws, req) => {
			const peer = `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? '?'}`;
			const instanceId = new URL(req.url || '/', `http://localhost:${DEFAULT_WS_PORT}`).searchParams.get('instanceId') ?? '(none)';
			void this.handleExtension(ws, req).catch((err: unknown) => {
				// Previously silent: a failed handshake looked exactly like "no
				// extension ever connected". Always leave a trace.
				this.log(`Extension ${instanceId} handshake rejected (origin=${req.headers.origin ?? '(none)'} peer=${peer}): ${err instanceof Error ? err.message : String(err)}`);
				try { ws.close(4003, 'Native authentication failed'); } catch {}
			});
		});
	}

	private async handleExtension(ws: WebSocket, req: IncomingMessage): Promise<void> {
		const url = new URL(req.url || '/', `http://localhost:${DEFAULT_WS_PORT}`);
		const instanceId = url.searchParams.get('instanceId');
		if (!instanceId || !/^[a-f0-9]{8}$/.test(instanceId)) { this.log(`Extension connection rejected: invalid instanceId ${JSON.stringify(instanceId)}`); ws.close(4001, 'valid instanceId required'); return; }
		const channel = await authenticateNativeSocket(ws, this.nativeToken, instanceId);
		if (ws.readyState !== WebSocket.OPEN) return;

		const existing = this.extensions.get(instanceId);
		if (existing && existing.ws !== ws) {
			// Clean up the old connection here — its 'close' handler will see a
			// different ws in the map and skip cleanup, so do it eagerly.
			if (existing.keepAliveTimer) clearInterval(existing.keepAliveTimer);
			for (const [extId, p] of existing.pending) {
				clearTimeout(p.timer);
				p.release();
				const agent = this.agents.get(p.agentId);
				if (agent) this.writeAgent(agent, { type: 'rpc_response', id: p.mcpRequestId, error: 'extension reconnected' });
				this.extReqIndex.delete(extId);
			}
			existing.pending.clear();
			try { existing.ws.close(); } catch {}
			this.extensions.delete(instanceId);
		}

		const conn: ExtensionConn = {
			ws,
			channel,
			info: { instanceId, connectedAt: Date.now() },
			lastSeenAt: Date.now(),
			answersPing: false,
			pending: new Map(),
			infoWaiters: new Map(),
			rpcCount: 0,
			tabSwitches: 0,
		};
		this.extensions.set(instanceId, conn);
		this.log(`Extension ${instanceId} connected (${this.extensions.size} total)`);
		this.broadcastInstanceChange();

		await this.sendExtension(conn, { type: 'hello', agentId: '__daemon__', clientInfo: { name: 'easyeda-mcp-daemon', version: DAEMON_VERSION }, port: DEFAULT_WS_PORT });

		ws.on('message', async (data) => {
			conn.lastSeenAt = Date.now();
			let msg: any;
			try { msg = await channel.decode(JSON.parse(data.toString())); } catch (err: any) {
				this.log(`Extension ${instanceId}: closing on undecodable frame (${err?.message ?? err})`);
				ws.close(4003,'Invalid authenticated frame'); return;
			}
			// Ping from extension — reply with pong so the extension's
			// heartbeat thinks of us as alive (resets its lastReceived too).
			if (msg.type === 'ping') {
				try { await this.sendExtension(conn, { type: 'pong' }); } catch {}
				return;
			}
			if (msg.type === 'pong') {
				conn.answersPing = true;
				conn.lastPongAt = Date.now();
				return;
			}
			if (msg.type === 'instanceInfo') {
				this.applyInstanceInfo(conn, msg.data);
				this.broadcastInstanceChange();
				return;
			}
			// instance.getInfo replies (initial + on-demand refresh) are not
			// agent RPCs — route them to the info waiters.
			if (typeof msg.id === 'string' && (msg.id.startsWith('init-') || msg.id.startsWith('info-'))) {
				if (!msg.error && msg.result) {
					this.applyInstanceInfo(conn, msg.result);
					this.broadcastInstanceChange();
				}
				const waiter = conn.infoWaiters.get(msg.id);
				if (waiter) { conn.infoWaiters.delete(msg.id); waiter(msg.error ? undefined : msg.result); }
				return;
			}
			// RPC response from extension
			if (msg.id != null) this.routeExtensionResponse(conn, msg);
		});

		// Send a periodic serverInfo so the extension's heartbeat
		// (lastReceived from bridge) stays fresh during idle periods, plus a
		// ping so we can tell a live extension from a zombie socket.
		conn.keepAliveTimer = setInterval(() => {
			if (ws.readyState !== WebSocket.OPEN) return;
			// Requests in flight have their own deadlines, and EasyEDA may block
			// the extension's event loop during a long legitimate operation
			// (repour, autoroute) — only an idle, silent socket is a zombie.
			if (conn.answersPing && conn.pending.size === 0 && Date.now() - conn.lastSeenAt > EXTENSION_SILENCE_LIMIT_MS) {
				this.log(`Extension ${instanceId} silent for ${Date.now() - conn.lastSeenAt}ms — terminating zombie socket`);
				try { ws.terminate(); } catch {}
				return;
			}
			try {
				void this.sendExtension(conn, {
					type: 'serverInfo',
					agentId: '__daemon__',
					clientInfo: { name: 'easyeda-mcp-daemon', version: DAEMON_VERSION },
					port: DEFAULT_WS_PORT,
				}).catch(()=>ws.close());
				void this.sendExtension(conn, { type: 'ping' }).catch(() => ws.close());
			} catch {}
		}, KEEP_ALIVE_MS);

		ws.on('close', (code: number, reason: Buffer) => {
			this.log(`Extension ${instanceId} socket closed (code ${code}${reason?.length ? `, ${reason.toString()}` : ''}; ${conn.pending.size} request(s) pending: ${[...conn.pending.values()].map((p) => p.method).join(', ') || 'none'})`);
			const cur = this.extensions.get(instanceId);
			for (const waiter of conn.infoWaiters.values()) waiter(undefined);
			conn.infoWaiters.clear();
			if (cur && cur.ws === ws) {
				if (cur.keepAliveTimer) clearInterval(cur.keepAliveTimer);
				this.extensions.delete(instanceId);
				// Fail all pending requests on this extension
				for (const [extId, p] of cur.pending) {
					clearTimeout(p.timer);
					p.release();
					const agent = this.agents.get(p.agentId);
					if (agent) this.writeAgent(agent, { type: 'rpc_response', id: p.mcpRequestId, error: 'extension disconnected' });
					this.extReqIndex.delete(extId);
				}
				this.log(`Extension ${instanceId} disconnected (${this.extensions.size} remaining)`);
				this.broadcastInstanceChange();
			}
		});

		// Ask the extension for its info
		try { await this.sendExtension(conn, { id: 'init-' + instanceId, method: 'instance.getInfo', params: {} }); } catch {}
	}

	private applyInstanceInfo(conn: ExtensionConn, data: any): void {
		if (!data || typeof data !== 'object') return;
		if (data.projectName !== undefined) conn.info.projectName = data.projectName;
		if (data.currentDocument !== undefined) conn.info.currentDocument = data.currentDocument;
		if (data.documentType !== undefined) conn.info.documentType = data.documentType;
		if (Array.isArray(data.documents)) conn.info.documents = data.documents;
		if (data.bridgeGeneration !== undefined) conn.info.bridgeGeneration = data.bridgeGeneration;
		if (data.gate !== undefined) conn.info.gate = data.gate;
	}

	/**
	 * Pull fresh project/tab/gate state from the extension. The extension only
	 * pushes instanceInfo at connect time, so without this the document list
	 * stays frozen at whatever tabs were open when it connected.
	 * `instance.getInfo` bypasses the extension's operation gate, so this
	 * answers even while a hung EasyEDA call holds the request queue.
	 */
	private refreshInstanceInfo(conn: ExtensionConn): Promise<void> {
		if (conn.ws.readyState !== WebSocket.OPEN) return Promise.resolve();
		const id = `info-${++this.requestSeq}`;
		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => { conn.infoWaiters.delete(id); resolve(); }, INFO_REFRESH_TIMEOUT_MS);
			conn.infoWaiters.set(id, () => { clearTimeout(timer); resolve(); });
			this.sendExtension(conn, { id, method: 'instance.getInfo', params: {} }).catch(() => {
				clearTimeout(timer);
				conn.infoWaiters.delete(id);
				resolve();
			});
		});
	}

	private async refreshAllInstanceInfo(): Promise<void> {
		await Promise.all([...this.extensions.values()].map((c) => this.refreshInstanceInfo(c)));
	}

	private async sendExtension(conn: ExtensionConn, message: unknown): Promise<void> {
		const frame = await conn.channel.encode(message);
		if (conn.ws.readyState !== WebSocket.OPEN) throw new Error('Native peer disconnected.');
		conn.ws.send(frame);
	}

	private routeExtensionResponse(sender: ExtensionConn, msg: any): void {
		const ext = this.extReqIndex.get(msg.id);
		if (!ext || ext !== sender) return;
		const pending = ext.pending.get(msg.id);
		if (!pending) return;
		clearTimeout(pending.timer);
		ext.pending.delete(msg.id);
		this.extReqIndex.delete(msg.id);
		pending.release();
		const agent = this.agents.get(pending.agentId);
		if (!agent) return;
		if (!msg.error && pending.cacheKey && pending.cacheTtlMs) {
			this.storeBoardCache(pending.cacheKey, msg.result, pending.cacheTtlMs);
		}
		if (!msg.error && pending.writeLock) this.invalidateAfterWrite(ext.info.instanceId, pending.method, pending.document);
		this.writeAgent(agent, { type: 'rpc_response', id: pending.mcpRequestId, result: msg.result, error: msg.error });
	}

	private planBoardCacheLookup(instanceId: string, document: string, method: string, params: Record<string, unknown>): { key: string; ttlMs: number; hit?: BoardCacheEntry } | undefined {
		if (!CACHEABLE_BOARD_METHODS.has(method)) return undefined;
		if ((params as any).forceRefresh === true) {
			this.invalidateBoardCache(instanceId, document);
			return undefined;
		}
		const ttlMs = Math.max(0, Number((params as any).cacheTtlMs ?? BOARD_CACHE_DEFAULT_TTL_MS));
		if (ttlMs <= 0) return undefined;
		// Schematic extracts can span every page, so they are versioned per
		// instance rather than per page document.
		const version = method.startsWith('sch.')
			? this.boardVersion(instanceId, SCH_VERSION_DOC)
			: this.boardVersion(instanceId, document);
		const normalizedParams = { ...params };
		delete (normalizedParams as any).cacheTtlMs;
		delete (normalizedParams as any).cacheMaxEntries;
		delete (normalizedParams as any).pinConcurrency;
		const key = [instanceId, document, version, this.boardVersion(instanceId, INSTANCE_VERSION_DOC), method, stableStringify(normalizedParams)].join('|');
		const hit = this.boardCache.get(key);
		if (hit && hit.expiresAt > Date.now()) {
			hit.lastAccessedAt = Date.now();
			this.boardCache.delete(key);
			this.boardCache.set(key, hit);
			return { key, ttlMs, hit };
		}
		if (hit) this.deleteBoardCacheEntry(key);
		return { key, ttlMs };
	}

	private storeBoardCache(key: string, result: unknown, ttlMs: number): void {
		const bytes = estimateJsonBytes(result);
		if (!Number.isFinite(bytes) || bytes > BOARD_CACHE_MAX_BYTES) return;
		this.deleteBoardCacheEntry(key);
		const now = Date.now();
		this.boardCache.set(key, {
			key,
			result,
			createdAt: now,
			expiresAt: now + ttlMs,
			lastAccessedAt: now,
			bytes,
		});
		this.boardCacheBytes += bytes;
		this.evictBoardCache();
	}

	private invalidateBoardCache(instanceId: string, document: string): void {
		const versionKey = this.boardVersionKey(instanceId, document);
		this.boardDocVersions.set(versionKey, (this.boardDocVersions.get(versionKey) ?? 0) + 1);
		for (const key of Array.from(this.boardCache.keys())) {
			if (key.startsWith(`${instanceId}|${document}|`)) this.deleteBoardCacheEntry(key);
		}
	}

	/**
	 * Bump versions (so in-flight reads can never store a pre-write result under
	 * a live key) and drop entries a successful write may have made stale.
	 */
	private invalidateAfterWrite(instanceId: string, method: string, document: string): void {
		if (method.startsWith('pcb.')) {
			this.invalidateBoardCache(instanceId, document);
			return;
		}
		const schOnly = method.startsWith('sch.');
		const versionKey = this.boardVersionKey(instanceId, schOnly ? SCH_VERSION_DOC : INSTANCE_VERSION_DOC);
		this.boardDocVersions.set(versionKey, (this.boardDocVersions.get(versionKey) ?? 0) + 1);
		for (const key of Array.from(this.boardCache.keys())) {
			const [keyInstance, , , , keyMethod] = key.split('|');
			if (keyInstance !== instanceId) continue;
			// Native source edits / project imports can touch any document.
			if (!schOnly || keyMethod?.startsWith('sch.')) this.deleteBoardCacheEntry(key);
		}
	}

	private boardVersion(instanceId: string, document: string): number {
		return this.boardDocVersions.get(this.boardVersionKey(instanceId, document)) ?? 0;
	}

	private boardVersionKey(instanceId: string, document: string): string {
		return `${instanceId}|${document}`;
	}

	private deleteBoardCacheEntry(key: string): void {
		const entry = this.boardCache.get(key);
		if (!entry) return;
		this.boardCache.delete(key);
		this.boardCacheBytes = Math.max(0, this.boardCacheBytes - entry.bytes);
	}

	private evictBoardCache(): void {
		const now = Date.now();
		for (const [key, entry] of Array.from(this.boardCache.entries())) {
			if (entry.expiresAt <= now) this.deleteBoardCacheEntry(key);
		}
		while (this.boardCache.size > BOARD_CACHE_MAX_ENTRIES || this.boardCacheBytes > BOARD_CACHE_MAX_BYTES) {
			let oldestKey: string | undefined;
			let oldestAccess = Number.POSITIVE_INFINITY;
			for (const [key, entry] of this.boardCache.entries()) {
				if (entry.lastAccessedAt < oldestAccess) {
					oldestAccess = entry.lastAccessedAt;
					oldestKey = key;
				}
			}
			if (!oldestKey) break;
			this.deleteBoardCacheEntry(oldestKey);
		}
	}

	private broadcastInstanceChange(): void {
		const snap = this.snapshotInstances();
		const frame: DaemonToAgent = { type: 'instance_change', instances: snap };
		for (const agent of this.agents.values()) {
			if (agent.subscriptions.has('instance_changes')) this.writeAgent(agent, frame);
		}
	}

	private log(msg: string): void {
		const line = `[${new Date().toISOString()}] ${msg}\n`;
		try { mkdirSync(dirname(PATHS.logfile), { recursive: true }); } catch {}
		try { require('fs').appendFileSync(PATHS.logfile, line); } catch {}
		process.stderr.write(line);
	}
}

function stableStringify(value: unknown): string {
	if (value == null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

function estimateJsonBytes(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value), 'utf8');
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

if (require.main === module) {
	const d = new Daemon();
	d.start().catch((e) => { console.error('Daemon fatal:', e); process.exit(1); });
}

export { Daemon };

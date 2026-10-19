// Protocol types for MCP ↔ daemon (Unix domain socket) and daemon ↔ extension (WebSocket).
//
// Wire format on UDS: newline-delimited JSON. Each line is one message.
// The daemon proxies extension RPC frames and adds: cross-agent per-document
// write locks, instance registry, and auth.
//
// The extension WS frames are unchanged — same shape today's bridge.ts speaks.

export const DAEMON_VERSION = '1.0.0';

// ===========================================================================
// MCP → daemon
// ===========================================================================

export interface AuthRequest {
	type: 'auth';
	token: string;
	clientInfo: { name?: string; version?: string; pid: number };
	mcpVersion: string;
}

export interface RpcRequest {
	type: 'rpc';
	id: string;                       // unique within the agent connection
	method: string;                   // forwarded to extension verbatim (e.g. "pcb.create.track")
	instanceId?: string;              // null = pick first connected; required if multiple
	document?: string;                // document UUID, used for per-doc lock keying
	timeoutMs?: number;
	params?: Record<string, unknown>;
	/** True for write methods — daemon serializes per (instanceId, document). */
	writeLock?: boolean;
	/** Work lease the call runs under (see lease-manager.ts). */
	leaseId?: string;
	/** Orchestrator escape hatch: run despite other agents' active leases. */
	overrideLeases?: boolean;
}

/** Work-lease management (claim / renew / release / list). */
export interface LeaseRequest {
	type: 'lease';
	id: string;
	action: 'claim' | 'renew' | 'release' | 'list';
	instanceId?: string;
	documents?: string[];
	mode?: 'exclusive' | 'shared' | 'read';
	owner?: string;
	task?: string;
	scope?: {
		nets?: string[];
		designators?: string[];
		pages?: string[];
		region?: { x1: number; y1: number; x2: number; y2: number };
	};
	ttlMs?: number;
	leaseId?: string;
	/** release: drop every lease on the instance (orchestrator cleanup). */
	all?: boolean;
}

export interface ListInstancesRequest {
	type: 'list_instances';
	id: string;
	/** Ask each extension for fresh project/tab/gate state first (bounded). */
	refresh?: boolean;
}

export interface SubscribeRequest {
	type: 'subscribe';
	channel: 'instance_changes';
}

export interface PingRequest {
	type: 'ping';
	id: string;
}

export type AgentToDaemon = AuthRequest | RpcRequest | ListInstancesRequest | SubscribeRequest | PingRequest | LeaseRequest;

// ===========================================================================
// Daemon → MCP
// ===========================================================================

export interface AuthOk {
	type: 'auth_ok';
	agentId: string;
	daemonVersion: string;
	/** Absent on daemons built before stale-daemon detection. */
	daemonPid?: number;
	daemonStartedAt?: number;
}

export interface AuthFailed {
	type: 'auth_failed';
	reason: string;
}

export interface RpcResponse {
	type: 'rpc_response';
	id: string;
	result?: unknown;
	error?: string;
}

export interface ListInstancesResponse {
	type: 'list_instances_response';
	id: string;
	instances: InstanceInfo[];
}

export interface InstanceChange {
	type: 'instance_change';
	instances: InstanceInfo[];
}

export interface LeaseResponse {
	type: 'lease_response';
	id: string;
	result?: unknown;
	error?: string;
}

export interface PingResponse {
	type: 'pong';
	id: string;
}

export interface DaemonError {
	type: 'error';
	id?: string;
	error: string;
}

export type DaemonToAgent = AuthOk | AuthFailed | RpcResponse | ListInstancesResponse | InstanceChange | PingResponse | DaemonError | LeaseResponse;

// ===========================================================================
// Shared
// ===========================================================================

export interface InstanceInfo {
	instanceId: string;
	connectedAt: number;
	projectName?: string;
	currentDocument?: string;
	documentType?: string;
	documents?: Array<{ title: string; uuid: string }>;
	/** Extension bridge build marker (absent on older extensions). */
	bridgeGeneration?: string;
	/** Extension operation-gate status: ready | busy | reconciliation-required. */
	gate?: unknown;
	/** Daemon-side view of the socket (added by snapshotInstances). */
	health?: {
		lastSeenMsAgo: number;
		answersPing: boolean;
		pendingRequests: number;
		oldestPendingMs?: number;
	};
}

export interface ClientInfo {
	name?: string;
	version?: string;
	pid?: number;
	startedAt?: number;
}

// ===========================================================================
// Locations (resolved per-OS)
// ===========================================================================

import { homedir } from 'os';
import { isLockedWrite } from '../shared/method-classes';
import { join } from 'path';

const ROOT = process.env.EDA_DAEMON_DIR || join(homedir(), '.easyeda-mcp');
export const PATHS = {
	root: ROOT,
	socket: join(ROOT, 'daemon.sock'),
	pidfile: join(ROOT, 'daemon.pid'),
	lockfile: join(ROOT, 'daemon.lock'),
	tokenfile: join(ROOT, 'token'),
	logfile: join(ROOT, 'daemon.log'),
};

// Write classification is shared with the extension (src/shared/method-classes.ts)
// so the daemon lock, board-cache invalidation and lease enforcement treat
// exactly the methods the extension gate treats as writes. Fail-closed: any
// method not listed as a read is a write.
export function methodIsWrite(method: string): boolean {
	return isLockedWrite(method);
}

// Max time the daemon waits to acquire the per-document write lock before
// failing an RPC. Clients must budget for this on top of the RPC timeout.
export const LOCK_WAIT_BUDGET_MS = 60_000;

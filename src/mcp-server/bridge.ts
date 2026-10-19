import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { randomBytes } from 'crypto';

const PEER_ORIGIN = 'http://easyeda-agent.internal';
const DEFAULT_MAX_INSTANCE_CONNECTIONS = 4;

const ALLOWED_ORIGIN_PATTERNS = [
	/^https?:\/\/([a-z0-9-]+\.)*easyeda\.com(:\d+)?$/,
	/^https?:\/\/([a-z0-9-]+\.)*lceda\.cn(:\d+)?$/,
	// EasyEDA Pro desktop app — the Electron renderer sends "https://client"
	// (or sometimes file://). Without these the WS gets 4001-rejected.
	/^https?:\/\/client(:\d+)?$/,
	/^file:\/\//,
];
const QUICK_METHOD_TIMEOUT_MS = 5_000;
// Headroom added to an explicit `_timeoutMs` when arming the bridge timer, so
// the extension-side deadline always fires first.
const BRIDGE_TIMEOUT_MARGIN_MS = 5_000;
// editor.zoom* are deliberately absent: those handlers enforce their own
// deadline (30s default, overridable via timeoutMs) and return a structured
// error, which the 5s bridge cap used to pre-empt. The region methods are
// absent too: they dispatch a never-settling SDK call and poll for
// confirmation, and a full board scan can outlive 5s.
const QUICK_METHOD_TIMEOUT_METHODS = new Set<string>([
	'pcb.document.zoomToBoardOutline',
	'pcb.document.navigateTo',
	'pcb.document.getPrimitiveAtPoint',
	'pcb.pad.findByRef',
]);
// Slow pcb.document.* writes that must NOT get the 5s quick timeout.
const SLOW_DOCUMENT_METHODS = new Set<string>([
	'pcb.document.save',
	'pcb.document.importChanges',
	'pcb.document.refresh',
]);

function isAllowedOrigin(origin: string | undefined): boolean {
	if (!origin) return false;
	if (process.env.EDA_WS_ALLOW_ALL_ORIGINS === '1') return true;
	if (origin === PEER_ORIGIN) return true;
	return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

export interface BridgeRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

export interface BridgeResponse {
	id: string;
	result?: unknown;
	error?: string;
}

export interface InstanceInfo {
	instanceId: string;
	connectedAt: number;
	projectName?: string;
	currentDocument?: string;
	documentType?: string;
	documents?: Array<{ title: string; uuid: string }>;
}

interface ConnectedClient {
	ws: WebSocket;
	info: InstanceInfo;
	lastSeenAt: number;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	instanceId: string;
}

export interface ClientInfo {
	name?: string;
	version?: string;
	pid?: number;
	startedAt?: number;
}

export class WebSocketBridge {
	private wss: WebSocketServer | null = null;
	private clients = new Map<string, ConnectedClient>();
	private pendingRequests = new Map<string, PendingRequest>();
	private requestIdCounter = 0;
	private readonly timeout: number;
	private readonly quickTimeout: number;
	private readonly maxConnectedInstances: number;
	readonly agentId: string;
	private clientInfo: ClientInfo;

	constructor(private readonly port: number = 15168, timeout?: number) {
		const envTimeout = Number(process.env.EDA_WS_TIMEOUT_MS);
		const envQuickTimeout = Number(process.env.EDA_WS_QUICK_TIMEOUT_MS);
		const envMaxConnections = Number(process.env.EDA_MAX_INSTANCE_CONNECTIONS);
		this.timeout = timeout ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 120_000);
		this.quickTimeout = Number.isFinite(envQuickTimeout) && envQuickTimeout > 0
			? envQuickTimeout
			: QUICK_METHOD_TIMEOUT_MS;
		this.maxConnectedInstances = Number.isFinite(envMaxConnections) && envMaxConnections > 0
			? Math.floor(envMaxConnections)
			: DEFAULT_MAX_INSTANCE_CONNECTIONS;
		this.agentId = randomBytes(8).toString('hex');
		this.clientInfo = { pid: process.pid, startedAt: Date.now() };
	}

	/**
	 * Update the description of the MCP client this bridge serves (set
	 * after MCP `initialize` resolves). Broadcasts an updated serverInfo
	 * to every connected EasyEDA extension.
	 */
	setClientInfo(info: { name?: string; version?: string }): void {
		this.clientInfo = { ...this.clientInfo, name: info.name, version: info.version };
		this.broadcastServerInfo();
	}

	getClientInfo(): ClientInfo {
		return { ...this.clientInfo };
	}

	private broadcastServerInfo(): void {
		const payload = JSON.stringify({
			type: 'serverInfo',
			agentId: this.agentId,
			clientInfo: this.clientInfo,
			port: this.port,
		});
		for (const [, client] of this.clients) {
			if (client.ws.readyState !== WebSocket.OPEN) continue;
			try { client.ws.send(payload); } catch {/* */}
		}
	}

	getPort(): number {
		return this.port;
	}

	static async startOnAvailablePort(
		portStart: number,
		portCount: number,
		timeout?: number,
	): Promise<WebSocketBridge> {
		for (let i = 0; i < portCount; i++) {
			const port = portStart + i;
			const bridge = new WebSocketBridge(port, timeout);
			try {
				await bridge.start();
				return bridge;
			} catch (err: any) {
				if (err?.code === 'EADDRINUSE') {
					console.error(`[Bridge] Port ${port} in use, trying next...`);
					continue;
				}
				throw err;
			}
		}
		throw new Error(
			`All ports in range ${portStart}-${portStart + portCount - 1} are in use. ` +
			`Cannot start WebSocket server. Set EDA_WS_PORT_RANGE to increase the range.`,
		);
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.wss = new WebSocketServer({
				port: this.port,
				host: '127.0.0.1',
				verifyClient: (info: { origin: string; req: IncomingMessage; secure: boolean }) => {
					if (isAllowedOrigin(info.origin)) {
						return true;
					}
					console.error(`[Bridge] Rejected WebSocket connection from origin: ${info.origin || '(none)'}`);
					return false;
				},
			});

			this.wss.on('listening', () => {
				console.error(`[Bridge] WebSocket Server listening on port ${this.port}`);
				resolve();
			});

			this.wss.on('error', (err) => {
				console.error(`[Bridge] WebSocket Server error:`, err);
				reject(err);
			});

			this.wss.on('connection', (ws, req) => {
				const origin = req.headers.origin;

				// Peer connections: short-lived, just relay newAgent notifications
				if (origin === PEER_ORIGIN) {
					ws.on('message', (data) => {
						try {
							const message = JSON.parse(data.toString());
							if (message.type === 'newAgent') {
								console.error(`[Bridge] Peer notification: new agent on port ${message.port} (agentId: ${message.agentId})`);
								this.broadcastToExtensions({ type: 'newAgent', port: message.port, agentId: message.agentId });
							}
						} catch {
							// Ignore malformed peer messages
						}
					});
					ws.on('close', () => {});
					ws.on('error', () => {});
					return;
				}

				const url = new URL(req.url || '/', `http://localhost:${this.port}`);
				const instanceId = url.searchParams.get('instanceId');

				this.pruneClosedClients();

				if (!instanceId) {
					console.error('[Bridge] EDA Pro Extension connected without instanceId, rejecting');
					ws.close(4001, 'instanceId query parameter required');
					return;
				}

				console.error(`[Bridge] EDA Pro Extension connected (instance: ${instanceId})`);

				// If a previous WS for this instance is still open, the extension
				// reconnected (page reload, network blip). Close the old one and
				// fail any outstanding requests so we don't leak handles or send
				// to a dead socket.
				const existing = this.clients.get(instanceId);
				if (existing && existing.ws !== ws) {
					console.error(`[Bridge] Replacing stale connection for instance ${instanceId}`);
					try { existing.ws.close(); } catch {/* already closed */}
					this.dropClient(instanceId, `Extension reconnected — request aborted (instance: ${instanceId})`);
				}

				if (this.clients.size >= this.maxConnectedInstances) {
					console.error(
						`[Bridge] Rejecting extension connect for ${instanceId}: `
						+ `max instances ${this.maxConnectedInstances} reached.`,
					);
					try { ws.close(4002, `Too many instances. Limit: ${this.maxConnectedInstances}.`); } catch {/* ignore */}
					return;
				}

				const client: ConnectedClient = {
					ws,
					info: {
						instanceId,
						connectedAt: Date.now(),
					},
					lastSeenAt: Date.now(),
				};
				this.clients.set(instanceId, client);
				console.error(`[Bridge] Connected instances: ${this.clients.size}/${this.maxConnectedInstances}`);

				ws.on('message', (data) => {
					try {
						const message = JSON.parse(data.toString());

						// Check if this is a notification (has 'type' field) vs a response (has 'id' field)
						if (message.type === 'ping') {
							ws.send(JSON.stringify({ type: 'pong' }));
							return;
						}

						if (message.type === 'instanceInfo') {
							this.handleInstanceInfo(instanceId, message.data);
							return;
						}

						const response: BridgeResponse = message;
						this.handleResponse(response);
					} catch (err) {
						console.error('[Bridge] Failed to parse message:', err);
					}
				});

				ws.on('close', () => {
					// Only clear the client entry if THIS ws is still the active
					// one. A stale socket closing after replacement should not
					// erase the fresh connection.
					const current = this.clients.get(instanceId);
					if (current && current.ws === ws) {
						console.error(`[Bridge] EDA Pro Extension disconnected (instance: ${instanceId})`);
						this.dropClient(instanceId, `EDA Pro Extension disconnected (instance: ${instanceId})`);
					}
				});

				ws.on('error', (err) => {
					console.error(`[Bridge] Client error (instance: ${instanceId}):`, err);
				});

				// Send agentId + clientInfo so the extension can label this
				// connection ("Claude Code chat XYZ" vs "Codex chat ABC" etc.).
				ws.send(JSON.stringify({
					type: 'hello',
					agentId: this.agentId,
					clientInfo: this.clientInfo,
					port: this.port,
				}));

				// Request instance info from the newly connected extension
				this.requestInstanceInfo(instanceId).catch((err) => {
					console.error(`[Bridge] Failed to get instance info from ${instanceId}:`, err);
				});
			});
		});
	}

	private handleInstanceInfo(instanceId: string, data: Record<string, unknown>): void {
		const client = this.clients.get(instanceId);
		if (!client) return;

		client.info.projectName = data.projectName as string | undefined;
		client.info.currentDocument = data.currentDocument as string | undefined;
		client.info.documentType = data.documentType as string | undefined;
		client.info.documents = data.documents as Array<{ title: string; uuid: string }> | undefined;

		console.error(`[Bridge] Instance ${instanceId} info updated: project="${client.info.projectName}", doc="${client.info.currentDocument}" (${client.info.documentType})`);
	}

	private async requestInstanceInfo(instanceId: string): Promise<void> {
		try {
			const result = await this.sendToInstance(instanceId, 'instance.getInfo');
			this.handleInstanceInfo(instanceId, result as Record<string, unknown>);
		} catch {
			// Non-critical, info will be updated when extension sends it
		}
	}

	isConnected(): boolean {
		this.pruneClosedClients();
		return this.clients.size > 0;
	}

	getConnectedCount(): number {
		this.pruneClosedClients();
		return this.clients.size;
	}

	getConnectedInstances(): InstanceInfo[] {
		this.pruneClosedClients();
		return Array.from(this.clients.values())
			.map((c) => ({ ...c.info }))
			.sort((a, b) => b.connectedAt - a.connectedAt);
	}

	/**
	 * Resolve which client to send to.
	 * - If instanceId is provided, use that specific client.
	 * - If only one client is connected, auto-select it.
	 * - If zero or multiple clients, throw a descriptive error.
	 */
	private resolveClient(instanceId?: string): ConnectedClient {
		this.pruneClosedClients();

		if (instanceId) {
			const client = this.clients.get(instanceId);
			if (!client || client.ws.readyState !== WebSocket.OPEN) {
				const available = this.getConnectedInstances();
				const listText = available.length > 0
					? `\n\nConnected instances:\n${this.formatInstanceList(available)}`
					: '\n\nNo instances are currently connected.';
				throw new Error(
					`Instance "${instanceId}" is not connected.${listText}`,
				);
			}
			return client;
		}

		if (this.clients.size === 0) {
			throw new Error('EDA Pro Extension is not connected. Please open EDA Pro and click "Connect Claude" first.');
		}

		if (this.clients.size === 1) {
			const [, client] = this.clients.entries().next().value!;
			if (client.ws.readyState !== WebSocket.OPEN) {
				throw new Error('EDA Pro Extension is not connected. Please open EDA Pro and click "Connect Claude" first.');
			}
			return client;
		}

		// Multiple clients connected — require instance_id
		const available = this.getConnectedInstances();
		throw new Error(
			`Multiple EasyEDA instances are connected. Specify instance_id to choose one.\n\nConnected instances:\n${this.formatInstanceList(available)}\n\nUse list_instances for full details, or pass the instance_id of the instance you want to interact with.`,
		);
	}

	private formatInstanceList(instances: InstanceInfo[]): string {
		return instances.map((info) => {
			const parts = [`  - ${info.instanceId}`];
			if (info.projectName) parts.push(`project: "${info.projectName}"`);
			if (info.currentDocument) {
				parts.push(`active: "${info.currentDocument}" (${info.documentType || 'unknown'})`);
			}
			return parts.join(' | ');
		}).join('\n');
	}

	/**
	 * Send a request to an EasyEDA instance.
	 * If params contains instance_id, it is extracted and used for routing (not forwarded to the extension).
	 * If only one instance is connected, auto-selects it.
	 */
	async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		const { instance_id, _timeoutMs, ...rest } = params;
		const client = this.resolveClient(instance_id as string | undefined);
		const requested = Number(_timeoutMs);
		if (!Number.isFinite(requested) || requested <= 0) {
			return this.sendToClient(client, method, rest);
		}
		// Forward the handler-side deadline to the extension AND size the
		// bridge timer above it, so the handler's own timeout fires first and
		// returns a structured result instead of a bare bridge timeout.
		const forwardParams = { ...rest, _timeoutMs: requested };
		return this.sendToClient(client, method, forwardParams, requested + BRIDGE_TIMEOUT_MARGIN_MS);
	}

	/**
	 * Send to a specific instance by ID (for internal use like requestInstanceInfo).
	 */
	private async sendToInstance(instanceId: string, method: string, params: Record<string, unknown> = {}, timeoutOverride?: number): Promise<unknown> {
		const client = this.clients.get(instanceId);
		if (!client || client.ws.readyState !== WebSocket.OPEN) {
			throw new Error(`Instance "${instanceId}" is not connected`);
		}
		return this.sendToClient(client, method, params, timeoutOverride);
	}

	private async sendToClient(client: ConnectedClient, method: string, params: Record<string, unknown> = {}, timeoutOverride?: number): Promise<unknown> {
		const id = String(++this.requestIdCounter);
		const timeout = timeoutOverride ?? (
			this.isQuickMethod(method) ? this.quickTimeout : this.timeout
		);
		// The extension's operation gate releases a request still stuck in
		// EasyEDA at this deadline instead of blocking every later request.
		const request: BridgeRequest = { id, method, params: { ...params, _rpcTimeoutMs: timeout } };

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Request timed out after ${timeout}ms: ${method} (override with _timeoutMs)`));
			}, timeout);

			this.pendingRequests.set(id, { resolve, reject, timer, instanceId: client.info.instanceId });
			client.ws.send(JSON.stringify(request));
		});
	}

	private isQuickMethod(method: string): boolean {
		if (QUICK_METHOD_TIMEOUT_METHODS.has(method)) return true;
		if (method.startsWith('pcb.getAll.')) return true;
		if (method.startsWith('pcb.get.')) return true;
		if (
			method.startsWith('pcb.document.')
			&& !method.startsWith('pcb.document.set')
			&& !SLOW_DOCUMENT_METHODS.has(method)
		) return true;
		return method === 'pcb.component.getPins'
			|| method === 'pcb.net.getAllNames'
			|| method === 'pcb.net.getPrimitives'
			|| method === 'pcb.net.getLength'
			|| method === 'pcb.select.getAll';
	}

	private pruneClosedClients(): void {
		for (const [instanceId, client] of this.clients) {
			if (client.ws.readyState !== WebSocket.OPEN) {
				this.dropClient(instanceId, 'Removing closed extension connection');
			}
		}
	}

	private dropClient(instanceId: string, reason: string): void {
		const client = this.clients.get(instanceId);
		if (!client) return;

		this.clients.delete(instanceId);
		for (const [id, pending] of this.pendingRequests) {
			if (pending.instanceId !== instanceId) continue;
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
			this.pendingRequests.delete(id);
		}
		try {
			client.ws.close();
		} catch {
			// Already closed
		}
	}

	/**
	 * Refresh instance info for all connected instances.
	 */
	async refreshAllInstanceInfo(): Promise<void> {
		const refreshes = Array.from(this.clients.keys()).map((id) =>
			this.requestInstanceInfo(id),
		);
		await Promise.allSettled(refreshes);
	}

	private handleResponse(response: BridgeResponse): void {
		const pending = this.pendingRequests.get(response.id);
		if (!pending) {
			console.error(`[Bridge] Received response for unknown request: ${response.id}`);
			return;
		}

		clearTimeout(pending.timer);
		this.pendingRequests.delete(response.id);

		if (response.error) {
			pending.reject(new Error(response.error));
		} else {
			pending.resolve(response.result);
		}
	}

	/**
	 * Send a JSON message to all connected EasyEDA extensions.
	 */
	private broadcastToExtensions(message: Record<string, unknown>): void {
		const json = JSON.stringify(message);
		for (const [, client] of this.clients) {
			try {
				if (client.ws.readyState === WebSocket.OPEN) {
					client.ws.send(json);
				}
			} catch {
				// Best-effort
			}
		}
	}

	/**
	 * Notify all peer MCP servers in the port range that this agent has started.
	 * Connects briefly to each, sends a newAgent message, then disconnects.
	 */
	notifyPeers(portStart: number, portCount: number): void {
		const notification = JSON.stringify({
			type: 'newAgent',
			port: this.port,
			agentId: this.agentId,
		});

		// 2 second probe budget per peer is plenty — same-host loopback
		// connects in <50ms when something is listening. Without this, a
		// peer port that accepts the TCP connection but never speaks WS (a
		// firewall/proxy/orphaned listener) would keep the socket open
		// until the OS-level keepalive expires (minutes), leaking handles.
		const PEER_PROBE_TIMEOUT_MS = 2_000;

		for (let i = 0; i < portCount; i++) {
			const peerPort = portStart + i;
			if (peerPort === this.port) continue;

			const peerWs = new WebSocket(`ws://127.0.0.1:${peerPort}`, {
				origin: PEER_ORIGIN,
			});

			let settled = false;
			const cleanup = (): void => {
				settled = true;
				clearTimeout(probeTimer);
				try { peerWs.terminate(); } catch {/* */}
			};

			const probeTimer = setTimeout(() => {
				if (settled) return;
				cleanup();
			}, PEER_PROBE_TIMEOUT_MS);

			peerWs.on('open', () => {
				if (settled) return;
				try { peerWs.send(notification); } catch {/* */}
				try { peerWs.close(); } catch {/* */}
				clearTimeout(probeTimer);
				settled = true;
				console.error(`[Bridge] Notified peer on port ${peerPort}`);
			});

			peerWs.on('close', () => { if (!settled) cleanup(); });
			// Silently ignore connection failures (no peer on that port).
			peerWs.on('error', () => { if (!settled) cleanup(); });
		}
	}

	async stop(): Promise<void> {
		for (const [id, pending] of this.pendingRequests) {
			clearTimeout(pending.timer);
			pending.reject(new Error('Bridge shutting down'));
			this.pendingRequests.delete(id);
		}

		// Notify all connected extensions before closing
		const shutdownMsg = JSON.stringify({ type: 'shutdown', agentId: this.agentId });
		for (const [, client] of this.clients) {
			try {
				if (client.ws.readyState === WebSocket.OPEN) {
					client.ws.send(shutdownMsg);
				}
			} catch {
				// Best-effort
			}
			client.ws.close();
		}
		this.clients.clear();

		return new Promise((resolve) => {
			if (this.wss) {
				this.wss.close(() => {
					console.error('[Bridge] WebSocket Server closed');
					resolve();
				});
			} else {
				resolve();
			}
		});
	}
}

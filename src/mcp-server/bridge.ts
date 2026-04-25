import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { randomBytes } from 'crypto';

const PEER_ORIGIN = 'http://easyeda-agent.internal';

const ALLOWED_ORIGIN_PATTERNS = [
	/^https?:\/\/([a-z0-9-]+\.)*easyeda\.com(:\d+)?$/,
	/^https?:\/\/([a-z0-9-]+\.)*lceda\.cn(:\d+)?$/,
];

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
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	instanceId: string;
}

export class WebSocketBridge {
	private wss: WebSocketServer | null = null;
	private clients = new Map<string, ConnectedClient>();
	private pendingRequests = new Map<string, PendingRequest>();
	private requestIdCounter = 0;
	private readonly timeout: number;
	readonly agentId: string;

	constructor(private readonly port: number = 15168, timeout?: number) {
		// Default 120s; can be overridden via EDA_WS_TIMEOUT_MS env (whole-number ms).
		// 120s covers repour-all on dense boards, DSN/SES roundtrips, and big DRC
		// runs without the agent having to hand-tune _timeoutMs per call.
		const envTimeout = Number(process.env.EDA_WS_TIMEOUT_MS);
		this.timeout = timeout ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 120_000);
		this.agentId = randomBytes(8).toString('hex');
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
					for (const [reqId, pending] of this.pendingRequests) {
						if (pending.instanceId === instanceId) {
							clearTimeout(pending.timer);
							pending.reject(new Error(`Extension reconnected — request aborted (instance: ${instanceId})`));
							this.pendingRequests.delete(reqId);
						}
					}
				}

				const client: ConnectedClient = {
					ws,
					info: {
						instanceId,
						connectedAt: Date.now(),
					},
				};
				this.clients.set(instanceId, client);

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
						this.clients.delete(instanceId);
						for (const [id, pending] of this.pendingRequests) {
							if (pending.instanceId === instanceId) {
								clearTimeout(pending.timer);
								pending.reject(new Error(`EDA Pro Extension disconnected (instance: ${instanceId})`));
								this.pendingRequests.delete(id);
							}
						}
					}
				});

				ws.on('error', (err) => {
					console.error(`[Bridge] Client error (instance: ${instanceId}):`, err);
				});

				// Send agentId to the extension so it can deduplicate connections
				ws.send(JSON.stringify({ type: 'hello', agentId: this.agentId }));

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
		return this.clients.size > 0;
	}

	getConnectedCount(): number {
		return this.clients.size;
	}

	getConnectedInstances(): InstanceInfo[] {
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
		const { instance_id, _timeoutMs, ...forwardParams } = params;
		const client = this.resolveClient(instance_id as string | undefined);
		const timeoutMs = typeof _timeoutMs === 'number' && _timeoutMs > 0 ? _timeoutMs : undefined;
		return this.sendToClient(client, method, forwardParams, timeoutMs);
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
		const request: BridgeRequest = { id, method, params };
		const timeout = timeoutOverride ?? this.timeout;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Request timed out after ${timeout}ms: ${method} (override with _timeoutMs)`));
			}, timeout);

			this.pendingRequests.set(id, { resolve, reject, timer, instanceId: client.info.instanceId });
			client.ws.send(JSON.stringify(request));
		});
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

		for (let i = 0; i < portCount; i++) {
			const peerPort = portStart + i;
			if (peerPort === this.port) continue;

			const peerWs = new WebSocket(`ws://127.0.0.1:${peerPort}`, {
				origin: PEER_ORIGIN,
			});

			peerWs.on('open', () => {
				peerWs.send(notification);
				peerWs.close();
				console.error(`[Bridge] Notified peer on port ${peerPort}`);
			});

			// Silently ignore connection failures (no peer on that port)
			peerWs.on('error', () => {});
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

import { componentHandlers } from './handlers/component';
import { trackHandlers } from './handlers/track';
import { viaHandlers } from './handlers/via';
import { netHandlers } from './handlers/net';
import { drcHandlers } from './handlers/drc';
import { documentHandlers } from './handlers/document';
import { schComponentHandlers } from './handlers/sch-component';
import { schWireHandlers } from './handlers/sch-wire';
import { schDocumentHandlers } from './handlers/sch-document';
import { schSelectHandlers } from './handlers/sch-select';
import { schPrimitiveHandlers } from './handlers/sch-primitive';
import { libraryHandlers } from './handlers/library';
import { pourFillHandlers } from './handlers/pour-fill';
import { manufactureHandlers } from './handlers/manufacture';
import { layerHandlers } from './handlers/layer';
import { pcbPrimitiveHandlers } from './handlers/pcb-primitive';
import { editorHandlers } from './handlers/editor';
import { schExtractHandlers } from './handlers/sch-extract';

const PORT_RANGE_START = 15168;
const PORT_RANGE_SIZE = 40;

// === Instance ID =========================================================

const GLOBAL_KEY = '__claude_mcp_instance_id__';

function getOrCreateInstanceId(): string {
	const g = globalThis as any;
	if (!g[GLOBAL_KEY]) {
		const bytes = new Uint8Array(4);
		crypto.getRandomValues(bytes);
		g[GLOBAL_KEY] = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	}
	return g[GLOBAL_KEY];
}

const instanceId = getOrCreateInstanceId();

export function getInstanceId(): string {
	return instanceId;
}

// === Query-param post-processing =========================================

interface QueryParams {
	fields?: string[];
	filter?: Record<string, string | number | boolean | string[]>;
	limit?: number;
	compact?: boolean;
}

const COMPACT_FIELDS = [
	'primitiveId', 'id', 'net', 'layer',
	'x', 'y', 'startX', 'startY', 'endX', 'endY',
	'designator', 'padNumber', 'name', 'pourName',
	'lineWidth', 'holeDiameter', 'diameter', 'rotation', 'primitiveLock', 'viaType',
	'segmentCount', 'primitiveIds', 'deletedCount', 'ids',
	'modified', 'persisted', 'pourCount', 'rebuilt',
];

function compactItem(item: any): any {
	if (!item || typeof item !== 'object') return item;
	const out: any = {};
	for (const key of COMPACT_FIELDS) {
		if (key in item) out[key] = item[key];
	}
	if (typeof item.getState_PrimitiveId === 'function' && out.primitiveId == null) {
		try { out.primitiveId = item.getState_PrimitiveId(); } catch {/* ignore */}
	}
	return out;
}

function matchesFilter(item: any, filter: Record<string, string | number | boolean | string[]>): boolean {
	for (const [key, condition] of Object.entries(filter)) {
		const value = item[key];
		if (Array.isArray(condition)) {
			if (!condition.includes(String(value))) return false;
		} else if (typeof condition === 'string' && condition.endsWith('*')) {
			const prefix = condition.slice(0, -1);
			if (typeof value !== 'string' || !value.startsWith(prefix)) return false;
		} else {
			if (value !== condition) return false;
		}
	}
	return true;
}

function projectFields(item: any, fields: string[]): any {
	const projected: any = {};
	for (const field of fields) {
		if (field in item) projected[field] = item[field];
	}
	return projected;
}

function applyQueryParams(result: any, qp: QueryParams): any {
	if (!qp.fields && !qp.filter && !qp.limit && !qp.compact) return result;

	if (!Array.isArray(result)) {
		if (qp.fields && result && typeof result === 'object') return projectFields(result, qp.fields);
		if (qp.compact && result && typeof result === 'object') return compactItem(result);
		return result;
	}

	let items = result;
	if (qp.filter) items = items.filter((i: any) => matchesFilter(i, qp.filter!));
	if (qp.limit && items.length > qp.limit) items = items.slice(0, qp.limit);
	if (qp.fields) {
		return items.map((i: any) => projectFields(i, qp.fields!));
	}
	if (qp.compact) items = items.map(compactItem);
	return items;
}

// === Connection model ====================================================
// Multi-connection: the extension keeps a WebSocket open to every running
// MCP server it discovers. Each server can independently dispatch tool
// calls; the extension processes them concurrently for reads and serializes
// writes per-document via the lock manager (see runHandler below).

interface ClientInfo {
	name?: string;
	version?: string;
	pid?: number;
	startedAt?: number;
}

interface ServerEntry {
	port: number;
	agentId: string;
	connectedAt: number;
	greeted: boolean;
	clientInfo?: ClientInfo;
}

export function getConnectedServers(): ServerEntry[] {
	return Array.from(servers.values()).map((s) => ({ ...s }));
}

const SERVERS_KEY = '__claude_mcp_servers__';
const PROBES_KEY = '__claude_mcp_probes__';
const LAST_RECV_KEY = '__claude_mcp_last_received__';

const g = globalThis as any;
const servers: Map<number, ServerEntry> = g[SERVERS_KEY] || (g[SERVERS_KEY] = new Map<number, ServerEntry>());
const probes: Map<number, any> = g[PROBES_KEY] || (g[PROBES_KEY] = new Map<number, any>());
const lastReceivedTime: Map<number, number> = g[LAST_RECV_KEY] || (g[LAST_RECV_KEY] = new Map<number, number>());

const PROBE_TIMEOUT_MS = 4_000;

function wsIdForPort(port: number): string {
	return `mcp-bridge-${port}`;
}

function wsUrlForPort(port: number): string {
	return `ws://localhost:${port}?instanceId=${instanceId}`;
}

// === Lock manager (per-document write serialization) =====================
// Reads dispatch immediately. Writes acquire an async mutex keyed by the
// document UUID (or a global key when no doc context). This lets two agents
// work in parallel — one on a schematic and one on a PCB, or two reads
// against the same doc — while preventing simultaneous writes from
// trampling each other (e.g. two tools both creating tracks on the same PCB).

const docLocks: Map<string, Promise<void>> = new Map();

async function withDocLock<T>(docKey: string, fn: () => Promise<T>): Promise<T> {
	const prev = docLocks.get(docKey) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((r) => { release = r; });
	docLocks.set(docKey, prev.then(() => gate));
	try {
		await prev;
		return await fn();
	} finally {
		release();
		if (docLocks.get(docKey) === prev.then(() => gate)) docLocks.delete(docKey);
	}
}

// Methods that don't mutate the document. Any method NOT in this set is
// treated as a write and goes through the lock.
const READ_METHODS = new Set<string>([
	'instance.getInfo',
	// PCB reads
	'pcb.getAll.component', 'pcb.get.component', 'pcb.component.getPins',
	'pcb.getAll.line', 'pcb.get.line',
	'pcb.getAll.polyline', 'pcb.get.polyline',
	'pcb.getAll.via', 'pcb.get.via',
	'pcb.getAll.pad', 'pcb.get.pad', 'pcb.pad.findByRef',
	'pcb.getAll.pour', 'pcb.get.pour',
	'pcb.getAll.fill', 'pcb.get.fill',
	'pcb.getAll.arc', 'pcb.get.arc',
	'pcb.getAll.region', 'pcb.get.region',
	'pcb.net.getAllNames', 'pcb.net.getPrimitives', 'pcb.net.getLength',
	'pcb.net.connectivityStatus',
	'pcb.drc.check', 'pcb.drc.summarize',
	'pcb.drc.getCurrentRuleConfigName', 'pcb.drc.getRuleConfiguration',
	'pcb.drc.getRuleConfigByName', 'pcb.drc.getAllRuleConfigs',
	'pcb.drc.getDefaultRuleConfigName', 'pcb.drc.getNetRules',
	'pcb.drc.getNetByNetRules', 'pcb.drc.getRegionRules',
	'pcb.drc.getAllNetClasses', 'pcb.drc.getDiffPairs',
	'pcb.drc.getEqualLengthGroups',
	'pcb.layer.getAll', 'pcb.layer.getStatus',
	'pcb.document.navigateToCoordinates', 'pcb.document.navigateToRegion',
	'pcb.document.getPrimitiveAtPoint', 'pcb.document.getPrimitivesInRegion',
	'pcb.document.zoomToBoardOutline', 'pcb.document.getCanvasOrigin',
	'pcb.document.convertCanvasToData', 'pcb.document.convertDataToCanvas',
	'pcb.document.getCanvasFilter',
	'pcb.select.getAll',
	// SCH reads
	'sch.connectivity.get', 'sch.netlist.get', 'sch.drc.check',
	'sch.component.get', 'sch.component.getAll', 'sch.component.getAllPins',
	'sch.wire.get', 'sch.wire.getAll',
	'sch.primitive.get', 'sch.primitive.getType', 'sch.primitive.getBBox',
	'sch.select.getAll', 'sch.select.getAllIds',
	'sch.extract.design',
	// Editor / project reads + screenshots
	'editor.project.getStructure', 'editor.getCurrentDocument', 'editor.getOpenTabs',
	'editor.screenshot', 'pcb.screenshot.board',
	// Library reads (most lib operations are search/lookup)
	'lib.getAll', 'lib.search', 'lib.get', 'lib.getByLcsc', 'lib.getSystemUuid',
]);

function isReadMethod(method: string): boolean {
	if (READ_METHODS.has(method)) return true;
	// Permissive heuristic: lib.* defaults to read. Anything else is a write.
	if (method.startsWith('lib.')) return true;
	return false;
}

function lockKey(docUuid: string | undefined, method: string): string {
	if (docUuid) return `doc:${docUuid}`;
	// Global lock for methods that affect all docs / app-level state.
	return `__global__`;
}

// === Handler dispatch ====================================================

const allHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	...componentHandlers,
	...trackHandlers,
	...viaHandlers,
	...netHandlers,
	...drcHandlers,
	...documentHandlers,
	...schComponentHandlers,
	...schWireHandlers,
	...schDocumentHandlers,
	...schSelectHandlers,
	...schPrimitiveHandlers,
	...libraryHandlers,
	...pourFillHandlers,
	...manufactureHandlers,
	...layerHandlers,
	...pcbPrimitiveHandlers,
	...editorHandlers,
	...schExtractHandlers,
};

async function getInstanceInfo(): Promise<Record<string, any>> {
	const DOC_TYPE_NAMES: Record<number, string> = { 1: 'schematic', 3: 'pcb' };

	try {
		const [project, currentDoc, tree] = await Promise.all([
			eda.dmt_Project.getCurrentProjectInfo(),
			eda.dmt_SelectControl.getCurrentDocumentInfo(),
			eda.dmt_EditorControl.getSplitScreenTree(),
		]);

		const documents: Array<{ title: string; uuid: string }> = [];
		if (tree) {
			(function collectTabs(node: any): void {
				if (node.tabs) for (const tab of node.tabs) documents.push({ title: tab.title, uuid: tab.tabId });
				if (node.children) for (const child of node.children) collectTabs(child);
			})(tree);
		}

		const proj = project as any;
		const doc = currentDoc as any;

		return {
			instanceId,
			projectName: proj?.name ?? proj?.title,
			currentDocument: doc?.tabId,
			documentType: doc?.documentType != null ? (DOC_TYPE_NAMES[doc.documentType] || `type_${doc.documentType}`) : undefined,
			documents,
			connectedServers: servers.size,
		};
	} catch {
		return { instanceId };
	}
}

allHandlers['instance.getInfo'] = async () => getInstanceInfo();

async function requireDocumentType(method: string): Promise<void> {
	const requiresPcb = method.startsWith('pcb.');
	const requiresSch = method.startsWith('sch.');
	if (!requiresPcb && !requiresSch) return;

	const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	const docType = doc?.documentType;

	if (requiresPcb && docType !== 3) {
		const current = docType === 1 ? ' (a schematic is currently open)' : docType != null ? '' : ' (no document is open)';
		throw new Error(
			`This tool requires a PCB document, but the currently active tab is not a PCB${current}. Pass a PCB document UUID as the "document" parameter, or use editor_open_document to switch.`,
		);
	}
	if (requiresSch && docType !== 1) {
		const current = docType === 3 ? ' (a PCB is currently open)' : docType != null ? '' : ' (no document is open)';
		throw new Error(
			`This tool requires a schematic document, but the currently active tab is not a schematic${current}. Pass a schematic document UUID as the "document" parameter, or use editor_open_document to switch.`,
		);
	}
}

// === WS message handler ==================================================

function handleMessage(extensionUuid: string, port: number, event: MessageEvent<any>): void {
	let id: string | undefined;
	try {
		const message = typeof event.data === 'string' ? event.data : String(event.data);
		const request = JSON.parse(message);

		lastReceivedTime.set(port, Date.now());

		if (request.type === 'pong') return;

		if (request.type === 'hello') {
			handleHello(extensionUuid, port, request.agentId || '', request.clientInfo);
			return;
		}

		if (request.type === 'serverInfo') {
			// Bridge sent updated client info after MCP initialize handshake.
			const entry = servers.get(port);
			if (entry) {
				entry.clientInfo = request.clientInfo;
				if (request.agentId) entry.agentId = request.agentId;
			}
			return;
		}

		if (request.type === 'newAgent') {
			const newPort = request.port as number;
			if (newPort && newPort !== port && !servers.has(newPort) && !probes.has(newPort)) {
				openWs(extensionUuid, newPort);
			}
			return;
		}

		if (request.type === 'shutdown') {
			handleShutdown(extensionUuid, port);
			return;
		}

		// RPC request from a connected MCP server.
		id = request.id;
		const method: string = request.method;
		const params: Record<string, any> = request.params || {};

		const { fields, filter, limit, compact, document, ...handlerParams } = params;
		const qp: QueryParams = { fields, filter, limit, compact };

		const handler = allHandlers[method];
		if (!handler) {
			sendResponse(extensionUuid, port, id!, undefined, `Unknown method: ${method}. If you recently updated the MCP server, you may need to reinstall the EasyEDA extension as well.`);
			return;
		}

		const docUuid = document ? String(document).split('@')[0] : undefined;
		const switchDoc = docUuid ? eda.dmt_EditorControl.openDocument(docUuid) : Promise.resolve();

		const dispatch = async () => {
			await switchDoc;
			await requireDocumentType(method);
			const result = await handler(handlerParams);
			return applyQueryParams(result, qp);
		};

		const work = isReadMethod(method)
			? dispatch()
			: withDocLock(lockKey(docUuid, method), dispatch);

		work.then(
			(result) => sendResponse(extensionUuid, port, id!, result),
			(err: any) => sendResponse(extensionUuid, port, id!, undefined, err instanceof Error ? err.message : String(err)),
		);
	} catch (err: any) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		if (id) sendResponse(extensionUuid, port, id, undefined, errorMsg);
	}
}

function sendResponse(extensionUuid: string, port: number, id: string, result?: any, error?: string): void {
	const response: Record<string, any> = { id };
	if (error) response.error = error; else response.result = result;
	try {
		eda.sys_WebSocket.send(wsIdForPort(port), JSON.stringify(response), extensionUuid);
	} catch {
		dropConnection(extensionUuid, port);
	}
}

function sendNotification(extensionUuid: string, port: number, type: string, data: any): void {
	try {
		eda.sys_WebSocket.send(wsIdForPort(port), JSON.stringify({ type, data }), extensionUuid);
	} catch {
		dropConnection(extensionUuid, port);
	}
}

async function pushInstanceInfoToAll(extensionUuid: string): Promise<void> {
	if (servers.size === 0) return;
	const info = await getInstanceInfo();
	for (const port of servers.keys()) {
		sendNotification(extensionUuid, port, 'instanceInfo', info);
	}
}

// === Connection lifecycle ================================================

function handleHello(extensionUuid: string, port: number, agentId: string, clientInfo?: ClientInfo): void {
	const probeTimer = probes.get(port);
	if (probeTimer != null) {
		clearTimeout(probeTimer);
		probes.delete(port);
	}

	const existing = servers.get(port);
	if (existing) {
		existing.agentId = agentId;
		existing.greeted = true;
		if (clientInfo) existing.clientInfo = clientInfo;
		return;
	}

	servers.set(port, { port, agentId, connectedAt: Date.now(), greeted: true, clientInfo });
	queueConnectionToast(port, clientInfo);
	setTimeout(() => pushInstanceInfoToAll(extensionUuid), 200);
}

function handleShutdown(extensionUuid: string, port: number): void {
	if (servers.has(port)) {
		servers.delete(port);
		showInfo(`Claude MCP Server on port ${port} shut down`);
	}
	closeWs(extensionUuid, port);
}

function dropConnection(extensionUuid: string, port: number): void {
	const had = servers.delete(port);
	probes.delete(port);
	lastReceivedTime.delete(port);
	if (had) showWarning(`Lost connection to Claude MCP Server on port ${port}`);
	try {
		eda.sys_WebSocket.close(wsIdForPort(port), undefined, undefined, extensionUuid);
	} catch {/* already closed */}
}

// Toast batcher — multiple ports connecting in the same scan window
// produce ONE toast that names each client when known.
interface PendingConn { port: number; client?: ClientInfo }
let pendingConnects: PendingConn[] = [];
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function queueConnectionToast(port: number, client?: ClientInfo): void {
	pendingConnects.push({ port, client });
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		const conns = pendingConnects;
		pendingConnects = [];
		toastTimer = null;
		const labels = conns.map((c) => labelFor(c));
		if (labels.length === 1) {
			showSuccess(`Connected to ${labels[0]}`);
		} else if (labels.length > 1) {
			showSuccess(`Connected to ${labels.length} agents — ${labels.join(', ')}`);
		}
	}, 600);
}

function labelFor(c: { port: number; client?: ClientInfo }): string {
	if (c.client?.name) {
		return c.client.version ? `${c.client.name} ${c.client.version} (port ${c.port})` : `${c.client.name} (port ${c.port})`;
	}
	return `Claude MCP Server on port ${c.port}`;
}

// === WS open / close primitives =========================================

function openWs(extensionUuid: string, port: number): void {
	if (probes.has(port) || servers.has(port)) return;

	const wsId = wsIdForPort(port);
	const wsUrl = wsUrlForPort(port);

	const timer = setTimeout(() => {
		probes.delete(port);
		try { eda.sys_WebSocket.close(wsId, undefined, undefined, extensionUuid); } catch {/* */}
	}, PROBE_TIMEOUT_MS);
	probes.set(port, timer);

	eda.sys_WebSocket.register(
		wsId,
		wsUrl,
		(event: MessageEvent<any>) => handleMessage(extensionUuid, port, event),
		() => { lastReceivedTime.set(port, Date.now()); },
	);
}

function closeWs(extensionUuid: string, port: number): void {
	const probeTimer = probes.get(port);
	if (probeTimer != null) {
		clearTimeout(probeTimer);
		probes.delete(port);
	}
	lastReceivedTime.delete(port);
	try {
		eda.sys_WebSocket.close(wsIdForPort(port), undefined, undefined, extensionUuid);
	} catch {/* already closed */}
}

// === Scanning ============================================================

function scanForServers(extensionUuid: string): void {
	for (let i = 0; i < PORT_RANGE_SIZE; i++) {
		const port = PORT_RANGE_START + i;
		if (!servers.has(port) && !probes.has(port)) {
			openWs(extensionUuid, port);
		}
	}
}

export function connectToMcpServers(extensionUuid: string): void {
	const before = servers.size;
	scanForServers(extensionUuid);
	if (before > 0) {
		// User explicitly clicked Connect Claude with existing connections —
		// signal to them.
		setTimeout(() => {
			if (servers.size === before) {
				showInfo(`No new servers found (${before} already connected)`);
			}
		}, PROBE_TIMEOUT_MS + 500);
	}
}

export function disconnectFromAllMcpServers(extensionUuid: string): void {
	for (const port of servers.keys()) closeWs(extensionUuid, port);
	for (const port of probes.keys()) closeWs(extensionUuid, port);
	servers.clear();
	probes.clear();
	lastReceivedTime.clear();
}

export function getConnectedPortCount(): number {
	return servers.size;
}

export function getConnectedPorts(): number[] {
	return Array.from(servers.keys());
}

// === Heartbeat ===========================================================

const HEARTBEAT_INTERVAL_MS = 20_000;
const QUIET_THRESHOLD_MS = 25_000;
const DEAD_THRESHOLD_MS = 45_000;
const HEARTBEAT_TIMER_KEY = '__claude_mcp_heartbeat_timer__';

function runHeartbeat(extensionUuid: string): void {
	if (servers.size === 0) return;
	const now = Date.now();
	for (const port of [...servers.keys()]) {
		const lastRecv = lastReceivedTime.get(port) ?? 0;
		const silenceMs = now - lastRecv;

		if (silenceMs >= DEAD_THRESHOLD_MS) {
			dropConnection(extensionUuid, port);
		} else if (silenceMs >= QUIET_THRESHOLD_MS) {
			try {
				eda.sys_WebSocket.send(wsIdForPort(port), JSON.stringify({ type: 'ping' }), extensionUuid);
			} catch {
				dropConnection(extensionUuid, port);
			}
		}
	}
}

function startHeartbeat(extensionUuid: string): void {
	const g2 = globalThis as any;
	if (g2[HEARTBEAT_TIMER_KEY]) clearInterval(g2[HEARTBEAT_TIMER_KEY]);
	g2[HEARTBEAT_TIMER_KEY] = setInterval(() => runHeartbeat(extensionUuid), HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
	const g2 = globalThis as any;
	if (g2[HEARTBEAT_TIMER_KEY]) {
		clearInterval(g2[HEARTBEAT_TIMER_KEY]);
		g2[HEARTBEAT_TIMER_KEY] = null;
	}
}

// === Live mode ===========================================================

const LIVE_MODE_KEY = '__claude_mcp_live_mode__';
const LIVE_TIMER_KEY = '__claude_mcp_live_timer__';
const LIVE_UUID_KEY = '__claude_mcp_live_uuid__';
// Adaptive: 3s while we have any active connection (cheap discovery for new
// servers), 5s when empty (still snappy for spawn-and-call scripts). The
// scan checks every port but skips already-connected ones.
const SCAN_INTERVAL_ACTIVE_MS = 3_000;
const SCAN_INTERVAL_EMPTY_MS = 5_000;

function liveTick(extensionUuid: string): void {
	scanForServers(extensionUuid);
}

export function startLiveMode(extensionUuid: string): void {
	const g2 = globalThis as any;
	if (g2[LIVE_TIMER_KEY]) clearInterval(g2[LIVE_TIMER_KEY]);
	g2[LIVE_MODE_KEY] = true;
	g2[LIVE_UUID_KEY] = extensionUuid;
	liveTick(extensionUuid);
	const interval = servers.size > 0 ? SCAN_INTERVAL_ACTIVE_MS : SCAN_INTERVAL_EMPTY_MS;
	g2[LIVE_TIMER_KEY] = setInterval(() => liveTick(extensionUuid), interval);
	startHeartbeat(extensionUuid);
}

export function stopLiveMode(): void {
	const g2 = globalThis as any;
	g2[LIVE_MODE_KEY] = false;
	if (g2[LIVE_TIMER_KEY]) {
		clearInterval(g2[LIVE_TIMER_KEY]);
		g2[LIVE_TIMER_KEY] = null;
	}
	stopHeartbeat();
}

export function isLiveModeActive(): boolean {
	return !!(globalThis as any)[LIVE_MODE_KEY];
}

// === Toast helpers =======================================================

function showSuccess(msg: string): void {
	try { eda.sys_Message.showToastMessage(msg, ESYS_ToastMessageType.SUCCESS, 4); } catch {/* */}
}
function showInfo(msg: string): void {
	try { eda.sys_Message.showToastMessage(msg, ESYS_ToastMessageType.INFO, 3); } catch {/* */}
}
function showWarning(msg: string): void {
	try { eda.sys_Message.showToastMessage(msg, ESYS_ToastMessageType.WARNING, 4); } catch {/* */}
}

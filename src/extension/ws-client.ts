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

const PORT_RANGE_START = 15168;
const PORT_RANGE_SIZE = 40;

// === Instance ID =========================================================
// Random 8-char hex stamped on the extension. Survives IIFE re-evaluations
// (stored on globalThis), unique per browser tab.

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

// Whitelist when `compact:true` is set explicitly. The default response
// already omits heavy geometry (see flattenState in _utils.ts); compact
// goes further to identity + key geometry only.
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
		// Drop the `_availableFields` envelope — it adds tokens for every call
		// and the agent can always omit `fields` to discover them.
		return items.map((i: any) => projectFields(i, qp.fields!));
	}
	if (qp.compact) items = items.map(compactItem);
	return items;
}

// === Connection model ====================================================
// Single-primary: at most ONE open WebSocket to an MCP server. Other servers
// discovered via scan or peer notifications go on a standby list (port +
// agentId + lastSeen). When a `newAgent` event arrives we promote the new
// port — this matches the user expectation that the freshly started Claude
// terminal becomes active. If the primary dies, the most-recent standby
// gets promoted.

const PRIMARY_KEY = '__claude_mcp_primary__';
const STANDBY_KEY = '__claude_mcp_standby__';
const PROBES_KEY = '__claude_mcp_probes__';
const LAST_RECV_KEY = '__claude_mcp_last_received__';

interface PrimaryState {
	port: number;
	agentId: string;
}

interface StandbyEntry {
	agentId: string;
	lastSeen: number;
}

const g = globalThis as any;
const primary: { current: PrimaryState | null } =
	g[PRIMARY_KEY] || (g[PRIMARY_KEY] = { current: null });
const standby: Map<number, StandbyEntry> =
	g[STANDBY_KEY] || (g[STANDBY_KEY] = new Map<number, StandbyEntry>());
// Open WS that haven't yet greeted us with `hello`. Either they'll greet
// (and become primary or be moved to standby), or they'll be reaped by the
// 4s probe timeout.
const probes: Map<number, number> = g[PROBES_KEY] || (g[PROBES_KEY] = new Map<number, number>());
const lastReceivedTime: Map<number, number> =
	g[LAST_RECV_KEY] || (g[LAST_RECV_KEY] = new Map<number, number>());

const PROBE_TIMEOUT_MS = 4_000;

function wsIdForPort(port: number): string {
	return `mcp-bridge-${port}`;
}

function wsUrlForPort(port: number): string {
	return `ws://localhost:${port}?instanceId=${instanceId}`;
}

function isPrimary(port: number): boolean {
	return primary.current?.port === port;
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
			handleHello(extensionUuid, port, request.agentId || '');
			return;
		}

		if (request.type === 'newAgent') {
			// Peer notification: a brand-new MCP server just started. Promote it.
			const newPort = request.port as number;
			if (newPort && newPort !== port) {
				promoteOrConnect(extensionUuid, newPort, request.agentId || '');
			}
			return;
		}

		if (request.type === 'shutdown') {
			handleShutdown(extensionUuid, port);
			return;
		}

		// Only the primary processes RPC requests. Other ports shouldn't be
		// sending RPC at all (we close them after hello), but guard anyway.
		if (!isPrimary(port)) return;

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

		switchDoc.then(
			() => requireDocumentType(method).then(
				() => handler(handlerParams).then(
					(result) => sendResponse(extensionUuid, port, id!, applyQueryParams(result, qp)),
					(err: any) => sendResponse(extensionUuid, port, id!, undefined, err instanceof Error ? err.message : String(err)),
				),
				(err: any) => sendResponse(extensionUuid, port, id!, undefined, err instanceof Error ? err.message : String(err)),
			),
			(err: any) => sendResponse(extensionUuid, port, id!, undefined, `Failed to switch to document "${docUuid}": ${err instanceof Error ? err.message : String(err)}`),
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

async function pushPrimaryInstanceInfo(extensionUuid: string): Promise<void> {
	if (!primary.current) return;
	const info = await getInstanceInfo();
	sendNotification(extensionUuid, primary.current.port, 'instanceInfo', info);
}

// === Promotion / standby ================================================

function handleHello(extensionUuid: string, port: number, agentId: string): void {
	// Probe completed — server greeted us.
	const probeTimer = probes.get(port);
	if (probeTimer != null) {
		clearTimeout(probeTimer);
		probes.delete(port);
	}

	standby.set(port, { agentId, lastSeen: Date.now() });

	if (primary.current == null) {
		setPrimary(extensionUuid, port, agentId);
	} else if (primary.current.port === port) {
		// Already primary — refresh agentId
		primary.current.agentId = agentId;
	} else {
		// Already have a primary; this one stays in standby silently.
		// Close its WS to keep extension's open-socket count at exactly 1.
		closeWs(extensionUuid, port);
	}
}

function handleShutdown(extensionUuid: string, port: number): void {
	standby.delete(port);
	closeWs(extensionUuid, port);

	if (primary.current?.port === port) {
		primary.current = null;
		showInfo(`Claude MCP Server on port ${port} shut down`);
		promoteFromStandby(extensionUuid);
	}
}

function dropConnection(extensionUuid: string, port: number): void {
	standby.delete(port);
	probes.delete(port);
	lastReceivedTime.delete(port);

	if (primary.current?.port === port) {
		primary.current = null;
		promoteFromStandby(extensionUuid);
	}

	try {
		eda.sys_WebSocket.close(wsIdForPort(port), undefined, undefined, extensionUuid);
	} catch {/* already closed */}
}

function setPrimary(extensionUuid: string, port: number, agentId: string): void {
	const previous = primary.current;
	primary.current = { port, agentId };

	if (previous && previous.port !== port) {
		standby.set(previous.port, { agentId: previous.agentId, lastSeen: Date.now() });
		closeWs(extensionUuid, previous.port);
	}

	showSuccess(`Connected to Claude MCP Server on port ${port}`);
	setTimeout(() => pushPrimaryInstanceInfo(extensionUuid), 200);
}

function promoteOrConnect(extensionUuid: string, port: number, agentId: string): void {
	standby.set(port, { agentId, lastSeen: Date.now() });

	// Already primary? Nothing to do.
	if (primary.current?.port === port) return;

	// Open a WS and let `hello` decide.
	openWs(extensionUuid, port, /* preferPrimary */ true);
}

function promoteFromStandby(extensionUuid: string): void {
	if (primary.current != null) return;

	const candidates = Array.from(standby.entries())
		.sort((a, b) => b[1].lastSeen - a[1].lastSeen);
	for (const [port] of candidates) {
		openWs(extensionUuid, port, true);
		return; // try one at a time; if it fails the timeout will trigger another pass
	}

	// No standby — kick off a fresh scan.
	scanForServers(extensionUuid);
}

// === WS open / close primitives =========================================

function openWs(extensionUuid: string, port: number, preferPrimary: boolean): void {
	if (probes.has(port)) return;
	if (primary.current?.port === port) return;

	const wsId = wsIdForPort(port);
	const wsUrl = wsUrlForPort(port);

	// Probe timeout: if `hello` doesn't arrive within PROBE_TIMEOUT_MS, give up.
	const timer = setTimeout(() => {
		probes.delete(port);
		// Quietly close the failed probe — most likely no server on this port.
		try {
			eda.sys_WebSocket.close(wsId, undefined, undefined, extensionUuid);
		} catch {/* never opened */}
	}, PROBE_TIMEOUT_MS);
	probes.set(port, timer as unknown as number);

	eda.sys_WebSocket.register(
		wsId,
		wsUrl,
		(event: MessageEvent<any>) => handleMessage(extensionUuid, port, event),
		() => {
			lastReceivedTime.set(port, Date.now());
			// If preferPrimary and we currently have no primary, eagerly switch
			// the moment hello arrives (handled by handleHello).
			void preferPrimary;
		},
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

let scanInFlight = false;
let scanCompletionTimer: ReturnType<typeof setTimeout> | null = null;

function scanForServers(extensionUuid: string): void {
	if (scanInFlight) return;
	scanInFlight = true;

	for (let i = 0; i < PORT_RANGE_SIZE; i++) {
		openWs(extensionUuid, PORT_RANGE_START + i, /* preferPrimary */ true);
	}

	if (scanCompletionTimer) clearTimeout(scanCompletionTimer);
	scanCompletionTimer = setTimeout(() => {
		scanInFlight = false;
		scanCompletionTimer = null;
		if (!primary.current && standby.size === 0) {
			showInfo('No Claude MCP Server found in port range 15168–15207');
		}
	}, PROBE_TIMEOUT_MS + 500);
}

export function connectToMcpServers(extensionUuid: string): void {
	if (primary.current) {
		showInfo(`Already connected to Claude on port ${primary.current.port}`);
		return;
	}
	scanForServers(extensionUuid);
}

export function disconnectFromAllMcpServers(extensionUuid: string): void {
	if (primary.current) {
		closeWs(extensionUuid, primary.current.port);
	}
	for (const port of standby.keys()) closeWs(extensionUuid, port);
	for (const port of probes.keys()) closeWs(extensionUuid, port);
	primary.current = null;
	standby.clear();
	probes.clear();
	lastReceivedTime.clear();
}

export function getConnectedPortCount(): number {
	return primary.current ? 1 : 0;
}

export function getConnectedPorts(): number[] {
	return primary.current ? [primary.current.port] : [];
}

// === Heartbeat ===========================================================
// Tighter than the old 90/60/180s cadence so dead connections vanish in
// under a minute. We only watch the primary; standby ports have no open WS.

const HEARTBEAT_INTERVAL_MS = 20_000;
const QUIET_THRESHOLD_MS = 25_000;
const DEAD_THRESHOLD_MS = 45_000;
const HEARTBEAT_TIMER_KEY = '__claude_mcp_heartbeat_timer__';

function runHeartbeat(extensionUuid: string): void {
	if (!primary.current) return;
	const port = primary.current.port;
	const now = Date.now();
	const lastRecv = lastReceivedTime.get(port) ?? 0;
	const silenceMs = now - lastRecv;

	if (silenceMs >= DEAD_THRESHOLD_MS) {
		showWarning(`Lost connection to Claude MCP Server on port ${port}`);
		dropConnection(extensionUuid, port);
		return;
	}

	if (silenceMs >= QUIET_THRESHOLD_MS) {
		try {
			eda.sys_WebSocket.send(wsIdForPort(port), JSON.stringify({ type: 'ping' }), extensionUuid);
		} catch {
			dropConnection(extensionUuid, port);
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
// Background discovery only kicks in when we have NO primary. Once we own
// a primary, peer notifications (`newAgent`) handle discovery for free —
// no rescans needed.

const LIVE_MODE_KEY = '__claude_mcp_live_mode__';
const LIVE_TIMER_KEY = '__claude_mcp_live_timer__';
const LIVE_UUID_KEY = '__claude_mcp_live_uuid__';
const SCAN_RETRY_INTERVAL_MS = 30_000;

function liveTick(extensionUuid: string): void {
	if (primary.current) return;
	scanForServers(extensionUuid);
}

export function startLiveMode(extensionUuid: string): void {
	const g2 = globalThis as any;
	if (g2[LIVE_TIMER_KEY]) clearInterval(g2[LIVE_TIMER_KEY]);
	g2[LIVE_MODE_KEY] = true;
	g2[LIVE_UUID_KEY] = extensionUuid;
	g2[LIVE_TIMER_KEY] = setInterval(() => liveTick(extensionUuid), SCAN_RETRY_INTERVAL_MS);
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

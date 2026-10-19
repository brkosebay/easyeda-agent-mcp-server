import { decodeNativeMessage, encodeNativeMessage, forgetNativePeer } from './native-peer';
import { panelizeHandlers } from './handlers/panelize';
import { activateNativeDocument } from './document-context';
import { createNativeOperationGate, nativeOperationStatus, onNativeOperationsReset, resetNativeOperations } from './native-operation-gate';
import { nativeProjectHandlers } from './handlers/native-project';
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
import { routingHandlers } from './handlers/routing';
import { editorHandlers } from './handlers/editor';
import { schExtractHandlers } from './handlers/sch-extract';
import { pcbExtractHandlers } from './handlers/pcb-extract';
import { placementHandlers } from './handlers/placement';
import { traceObstacleHandlers } from './handlers/trace-obstacles';
import { boardContextHandlers, invalidateBoardSnapshotCache } from './handlers/board-context';
import { impedanceHandlers } from './handlers/impedance';
import { routeCleanupHandlers } from './handlers/route-cleanup';
import { routePathHandlers } from './handlers/route-path';
import { nativeEditorHandlers } from './handlers/native-editor';
import { splitPourHandlers } from './handlers/split-pour';
import { layerAnalysisHandlers } from './handlers/layer-analysis';
import { routePairHandlers } from './handlers/route-pair';
import { didTimeOut, flattenState, withTimeout } from './handlers/_utils';
import { selectionGuardKind, withSelectionGuard } from './selection-guard';
import { GATE_BYPASS_METHODS, isReadMethod } from '../shared/method-classes';

const nativeOperationGate = createNativeOperationGate();

// Bump whenever the bridge wire protocol or gate semantics change. Socket
// state lives on globalThis (so menu re-evaluations keep their connections);
// a bundle with a different generation must NOT inherit sockets whose
// message callbacks still point into the previous build's closures.
// 2.1.10: document locks expire with the caller's deadline and are dropped by
// native_operation_reset; repour/save/importChanges never await EasyEDA
// without a deadline.
// The generation is the packaged extension version (esbuild define): it was
// hand-bumped before, and a forgotten bump (stuck at v2.1.16 through 2.1.19)
// let an upgraded bundle keep serving the previous bundle's handlers.
declare const __EXTENSION_VERSION__: string | undefined;
const BRIDGE_GENERATION = `v${typeof __EXTENSION_VERSION__ === 'string' ? __EXTENSION_VERSION__ : 'dev'}`;
const GENERATION_KEY = '__claude_mcp_bridge_generation__';

// Used when a legacy peer sends no deadline with the request.
const DEFAULT_GATE_TIMEOUT_MS = 120_000;

// Status / recovery / identity requests (GATE_BYPASS_METHODS) must answer even
// while a native call holds the gate — they are how an operator finds and
// clears a wedge. The method lists live in src/shared/method-classes.ts so the
// daemon classifies writes exactly the way this gate does.

const PORT_RANGE_START = 15168;
const PORT_RANGE_SIZE = 40;
const DEFAULT_MAX_CONNECTED_SERVERS = 4;
const MAX_CONNECTED_SERVERS_KEY = 'maxConnectedAgents';
const STALE_SERVER_MS = 90_000;
const MAX_RESPONSE_SANITIZE_DEPTH = 14;

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
	'summary', 'outlineSummary',
	// Regions carry no x/y at all — their identity is regionName/ruleType and
	// their geometry only survives as the summarized polygon.
	'regionName', 'ruleType', 'geometry', 'coordinateSpace', 'primitiveType',
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
	// Handlers that project server-side attach `_availableFields`; a second
	// projection here must not strip that metadata back off.
	if (item && typeof item === 'object' && '_availableFields' in item) {
		projected._availableFields = item._availableFields;
	}
	return projected;
}

function applyQueryParams(result: any, qp: QueryParams): any {
	if (!qp.fields && !qp.filter && !qp.limit && !qp.compact) return result;

	if (!Array.isArray(result)) {
		// {total, matched, returned, truncated, items} envelopes
		// (envelopeStateArray): apply query params to the items, not the
		// envelope itself.
		//
		// `total`   — how many primitives matched the handler's own query
		//             (net/layer/lock), before any `filter` or `limit`.
		// `matched` — how many survived `filter`, within the window the
		//             handler returned.
		// `truncated` is true only when items were really cut off: either the
		// handler paginated (window smaller than total) or `limit` trimmed the
		// post-filter set.
		if (result && typeof result === 'object' && Array.isArray(result.items) && typeof result.total === 'number') {
			const window: any[] = result.items;
			const filtered = qp.filter ? window.filter((i: any) => matchesFilter(i, qp.filter!)) : window;
			const items = applyQueryParams(filtered, { ...qp, filter: undefined });
			const priorMatched = typeof result.matched === 'number' ? result.matched : result.total;
			const matched = qp.filter ? filtered.length : priorMatched;
			const windowWasCut = window.length < result.total;
			return {
				...result,
				matched,
				returned: items.length,
				truncated: items.length < filtered.length || windowWasCut,
				items,
			};
		}
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

function hasStateGetters(value: any): boolean {
	if (!value || typeof value !== 'object') return false;
	for (let p = Object.getPrototypeOf(value); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
		for (const name of Object.getOwnPropertyNames(p)) {
			if (name.startsWith('getState_') && typeof value[name] === 'function') return true;
		}
	}
	return false;
}

function sanitizeForJson(value: any, seen = new WeakSet<object>(), depth = 0): any {
	if (value == null) return value;
	const type = typeof value;
	if (type === 'string' || type === 'number' || type === 'boolean') return value;
	if (type === 'bigint') return String(value);
	if (type === 'function' || type === 'symbol' || type === 'undefined') return undefined;
	if (type !== 'object') return value;

	// `seen` tracks only the current ancestor path so shared (non-circular)
	// references are sanitized normally instead of becoming "[Circular]".
	if (seen.has(value)) return '[Circular]';
	seen.add(value);
	try {
		if (hasStateGetters(value)) {
			return sanitizeForJson(flattenState(value), seen, depth + 1);
		}

		if (Array.isArray(value)) {
			return value
				.map((item) => sanitizeForJson(item, seen, depth + 1))
				.filter((item) => item !== undefined);
		}

		if (value instanceof Map) {
			const out: Record<string, any> = {};
			for (const [k, v] of value.entries()) out[String(k)] = sanitizeForJson(v, seen, depth + 1);
			return out;
		}

		if (value instanceof Set) {
			return Array.from(value.values())
				.map((item) => sanitizeForJson(item, seen, depth + 1))
				.filter((item) => item !== undefined);
		}

		if (value instanceof Date) return value.toISOString();

		if (typeof Blob !== 'undefined' && value instanceof Blob) {
			return { type: value.type, size: value.size };
		}

		if (depth >= MAX_RESPONSE_SANITIZE_DEPTH) {
			const keys = Object.keys(value);
			return { _truncated: true, type: value?.constructor?.name, keys: keys.slice(0, 20), keyCount: keys.length };
		}

		const out: Record<string, any> = {};
		for (const key of Object.keys(value)) {
			const sanitized = sanitizeForJson(value[key], seen, depth + 1);
			if (sanitized !== undefined) out[key] = sanitized;
		}
		return out;
	} finally {
		seen.delete(value);
	}
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

interface DocumentAlias {
	title?: string;
	uuid: string;
	documentType?: number;
}

export function getConnectedServers(): ServerEntry[] {
	return Array.from(servers.values()).map((s) => ({ ...s }));
}

const SERVERS_KEY = '__claude_mcp_servers__';
const PROBES_KEY = '__claude_mcp_probes__';
const LAST_RECV_KEY = '__claude_mcp_last_received__';
const DOC_ALIAS_KEY = '__claude_mcp_doc_aliases__';
const SCAN_CURSOR_KEY = '__claude_mcp_scan_cursor__';

const g = globalThis as any;
const servers: Map<number, ServerEntry> = g[SERVERS_KEY] || (g[SERVERS_KEY] = new Map<number, ServerEntry>());
const probes: Map<number, any> = g[PROBES_KEY] || (g[PROBES_KEY] = new Map<number, any>());
const lastReceivedTime: Map<number, number> = g[LAST_RECV_KEY] || (g[LAST_RECV_KEY] = new Map<number, number>());
const documentAliases: Map<string, DocumentAlias> = g[DOC_ALIAS_KEY] || (g[DOC_ALIAS_KEY] = new Map<string, DocumentAlias>());
let scanCursor: number = Number.isInteger(g[SCAN_CURSOR_KEY]) ? g[SCAN_CURSOR_KEY] : 0;

const PROBE_TIMEOUT_MS = 4_000;

function wsIdForPort(port: number): string {
	return `mcp-bridge-${port}`;
}

function wsUrlForPort(port: number): string {
	return `ws://localhost:${port}?instanceId=${instanceId}`;
}

function getMaxConnectedServers(): number {
	const override = (() => {
		try {
			return eda.sys_Storage.getExtensionUserConfig(MAX_CONNECTED_SERVERS_KEY);
		} catch {
			return undefined;
		}
	})();
	const parsed = Number(override);
	if (Number.isFinite(parsed)) {
		return Math.max(1, Math.min(PORT_RANGE_SIZE, Math.floor(parsed)));
	}
	return DEFAULT_MAX_CONNECTED_SERVERS;
}

function trimServersToCapacity(extensionUuid: string): void {
	const maxConnections = getMaxConnectedServers();
	if (servers.size <= maxConnections) return;

	const sorted = Array.from(servers.values()).sort((a, b) => a.connectedAt - b.connectedAt);
	const overage = servers.size - maxConnections;
	for (const entry of sorted.slice(0, overage)) {
		servers.delete(entry.port);
		lastReceivedTime.delete(entry.port);
		inflightRequests.delete(entry.port);
		try { eda.sys_WebSocket.close(wsIdForPort(entry.port), undefined, undefined, extensionUuid); } catch {/* ignore */}
	}
}

function isServerStale(port: number, now: number): boolean {
	const lastRecv = lastReceivedTime.get(port);
	if (lastRecv == null) return true;
	return now - lastRecv >= STALE_SERVER_MS;
}

function reapStaleServers(extensionUuid: string): number {
	const now = Date.now();
	let removed = 0;

	for (const [port, entry] of servers) {
		const inflight = inflightRequests.get(port) ?? 0;
		if (inflight > 0) continue;
		if (isServerStale(port, now)) {
			servers.delete(entry.port);
			lastReceivedTime.delete(entry.port);
			inflightRequests.delete(entry.port);
			try { eda.sys_WebSocket.close(wsIdForPort(entry.port), undefined, undefined, extensionUuid); } catch {/* ignore */}
			removed += 1;
		}
	}

	return removed;
}

function hasFreeConnectionSlot(reservedSlots = 1): boolean {
	const maxConnections = getMaxConnectedServers();
	return (servers.size + probes.size + reservedSlots) <= maxConnections;
}

// === Lock manager (per-document write serialization) =====================
// Reads dispatch immediately. Writes acquire an async mutex keyed by the
// document UUID (or a global key when no doc context). This lets two agents
// work in parallel — one on a schematic and one on a PCB, or two reads
// against the same doc — while preventing simultaneous writes from
// trampling each other (e.g. two tools both creating tracks on the same PCB).

const docLocks: Map<string, Promise<void>> = new Map();

// A handler whose EasyEDA promise never settles must not hold its document
// forever. Before 2.1.10 the lock was released only when `fn` settled, so one
// wedged write (e.g. pcb.pour.repourAll awaiting an unanswered SDK call) kept
// the per-document chain pending for the rest of the session: the operation
// gate's watchdog abandoned the call and `native_operation_reset` cleared the
// gate, but every later write — native getSource included — still queued here
// and timed out. `maxHoldMs` is the caller's remaining deadline (the same one
// the gate watchdog enforces); at that point the lock is released even if
// `fn` is still running inside EasyEDA.
async function withDocLock<T>(docKey: string, fn: () => Promise<T>, maxHoldMs?: number): Promise<T> {
	const prev = docLocks.get(docKey) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((r) => { release = r; });
	// Capture the chain in a stable variable. The previous version called
	// `prev.then(() => gate)` twice — once to set, once to compare — which
	// produced two DIFFERENT promise objects. The strict-equality guard at
	// cleanup never matched, so docLocks grew forever (one entry per unique
	// document UUID ever touched in the session). Real memory leak.
	const chain = prev.then(() => gate);
	docLocks.set(docKey, chain);
	let holdTimer: ReturnType<typeof setTimeout> | undefined;
	let released = false;
	const releaseOnce = () => {
		if (released) return;
		released = true;
		if (holdTimer !== undefined) clearTimeout(holdTimer);
		release();
		if (docLocks.get(docKey) === chain) docLocks.delete(docKey);
	};
	try {
		await prev;
		if (maxHoldMs !== undefined && Number.isFinite(maxHoldMs) && maxHoldMs > 0) {
			holdTimer = setTimeout(releaseOnce, maxHoldMs);
		}
		return await fn();
	} finally {
		releaseOnce();
	}
}

// `native_operation_reset` must also drop document locks: a lock chain whose
// holder never settles (pre-2.1.10 holders had no hold deadline) would
// otherwise survive the gate reset and keep blocking writes.
onNativeOperationsReset(() => {
	const cleared = docLocks.size;
	docLocks.clear();
	return { docLocksCleared: cleared };
});

// Handlers that size their own work to the caller's deadline receive it as
// `_gateDeadlineAt` (epoch ms). Only listed methods get it so the key never
// leaks into handlers that spread params into EasyEDA property objects.
const DEADLINE_AWARE_METHODS = new Set<string>([
	'pcb.pour.repourAll',
	'pcb.document.save',
	'pcb.document.importChanges',
	'pcb.modify.pad',
	'pcb.create.pad',
	'editor.openDocument',
	// Commit + verification stages that size themselves to the deadline.
	'pcb.route.path',
	'pcb.via.moveWithTracks',
	'pcb.splitPour.create',
	'pcb.layer.moveTracks',
	'pcb.route.pair',
]);

function lockKey(docUuid: string | undefined, method: string): string {
	if (docUuid) return `doc:${docUuid}`;
	// Global lock for methods that affect all docs / app-level state.
	return `__global__`;
}

// === Handler dispatch ====================================================

const allHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	...componentHandlers,
	...trackHandlers,
	...routePathHandlers,
	...nativeEditorHandlers,
	...splitPourHandlers,
	...layerAnalysisHandlers,
	...routePairHandlers,
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
	...routingHandlers,
	...editorHandlers,
	...nativeProjectHandlers,
	...panelizeHandlers,
	...schExtractHandlers,
	...pcbExtractHandlers,
	...placementHandlers,
	...traceObstacleHandlers,
	...boardContextHandlers,
	...impedanceHandlers,
	...routeCleanupHandlers,
};

const INFO_CALL_TIMEOUT_MS = 3_000;

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	return new Promise<T | undefined>((resolve) => {
		const timer = setTimeout(() => resolve(undefined), ms);
		Promise.resolve(promise).then(
			(value) => { clearTimeout(timer); resolve(value); },
			() => { clearTimeout(timer); resolve(undefined); },
		);
	});
}

async function getInstanceInfo(): Promise<Record<string, any>> {
	const DOC_TYPE_NAMES: Record<number, string> = { 1: 'schematic', 3: 'pcb' };

	try {
		// Bounded: this runs outside the operation gate and must answer even
		// while EasyEDA is stuck in a modal/placement state.
		const [project, currentDoc, tree] = await Promise.all([
			settleWithin(eda.dmt_Project.getCurrentProjectInfo(), INFO_CALL_TIMEOUT_MS),
			settleWithin(eda.dmt_SelectControl.getCurrentDocumentInfo(), INFO_CALL_TIMEOUT_MS),
			settleWithin(eda.dmt_EditorControl.getSplitScreenTree(), INFO_CALL_TIMEOUT_MS),
		]);

		const documents: Array<{ title: string; uuid: string }> = [];
		if (tree) {
			(function collectTabs(node: any): void {
				if (node.tabs) {
					for (const tab of node.tabs) {
						documents.push({ title: tab.title, uuid: tab.tabId });
						rememberDocumentAlias(tab.title, tab.tabId);
					}
				}
				if (node.children) for (const child of node.children) collectTabs(child);
			})(tree);
		}

		const proj = project as any;
		const doc = currentDoc as any;

		// Seed our caches from this fresh fetch.
		if (doc?.tabId) {
			currentDocUuid = canonicalDocumentId(doc.tabId);
			if (doc.documentType != null) rememberDocType(currentDocUuid, doc.documentType);
			rememberDocumentAlias(doc.title ?? doc.name, doc.tabId, doc.documentType);
			if (doc.uuid) rememberDocumentAlias(doc.title ?? doc.name, doc.uuid, doc.documentType);
		}

		return {
			instanceId,
			projectName: proj?.name ?? proj?.title,
			currentDocument: doc?.tabId,
			documentType: doc?.documentType != null ? (DOC_TYPE_NAMES[doc.documentType] || `type_${doc.documentType}`) : undefined,
			documents,
			connectedServers: servers.size,
			bridgeGeneration: BRIDGE_GENERATION,
			gate: nativeOperationStatus(),
		};
	} catch {
		return { instanceId, bridgeGeneration: BRIDGE_GENERATION, gate: nativeOperationStatus() };
	}
}

allHandlers['instance.getInfo'] = async () => getInstanceInfo();

// Cache: docUuid → documentType (1 = schematic, 3 = pcb). Doc type is
// immutable for the life of a document so this cache is safe.
//
// Capped via FIFO eviction: a long session that touches hundreds of
// documents (e.g. an agent walking every page of a multi-sheet schematic
// project) would otherwise keep every entry forever.
const DOC_TYPE_CACHE_MAX = 256;
const docTypeCache: Map<string, number> = new Map();
function rememberDocType(uuid: string, type: number): void {
	uuid = canonicalDocumentId(uuid);
	// Map iteration order is insertion order — re-inserting moves the entry
	// to the back, so an LRU-ish eviction works without a sidecar list.
	if (docTypeCache.has(uuid)) docTypeCache.delete(uuid);
	docTypeCache.set(uuid, type);
	while (docTypeCache.size > DOC_TYPE_CACHE_MAX) {
		const oldest = docTypeCache.keys().next().value;
		if (!oldest) break;
		docTypeCache.delete(oldest);
	}
}

function canonicalDocumentId(value: string): string {
	return String(value).trim().split('@')[0];
}

function documentAliasKey(value: string): string {
	return canonicalDocumentId(value).toLowerCase();
}

function rememberDocumentAlias(title: string | undefined, uuid: string | undefined, documentType?: number): void {
	if (!uuid) return;
	const canonicalUuid = canonicalDocumentId(uuid);
	const alias: DocumentAlias = { title, uuid: canonicalUuid, documentType };

	documentAliases.set(documentAliasKey(canonicalUuid), alias);
	documentAliases.set(documentAliasKey(uuid), alias);
	if (title) documentAliases.set(documentAliasKey(title), alias);
	if (documentType != null) rememberDocType(canonicalUuid, documentType);
}

function lookupDocumentAlias(value: string | undefined): DocumentAlias | undefined {
	if (!value) return undefined;
	return documentAliases.get(documentAliasKey(value));
}

function isLikelyDocumentUuid(value: string): boolean {
	// EasyEDA tab/document UUIDs are long opaque strings. Short labels like
	// "PCB2" must be resolved from open tabs rather than passed directly to
	// openDocument(), which can hang in the editor runtime.
	return value.length >= 8 && !/\s/.test(value);
}

async function refreshDocumentAliases(): Promise<void> {
	const [tree, currentDoc] = await Promise.all([
		eda.dmt_EditorControl.getSplitScreenTree().catch(() => undefined),
		eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => undefined),
	]);

	function collectTabs(node: any): void {
		if (node?.tabs) {
			for (const tab of node.tabs) {
				rememberDocumentAlias(tab.title, tab.tabId);
			}
		}
		if (node?.children) {
			for (const child of node.children) collectTabs(child);
		}
	}
	if (tree) collectTabs(tree);

	const doc = currentDoc as any;
	if (doc?.tabId || doc?.uuid) {
		const activeUuid = canonicalDocumentId(doc.tabId ?? doc.uuid);
		currentDocUuid = activeUuid;
		rememberDocumentAlias(doc.title ?? doc.name, doc.tabId ?? doc.uuid, doc.documentType);
		if (doc.uuid) rememberDocumentAlias(doc.title ?? doc.name, doc.uuid, doc.documentType);
		if (doc.documentType != null) rememberDocType(activeUuid, doc.documentType);
	}
}

async function resolveDocumentUuid(document: string | undefined): Promise<string | undefined> {
	if (!document) return undefined;
	const requested = canonicalDocumentId(document);
	if (!requested) return undefined;
	if (currentDocUuid && currentDocUuid === requested) return requested;

	let alias = lookupDocumentAlias(requested);
	if (alias) return alias.uuid;

	await refreshDocumentAliases();
	if (currentDocUuid && currentDocUuid === requested) return requested;

	alias = lookupDocumentAlias(requested);
	if (alias) return alias.uuid;

	if (isLikelyDocumentUuid(requested)) return requested;

	throw new Error(
		`Document "${document}" is not an open document UUID/title. Use list_instances or editor_get_open_tabs and pass the full PCB document UUID instead of a short label.`,
	);
}

// Tracks the currently-active document UUID so we can skip redundant
// `openDocument` calls (which switch tabs and cost ~50ms each).
let currentDocUuid: string | undefined;

async function requireDocumentType(method: string, docUuid: string | undefined): Promise<void> {
	const requiresPcb = method.startsWith('pcb.');
	const requiresSch = method.startsWith('sch.');
	if (!requiresPcb && !requiresSch) return;

	const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	const active = doc?.uuid ? canonicalDocumentId(doc.uuid) : undefined;
	if (docUuid && active !== canonicalDocumentId(docUuid)) throw new Error('Active document changed before tool execution.');
	const docType = doc?.documentType;
	currentDocUuid = active;

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

/**
 * Activate `docUuid` (fire-and-verify, never quarantines — document-context.ts)
 * within the caller's deadline. Returns the bare UUID that is actually active:
 * a schematic UUID activates one of its pages.
 */
async function ensureDocument(docUuid: string | undefined, deadlineAt?: number): Promise<string | undefined> {
	if (!docUuid) return undefined;
	const result: any = await activateNativeDocument(docUuid, deadlineAt ? { deadlineAt: deadlineAt - 1_500 } : {});
	const active = result?.uuid ? canonicalDocumentId(String(result.uuid)) : canonicalDocumentId(docUuid);
	currentDocUuid = active;
	return active;
}

// === WS message handler ==================================================

async function handleMessage(extensionUuid: string, port: number, event: MessageEvent<any>): Promise<void> {
	let id: string | undefined;
	try {
		const message = typeof event.data === 'string' ? event.data : String(event.data);
		const request = await decodeNativeMessage(port, instanceId, JSON.parse(message), payload=>eda.sys_WebSocket.send(wsIdForPort(port),payload,extensionUuid)) as Record<string, any> | undefined;
		if (!request) return;

		lastReceivedTime.set(port, Date.now());

		if (request.type === 'pong') return;

		// Application-level liveness probe from the daemon/bridge. Answered
		// here, before the operation gate, so a busy gate never looks like a
		// dead socket — the daemon uses the gate status in instance.getInfo
		// for that instead.
		if (request.type === 'ping') {
			sendNativeFrame(extensionUuid, port, { type: 'pong', generation: BRIDGE_GENERATION });
			return;
		}

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

		if (!servers.get(port)?.greeted) throw new Error('Native RPC arrived before peer registration.');

		// RPC request from a connected MCP server.
		id = request.id;
		const method: string = request.method;
		const params: Record<string, any> = request.params || {};

		const receivedAt = Date.now();
		const { fields, filter, limit, compact, document, _rpcTimeoutMs, ...handlerParams } = params;
		const qp: QueryParams = { fields, filter, limit, compact };
		// getAll-style handlers paginate at the source (envelopeStateArray) and
		// need limit/fields too — re-applying them post-hoc is idempotent.
		if (limit != null) handlerParams.limit = limit;
		if (fields != null) handlerParams.fields = fields;
		// Handlers that paginate at the source need `filter` too, otherwise the
		// limit is applied to the unfiltered set and the matching items further
		// down the list are never seen. Re-applying it post-hoc is idempotent.
		if (filter != null) handlerParams.filter = filter;

		const handler = allHandlers[method];
		if (!handler) {
			sendResponse(extensionUuid, port, id!, undefined, `Unknown method: ${method}. If you recently updated the MCP server, you may need to reinstall the EasyEDA extension as well.`);
			return;
		}

		// The caller's deadline (daemon/bridge timer). Explicit `_timeoutMs`
		// wins; legacy peers that send neither get a conservative default so
		// one hung EasyEDA call can never hold the gate forever.
		const explicitTimeout = Number(_rpcTimeoutMs ?? handlerParams._timeoutMs);
		const gateTimeoutMs = Number.isFinite(explicitTimeout) && explicitTimeout > 0 ? explicitTimeout : DEFAULT_GATE_TIMEOUT_MS;
		if (DEADLINE_AWARE_METHODS.has(method)) handlerParams._gateDeadlineAt = receivedAt + gateTimeoutMs;

		const requestedDocument = document ? String(document) : undefined;
		const dispatchForDocument = async (docUuid: string | undefined) => {
			// editor.openDocument activates its own target; the daemon injects its
			// cached (possibly stale) current document, which must not be
			// re-activated first.
			const target = method === 'editor.openDocument' ? undefined : docUuid;
			const active = await ensureDocument(target, receivedAt + gateTimeoutMs);
			await requireDocumentType(method, active ?? target);
			// Writes run with the GUI selection released so the Property panel
			// can't commit stale values over them (see selection-guard.ts).
			const result = await withSelectionGuard(selectionGuardKind(method, isReadMethod(method)), () => handler(handlerParams));
			// sendResponse sanitizes the final payload; no need to do it twice.
			return applyQueryParams(result, qp);
		};

		const dispatchRead = async () => {
			const docUuid = await resolveDocumentUuid(requestedDocument);
			return dispatchForDocument(docUuid);
		};

		const dispatchWrite = async () => {
			const docUuid = await resolveDocumentUuid(requestedDocument);
			// Hold the document no longer than the caller's deadline — the gate
			// watchdog abandons the call at the same moment.
			const remainingMs = Math.max(1_000, receivedAt + gateTimeoutMs - Date.now());
			return withDocLock(lockKey(docUuid, method), async () => {
				try { return await dispatchForDocument(docUuid); }
				finally {
					if (method.startsWith('pcb.') || method === 'editor.native.set') invalidateBoardSnapshotCache(docUuid);
				}
			}, remainingMs);
		};

		const read = isReadMethod(method);
		const work = GATE_BYPASS_METHODS.has(method)
			? handler(handlerParams)
			: nativeOperationGate(!read, () => read ? dispatchRead() : dispatchWrite(), {
				label: method,
				timeoutMs: gateTimeoutMs,
				enqueuedAt: receivedAt,
			});

		// Mark this port as having an in-flight handler so the heartbeat
		// doesn't drop the connection during a slow operation (repour_all,
		// autoroute, big exports). Decremented in both branches.
		noteInflightStart(port);
		work.then(
			(result) => { noteInflightEnd(port); sendResponse(extensionUuid, port, id!, result); },
			(err: any) => { noteInflightEnd(port); sendResponse(extensionUuid, port, id!, undefined, err instanceof Error ? err.message : String(err)); },
		);
	} catch (err: any) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		if (id) sendResponse(extensionUuid, port, id, undefined, errorMsg);
		else {
			reportBridgeFailure(extensionUuid, port, err);
			dropConnection(extensionUuid, port);
		}
	}
}

// Handshake / framing failures used to drop the socket silently, which made
// a broken credential look like "no daemon running". Tell the peer why (so
// the daemon can log it), write it to EasyEDA's Log panel, and toast it —
// deduplicated, because the live scan retries every few seconds.
const FAILURE_TOAST_DEDUP_MS = 60_000;
const FAILURE_SEEN_KEY = '__claude_mcp_failure_seen__';

function reportBridgeFailure(extensionUuid: string, port: number, err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	const stage = (err as { stage?: unknown })?.stage;
	const stageLabel = typeof stage === 'string' ? stage : 'message';
	try {
		// Plain JSON: the peer has not authenticated us, so it cannot decode
		// an authenticated frame. Contains no secret material.
		eda.sys_WebSocket.send(
			wsIdForPort(port),
			JSON.stringify({ type: 'native-auth-error', stage: stageLabel, message: message.slice(0, 500), instanceId }),
			extensionUuid,
		);
	} catch {/* socket may already be gone */}

	const text = `EasyEDA Agent: bridge handshake with port ${port} failed (${stageLabel}): ${message}`;
	try { eda.sys_Log.add(text, ESYS_LogType.ERROR); } catch {/* */}

	const g2 = globalThis as any;
	const seen: Map<string, number> = g2[FAILURE_SEEN_KEY] || (g2[FAILURE_SEEN_KEY] = new Map<string, number>());
	const key = `${stageLabel}|${message}`;
	const now = Date.now();
	if ((seen.get(key) ?? 0) + FAILURE_TOAST_DEDUP_MS > now) return;
	seen.set(key, now);
	try { eda.sys_Message.showToastMessage(text, ESYS_ToastMessageType.ERROR, 8); } catch {/* */}
}

function sendNativeFrame(extensionUuid: string, port: number, value: unknown): void {
 void encodeNativeMessage(port, value).then(payload => {
  eda.sys_WebSocket.send(wsIdForPort(port), payload, extensionUuid);
 }).catch((err: any)=>dropConnection(extensionUuid,port,`send failed: ${err?.message ?? err}`));
}

function sendResponse(extensionUuid: string, port: number, id: string, result?: any, error?: string): void {
	const response: Record<string, any> = { id };
	if (error) response.error = error; else response.result = sanitizeForJson(result);
	let payload: string;
	try {
		payload = JSON.stringify(response);
	} catch (err: any) {
		payload = JSON.stringify({
			id,
			error: `Failed to serialize tool response: ${err instanceof Error ? err.message : String(err)}`,
		});
	}
	try {
		sendNativeFrame(extensionUuid, port, JSON.parse(payload));
	} catch {
		dropConnection(extensionUuid, port);
	}
}

function sendNotification(extensionUuid: string, port: number, type: string, data: any): void {
	try {
		sendNativeFrame(extensionUuid, port, sanitizeForJson({ type, data }));
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

	const maxConnections = getMaxConnectedServers();
	reapStaleServers(extensionUuid);
	if (servers.size >= maxConnections) {
		try {
			eda.sys_WebSocket.close(wsIdForPort(port), undefined, undefined, extensionUuid);
		} catch {
			// Best effort: capacity already reached, drop this newcomer
		}
		return;
	}

	servers.set(port, { port, agentId, connectedAt: Date.now(), greeted: true, clientInfo });
	queueConnectionToast(port, clientInfo);
	setTimeout(() => pushInstanceInfoToAll(extensionUuid), 200);
	trimServersToCapacity(extensionUuid);
}

function handleShutdown(extensionUuid: string, port: number): void {
	if (servers.has(port)) {
		servers.delete(port);
		showInfo(`Claude MCP Server on port ${port} shut down`);
	}
	closeWs(extensionUuid, port);
}

function dropConnection(extensionUuid: string, port: number, reason?: string): void {
	forgetNativePeer(port);
	const had = servers.delete(port);
	const probeTimer = probes.get(port);
	if (probeTimer != null) clearTimeout(probeTimer);
	probes.delete(port);
	lastReceivedTime.delete(port);
	if (had) showWarning(`Lost connection to Claude MCP Server on port ${port}${reason ? ` (${reason})` : ''}`);
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
	if (!hasFreeConnectionSlot(1)) return;

	forgetNativePeer(port);
	const wsId = wsIdForPort(port);
	const wsUrl = wsUrlForPort(port);

	const timer = setTimeout(() => {
		// wsIds are shared across bundle generations and reconnects: a stale
		// timer must not close a socket some later openWs registered.
		if (probes.get(port) !== timer) return;
		probes.delete(port);
		try { eda.sys_WebSocket.close(wsId, undefined, undefined, extensionUuid); } catch {/* */}
	}, PROBE_TIMEOUT_MS);
	probes.set(port, timer);

	eda.sys_WebSocket.register(
		wsId,
		wsUrl,
		(event: MessageEvent<any>) => { void handleMessage(extensionUuid, port, event); },
		() => { lastReceivedTime.set(port, Date.now()); },
	);
}

function closeWs(extensionUuid: string, port: number): void {
	forgetNativePeer(port);
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
	// The shared daemon always lives on the first port. The rotating cursor
	// below only probes a few ports per tick (connection cap), so without
	// this the daemon could wait ~50 s for its turn after "Connect Claude".
	if (!servers.has(PORT_RANGE_START) && !probes.has(PORT_RANGE_START)) {
		openWs(extensionUuid, PORT_RANGE_START);
	}
	let checked = 0;
	while (checked < PORT_RANGE_SIZE && hasFreeConnectionSlot(1)) {
		const idx = (scanCursor + checked) % PORT_RANGE_SIZE;
		const port = PORT_RANGE_START + idx;
		checked += 1;
		if (!servers.has(port) && !probes.has(port) && hasFreeConnectionSlot(1)) {
			openWs(extensionUuid, port);
		}
	}
	scanCursor = (scanCursor + checked) % PORT_RANGE_SIZE;
	(globalThis as any)[SCAN_CURSOR_KEY] = scanCursor;
}

/**
 * Sockets opened by a different bundle generation (extension reinstalled or
 * upgraded in place) still deliver frames to that older build's callbacks,
 * and the daemon keeps routing to them because the socket looks healthy.
 * Close them so this generation reconnects with its own handlers — the daemon
 * then sees a genuinely new connection and replaces the old one.
 */
function retireForeignGeneration(extensionUuid: string): void {
	const g2 = globalThis as any;
	if (g2[GENERATION_KEY] === BRIDGE_GENERATION) return;
	const hadSockets = servers.size + probes.size > 0;
	closeAllSockets(extensionUuid);
	g2[GENERATION_KEY] = BRIDGE_GENERATION;
	if (hadSockets) showInfo('EasyEDA Agent bridge updated — reconnecting to MCP servers');
}

function closeAllSockets(extensionUuid: string): number {
	const ports = new Set<number>([...servers.keys(), ...probes.keys()]);
	for (const port of ports) closeWs(extensionUuid, port);
	servers.clear();
	probes.clear();
	lastReceivedTime.clear();
	inflightRequests.clear();
	return ports.size;
}

/**
 * Operator recovery ("Connect Claude" while already live): drop every
 * socket, optionally release a wedged operation queue, and rescan with fresh
 * connections. Native work already running inside EasyEDA is not cancelled.
 */
export function reconnectAll(extensionUuid: string, options: { resetQueue?: boolean } = {}): { closed: number; gate?: unknown } {
	stopLiveMode();
	const closed = closeAllSockets(extensionUuid);
	const gate = options.resetQueue ? resetNativeOperations({ clearQuarantine: false }) : undefined;
	(globalThis as any)[GENERATION_KEY] = BRIDGE_GENERATION;
	// Give the host a moment to finish closing before re-registering the
	// same WebSocket ids.
	setTimeout(() => startLiveMode(extensionUuid), 500);
	return { closed, gate };
}

export function connectToMcpServers(extensionUuid: string): void {
	retireForeignGeneration(extensionUuid);
	reapStaleServers(extensionUuid);
	trimServersToCapacity(extensionUuid);
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

// Heartbeat thresholds tuned for long-running write ops. Repour-all,
// autoroute, big exports, and DRC on dense boards can each run >45s and
// EasyEDA's runtime blocks the JS event loop while doing the heavy lifting
// — meaning incoming bridge messages queue up and our `lastReceivedTime`
// stops updating. Previously this killed the connection mid-operation. The
// fix is twofold: extend the dead threshold, and treat in-flight handlers
// as "alive" regardless of silence.
const HEARTBEAT_INTERVAL_MS = 15_000;
const QUIET_THRESHOLD_MS = 30_000;
const DEAD_THRESHOLD_MS = 180_000;
const HEARTBEAT_TIMER_KEY = '__claude_mcp_heartbeat_timer__';

// Per-port count of currently-executing handler invocations. When >0, the
// extension is the one keeping the bridge waiting — silence from the bridge
// is expected and must not trigger a connection drop. Incremented as soon
// as we accept a request, decremented in the response/error path.
const inflightRequests: Map<number, number> = new Map();

function noteInflightStart(port: number): void {
	inflightRequests.set(port, (inflightRequests.get(port) ?? 0) + 1);
}
function noteInflightEnd(port: number): void {
	const cur = inflightRequests.get(port) ?? 0;
	if (cur <= 1) inflightRequests.delete(port);
	else inflightRequests.set(port, cur - 1);
}

function runHeartbeat(extensionUuid: string): void {
	if (servers.size === 0) return;
	const now = Date.now();
	for (const port of [...servers.keys()]) {
		const lastRecv = lastReceivedTime.get(port) ?? 0;
		const silenceMs = now - lastRecv;
		const inflight = inflightRequests.get(port) ?? 0;

		// Always send a ping when quiet — keeps the bridge's view of the WS
		// fresh even when we're busy. Cheap and idempotent.
		if (silenceMs >= QUIET_THRESHOLD_MS) {
			try {
				sendNativeFrame(extensionUuid, port, { type: 'ping' });
			} catch {
				dropConnection(extensionUuid, port);
				continue;
			}
		}

		// Only drop on silence when there's NOTHING in flight. With a
		// long-running handler executing (e.g. repour_all, autoroute), the
		// bridge is correctly waiting on us — silence isn't a death signal.
		if (silenceMs >= DEAD_THRESHOLD_MS && inflight === 0) {
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
	retireForeignGeneration(extensionUuid);
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

// Native copper access — EasyEDA's own copper engine and copper store, reached
// through the host UI's message bridge instead of the public SDK.
//
// Why: on EasyEDA Pro 2.2.47 the SDK cannot see or rebuild poured copper. The
// PCB editor implements the pour SDK through internal services
// (pcb/extensionAPI/copper-*), but nothing answers the poured-fill or
// rebuildCopperRegion calls — they wait forever. The editor's own UI uses:
//   - rpc 'CopperSource'          → the computed copper of every pour (what a
//                                     save persists as the board's "coppers")
//   - publish 'rebuildCopper' + 'rebuildPlane'   (Shift+B)
//   - publish 'rebuildSingleCopper' {ids,isLast} (one pour / selection)
// delivered into the PCB tab's frame via UI.gVars.windowBridge (ui.js).

import { canonicalDocumentId } from '../../shared/method-classes';
import { didTimeOut, readWithTimeout } from './_utils';

const NATIVE_CALL_MS = 4_000;
const COPPER_SOURCE_MS = 15_000;

export interface NativeHost {
	via: string;
	tabBar: { getActiveTab: () => unknown; getTabIFrame: (tabId: string) => Promise<{ contentWindow?: unknown } | undefined> };
	windowBridge: {
		publish: (topic: string, message: unknown, target: unknown) => void;
		rpcCall?: (topic: string, message: unknown, target: unknown, timeoutMs?: number) => Promise<{ message?: unknown } | undefined>;
	};
	messageBus: {
		subscribe: (topic: string, fn: (message: unknown) => void) => { cancel?: () => void } | undefined;
		publish?: (topic: string, message: unknown) => void;
	};
}

export interface NativeHostStatus {
	via: string | null;
	tabBar: boolean;
	windowBridge: boolean;
	copperSource: boolean;
	messageBus: boolean;
	error?: string;
}

/** Locate EasyEDA's host UI (`self.UI` in the top window: tabBar + gVars buses). */
export function findNativeHost(): { host?: NativeHost; status: NativeHostStatus } {
	const status: NativeHostStatus = { via: null, tabBar: false, windowBridge: false, copperSource: false, messageBus: false };
	const g = globalThis as any;
	const candidates: Array<[string, () => any]> = [
		['globalThis.UI', () => g.UI],
		['top.UI', () => g.top?.UI],
		['parent.UI', () => g.parent?.UI],
	];
	for (const [via, get] of candidates) {
		let ui: any;
		try { ui = get(); } catch (err: any) { status.error = `${via}: ${err?.message ?? String(err)}`; continue; }
		if (!ui) continue;
		const tabBar = ui.tabBar;
		const windowBridge = ui.gVars?.windowBridge;
		const messageBus = ui.gVars?.messageBus;
		status.via = via;
		status.tabBar = typeof tabBar?.getActiveTab === 'function' && typeof tabBar?.getTabIFrame === 'function';
		status.windowBridge = typeof windowBridge?.publish === 'function';
		status.copperSource = typeof windowBridge?.rpcCall === 'function';
		status.messageBus = typeof messageBus?.subscribe === 'function';
		if (status.tabBar && status.windowBridge && status.messageBus) return { host: { via, tabBar, windowBridge, messageBus }, status };
	}
	return { status };
}

export function nativeHostStatus(): NativeHostStatus {
	return findNativeHost().status;
}

export interface NativePcbTab {
	host: NativeHost;
	tabId: string;
	target: unknown;
}

/**
 * The active tab's frame, only if it is `documentUuid` — never act on
 * whatever the user happens to have in front.
 */
export async function resolveNativePcbTab(documentUuid: string | undefined): Promise<{ tab?: NativePcbTab; error?: string; status: NativeHostStatus }> {
	const found = findNativeHost();
	if (!found.host) return { status: found.status, error: 'EasyEDA\'s editor message bus is not reachable from the extension runtime (see nativeHost).' };
	const host = found.host;
	let tabId = '';
	try { tabId = String(host.tabBar.getActiveTab() ?? ''); } catch (err: any) {
		return { status: found.status, error: `Could not read the active editor tab: ${err?.message ?? String(err)}` };
	}
	if (!tabId) return { status: found.status, error: 'No active editor tab.' };
	if (documentUuid && canonicalDocumentId(tabId) !== canonicalDocumentId(documentUuid)) {
		return { status: found.status, error: `The active editor tab (${tabId}) is not the requested document (${documentUuid}).` };
	}
	const frame = await readWithTimeout(() => host.tabBar.getTabIFrame(tabId), NATIVE_CALL_MS);
	const target = !didTimeOut(frame) ? (frame as any)?.contentWindow : undefined;
	if (!target) return { status: found.status, error: 'Could not reach the PCB tab frame.' };
	return { status: found.status, tab: { host, tabId, target } };
}

// ---------------------------------------------------------------------------
// CopperSource — the editor's computed copper
// ---------------------------------------------------------------------------

export interface PourCopper {
	/** Poured-fill island ids (fresh ids after every real rebuild). */
	fillIds: string[];
	islands: number;
	solid: boolean;
	/** From island vertices; arc bulges are not traced, so treat as approximate. */
	bboxApprox?: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Read the copper every pour currently has, keyed by pour primitive id. */
export async function readCopperSource(tab: NativePcbTab): Promise<{ byPour: Map<string, PourCopper>; records: number } | { error: string }> {
	const rpc = tab.host.windowBridge.rpcCall;
	if (typeof rpc !== 'function') return { error: 'The host message bridge has no rpcCall; copper cannot be read.' };
	const reply = await readWithTimeout(() => rpc.call(tab.host.windowBridge, 'CopperSource', '', tab.target, COPPER_SOURCE_MS), COPPER_SOURCE_MS + 1_000)
		.catch((err: any) => ({ __error: err?.message ?? String(err) }));
	if (didTimeOut(reply)) return { error: `The editor did not return its copper within ${COPPER_SOURCE_MS} ms.` };
	if ((reply as any)?.__error) return { error: `CopperSource failed: ${(reply as any).__error}` };
	const chunks = (reply as any)?.message;
	if (!Array.isArray(chunks)) return { error: 'CopperSource returned an unexpected payload.' };
	return parseCopperSource(chunks);
}

/**
 * CopperSource chunks are POURED documents: a '["DOCTYPE","POURED","1.1"]'
 * header followed by space-separated records
 *   ["POURED", fillId, pourId, gridLineWidth, isSolid, copperPath]
 * (pcb.js t2.save). One record per copper island.
 */
export function parseCopperSource(chunks: unknown[]): { byPour: Map<string, PourCopper>; records: number } {
	const byPour = new Map<string, PourCopper>();
	let records = 0;
	for (const chunk of chunks) {
		if (typeof chunk !== 'string') continue;
		for (const raw of splitRecords(chunk)) {
			let rec: unknown;
			try { rec = JSON.parse(raw); } catch { continue; }
			if (!Array.isArray(rec) || rec[0] !== 'POURED') continue;
			records++;
			const fillId = String(rec[1]);
			const pourId = String(rec[2]);
			const entry = byPour.get(pourId) ?? { fillIds: [], islands: 0, solid: rec[4] === true };
			entry.fillIds.push(fillId);
			entry.islands++;
			const box = pathBounds(rec[5]);
			if (box) {
				entry.bboxApprox = entry.bboxApprox
					? { minX: Math.min(entry.bboxApprox.minX, box.minX), minY: Math.min(entry.bboxApprox.minY, box.minY), maxX: Math.max(entry.bboxApprox.maxX, box.maxX), maxY: Math.max(entry.bboxApprox.maxY, box.maxY) }
					: box;
			}
			byPour.set(pourId, entry);
		}
	}
	return { byPour, records };
}

/** Records are top-level JSON arrays separated by whitespace. */
function splitRecords(chunk: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	for (let i = 0; i < chunk.length; i++) {
		const ch = chunk[i];
		if (inString) {
			if (ch === '\\') i++;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === '[') { if (depth === 0) start = i; depth++; }
		else if (ch === ']') { depth--; if (depth === 0 && start >= 0) { out.push(chunk.slice(start, i + 1)); start = -1; } }
	}
	return out;
}

/** Bounding box of an EasyEDA polygon path: x,y then "L" pairs / "ARC"|"CARC" angle,x,y / "R" x,y,w,h / "CIRCLE" cx,cy,r. */
function pathBounds(path: unknown): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	const add = (x: unknown, y: unknown) => {
		if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
		minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
	};
	const walk = (node: unknown) => {
		if (!Array.isArray(node)) return;
		if (node.some((v) => Array.isArray(v))) { node.forEach(walk); return; }
		let i = 0;
		let cmd = 'L';
		if (typeof node[0] === 'string') {
			const head = node[0];
			if (head === 'R') { const [, x, y, w, h] = node as any[]; add(x, y); add(x + w, y + h); add(x, y + h); add(x + w, y); return; }
			if (head === 'CIRCLE') { const [, cx, cy, r] = node as any[]; add(cx - r, cy - r); add(cx + r, cy + r); return; }
			cmd = head; i = 1;
		}
		while (i < node.length) {
			const v = node[i];
			if (typeof v === 'string') { cmd = v; i++; continue; }
			if (cmd === 'ARC' || cmd === 'CARC') { add(node[i + 1], node[i + 2]); i += 3; continue; }
			add(node[i], node[i + 1]); i += 2;
		}
	};
	walk(path);
	if (!Number.isFinite(minX)) return undefined;
	const r = (n: number) => Math.round(n * 100) / 100;
	return { minX: r(minX), minY: r(minY), maxX: r(maxX), maxY: r(maxY) };
}

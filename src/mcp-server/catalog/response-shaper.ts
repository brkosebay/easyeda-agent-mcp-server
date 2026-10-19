// Response governor for tool results — the single place that keeps any one
// tool call from flooding an agent's context window.
//
// Measured on real transcripts (Claude Code + Codex, ~11.8k calls): a single
// pcb_extract_design averaged ~54k tokens, pcb_get_routing_context hit ~120k
// at p95, verbose DRC ~200k. Agents compacted after a handful of calls.
//
// Two stages, applied to every JSON text result:
//   1. compact — round floats (coordinates arrive as 984.2519685039371) and
//      drop null object fields. Lossless for EDA purposes: values >= 1 keep 4
//      decimals (≤ 2.5 nm error on mil coordinates); smaller values keep 6
//      significant digits so 1e-9 F capacitances survive.
//   2. budget — over `maxChars`, the full result is parked in an in-memory
//      store and the agent gets a same-shaped preview: long arrays cut to their
//      first items plus a marker saying exactly how to page the rest with
//      read_result. Nothing is re-queried from EasyEDA.

import { randomBytes } from 'crypto';

export const DEFAULT_MAX_CHARS = (() => {
	const env = process.env.EDA_RESPONSE_MAX_CHARS;
	if (env === undefined || env === '') return 24_000;
	const n = Number(env);
	return Number.isFinite(n) && n >= 0 ? n : 24_000; // 0 = unlimited
})();
const HARD_MAX_CHARS = 400_000;
const STORE_MAX_ENTRIES = 24;
const STORE_MAX_CHARS = 48 * 1024 * 1024;
const STORE_TTL_MS = 45 * 60_000;

// ---------------------------------------------------------------------------
// Stage 1 — compaction
// ---------------------------------------------------------------------------

export function roundNumber(n: number): number {
	if (!Number.isFinite(n) || Number.isInteger(n)) return n;
	if (Math.abs(n) >= 1) return Math.round(n * 1e4) / 1e4;
	return Number(n.toPrecision(6));
}

export function compactValue(value: unknown): unknown {
	if (typeof value === 'number') return roundNumber(value);
	if (Array.isArray(value)) return value.map(compactValue);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (v === null || v === undefined) continue;
			out[k] = compactValue(v);
		}
		return out;
	}
	return value;
}

// ---------------------------------------------------------------------------
// Result store (per MCP process, bounded)
// ---------------------------------------------------------------------------

interface StoredResult { value: unknown; chars: number; tool: string; expiresAt: number }

class ResultStore {
	private entries = new Map<string, StoredResult>();
	private chars = 0;

	put(tool: string, value: unknown, chars: number): string {
		this.prune();
		const handle = 'res_' + randomBytes(5).toString('hex');
		this.entries.set(handle, { value, chars, tool, expiresAt: Date.now() + STORE_TTL_MS });
		this.chars += chars;
		while (this.entries.size > STORE_MAX_ENTRIES || this.chars > STORE_MAX_CHARS) {
			const oldest = this.entries.keys().next().value;
			if (!oldest || oldest === handle) break;
			this.drop(oldest);
		}
		return handle;
	}

	get(handle: string): StoredResult | undefined {
		const e = this.entries.get(handle);
		if (!e) return undefined;
		if (e.expiresAt <= Date.now()) { this.drop(handle); return undefined; }
		e.expiresAt = Date.now() + STORE_TTL_MS;
		return e;
	}

	private drop(handle: string): void {
		const e = this.entries.get(handle);
		if (!e) return;
		this.entries.delete(handle);
		this.chars = Math.max(0, this.chars - e.chars);
	}

	private prune(): void {
		const now = Date.now();
		for (const [h, e] of this.entries) if (e.expiresAt <= now) this.drop(h);
	}
}

export const resultStore = new ResultStore();

// ---------------------------------------------------------------------------
// Stage 2 — budgeted preview
// ---------------------------------------------------------------------------

function shrink(value: unknown, path: string, itemsKept: number, strMax: number, handle: string): unknown {
	if (typeof value === 'string') {
		return value.length > strMax ? `${value.slice(0, strMax)}…(+${value.length - strMax} chars; read_result handle=${handle}${path ? ` path=${path}` : ''})` : value;
	}
	if (Array.isArray(value)) {
		const kept = value.slice(0, itemsKept).map((v, i) => shrink(v, join(path, i), itemsKept, strMax, handle));
		if (value.length > itemsKept) {
			kept.push(`…${value.length - itemsKept} more of ${value.length} — read_result handle=${handle}${path ? ` path=${path}` : ''} offset=${itemsKept}`);
		}
		return kept;
	}
	if (value && typeof value === 'object') {
		// Maps keyed by id (components by designator, nets by name) are lists
		// in disguise — trim them like arrays. Ordinary records stay whole.
		const entries = Object.entries(value as Record<string, unknown>);
		const isMap = entries.length > Math.max(16, itemsKept);
		const kept = isMap ? entries.slice(0, itemsKept) : entries;
		const out: Record<string, unknown> = {};
		for (const [k, v] of kept) out[k] = shrink(v, join(path, k), itemsKept, strMax, handle);
		if (isMap) out['…'] = `${entries.length - itemsKept} more of ${entries.length} keys — read_result handle=${handle}${path ? ` path=${path}` : ''} offset=${itemsKept}`;
		return out;
	}
	return value;
}

/** Outline for results whose breadth (thousands of keys) defeats array trimming. */
function outline(value: unknown, depth: number): unknown {
	if (Array.isArray(value)) return `array(${value.length})`;
	if (value && typeof value === 'object') {
		const keys = Object.keys(value as object);
		if (depth <= 0) return `object(${keys.length} keys)`;
		const out: Record<string, unknown> = {};
		for (const k of keys.slice(0, 60)) out[k] = outline((value as any)[k], depth - 1);
		if (keys.length > 60) out['…'] = `${keys.length - 60} more keys`;
		return out;
	}
	if (typeof value === 'string') return value.length > 80 ? `string(${value.length})` : value;
	return value;
}

function join(path: string, key: string | number): string {
	return path ? `${path}.${key}` : String(key);
}

function preview(value: unknown, maxChars: number, handle: string): unknown {
	for (const [items, strMax] of [[25, 2000], [10, 600], [5, 300], [3, 160], [1, 100]] as const) {
		const candidate = shrink(value, '', items, strMax, handle);
		if (JSON.stringify(candidate).length <= maxChars) return candidate;
	}
	for (const depth of [3, 2, 1, 0]) {
		const candidate = { outline: outline(value, depth) };
		if (JSON.stringify(candidate).length <= maxChars) return candidate;
	}
	return { outline: Array.isArray(value) ? `array(${value.length})` : typeof value };
}

function budgetNote(handle: string, chars: number, maxChars: number): Record<string, unknown> {
	return {
		handle,
		fullChars: chars,
		shownBudget: maxChars,
		hint: 'Result exceeded the response budget; arrays/strings below are cut where marked. Page with read_result(handle, path, offset, limit, fields), narrow the call (filter/fields/limit/region), or re-run with max_chars.',
	};
}

/**
 * Fit an already-compacted value into maxChars, parking the full value when
 * needed. `original` is what gets parked: the exact pre-compaction result, so
 * a handle passed back as a tool argument (snapshot repair) is byte-faithful.
 */
export function fitToBudget(tool: string, value: unknown, maxChars: number, original: unknown = value): string {
	const text = JSON.stringify(value);
	if (text === undefined) return 'null';
	if (maxChars <= 0 || text.length <= maxChars) return text;
	const handle = resultStore.put(tool, original, text.length);
	const room = Math.max(2_000, maxChars - 600);
	const shown = preview(value, room, handle);
	const note = budgetNote(handle, text.length, maxChars);
	const wrapped = shown && typeof shown === 'object' && !Array.isArray(shown)
		? { _truncated: note, ...(shown as Record<string, unknown>) }
		: { _truncated: note, preview: shown };
	return JSON.stringify(wrapped);
}

export interface ShapeOptions {
	tool: string;
	/** 0 = unlimited. */
	maxChars?: number;
	/** Skip compaction and budgeting entirely (exact values, full size). */
	raw?: boolean;
}

type ContentItem = { type: string; text?: string; [k: string]: unknown };

/** Apply compaction + budget to every JSON/text item of an MCP tool result. Images pass through. */
export function shapeToolResult<T extends { content?: ContentItem[] }>(result: T, opts: ShapeOptions): T {
	if (opts.raw || !result || !Array.isArray(result.content)) return result;
	const maxChars = Math.min(HARD_MAX_CHARS, opts.maxChars ?? DEFAULT_MAX_CHARS) || 0;
	const content = result.content.map((item) => {
		if (item?.type !== 'text' || typeof item.text !== 'string') return item;
		let parsed: unknown;
		try { parsed = JSON.parse(item.text); } catch { parsed = undefined; }
		if (parsed === undefined) {
			if (maxChars <= 0 || item.text.length <= maxChars) return item;
			const handle = resultStore.put(opts.tool, item.text, item.text.length);
			return { ...item, text: `${item.text.slice(0, maxChars)}\n…(+${item.text.length - maxChars} chars — read_result handle=${handle} offset=${maxChars})` };
		}
		return { ...item, text: fitToBudget(opts.tool, compactValue(parsed), maxChars, parsed) };
	});
	return { ...result, content };
}

// ---------------------------------------------------------------------------
// read_result — page into a parked result
// ---------------------------------------------------------------------------

export interface ReadResultArgs {
	handle: string;
	path?: string;
	offset?: number;
	limit?: number;
	fields?: string[];
}

/** Exact stored value for a handle (used to swap trimmed previews back into tool arguments). */
export function storedValue(handle: string): unknown {
	const stored = resultStore.get(handle);
	if (!stored) throw new Error(`Result ${handle} expired or unknown — omit the argument and let the tool fetch fresh data.`);
	return stored.value;
}

const HANDLE_RE = /^res_[0-9a-f]{10}$/;

/**
 * Agents feed big results back into analyzers (`snapshot` args). A trimmed
 * preview (it carries `_truncated.handle`) or a bare handle is swapped for the
 * full stored value — otherwise the analyzer would silently see a partial
 * snapshot, and the agent would burn output tokens re-typing 80 KB.
 */
export function resolveResultHandles(args: Record<string, unknown>): Record<string, unknown> {
	let out = args;
	for (const [key, value] of Object.entries(args)) {
		let handle: string | undefined;
		// snapshot, pcbSnapshot, schSnapshot …
		if (typeof value === 'string' && HANDLE_RE.test(value) && /snapshot$/i.test(key)) handle = value;
		else if (value && typeof value === 'object' && !Array.isArray(value)) {
			const h = (value as any)._truncated?.handle;
			if (typeof h === 'string' && HANDLE_RE.test(h)) handle = h;
		}
		if (handle) {
			if (out === args) out = { ...args };
			out[key] = storedValue(handle);
		}
	}
	return out;
}

export function readStoredResult(args: ReadResultArgs): unknown {
	const stored = resultStore.get(args.handle);
	if (!stored) throw new Error(`Result ${args.handle} expired or unknown (results are kept ~45 min, last ${STORE_MAX_ENTRIES} only). Re-run the tool with narrower arguments.`);
	let node: unknown = stored.value;
	const segments = (args.path ?? '').split('.').filter(Boolean);
	for (const seg of segments) {
		if (node === null || typeof node !== 'object') throw new Error(`Path ${args.path} does not exist (stopped at "${seg}").`);
		node = Array.isArray(node) ? node[Number(seg)] : (node as Record<string, unknown>)[seg];
		if (node === undefined) throw new Error(`Path ${args.path} does not exist (no "${seg}").`);
	}
	const offset = Math.max(0, Math.floor(args.offset ?? 0));
	if (typeof node === 'string') {
		const limit = Math.max(1, Math.floor(args.limit ?? 20_000));
		return { tool: stored.tool, path: args.path ?? '', totalChars: node.length, offset, text: node.slice(offset, offset + limit) };
	}
	if (Array.isArray(node)) {
		const limit = Math.max(1, Math.floor(args.limit ?? 50));
		let items = node.slice(offset, offset + limit);
		if (args.fields?.length) items = items.map((it) => project(it, args.fields!));
		return { tool: stored.tool, path: args.path ?? '', total: node.length, offset, returned: items.length, items: compactValue(items) };
	}
	if (node && typeof node === 'object') {
		const entries = Object.entries(node as Record<string, unknown>);
		// Id-keyed maps page by key, like arrays.
		if (args.offset !== undefined || args.limit !== undefined || entries.length > 50) {
			const limit = Math.max(1, Math.floor(args.limit ?? 50));
			const slice = entries.slice(offset, offset + limit).map(([k, v]) => [k, args.fields?.length ? project(v, args.fields) : v]);
			return { tool: stored.tool, path: args.path ?? '', totalKeys: entries.length, offset, returned: slice.length, entries: compactValue(Object.fromEntries(slice)) };
		}
	}
	return compactValue(args.fields?.length ? project(node, args.fields) : node);
}

function project(item: unknown, fields: string[]): unknown {
	if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
	const out: Record<string, unknown> = {};
	for (const f of fields) if (f in (item as object)) out[f] = (item as Record<string, unknown>)[f];
	return out;
}

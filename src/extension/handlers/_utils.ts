// Shared extension-side helpers: layer-name normalization, polygon coercion,
// unit conversion. Imported by primitive handlers so callers can pass
// human-friendly inputs without losing the strict types EasyEDA requires.

import { boundedNativeOperation, NativeOperationTimeoutError, assertNativeOperationReady } from '../native-operation-gate';

/** Preserve the timeout sentinel while quarantining the actual pending SDK work. */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | { __timedOut: true }> {
 return callWithTimeout(() => p, ms);
}

/** Check admission before invoking SDK work; a deadline never releases native ownership. */
export async function callWithTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T | { __timedOut: true }> {
 assertNativeOperationReady();
 if (!ms || ms <= 0) return fn();
 try {
  return await boundedNativeOperation('EasyEDA SDK operation', fn, ms);
 } catch (error) {
  if (error instanceof NativeOperationTimeoutError) return { __timedOut: true };
  throw error;
 }
}

/**
 * Deadline for view-only / read-only SDK calls (zoom, pan, screenshot,
 * viewport probes, primitive queries). Same sentinel as callWithTimeout, but
 * a timeout does NOT quarantine the document: nothing was edited, so a call
 * that never resolves (several EasyEDA view APIs have no host handler at all
 * on 2.2.47) must fail cleanly instead of blocking every later write.
 */
export async function readWithTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T | { __timedOut: true }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve({ __timedOut: true }), Math.max(1, ms));
		Promise.resolve().then(fn).then(
			(v) => { clearTimeout(timer); resolve(v); },
			(e) => { clearTimeout(timer); reject(e); },
		);
	});
}

/** Type guard for the {@link withTimeout} timeout sentinel. */
export function didTimeOut<T>(v: T | { __timedOut: true }): v is { __timedOut: true } {
	return !!v && typeof v === 'object' && (v as any).__timedOut === true;
}

/**
 * Run an async task per item with bounded concurrency. Use instead of
 * `Promise.all(items.map(fn))` when `items` may contain hundreds or thousands
 * of entries — EasyEDA's runtime serializes a lot internally, and firing
 * thousands of concurrent calls saturates the event loop and can hang the
 * editor.
 *
 * Errors are swallowed (Promise.allSettled-style); callers wanting per-item
 * status should track it inside `fn`.
 */
export async function mapWithConcurrency<T>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<unknown>,
): Promise<void> {
	const limit = Math.max(1, Math.floor(concurrency));
	let cursor = 0;
	const workers: Array<Promise<void>> = [];
	const next = async (): Promise<void> => {
		while (true) {
			const i = cursor++;
			if (i >= items.length) return;
			try { await fn(items[i], i); } catch { /* swallow per-item failure */ }
		}
	};
	for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(next());
	await Promise.all(workers);
}

/**
 * Map of layer aliases → numeric EPCB_LayerId. Accepts forms users actually
 * type: numeric IDs (1, "1"), CamelCase ("TopLayer"), spaced ("Top Layer"),
 * legacy ("Top", "T"), and inner/custom by index.
 */
const LAYER_ALIASES: Record<string, number> = {
	// Top / Bottom (signal)
	'1': 1, top: 1, toplayer: 1, 'top layer': 1, t: 1,
	'2': 2, bottom: 2, bottomlayer: 2, 'bottom layer': 2, b: 2,

	// Silkscreen
	'3': 3, topsilkscreen: 3, 'top silkscreen': 3, 'top silk': 3, topsilk: 3,
	'4': 4, bottomsilkscreen: 4, 'bottom silkscreen': 4, 'bottom silk': 4, bottomsilk: 4,

	// Solder mask
	'5': 5, topsoldermask: 5, 'top solder mask': 5, 'top mask': 5,
	'6': 6, bottomsoldermask: 6, 'bottom solder mask': 6, 'bottom mask': 6,

	// Paste (stencil)
	'7': 7, toppastemask: 7, 'top paste mask': 7, 'top paste': 7,
	'8': 8, bottompastemask: 8, 'bottom paste mask': 8, 'bottom paste': 8,

	// Assembly
	'9': 9, topassembly: 9, 'top assembly': 9,
	'10': 10, bottomassembly: 10, 'bottom assembly': 10,

	// Misc
	'11': 11, boardoutline: 11, 'board outline': 11, outline: 11, edgecuts: 11, 'edge cuts': 11,
	'12': 12, multi: 12, multilayer: 12,
	'13': 13, document: 13, doc: 13,
	'14': 14, mechanical: 14, mech: 14,
	'47': 47, hole: 47,
	'56': 56, drilldrawing: 56, 'drill drawing': 56,
	'57': 57, ratline: 57, ratlines: 57,
	'58': 58, topstiffener: 58, 'top stiffener': 58,
	'59': 59, bottomstiffener: 59, 'bottom stiffener': 59,

	// KiCad names (agents often think in them)
	'f.cu': 1, 'b.cu': 2, 'f.silks': 3, 'b.silks': 4, 'f.mask': 5, 'b.mask': 6,
	'f.paste': 7, 'b.paste': 8, 'f.fab': 9, 'b.fab': 10, 'edge.cuts': 11,
};

// Inner copper layers: ID = 14 + n, n in 1..30
for (let i = 1; i <= 30; i++) {
	const id = 14 + i;
	LAYER_ALIASES[String(id)] = id;
	LAYER_ALIASES[`inner${i}`] = id;
	LAYER_ALIASES[`innerlayer${i}`] = id;
	LAYER_ALIASES[`inner ${i}`] = id;
	LAYER_ALIASES[`inner layer ${i}`] = id;
	LAYER_ALIASES[`in${i}.cu`] = id;
}

// Custom layers: ID = 70 + n, n in 1..30
for (let i = 1; i <= 30; i++) {
	const id = 70 + i;
	LAYER_ALIASES[String(id)] = id;
	LAYER_ALIASES[`custom${i}`] = id;
	LAYER_ALIASES[`customlayer${i}`] = id;
	LAYER_ALIASES[`custom ${i}`] = id;
	LAYER_ALIASES[`custom layer ${i}`] = id;
}

/**
 * Normalize a layer reference to its numeric EPCB_LayerId.
 * Accepts numbers, numeric strings, and human-readable names. Returns the
 * input unchanged if it's a finite number or numeric string the API will
 * accept; throws on unrecognized strings so the agent gets a clear error
 * instead of EasyEDA's silent rejection.
 */
export function normalizeLayer(input: any): any {
	if (input == null) return input;
	if (typeof input === 'number' && Number.isFinite(input)) return input;
	if (typeof input !== 'string') return input;

	const key = input.trim().toLowerCase();
	if (key === '') return input;

	// Try direct numeric coercion first (e.g. "15" → 15)
	if (/^\d+$/.test(key)) return Number(key);

	const direct = LAYER_ALIASES[key];
	if (direct != null) return direct;

	const compact = key.replace(/[\s_-]+/g, '');
	const compactHit = LAYER_ALIASES[compact];
	if (compactHit != null) return compactHit;

	throw new Error(
		`Unknown layer "${input}". Use a numeric ID (1=Top, 2=Bottom, 11=BoardOutline, 15..44=Inner1..30) or a name like "TopLayer", "BottomLayer", "Inner1" (KiCad "F.Cu", "In1.Cu" also work).`,
	);
}

type Pt = { x: number; y: number };
type PolygonInput =
	| Array<string | number>
	| Array<Pt>
	| { points: Array<Pt> }
	| { closed?: boolean; points: Array<Pt> };

/**
 * Coerce friendly polygon shapes into the polygon source array EasyEDA expects.
 *
 * Accepted inputs:
 *   - friendly line array: ["L", x1, y1, x2, y2, ...]
 *     → [x1, y1, "L", x2, y2, ...]
 *   - friendly rectangle array: ["R", cx, cy, w, h, rotation, radius]
 *     → ["R", left, top, w, h, rotation, radius]
 *   - native source array: [x1, y1, "L", x2, y2, ...] or ["CIRCLE", cx, cy, r]
 *   - point array: [{x, y}, ...] → [x1, y1, "L", x2, y2, ...]
 *   - object: {points: [{x, y}, ...]} → [x1, y1, "L", ...]
 *
 * Always closes the ring by repeating the first point if not already closed.
 */
export function normalizePolygon(input: PolygonInput): Array<string | number> {
	if (!input) {
		throw new Error('Polygon input is empty.');
	}

	// Object form: {points: [...]}
	if (!Array.isArray(input) && typeof input === 'object' && Array.isArray((input as any).points)) {
		return pointsToLMode((input as any).points);
	}

	if (!Array.isArray(input)) {
		throw new Error('Polygon must be an array or {points: [...]} object.');
	}

	// Friendly/native source array — first element is a mode tag string.
	if (input.length > 0 && typeof input[0] === 'string') {
		const mode = String(input[0]).toUpperCase();
		if (mode === 'L') {
			const nums = (input.slice(1) as Array<string | number>).map((v) => Number(v));
			if (nums.length < 6 || nums.length % 2 !== 0 || nums.some((v) => !Number.isFinite(v))) {
				throw new Error('L polygon source must contain at least 3 finite x,y pairs.');
			}
			return xyPairsToEasyEdaLineSource(nums);
		}
		if (mode === 'R') {
			const [, cx, cy, w, h, rotation = 0, radius = 0] = input as Array<string | number>;
			const values = [cx, cy, w, h, rotation, radius].map((v) => Number(v));
			if (values.some((v) => !Number.isFinite(v)) || values[2] <= 0 || values[3] <= 0) {
				throw new Error('R polygon source must be ["R", centerX, centerY, width, height, rotation, radius] with width/height > 0.');
			}
			const [centerX, centerY, width, height, rot, cornerRadius] = values;
			return ['R', centerX - width / 2, centerY - height / 2, width, height, rot, cornerRadius];
		}
		return input as Array<string | number>;
	}

	// Numeric flat array — assume L mode pairs, prepend "L" + auto-close
	if (input.length > 0 && typeof input[0] === 'number') {
		const hasModeTokens = input.some((v) => typeof v === 'string');
		if (hasModeTokens) {
			return input as Array<string | number>;
		}
		if (input.length % 2 !== 0) {
			throw new Error('Numeric polygon array must have an even number of values (x,y pairs).');
		}
		const nums = input as number[];
		if (nums.length < 6 || nums.some((v) => !Number.isFinite(v))) {
			throw new Error('Numeric polygon array must contain at least 3 finite x,y pairs.');
		}
		return xyPairsToEasyEdaLineSource(nums);
	}

	// Point object array
	if (input.length > 0 && typeof (input as any)[0] === 'object') {
		return pointsToLMode(input as Pt[]);
	}

	throw new Error('Polygon array is empty or has an unrecognized element type.');
}

function pointsToLMode(points: Pt[]): Array<string | number> {
	if (!points || points.length < 3) {
		throw new Error('Polygon needs at least 3 points.');
	}
	const nums: number[] = [];
	for (const p of points) {
		if (typeof p?.x !== 'number' || typeof p?.y !== 'number') {
			throw new Error('Polygon points must be {x: number, y: number} objects.');
		}
		nums.push(p.x, p.y);
	}
	return xyPairsToEasyEdaLineSource(nums);
}

function xyPairsToEasyEdaLineSource(nums: number[]): Array<string | number> {
	const pairs = nums.slice();
	const x0 = pairs[0], y0 = pairs[1];
	const xN = pairs[pairs.length - 2], yN = pairs[pairs.length - 1];
	if (x0 !== xN || y0 !== yN) {
		pairs.push(x0, y0);
	}
	const [firstX, firstY, ...rest] = pairs;
	return [firstX, firstY, 'L', ...rest];
}

/**
 * Convert millimeters to mils (EasyEDA's internal unit). Falls back to a
 * literal multiplier if eda.sys_Unit isn't loaded yet (defensive — should
 * not happen in the running extension).
 */
export function mmToMil(mm: number): number {
	const u = (globalThis as any).eda?.sys_Unit;
	if (u && typeof u.mmToMil === 'function') {
		return u.mmToMil(mm);
	}
	return mm * 39.3700787401575;
}

/**
 * Normalize a via-type input. EasyEDA's enum is numeric:
 *   0 = Through (default), 1 = BlindBuried, 2 = Suture
 * Accept string aliases ("Through"/"BlindBuried"/"Suture") and pass through
 * numbers. Anything else throws so callers don't get silent default-0 behavior.
 */
export function normalizeViaType(input: any): number | undefined {
	if (input == null) return undefined;
	if (typeof input === 'number') return input;
	if (typeof input === 'string') {
		const k = input.trim().toLowerCase();
		if (k === '0' || k === 'through' || k === 'via') return 0;
		if (k === '1' || k === 'blind' || k === 'blindburied' || k === 'blind_buried' || k === 'buried') return 1;
		if (k === '2' || k === 'suture' || k === 'stitch' || k === 'stitching') return 2;
	}
	throw new Error(`Unknown viaType "${input}". Use 0/Through, 1/BlindBuried, or 2/Suture.`);
}

// Fields stripped from flattened primitives by default — they can balloon a
// single response by hundreds of KB (polygon source arrays carry every x/y
// vertex, complex polygons store their decomposition, etc.). Callers that
// genuinely need geometry can opt back in with `verbose:true` on the tool.
const HEAVY_FIELDS = new Set([
	'complexPolygon',
	'polygon',
	'pourFills',
	'source',
	'sourcePolygon',
	'rawData',
]);

/**
 * Walk an EasyEDA primitive instance, call every `getState_*` method, and
 * return a plain object. Strips heavy geometry fields by default so the
 * response stays compact in JSON form — pass {verbose: true} to keep them.
 */
export function flattenState(instance: any, opts: { verbose?: boolean } = {}): any {
	if (!instance || typeof instance !== 'object') return instance;

	const proto = Object.getPrototypeOf(instance);
	if (proto === Object.prototype || proto == null) return instance;

	const out: Record<string, any> = {};
	const seen = new Set<string>();

	for (let p = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
		for (const name of Object.getOwnPropertyNames(p)) {
			if (seen.has(name)) continue;
			seen.add(name);
			if (!name.startsWith('getState_')) continue;
			const fn = (instance as any)[name];
			if (typeof fn !== 'function') continue;
			const key = name.slice('getState_'.length);
			const camel = key.charAt(0).toLowerCase() + key.slice(1);
			if (!opts.verbose && HEAVY_FIELDS.has(camel)) continue;
			try {
				const value = fn.call(instance);
				if (value !== undefined) out[camel] = value;
			} catch {
				/* getter threw — skip */
			}
		}
	}

	for (const k of Object.keys(instance)) {
		if (k in out) continue;
		if (!opts.verbose && HEAVY_FIELDS.has(k)) continue;
		out[k] = (instance as any)[k];
	}
	return out;
}

export function flattenStateArray(instances: any[] | null | undefined, opts: { verbose?: boolean } = {}): any[] {
	if (!Array.isArray(instances)) return [];
	return instances.map((i) => flattenState(i, opts));
}

type EnvelopeFilter = Record<string, string | number | boolean | string[]>;

function itemMatchesFilter(item: any, filter: EnvelopeFilter): boolean {
	for (const [key, condition] of Object.entries(filter)) {
		const value = item?.[key];
		if (Array.isArray(condition)) {
			if (!condition.includes(String(value))) return false;
		} else if (typeof condition === 'string' && condition.endsWith('*')) {
			if (typeof value !== 'string' || !value.startsWith(condition.slice(0, -1))) return false;
		} else if (value !== condition) {
			return false;
		}
	}
	return true;
}

/**
 * Flatten + paginate a primitive list for getAll-style handlers. Applies
 * `filter` FIRST, then `limit` (default 100), then an optional `fields`
 * whitelist, returning a `{ total, matched, returned, truncated, items }`
 * envelope so agents see how much was cut instead of receiving an unbounded
 * dump.
 *
 * `total` counts everything the underlying query returned; `matched` counts
 * what survived `filter`; `truncated` is true only when `limit` actually cut
 * matching items off.
 */
export function envelopeStateArray(
	instances: any[] | null | undefined,
	params: { limit?: number; fields?: string[]; filter?: EnvelopeFilter } | undefined,
	opts: { verbose?: boolean } = {},
): { total: number; matched: number; returned: number; truncated: boolean; items: any[] } {
	const items = flattenStateArray(instances, opts);
	const total = items.length;
	const filter = params?.filter && typeof params.filter === 'object' && !Array.isArray(params.filter)
		? params.filter
		: null;
	// Filter before limiting — limiting first hides matching items that sit
	// past the cutoff and makes the envelope counts lie.
	const matchedItems = filter ? items.filter((item) => itemMatchesFilter(item, filter)) : items;
	const matched = matchedItems.length;
	const rawLimit = Number(params?.limit);
	const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 100;
	let sliced = matchedItems.slice(0, limit);
	const fields = Array.isArray(params?.fields) && params.fields.length > 0 ? params.fields : null;
	if (fields) {
		sliced = sliced.map((item) => {
			const out: Record<string, any> = {};
			for (const f of fields) {
				if (item != null && f in item) out[f] = item[f];
			}
			return out;
		});
	}
	return { total, matched, returned: sliced.length, truncated: sliced.length < matched, items: sliced };
}

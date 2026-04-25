// Shared extension-side helpers: layer-name normalization, polygon coercion,
// unit conversion. Imported by primitive handlers so callers can pass
// human-friendly inputs without losing the strict types EasyEDA requires.

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
};

// Inner copper layers: ID = 14 + n, n in 1..30
for (let i = 1; i <= 30; i++) {
	const id = 14 + i;
	LAYER_ALIASES[String(id)] = id;
	LAYER_ALIASES[`inner${i}`] = id;
	LAYER_ALIASES[`innerlayer${i}`] = id;
	LAYER_ALIASES[`inner ${i}`] = id;
	LAYER_ALIASES[`inner layer ${i}`] = id;
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
		`Unknown layer "${input}". Use a numeric ID (1=Top, 2=Bottom, 11=BoardOutline, 15..44=Inner1..30) or a name like "TopLayer", "BottomLayer", "Inner1".`,
	);
}

type Pt = { x: number; y: number };
type PolygonInput =
	| Array<string | number>
	| Array<Pt>
	| { points: Array<Pt> }
	| { closed?: boolean; points: Array<Pt> };

/**
 * Coerce friendly polygon shapes into the L-mode source array EasyEDA expects.
 *
 * Accepted inputs:
 *   - native source array, e.g. ["L", x1, y1, x2, y2, ...] or ["R", cx, cy, w, h, 0, 0]
 *     → returned as-is
 *   - point array: [{x, y}, ...] → ["L", x1, y1, x2, y2, ...]
 *   - object: {points: [{x, y}, ...]} → ["L", ...]
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

	// Native source array — first element is a mode tag string
	if (input.length > 0 && typeof input[0] === 'string') {
		return input as Array<string | number>;
	}

	// Numeric flat array — assume L mode pairs, prepend "L"
	if (input.length > 0 && typeof input[0] === 'number') {
		if (input.length % 2 !== 0) {
			throw new Error('Numeric polygon array must have an even number of values (x,y pairs).');
		}
		return ['L', ...(input as number[])];
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
	const out: Array<string | number> = ['L'];
	for (const p of points) {
		if (typeof p?.x !== 'number' || typeof p?.y !== 'number') {
			throw new Error('Polygon points must be {x: number, y: number} objects.');
		}
		out.push(p.x, p.y);
	}
	const first = points[0];
	const last = points[points.length - 1];
	if (first.x !== last.x || first.y !== last.y) {
		out.push(first.x, first.y);
	}
	return out;
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

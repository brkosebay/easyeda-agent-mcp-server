// Pure helpers for schematic write handlers. No `eda` access here so the
// logic can be exercised by scripts/sch-geometry-smoke.ts under Node.

/**
 * EasyEDA's `sch_PrimitiveWire.create/modify` take either ONE flat polyline
 * `[x1,y1,x2,y2,...]` or an array of flat polylines `[[x1,y1,x2,y2],[...]]`.
 * Agents naturally send point pairs `[[x1,y1],[x2,y2]]`, which EasyEDA reads
 * as several one-point polylines and rejects with "create failed!". Point
 * pairs are therefore joined into a single polyline here.
 */
export function normalizeWireLine(line: unknown): number[] | number[][] {
	if (!Array.isArray(line) || line.length === 0) {
		throw new Error('Wire `line` must be a flat [x1,y1,x2,y2,...] array, point pairs [[x1,y1],[x2,y2],...], or polylines [[x1,y1,x2,y2,...],...].');
	}
	const checkFlat = (arr: unknown[], ctx: string): number[] => {
		if (arr.length < 4 || arr.length % 2 !== 0) {
			throw new Error(`${ctx} needs an even number of coordinates and at least two points (got ${arr.length} values).`);
		}
		return arr.map((v, i) => {
			const n = Number(v);
			if (typeof v === 'boolean' || v === null || v === '' || !Number.isFinite(n)) throw new Error(`${ctx}[${i}] is not a finite number.`);
			return n;
		});
	};
	if (line.every((v) => !Array.isArray(v))) return checkFlat(line, 'line');
	if (!line.every((v) => Array.isArray(v))) {
		throw new Error('Wire `line` mixes numbers and arrays; use one format.');
	}
	const nested = line as unknown[][];
	if (nested.every((p) => p.length === 2)) {
		return checkFlat(nested.flat(), 'line (point pairs)');
	}
	return nested.map((poly, i) => checkFlat(poly, `line[${i}]`));
}

/** First and last vertex of a (possibly multi-) polyline, for diagnostics. */
export function wireEndpoints(line: number[] | number[][]): Array<[number, number]> {
	const polys = Array.isArray(line[0]) ? (line as number[][]) : [line as number[]];
	const out: Array<[number, number]> = [];
	for (const p of polys) {
		out.push([p[0], p[1]], [p[p.length - 2], p[p.length - 1]]);
	}
	return out;
}

export interface FrameSample {
	/** Component origin Y as reported by sch_PrimitiveComponent (getState_Y). */
	componentY: number;
	/** Absolute pin Y values reported by getAllPinsByPrimitiveId (same frame as wires). */
	pinYs: number[];
}

export interface FrameDecision {
	/** true → component Y must be negated to match the pin/wire frame. */
	flip: boolean;
	/** false when no sample was conclusive (flip holds the fallback). */
	decided: boolean;
	votesFlip: number;
	votesSame: number;
}

function median(values: number[]): number {
	const s = [...values].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * EasyEDA Pro 2.2.x reports schematic component positions in a Y-inverted
 * frame relative to pins and wires (observed: Q1 at y=600 while its pins and
 * wires sit at y≈-600). Rather than hard-coding that quirk, measure it: a
 * part's pins always cluster around its own origin, so whichever sign puts
 * the origin among its pins is the right one.
 */
export function decideComponentYFrame(samples: FrameSample[], fallbackFlip = true, minSeparation = 10): FrameDecision {
	let votesFlip = 0;
	let votesSame = 0;
	for (const s of samples) {
		const ys = s.pinYs.filter((y) => Number.isFinite(y));
		if (!Number.isFinite(s.componentY) || ys.length === 0) continue;
		const dSame = median(ys.map((y) => Math.abs(y - s.componentY)));
		const dFlip = median(ys.map((y) => Math.abs(y + s.componentY)));
		// Only near-origin parts are ambiguous (both signs land on the pins).
		if (Math.abs(dSame - dFlip) < minSeparation) continue;
		if (dFlip < dSame / 2) votesFlip += 1;
		else if (dSame < dFlip / 2) votesSame += 1;
	}
	if (votesFlip === 0 && votesSame === 0) return { flip: fallbackFlip, decided: false, votesFlip, votesSame };
	return { flip: votesFlip > votesSame, decided: votesFlip !== votesSame, votesFlip, votesSame };
}

/**
 * Given where we asked a component to be (`sent`) and where EasyEDA put it
 * (`observed`), choose the value to send on a corrective second write so it
 * lands on `intended`. Handles the two failure shapes seen in practice: the
 * coordinate got negated (mirror applied about the page origin) or offset.
 */
export function correctedCoordinate(intended: number, sent: number, observed: number, eps = 0.01): number | undefined {
	if (Math.abs(observed - intended) <= eps) return undefined;
	if (Math.abs(sent) > eps && Math.abs(observed + sent) <= eps) return -intended;
	return sent + (intended - observed);
}

/** Property names sch_modify_component accepts, split by how they are applied. */
export const COMPONENT_STATE_SETTERS: Record<string, string> = {
	x: 'setState_X',
	y: 'setState_Y',
	rotation: 'setState_Rotation',
	mirror: 'setState_Mirror',
	addIntoBom: 'setState_AddIntoBom',
	addIntoPcb: 'setState_AddIntoPcb',
	designator: 'setState_Designator',
	name: 'setState_Name',
	uniqueId: 'setState_UniqueId',
	manufacturer: 'setState_Manufacturer',
	manufacturerId: 'setState_ManufacturerId',
	supplier: 'setState_Supplier',
	supplierId: 'setState_SupplierId',
	net: 'setState_Net',
};

/**
 * EasyEDA's done()/modify() blank every "other" property whose value is
 * falsy, so re-send the complete set (existing values overlaid with the
 * caller's) and represent empty values as "" explicitly.
 */
export function mergeOtherProperty(
	existing: Record<string, unknown> | undefined,
	requested: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	for (const src of [existing ?? {}, requested ?? {}]) {
		for (const [k, v] of Object.entries(src)) {
			if (v === undefined) continue;
			out[k] = v === null ? '' : (typeof v === 'number' || typeof v === 'boolean' ? v : String(v));
		}
	}
	return out;
}

/** Net flag / net port device titles in the EasyEDA system library. */
export const NET_FLAG_TITLES: Record<string, string[]> = {
	Power: ['Power-5V', 'VCC', 'Power'],
	Ground: ['Ground-GND', 'GND'],
	AnalogGround: ['Ground-AGND', 'AGND'],
	ProtectGround: ['Ground-PGND', 'PGND'],
};
export const NET_PORT_TITLES: Record<string, string[]> = {
	IN: ['Netport-IN'],
	OUT: ['Netport-OUT'],
	BI: ['Netport-BI'],
};

/** Classify a flattened schematic component as a net flag / net port. */
export function classifyNetSymbol(item: { componentType?: unknown; component?: any; symbol?: any; name?: unknown }): 'netflag' | 'netport' | undefined {
	const type = String(item.componentType ?? '');
	if (type === 'netflag' || type === 'netport') return type;
	const titles = [item.component?.name, item.symbol?.name, item.name].filter((t) => typeof t === 'string') as string[];
	if (titles.some((t) => /^Netport-(IN|OUT|BI)$/i.test(t))) return 'netport';
	if (titles.some((t) => /^(Power|Ground)-/i.test(t))) return 'netflag';
	return undefined;
}

/** Numeric part of a schematic primitive id: "e287", "$1I287" and "287" all → "287". */
export function primitiveIdNumber(id: unknown): string | undefined {
	const m = String(id ?? '').match(/(\d+)$/);
	return m ? m[1] : undefined;
}

export interface SourceNetSymbol {
	/** Record id in the document source, e.g. "e287" (accepted by delete/get). */
	id: string;
	num: string;
	/** Position/rotation as stored — same frame as sch_PrimitiveComponent (API) values. */
	x: number;
	y: number;
	rotation: number;
	mirror: boolean;
	/** The flag/port net name (its "Name" attribute). */
	name?: string;
	deviceUuid?: string;
	symbolUuid?: string;
}

/**
 * Net flags and net ports from native schematic source (`["COMPONENT", id,
 * partName, x, y, rotation, mirror, {}, lock]` + `["ATTR", id, parentId, key,
 * value, ...]` lines). They are the COMPONENT records with an empty part
 * name, no Designator/Footprint and a Name. EasyEDA Pro 2.2's
 * sch_PrimitiveComponent.getAll/get convert every component through a path
 * that dereferences multi-part / footprint data these records do not have,
 * so the API cannot return them — the source can.
 */
export function parseSchNetSymbols(source: string): SourceNetSymbol[] {
	const comps = new Map<string, any[]>();
	const attrs = new Map<string, Record<string, unknown>>();
	for (const line of source.split(/\r?\n/)) {
		if (!line.startsWith('["COMPONENT"') && !line.startsWith('["ATTR"')) continue;
		let rec: any[];
		try { rec = JSON.parse(line); } catch { continue; }
		if (rec[0] === 'COMPONENT' && typeof rec[1] === 'string') comps.set(rec[1], rec);
		else if (rec[0] === 'ATTR' && typeof rec[2] === 'string' && typeof rec[3] === 'string') {
			const a = attrs.get(rec[2]) ?? {};
			a[rec[3]] = rec[4];
			attrs.set(rec[2], a);
		}
	}
	const out: SourceNetSymbol[] = [];
	for (const [id, rec] of comps) {
		const a = attrs.get(id) ?? {};
		if (rec[2] !== '' || 'Designator' in a || 'Footprint' in a || typeof a.Name !== 'string') continue;
		const num = primitiveIdNumber(id);
		const x = Number(rec[3]);
		const y = Number(rec[4]);
		if (!num || !Number.isFinite(x) || !Number.isFinite(y)) continue;
		out.push({
			id,
			num,
			x,
			y,
			rotation: Number(rec[5]) || 0,
			mirror: !!rec[6],
			name: a.Name as string,
			deviceUuid: typeof a.Device === 'string' ? a.Device : undefined,
			symbolUuid: typeof a.Symbol === 'string' ? a.Symbol : undefined,
		});
	}
	return out;
}

export interface GeoPin { number: string; name?: string; x: number; y: number }
export interface GeoWire { line: number[] | number[][]; net?: string }
export interface GeoLabel { x: number; y: number; net: string }

function onSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number, tol: number): boolean {
	const dx = x2 - x1, dy = y2 - y1;
	const len2 = dx * dx + dy * dy;
	if (len2 === 0) return Math.hypot(px - x1, py - y1) <= tol;
	const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
	return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)) <= tol;
}

function wireTouches(w: GeoWire, x: number, y: number, tol: number): boolean {
	const polys = Array.isArray(w.line[0]) ? (w.line as number[][]) : [w.line as number[]];
	for (const p of polys) {
		for (let i = 0; i + 3 < p.length; i += 2) {
			if (onSegment(x, y, p[i], p[i + 1], p[i + 2], p[i + 3], tol)) return true;
		}
	}
	return false;
}

function wireVertices(w: GeoWire): Array<[number, number]> {
	const polys = Array.isArray(w.line[0]) ? (w.line as number[][]) : [w.line as number[]];
	const out: Array<[number, number]> = [];
	for (const p of polys) for (let i = 0; i + 1 < p.length; i += 2) out.push([p[i], p[i + 1]]);
	return out;
}

/**
 * Pin → net from live geometry: a pin is on a wire's net when it lies on the
 * wire; an unnamed wire takes the name of a net flag/port sitting on one of
 * its vertices; a flag/port placed directly on the pin names it too. Used
 * when the netlist (last saved state) does not know a live part.
 */
export function pinNetsFromGeometry(pins: GeoPin[], wires: GeoWire[], labels: GeoLabel[] = [], tol = 0.5): Record<string, { name: string; net: string; via: string }> {
	const named = wires.map((w) => {
		let net = String(w.net ?? '');
		if (!net) {
			for (const [vx, vy] of wireVertices(w)) {
				const hit = labels.find((l) => Math.hypot(l.x - vx, l.y - vy) <= tol);
				if (hit) { net = hit.net; break; }
			}
		}
		return { w, net };
	});
	const out: Record<string, { name: string; net: string; via: string }> = {};
	for (const p of pins) {
		let net = '';
		let via = 'unconnected';
		const touching = named.filter(({ w }) => wireTouches(w, p.x, p.y, tol));
		const withName = touching.find((t) => t.net);
		if (withName) { net = withName.net; via = 'wire'; }
		else if (touching.length) { net = '(unnamed wire)'; via = 'wire'; }
		const label = labels.find((l) => Math.hypot(l.x - p.x, l.y - p.y) <= tol);
		if (!net || net === '(unnamed wire)') { if (label) { net = label.net; via = 'net-symbol'; } }
		out[p.number] = { name: p.name ?? '', net, via };
	}
	return out;
}

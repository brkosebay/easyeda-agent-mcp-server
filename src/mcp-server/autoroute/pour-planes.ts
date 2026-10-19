// EasyEDA copper pours -> Specctra planes.
//
// EasyEDA's DSN export leaves pours out entirely. Without them fastroute sees
// a GND pad sitting in a pour as unconnected and routes a trace to it, and it
// treats a solid inner GND plane as a free signal layer. A pour becomes a
// `(plane NET (polygon LAYER 0 ...))` conduction area: same-net pads and vias
// touching it count as connected. An inner layer that is one solid, trace-free
// pour is additionally marked `(type power)`, so no signal is routed through
// it and every pad of its net is joined to it by a via.
//
// Only those solid inner planes are passed by default (innerOnly). A pour on
// a signal layer is not an obstacle to the router, so other nets route across
// it and EasyEDA's re-pour then cuts it into islands: pads the router counted
// as joined by the pour end up isolated. Without it the router connects every
// pad explicitly (trace, or via to the inner plane).
//
// Coordinates: pour summaries come back in canvas mil with Y up (the same
// frame as the via getters). The DSN uses 10-mil units with its own origin
// (EasyEDA puts it at the board outline's lower-left), so the offset is
// calibrated from vias or components that appear in both, falling back to the
// outline.

import type { WebSocketBridge } from '../bridge';
import { physicalLayerIndex } from './fastroute-config';
import { atom, atomText, childLists, firstChild, headOf, isNumberAtom, list, type SList, type SNode } from './specctra';

export interface Point { x: number; y: number }

export interface PourInput {
	primitiveId: string;
	net: string;
	layer: number | string;
	pourName?: string;
	/** Outline in canvas mil, Y up. */
	polygon: Point[];
	holes: number;
}

export interface PlaneSpec {
	net: string;
	dsnLayer: string;
	pourId: string;
	pourName?: string;
	/** board-outline: the pour covers the board, so the exact DSN boundary is used. */
	shape: 'board-outline' | 'pour-outline';
	powerLayer: boolean;
	coverage: number;
	/** Written to the DSN (innerOnly passes power-layer planes only). */
	passed: boolean;
}

export interface PlaneResult {
	planes: PlaneSpec[];
	pourNets: string[];
	powerLayers: string[];
	calibration?: { method: 'vias' | 'components' | 'board-outline'; offsetX: number; offsetY: number; support: number };
	warnings: string[];
}

// ---------------------------------------------------------------------------
// Pour geometry
// ---------------------------------------------------------------------------

function items(res: any): any[] {
	if (Array.isArray(res)) return res;
	if (Array.isArray(res?.items)) return res.items;
	return [];
}

function roundedRect(minX: number, minY: number, maxX: number, maxY: number, radius: number): Point[] {
	const r = Math.max(0, Math.min(radius || 0, (maxX - minX) / 2, (maxY - minY) / 2));
	if (r <= 0) return [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }, { x: minX, y: minY }];
	const pts: Point[] = [];
	const corner = (cx: number, cy: number, from: number) => {
		for (let k = 0; k <= 6; k++) {
			const a = ((from + k * 15) * Math.PI) / 180;
			pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
		}
	};
	corner(maxX - r, minY + r, 270);
	corner(maxX - r, maxY - r, 0);
	corner(minX + r, maxY - r, 90);
	corner(minX + r, minY + r, 180);
	pts.push({ ...pts[0] });
	return pts;
}

/** Vertices of a raw EasyEDA polygon source (["L", x, y, ...] or [x, y, "L", x, y, "ARC", angle, x, y, ...]). */
export function rawSourceVertices(src: any[]): { points: Point[]; arcs: number } {
	const points: Point[] = [];
	let arcs = 0;
	let i = typeof src[0] === 'string' && src[0] === 'L' ? 1 : 0;
	while (i < src.length) {
		const t = src[i];
		if (t === 'L') { i++; continue; }
		if (t === 'ARC' || t === 'CARC') { arcs++; i += 2; continue; } // angle, then the end point as a plain pair
		if (typeof t === 'number' && typeof src[i + 1] === 'number') { points.push({ x: t, y: src[i + 1] }); i += 2; continue; }
		i++;
	}
	return { points, arcs };
}

/** Per-axis affine raw -> canvas fitted from corresponding points. */
function fitAxis(raw: number[], canvas: number[]): { s: number; a: number } | undefined {
	for (let i = 0; i < raw.length; i++) {
		for (let j = i + 1; j < raw.length; j++) {
			const d = raw[j] - raw[i];
			if (Math.abs(d) > 1e-6) {
				const s = (canvas[j] - canvas[i]) / d;
				return { s, a: canvas[i] - s * raw[i] };
			}
		}
	}
	return undefined;
}

/** Canvas outline (mil, Y up) of one inspected pour, or why it cannot be used. */
export function pourCanvasPolygon(inspect: any): { polygon: Point[]; holes: number; note?: string } | { reason: string } {
	const summary = inspect?.summary;
	if (!summary) return { reason: 'no geometry summary' };
	if (inspect.coordinateSpace && inspect.coordinateSpace !== 'canvas-mil-negY') return { reason: `geometry in ${inspect.coordinateSpace} (canvas transform unavailable)` };
	const source = inspect.source;

	const one = (s: any, raw: any): { polygon: Point[]; note?: string } | { reason: string } => {
		if (s?.mode === 'R' && s.bbox) {
			const rot = Number(s.rectangle?.rotation ?? 0) % 360;
			return {
				polygon: roundedRect(s.bbox.minX, s.bbox.minY, s.bbox.maxX, s.bbox.maxY, Number(s.rectangle?.cornerRadius ?? 0)),
				...(rot ? { note: `rotated rectangle (${rot}°) approximated by its bounding box` } : {}),
			};
		}
		if (s?.mode === 'L') {
			if (!Array.isArray(raw)) return { reason: 'polygon source missing' };
			const { points: rawPts, arcs } = rawSourceVertices(raw);
			const sample: Point[] = Array.isArray(s.points) ? s.points : [];
			const n = Math.min(rawPts.length, sample.length);
			const fx = fitAxis(rawPts.slice(0, n).map((p) => p.x), sample.slice(0, n).map((p) => p.x));
			const fy = fitAxis(rawPts.slice(0, n).map((p) => p.y), sample.slice(0, n).map((p) => p.y));
			if (!fx || !fy) return { reason: 'cannot relate the polygon source to canvas coordinates' };
			const polygon = rawPts.map((p) => ({ x: fx.a + fx.s * p.x, y: fy.a + fy.s * p.y }));
			if (polygon.length < 3) return { reason: 'fewer than 3 vertices' };
			const f = polygon[0], l = polygon[polygon.length - 1];
			if (f.x !== l.x || f.y !== l.y) polygon.push({ ...f });
			return { polygon, ...(arcs ? { note: `${arcs} arc segment(s) approximated by chords` } : {}) };
		}
		return { reason: `unsupported polygon mode ${s?.mode ?? '?'}` };
	};

	if (summary.mode === 'complex' && Array.isArray(summary.children)) {
		// Largest child is the outline; the others are cut-outs.
		const area = (c: any) => (c?.bbox ? (c.bbox.maxX - c.bbox.minX) * (c.bbox.maxY - c.bbox.minY) : 0);
		let best = 0;
		summary.children.forEach((c: any, i: number) => { if (area(c) > area(summary.children[best])) best = i; });
		const res = one(summary.children[best], Array.isArray(source) ? source[best] : undefined);
		if ('reason' in res) return res;
		return { polygon: res.polygon, holes: summary.children.length - 1, ...(res.note ? { note: res.note } : {}) };
	}
	const res = one(summary, source);
	return 'reason' in res ? res : { polygon: res.polygon, holes: 0, ...(res.note ? { note: res.note } : {}) };
}

// ---------------------------------------------------------------------------
// DSN frame
// ---------------------------------------------------------------------------

/** Vias in the DSN wiring (EasyEDA units). */
export function dsnWiringVias(root: SList): Array<Point & { net: string }> {
	const wiring = firstChild(root, 'wiring');
	if (!wiring) return [];
	return childLists(wiring, 'via').flatMap((v) => {
		const x = Number(atomText(v.items[2]));
		const y = Number(atomText(v.items[3]));
		const net = atomText(firstChild(v, 'net')?.items[1]);
		return Number.isFinite(x) && Number.isFinite(y) && net ? [{ x, y, net }] : [];
	});
}

/** Layers carrying wiring in the DSN. */
export function dsnWiringLayers(root: SList): Set<string> {
	const out = new Set<string>();
	const wiring = firstChild(root, 'wiring');
	if (!wiring) return out;
	for (const w of childLists(wiring, 'wire')) {
		for (const shape of w.items) {
			if (shape.kind === 'list' && headOf(shape) === 'path') {
				const layer = atomText(shape.items[1]);
				if (layer) out.add(layer);
			}
		}
	}
	return out;
}

function boundaryPath(root: SList): SList | undefined {
	const structure = firstChild(root, 'structure');
	const boundary = structure ? firstChild(structure, 'boundary') : undefined;
	return boundary ? childLists(boundary).find((n) => ['path', 'polygon', 'rect'].includes(headOf(n) ?? '')) : undefined;
}

function bbox(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
	return {
		minX: Math.min(...points.map((p) => p.x)),
		minY: Math.min(...points.map((p) => p.y)),
		maxX: Math.max(...points.map((p) => p.x)),
		maxY: Math.max(...points.map((p) => p.y)),
	};
}

export function dsnBoundaryPoints(root: SList): Point[] {
	const p = boundaryPath(root);
	if (!p) return [];
	// (rect LAYER x1 y1 x2 y2); (path|polygon LAYER WIDTH x y ...)
	const nums = p.items.slice(headOf(p) === 'rect' ? 2 : 3).filter(isNumberAtom).map((a) => Number(a.text));
	if (headOf(p) === 'rect') {
		const [x1, y1, x2, y2] = nums;
		return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }, { x: x1, y: y1 }];
	}
	const pts: Point[] = [];
	for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
	return pts;
}

/**
 * Offset such that dsn = canvasMil / 10 - offset, from vias present on both
 * sides (same net). Returns the most common offset and how many vias agree.
 */
export function calibrateFromVias(dsnVias: Array<Point & { net: string }>, canvasVias: Array<Point & { net: string }>): { offsetX: number; offsetY: number; support: number } | undefined {
	const byNet = new Map<string, Point[]>();
	for (const v of canvasVias) {
		const arr = byNet.get(v.net) ?? [];
		arr.push(v);
		byNet.set(v.net, arr);
	}
	const votes = new Map<string, { x: number; y: number; n: number }>();
	for (const d of dsnVias) {
		for (const c of byNet.get(d.net) ?? []) {
			const ox = Math.round((c.x / 10 - d.x) * 50) / 50 || 0;
			const oy = Math.round((c.y / 10 - d.y) * 50) / 50 || 0;
			const key = `${ox}|${oy}`;
			const v = votes.get(key) ?? { x: ox, y: oy, n: 0 };
			v.n++;
			votes.set(key, v);
		}
	}
	let best: { x: number; y: number; n: number } | undefined;
	for (const v of votes.values()) if (!best || v.n > best.n) best = v;
	if (!best || best.n < Math.min(3, dsnVias.length)) return undefined;
	return { offsetX: best.x, offsetY: best.y, support: best.n };
}

/** Component placements `(place REF x y side rot)` of a DSN or SES (file units). */
export function dsnPlacements(root: SList): Array<Point & { ref: string }> {
	const placement = firstChild(root, 'placement');
	if (!placement) return [];
	return childLists(placement, 'component').flatMap((c) => childLists(c, 'place').flatMap((p) => {
		const ref = atomText(p.items[1]);
		const x = Number(atomText(p.items[2]));
		const y = Number(atomText(p.items[3]));
		return ref && Number.isFinite(x) && Number.isFinite(y) ? [{ ref, x, y }] : [];
	}));
}

/**
 * Offset such that dsn = canvasMil / 10 - offset, from components placed on
 * both sides (same designator). Works on boards without vias (placement only).
 * More than half of the matched components must agree.
 */
export function calibrateFromComponents(dsnParts: Array<Point & { ref: string }>, canvasParts: Array<Point & { ref: string }>): { offsetX: number; offsetY: number; support: number } | undefined {
	const canvasByRef = new Map(canvasParts.map((c) => [c.ref, c]));
	const votes = new Map<string, { x: number; y: number; n: number }>();
	let matched = 0;
	for (const d of dsnParts) {
		const c = canvasByRef.get(d.ref);
		if (!c) continue;
		matched++;
		const ox = Math.round((c.x / 10 - d.x) * 50) / 50 || 0;
		const oy = Math.round((c.y / 10 - d.y) * 50) / 50 || 0;
		const key = `${ox}|${oy}`;
		const v = votes.get(key) ?? { x: ox, y: oy, n: 0 };
		v.n++;
		votes.set(key, v);
	}
	let best: { x: number; y: number; n: number } | undefined;
	for (const v of votes.values()) if (!best || v.n > best.n) best = v;
	if (!best || best.n < Math.min(3, matched) || best.n * 2 <= matched) return undefined;
	return { offsetX: best.x, offsetY: best.y, support: best.n };
}

// ---------------------------------------------------------------------------
// Building the planes
// ---------------------------------------------------------------------------

export function dsnLayerNameFor(easyedaLayer: number | string, dsnLayers: string[]): string | undefined {
	const id = String(easyedaLayer).trim();
	if (dsnLayers.includes(id)) return id;
	const n = dsnLayers.length;
	const wanted = physicalLayerIndex(id, n);
	if (wanted == null) return undefined;
	return dsnLayers.find((l) => physicalLayerIndex(l, n) === wanted);
}

function polygonArea(pts: Point[]): number {
	let a = 0;
	for (let i = 0; i + 1 < pts.length; i++) a += pts[i].x * pts[i + 1].y - pts[i + 1].x * pts[i].y;
	return Math.abs(a) / 2;
}

/**
 * Add planes for `pours` to an EasyEDA-unit DSN tree (in place). `offset`
 * maps canvas mil to DSN units: dsn = canvas / 10 - offset.
 */
export function addPourPlanes(
	root: SList,
	pours: PourInput[],
	offset: { offsetX: number; offsetY: number },
	opts: { dsnNets: Set<string>; dsnLayers: string[]; markPowerLayers: boolean; innerOnly?: boolean },
): { planes: PlaneSpec[]; powerLayers: string[]; warnings: string[] } {
	const warnings: string[] = [];
	const structure = firstChild(root, 'structure');
	if (!structure) return { planes: [], powerLayers: [], warnings: ['DSN has no structure section; pours not added'] };
	const boundary = dsnBoundaryPoints(root);
	if (boundary.length < 3) return { planes: [], powerLayers: [], warnings: ['DSN has no board boundary; pours not added'] };
	const bb = bbox(boundary);
	const boardArea = polygonArea(boundary) || (bb.maxX - bb.minX) * (bb.maxY - bb.minY);
	const wiredLayers = dsnWiringLayers(root);

	const planes: PlaneSpec[] = [];
	const planeNodes: SList[] = [];
	const netsByLayer = new Map<string, Set<string>>();
	for (const p of pours) {
		if (!p.net) { warnings.push(`pour ${p.pourName ?? p.primitiveId}: no net; skipped`); continue; }
		if (!opts.dsnNets.has(p.net)) { warnings.push(`pour ${p.pourName ?? p.primitiveId}: net ${p.net} not in the DSN; skipped`); continue; }
		const dsnLayer = dsnLayerNameFor(p.layer, opts.dsnLayers);
		if (!dsnLayer) { warnings.push(`pour ${p.pourName ?? p.primitiveId}: layer ${p.layer} is not a DSN copper layer; skipped`); continue; }
		const pts = p.polygon.map((c) => ({ x: c.x / 10 - offset.offsetX, y: c.y / 10 - offset.offsetY }));
		const pb = bbox(pts);
		const overlapW = Math.max(0, Math.min(pb.maxX, bb.maxX) - Math.max(pb.minX, bb.minX));
		const overlapH = Math.max(0, Math.min(pb.maxY, bb.maxY) - Math.max(pb.minY, bb.minY));
		if (overlapW * overlapH <= 0) { warnings.push(`pour ${p.pourName ?? p.primitiveId}: lies outside the board after calibration; skipped`); continue; }
		const coverage = Math.min(1, polygonArea(pts) / boardArea);
		const coversBoard = pb.minX <= bb.minX + 0.5 && pb.minY <= bb.minY + 0.5 && pb.maxX >= bb.maxX - 0.5 && pb.maxY >= bb.maxY - 0.5;
		const ring = coversBoard ? boundary : pts;
		if (p.holes) warnings.push(`pour ${p.pourName ?? p.primitiveId}: ${p.holes} cut-out(s) ignored; the router treats them as copper`);
		const coords = ring.flatMap((q) => [atom(fmt(q.x)), atom(fmt(q.y))]);
		planeNodes.push(list('plane', atom(p.net, /[\s()"]/.test(p.net)), list('polygon', atom(dsnLayer), atom('0'), ...coords)));
		planes.push({ net: p.net, dsnLayer, pourId: p.primitiveId, ...(p.pourName ? { pourName: p.pourName } : {}), shape: coversBoard ? 'board-outline' : 'pour-outline', powerLayer: false, coverage: Math.round(coverage * 1000) / 1000, passed: true });
		const s = netsByLayer.get(dsnLayer) ?? new Set<string>();
		s.add(p.net);
		netsByLayer.set(dsnLayer, s);
	}

	// Solid single-net inner layers with no traces become power layers.
	const powerLayers: string[] = [];
	if (opts.markPowerLayers) {
		const n = opts.dsnLayers.length;
		for (const layer of opts.dsnLayers) {
			const idx = physicalLayerIndex(layer, n);
			if (idx == null || idx === 0 || idx === n - 1) continue;
			const nets = netsByLayer.get(layer);
			if (!nets || nets.size !== 1) continue;
			const cover = planes.filter((pl) => pl.dsnLayer === layer).reduce((m, pl) => Math.max(m, pl.coverage), 0);
			if (cover < 0.9) continue;
			if (wiredLayers.has(layer)) continue;
			const def = childLists(structure, 'layer').find((l) => atomText(l.items[1]) === layer);
			const type = def ? firstChild(def, 'type') : undefined;
			if (!type) continue;
			type.items = [atom('type'), atom('power')];
			powerLayers.push(layer);
			for (const pl of planes) if (pl.dsnLayer === layer) pl.powerLayer = true;
		}
	}

	if (opts.innerOnly) for (const pl of planes) pl.passed = pl.powerLayer;

	// Planes go after the layer definitions, where Specctra expects them.
	const lastLayer = structure.items.reduce((at, n, i) => (headOf(n) === 'layer' ? i : at), -1);
	structure.items.splice(lastLayer >= 0 ? lastLayer + 1 : structure.items.length, 0, ...planeNodes.filter((_, i) => planes[i].passed));
	return { planes, powerLayers, warnings };
}

function fmt(v: number): string {
	return (Math.round(v * 10000) / 10000).toString();
}

export type DsnCalibration = NonNullable<PlaneResult['calibration']>;

/**
 * Offset between the DSN frame and the board (dsn = canvasMil / 10 - offset),
 * from vias present on both sides, else from component positions, else from
 * the board outline. `dsnVias`, `dsnParts` and `dsnBoundary` are in EasyEDA DSN
 * units (10 mil); an SES in those units works the same way.
 */
export async function calibrateDsnFrame(
	send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
	dsnVias: Array<Point & { net: string }>,
	dsnBoundary: Point[],
	dsnParts: Array<Point & { ref: string }> = [],
): Promise<{ calibration?: DsnCalibration; warnings: string[] }> {
	const warnings: string[] = [];
	if (dsnVias.length) {
		try {
			const canvasVias = items(await send('pcb.getAll.via', { limit: 1_000_000, fields: ['x', 'y', 'net'] })).flatMap((v: any) => {
				const x = Number(v?.x), y = Number(v?.y), net = v?.net != null ? String(v.net) : '';
				return Number.isFinite(x) && Number.isFinite(y) && net ? [{ x, y, net }] : [];
			});
			const c = calibrateFromVias(dsnVias, canvasVias);
			if (c) return { calibration: { method: 'vias', ...c }, warnings };
		} catch (err: any) {
			warnings.push(`via calibration failed (pcb.getAll.via): ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (dsnParts.length) {
		try {
			const canvasParts = items(await send('pcb.getAll.component', { limit: 1_000_000, fields: ['designator', 'x', 'y'] })).flatMap((c: any) => {
				const x = Number(c?.x), y = Number(c?.y), ref = c?.designator != null ? String(c.designator) : '';
				return Number.isFinite(x) && Number.isFinite(y) && ref ? [{ x, y, ref }] : [];
			});
			const c = calibrateFromComponents(dsnParts, canvasParts);
			if (c) return { calibration: { method: 'components', ...c }, warnings };
			warnings.push('component calibration: designators did not agree on one offset');
		} catch (err: any) {
			warnings.push(`component calibration failed (pcb.getAll.component): ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (dsnBoundary.length) {
		try {
			const outline = items(await send('pcb.getAll.polyline', { layer: 11, limit: 1_000 }));
			const boxes = outline.map((o: any) => o?.summary?.bbox).filter(Boolean);
			if (boxes.length) {
				const minX = Math.min(...boxes.map((b: any) => b.minX));
				const minY = Math.min(...boxes.map((b: any) => b.minY));
				const db = bbox(dsnBoundary);
				warnings.push('DSN position calibrated from the board outline (no vias to calibrate from); check the result if the board origin was moved');
				return { calibration: { method: 'board-outline', offsetX: minX / 10 - db.minX, offsetY: minY / 10 - db.minY, support: boxes.length }, warnings };
			}
		} catch { /* no calibration */ }
	}
	return { warnings };
}

/** Read the board's pours and vias over the bridge and add the planes to `root` (EasyEDA units). */
export async function collectAndAddPourPlanes(
	bridge: WebSocketBridge,
	routingParams: Record<string, unknown>,
	root: SList,
	dsnNets: Set<string>,
	dsnLayers: string[],
	markPowerLayers: boolean,
	innerOnly = false,
): Promise<PlaneResult> {
	const warnings: string[] = [];
	const send = (method: string, params: Record<string, unknown> = {}) =>
		bridge.send(method, { ...routingParams, ...params, _timeoutMs: 20_000 });

	let pourList: any[];
	try {
		pourList = items(await send('pcb.getAll.pour', { limit: 10_000 }));
	} catch (err: any) {
		return { planes: [], pourNets: [], powerLayers: [], warnings: [`could not read pours (pcb.getAll.pour): ${err instanceof Error ? err.message : String(err)}`] };
	}
	if (!pourList.length) return { planes: [], pourNets: [], powerLayers: [], warnings };
	// Every net with a pour, passed to the router or not: reroutes leave these alone.
	const pourNets = Array.from(new Set(pourList.map((p) => String(p?.net ?? '')).filter((n) => n && dsnNets.has(n))));

	const pours: PourInput[] = [];
	for (const p of pourList) {
		const id = String(p?.primitiveId ?? '');
		if (!id) continue;
		let inspect: any = p;
		if (p?.summary?.mode !== 'R') {
			try { inspect = await send('pcb.pour.inspect', { primitiveId: id, includeSource: true }); } catch (err: any) {
				warnings.push(`pour ${p?.pourName ?? id}: inspect failed (${err instanceof Error ? err.message : String(err)}); skipped`);
				continue;
			}
		} else {
			inspect = { ...p, coordinateSpace: p.summary.coordinateSpace };
		}
		const geo = pourCanvasPolygon(inspect);
		if ('reason' in geo) { warnings.push(`pour ${p?.pourName ?? id}: ${geo.reason}; skipped`); continue; }
		if (geo.note) warnings.push(`pour ${p?.pourName ?? id}: ${geo.note}`);
		pours.push({ primitiveId: id, net: String(p?.net ?? ''), layer: p?.layer, ...(p?.pourName ? { pourName: String(p.pourName) } : {}), polygon: geo.polygon, holes: geo.holes });
	}

	const { calibration, warnings: calibrationWarnings } = await calibrateDsnFrame(send, dsnWiringVias(root), dsnBoundaryPoints(root), dsnPlacements(root));
	warnings.push(...calibrationWarnings);
	if (!calibration) {
		return { planes: [], pourNets, powerLayers: [], warnings: [...warnings, 'could not relate pour coordinates to the DSN; pours not passed to the router'] };
	}

	const added = addPourPlanes(root, pours, calibration, { dsnNets, dsnLayers, markPowerLayers, innerOnly });
	return {
		planes: added.planes,
		pourNets,
		powerLayers: added.powerLayers,
		calibration,
		warnings: [...warnings, ...added.warnings],
	};
}

// Re-exported for tests that build trees by hand.
export type { SNode };

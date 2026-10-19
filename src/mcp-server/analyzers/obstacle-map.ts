// Pure PCB obstacle-map analyzer.
//
// This is the MCP-side spatial index that routing/placement/reporting code can
// share when it already has a board snapshot. The live EasyEDA extension owns
// the SDK calls; this module owns the normalized obstacle representation.
//
// Units: every length in the input snapshot must already be mil. The extension
// normalizes component pads before they reach this module (their coordinates
// are 10-mil component units; pad extents are already mil and hole extents are
// 10-mil on every API); board primitives are mil at the source.
// Pads are modelled as rotated rectangles (center + width/height + rotation),
// vias as circles (their real shape), pours/keepouts as polygons.
// Net rules are read with the shared DRC-rule parser (src/shared/drc-rules.ts),
// the same one the extension's obstacle preflight and pathfinder use.

import {
	clearanceResolverFromRules,
	netRuleRows,
	netsWithRules,
	resolveTrackWidth,
	type ClearanceKind,
} from '../../shared/drc-rules';

export type ObstacleKind = 'track' | 'via' | 'pad' | 'component_pad' | 'pour' | 'keepout' | 'board_outline';

export interface Point {
	x: number;
	y: number;
}

export interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	width: number;
	height: number;
}

export interface NetRule {
	net: string;
	widthMil?: number;
	minWidthMil?: number;
	maxWidthMil?: number;
	/** 'rule:<config>/Track/<rule>...', 'payload:widthMil' or 'default (<why>)'. */
	widthSource?: string;
	clearanceMil?: number;
	clearanceByKind?: Partial<Record<ClearanceKind, number>>;
	/** 'rule:<config>/Safe Spacing/<rule>...', 'payload:clearanceMil' or 'default (<why>)'. */
	clearanceSource?: string;
}

export interface ObstacleShape {
	id: string;
	kind: ObstacleKind;
	layer?: string | number;
	net?: string;
	primitiveId?: string;
	reference?: string;
	padNumber?: string;
	bounds: Bounds;
	center?: Point;
	radiusMil?: number;
	widthMil?: number;
	heightMil?: number;
	rotationDeg?: number;
	segment?: { start: Point; end: Point; widthMil?: number };
	polygon?: Point[];
	source?: string;
}

export interface ObstacleLayerIndex {
	layer: string;
	obstacles: ObstacleShape[];
	bins: Record<string, string[]>;
}

export interface ObstacleMap {
	units: 'mil';
	binSizeMil: number;
	layers: Record<string, ObstacleLayerIndex>;
	netRules: Record<string, NetRule>;
	totals: Record<ObstacleKind, number>;
	bounds?: Bounds;
	boardOutline?: Bounds;
}

export interface ObstacleMapOptions {
	binSizeMil?: number;
	/** getNetRules() rows, the full getCurrentRuleConfiguration() payload, or {ruleConfig, netRules}. */
	netRules?: any;
	/** getCurrentRuleConfiguration() payload; needed to turn net-rule names into numbers. */
	ruleConfig?: any;
	defaultClearanceMil?: number;
	defaultWidthMil?: number;
}

export interface ObstacleQuery {
	layer?: string | number;
	net?: string;
	region: Bounds;
	ignoreSameNet?: boolean;
	kinds?: ObstacleKind[];
}

const FALLBACK_PAD_SIZE_MIL = 36;
const FALLBACK_VIA_DIAMETER_MIL = 24;

let generatedId = 0;

export function buildObstacleMap(snapshot: any, options: ObstacleMapOptions = {}): ObstacleMap {
	const binSizeMil = Math.max(10, Number(options.binSizeMil ?? 100));
	const map: ObstacleMap = {
		units: 'mil',
		binSizeMil,
		layers: {},
		netRules: normalizeNetRules(options.netRules, options),
		totals: {
			track: 0,
			via: 0,
			pad: 0,
			component_pad: 0,
			pour: 0,
			keepout: 0,
			board_outline: 0,
		},
		bounds: boundsFromAny(snapshot?.bounds),
		boardOutline: boundsFromAny(snapshot?.boardOutline?.bounds ?? snapshot?.boardOutline)
			?? outlinePolylineBounds(snapshot?.boardOutline),
	};

	for (const line of arrayOf(snapshot?.lines ?? snapshot?.tracks)) addShape(map, lineObstacle(line));
	for (const via of arrayOf(snapshot?.vias)) addShape(map, viaObstacle(via));
	// A snapshot from an older extension (or a hand-built one) may repeat each
	// component pad under standalonePads with the same primitiveId; count it once.
	const componentPads = arrayOf(snapshot?.componentPads);
	const componentPadIds = new Set(componentPads.map((pad) => stringOrUndefined(pad?.primitiveId ?? pad?.id)).filter(Boolean));
	for (const pad of arrayOf(snapshot?.standalonePads ?? snapshot?.pads)) {
		const id = stringOrUndefined(pad?.primitiveId ?? pad?.id);
		if (id && componentPadIds.has(id)) continue;
		addShape(map, padObstacle(pad, 'pad'));
	}
	for (const pad of componentPads) addShape(map, padObstacle(pad, 'component_pad'));
	for (const pour of arrayOf(snapshot?.pours)) addShape(map, polygonObstacle(pour, 'pour'));

	const explicitKeepouts = arrayOf(snapshot?.keepouts);
	const regions = explicitKeepouts.length > 0
		? explicitKeepouts
		: arrayOf(snapshot?.regions).filter(looksLikeKeepout);
	for (const region of regions) addShape(map, polygonObstacle(region, 'keepout'));

	const outlinePolylines = arrayOf(snapshot?.boardOutline?.polylines);
	if (outlinePolylines.length > 0) {
		for (const polyline of outlinePolylines) {
			const bounds = boundsFromAny(polyline);
			if (!bounds) continue;
			addShape(map, {
				id: idOf(polyline, 'board_outline'),
				kind: 'board_outline',
				layer: 11,
				bounds,
				source: 'boardOutline.polylines[].summary.bbox',
			});
		}
	} else if (map.boardOutline) {
		addShape(map, {
			id: idOf(snapshot?.boardOutline, 'board_outline'),
			kind: 'board_outline',
			layer: 11,
			bounds: map.boardOutline,
			source: 'boardOutline.bounds',
		});
	}

	return map;
}

export function summarizeObstacleMap(map: ObstacleMap): any {
	return {
		units: map.units,
		binSizeMil: map.binSizeMil,
		totals: map.totals,
		bounds: map.bounds,
		boardOutline: map.boardOutline,
		layers: Object.values(map.layers)
			.map((layer) => ({
				layer: layer.layer,
				obstacleCount: layer.obstacles.length,
				binCount: Object.keys(layer.bins).length,
				byKind: countByKind(layer.obstacles),
			}))
			.sort((a, b) => String(a.layer).localeCompare(String(b.layer))),
	};
}

export function queryObstacleMap(map: ObstacleMap, query: ObstacleQuery): ObstacleShape[] {
	const allowedKinds = query.kinds ? new Set(query.kinds) : undefined;
	const layerKeys = new Set<string>(['multi']);
	if (query.layer != null) layerKeys.add(String(query.layer));
	else for (const key of Object.keys(map.layers)) layerKeys.add(key);

	const candidates = new Map<string, ObstacleShape>();
	for (const layerKey of layerKeys) {
		const layer = map.layers[layerKey];
		if (!layer) continue;
		for (const binKey of binsForBounds(query.region, map.binSizeMil)) {
			for (const id of layer.bins[binKey] ?? []) {
				const shape = layer.obstacles.find((o) => o.id === id);
				if (!shape) continue;
				candidates.set(shape.id, shape);
			}
		}
	}

	return Array.from(candidates.values()).filter((shape) => {
		if (allowedKinds && !allowedKinds.has(shape.kind)) return false;
		if (query.ignoreSameNet !== false && query.net && shape.net === query.net) return false;
		return boundsOverlap(shape.bounds, query.region);
	});
}

function addShape(map: ObstacleMap, shape: ObstacleShape | undefined): void {
	if (!shape) return;
	const layerKey = layerKeyFor(shape);
	if (!map.layers[layerKey]) map.layers[layerKey] = { layer: layerKey, obstacles: [], bins: {} };
	const layer = map.layers[layerKey];
	layer.obstacles.push(shape);
	for (const binKey of binsForBounds(shape.bounds, map.binSizeMil)) {
		if (!layer.bins[binKey]) layer.bins[binKey] = [];
		layer.bins[binKey].push(shape.id);
	}
	map.totals[shape.kind] += 1;
}

function lineObstacle(line: any): ObstacleShape | undefined {
	const start = pointFrom(line, 'startX', 'startY');
	const end = pointFrom(line, 'endX', 'endY');
	if (!start || !end) return undefined;
	const widthMil = finiteNumber(line?.lineWidth);
	const pad = (widthMil ?? 0) / 2;
	return {
		id: idOf(line, 'track'),
		kind: 'track',
		layer: line?.layer,
		net: stringOrUndefined(line?.net),
		primitiveId: stringOrUndefined(line?.primitiveId ?? line?.id),
		bounds: expandBounds(boundsForPoints([start, end])!, pad),
		center: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
		segment: { start, end, widthMil },
		source: 'line',
	};
}

function viaObstacle(via: any): ObstacleShape | undefined {
	const center = pointFrom(via);
	if (!center) return undefined;
	const radiusMil = (finiteNumber(via?.diameter) ?? FALLBACK_VIA_DIAMETER_MIL) / 2;
	return {
		id: idOf(via, 'via'),
		kind: 'via',
		layer: 'multi',
		net: stringOrUndefined(via?.net),
		primitiveId: stringOrUndefined(via?.primitiveId ?? via?.id),
		bounds: boundsAround(center, radiusMil),
		center,
		radiusMil,
		source: 'via',
	};
}

function padObstacle(pad: any, kind: 'pad' | 'component_pad'): ObstacleShape | undefined {
	const center = pointFrom(pad);
	if (!center) return undefined;
	const reference = stringOrUndefined(pad?.reference ?? pad?.componentDesignator);
	const padNumber = stringOrUndefined(pad?.padNumber ?? pad?.pinNumber ?? pad?.number ?? pad?.name);
	const id = padIdOf(pad, reference, padNumber);
	if (!id) return undefined;
	const shape = padShape(pad, center);
	const bounds = boundsForPoints(shape.polygon);
	if (!bounds) return undefined;
	return {
		id,
		kind,
		layer: pad?.layer ?? 'multi',
		net: stringOrUndefined(pad?.net ?? pad?.netName),
		primitiveId: stringOrUndefined(pad?.primitiveId ?? pad?.id),
		reference,
		padNumber,
		bounds,
		center,
		widthMil: shape.widthMil,
		heightMil: shape.heightMil,
		rotationDeg: shape.rotationDeg,
		polygon: shape.polygon,
		source: kind,
	};
}

// EasyEDA pad shape: [ELLIPSE|OVAL|NGON, w, h] | [RECT, w, h, cornerRadius]
// | [POLYGON, polygonSource]. Non-polygon pads become a rotated rectangle so
// distance checks are edge-to-edge instead of center+radius.
function padShape(pad: any, center: Point): { polygon: Point[]; widthMil: number; heightMil: number; rotationDeg: number } {
	const rotationDeg = padRotationDeg(pad?.rotation ?? pad?.angle ?? pad?.rotate);
	const shapeArray = Array.isArray(pad?.pad) ? pad.pad : undefined;
	const shapeType = shapeArray ? String(shapeArray[0]).toUpperCase() : undefined;

	if (shapeType === 'POLYGON') {
		const polygon = polygonPoints({ source: shapeArray?.[1] });
		const bounds = polygon.length >= 3 ? boundsForPoints(polygon) : undefined;
		if (bounds) {
			return { polygon, widthMil: bounds.width, heightMil: bounds.height, rotationDeg };
		}
	}

	const shapeWidth = shapeArray ? finiteNumber(shapeArray[1]) : undefined;
	const shapeHeight = shapeArray ? finiteNumber(shapeArray[2]) ?? shapeWidth : undefined;
	const width = shapeWidth ?? finiteNumber(pad?.width ?? pad?.w ?? pad?.sizeX ?? pad?.padWidth ?? pad?.diameter);
	const height = shapeHeight ?? finiteNumber(pad?.height ?? pad?.h ?? pad?.sizeY ?? pad?.padHeight ?? pad?.diameter);
	const widthMil = Math.max(1, width ?? height ?? FALLBACK_PAD_SIZE_MIL);
	const heightMil = Math.max(1, height ?? width ?? FALLBACK_PAD_SIZE_MIL);
	return { polygon: rotatedRectCorners(center, widthMil, heightMil, rotationDeg), widthMil, heightMil, rotationDeg };
}

/** EasyEDA reports pad rotation in radians (component rotation is degrees).
 *  Any |value| within one turn of radians is radians; larger values are
 *  degrees. Mirrors padRotationDeg() in the extension's trace-obstacles. */
function padRotationDeg(value: any): number {
	const n = finiteNumber(value);
	if (n == null || n === 0) return 0;
	return Math.abs(n) <= Math.PI * 2 + 1e-6 ? (n * 180) / Math.PI : n;
}

function rotatedRectCorners(center: Point, widthMil: number, heightMil: number, rotationDeg: number): Point[] {
	const hw = widthMil / 2;
	const hh = heightMil / 2;
	const radians = (rotationDeg * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return [
		{ x: -hw, y: -hh },
		{ x: hw, y: -hh },
		{ x: hw, y: hh },
		{ x: -hw, y: hh },
	].map((corner) => ({
		x: center.x + corner.x * cos - corner.y * sin,
		y: center.y + corner.x * sin + corner.y * cos,
	}));
}

function polygonObstacle(value: any, kind: 'pour' | 'keepout'): ObstacleShape | undefined {
	const polygon = polygonPoints(value);
	const bounds = polygon.length > 0 ? boundsForPoints(polygon) : boundsFromAny(value);
	if (!bounds) return undefined;
	return {
		id: idOf(value, kind),
		kind,
		layer: value?.layer,
		net: kind === 'pour' ? stringOrUndefined(value?.net ?? value?.netName) : undefined,
		primitiveId: stringOrUndefined(value?.primitiveId ?? value?.id),
		bounds,
		center: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
		polygon: polygon.length > 0 ? polygon : undefined,
		source: kind,
	};
}

// Net rows only carry rule NAMES ('Safe Spacing': 'copperThickness2oz'); the
// numbers live in the rule configuration. So values resolve only when the
// configuration is supplied: `netRules` may be the full
// getCurrentRuleConfiguration() payload ({Rule, Net}), {ruleConfig, netRules},
// or a bare getNetRules() array plus options.ruleConfig. Without it — or
// without a usable rule — the option defaults apply and *Source says why.
// Hand-made rows with explicit numeric widthMil/clearanceMil are honoured.
function normalizeNetRules(rules: any, options: ObstacleMapOptions): Record<string, NetRule> {
	const out: Record<string, NetRule> = {};
	const ruleConfig = options.ruleConfig ?? rules?.ruleConfig ?? (rules?.Rule || rules?.config ? rules : undefined);
	const rowsInput = Array.isArray(rules) ? rules : Array.isArray(rules?.netRules) ? rules.netRules : undefined;
	const rows = netRuleRows(ruleConfig, rowsInput);
	const clearance = ruleConfig ? clearanceResolverFromRules(ruleConfig, rows) : undefined;
	const noConfig = 'no rule configuration supplied (net rows hold rule names only)';
	const explicitRows = new Map<string, any>();
	for (const row of rows) {
		const name = stringOrUndefined(row?.net ?? row?.netName ?? row?.name);
		if (name && row?.type !== 'netClass') explicitRows.set(name, row);
	}

	for (const net of netsWithRules(ruleConfig, rows)) {
		const row = explicitRows.get(net);
		const width = ruleConfig ? resolveTrackWidth(ruleConfig, rows, net) : undefined;
		const spacing = clearance?.for(net);
		const spacingFromRule = !!spacing && spacing.source.startsWith('rule:');
		const rowWidth = finiteNumber(row?.widthMil);
		const rowClearance = finiteNumber(row?.clearanceMil);
		out[net] = {
			net,
			widthMil: width?.rule?.widthMil ?? rowWidth ?? options.defaultWidthMil,
			...(width?.rule?.minMil != null ? { minWidthMil: width.rule.minMil } : {}),
			...(width?.rule?.maxMil != null ? { maxWidthMil: width.rule.maxMil } : {}),
			widthSource: width?.rule?.source ?? (rowWidth != null ? 'payload:widthMil' : `default (${width?.reason ?? noConfig})`),
			clearanceMil: spacingFromRule ? spacing!.clearanceMil : rowClearance ?? options.defaultClearanceMil,
			...(spacingFromRule && spacing!.byKind ? { clearanceByKind: spacing!.byKind } : {}),
			clearanceSource: spacingFromRule
				? spacing!.source
				: rowClearance != null ? 'payload:clearanceMil' : `default (${clearance?.summary.fallbackReason ?? noConfig})`,
		};
	}
	return out;
}

function countByKind(obstacles: ObstacleShape[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const obstacle of obstacles) out[obstacle.kind] = (out[obstacle.kind] ?? 0) + 1;
	return out;
}

function binsForBounds(bounds: Bounds, size: number): string[] {
	const minC = Math.floor(bounds.minX / size);
	const maxC = Math.floor(bounds.maxX / size);
	const minR = Math.floor(bounds.minY / size);
	const maxR = Math.floor(bounds.maxY / size);
	const out: string[] = [];
	for (let c = minC; c <= maxC; c++) for (let r = minR; r <= maxR; r++) out.push(`${c},${r}`);
	return out;
}

function layerKeyFor(shape: ObstacleShape): string {
	if (shape.kind === 'via') return 'multi';
	if (shape.layer == null) return 'unknown';
	return String(shape.layer);
}

function idOf(value: any, prefix: string): string {
	return stringOrUndefined(value?.primitiveId ?? value?.id ?? value?.uuid) ?? `${prefix}_${++generatedId}`;
}

// Pads are never given a synthetic id: a pad the board cannot name is not a
// pad we can report on. Real primitive ids win, then designator.padNumber.
function padIdOf(pad: any, reference: string | undefined, padNumber: string | undefined): string | undefined {
	const primitiveId = stringOrUndefined(pad?.primitiveId ?? pad?.id ?? pad?.uuid);
	if (primitiveId) return primitiveId;
	if (reference && padNumber) return `${reference}.${padNumber}`;
	return undefined;
}

function pointFrom(value: any, xKey = 'x', yKey = 'y'): Point | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const x = finiteNumber(value[xKey] ?? value.centerX);
	const y = finiteNumber(value[yKey] ?? value.centerY);
	return x != null && y != null ? { x, y } : undefined;
}

function polygonPoints(value: any): Point[] {
	const source = value?.source ?? value?.sourcePolygon ?? value?.complexPolygon ?? value?.polygon ?? value?.points;
	if (!source) return [];
	if (Array.isArray(source)) {
		if (source.length >= 7 && String(source[0]).toUpperCase() === 'R') {
			const left = finiteNumber(source[1]);
			const top = finiteNumber(source[2]);
			const width = finiteNumber(source[3]);
			const height = finiteNumber(source[4]);
			if (left != null && top != null && width != null && height != null) {
				return [
					{ x: left, y: top },
					{ x: left + width, y: top },
					{ x: left + width, y: top + height },
					{ x: left, y: top + height },
				];
			}
		}
		if (source.length > 0 && typeof source[0] === 'object') {
			return source
				.map((p) => ({ x: finiteNumber(p?.x), y: finiteNumber(p?.y) }))
				.filter((p): p is Point => p.x != null && p.y != null);
		}
		const nums = source.filter((v) => typeof v === 'number').map(Number);
		const out: Point[] = [];
		for (let i = 0; i + 1 < nums.length; i += 2) out.push({ x: nums[i], y: nums[i + 1] });
		return out;
	}
	if (Array.isArray(source?.points)) return polygonPoints({ source: source.points });
	return [];
}

function boundsFromAny(value: any): Bounds | undefined {
	if (!value || typeof value !== 'object') return undefined;
	if ([value.minX, value.minY, value.maxX, value.maxY].every((v) => finiteNumber(v) != null)) {
		return normalizeBounds(Number(value.minX), Number(value.minY), Number(value.maxX), Number(value.maxY));
	}
	if ([value.left, value.top, value.right, value.bottom].every((v) => finiteNumber(v) != null)) {
		return normalizeBounds(Number(value.left), Number(value.top), Number(value.right), Number(value.bottom));
	}
	if (value.bounds) return boundsFromAny(value.bounds);
	if (value.summary?.bbox) return boundsFromAny(value.summary.bbox);
	return undefined;
}

function outlinePolylineBounds(boardOutline: any): Bounds | undefined {
	const corners: Point[] = [];
	for (const polyline of arrayOf(boardOutline?.polylines)) {
		const bounds = boundsFromAny(polyline);
		if (!bounds) continue;
		corners.push({ x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.maxY });
	}
	return boundsForPoints(corners);
}

function boundsForPoints(points: Point[]): Bounds | undefined {
	const finite = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
	if (finite.length === 0) return undefined;
	let minX = finite[0].x;
	let maxX = finite[0].x;
	let minY = finite[0].y;
	let maxY = finite[0].y;
	for (const p of finite.slice(1)) {
		minX = Math.min(minX, p.x);
		maxX = Math.max(maxX, p.x);
		minY = Math.min(minY, p.y);
		maxY = Math.max(maxY, p.y);
	}
	return normalizeBounds(minX, minY, maxX, maxY);
}

function boundsAround(center: Point, radiusMil: number): Bounds {
	return normalizeBounds(center.x - radiusMil, center.y - radiusMil, center.x + radiusMil, center.y + radiusMil);
}

function expandBounds(bounds: Bounds, amount: number): Bounds {
	return normalizeBounds(bounds.minX - amount, bounds.minY - amount, bounds.maxX + amount, bounds.maxY + amount);
}

function normalizeBounds(x1: number, y1: number, x2: number, y2: number): Bounds {
	const minX = Math.min(x1, x2);
	const maxX = Math.max(x1, x2);
	const minY = Math.min(y1, y2);
	const maxY = Math.max(y1, y2);
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function looksLikeKeepout(region: any): boolean {
	const hay = JSON.stringify({
		ruleType: region?.ruleType,
		regionName: region?.regionName,
		name: region?.name,
		type: region?.type,
	}).toLowerCase();
	return /keep\s*out|keepout|no[\s_-]*(route|copper|track|via)|forbid|prohibit|restrict/.test(hay)
		|| hasNumericKeepoutRule(region);
}

function hasNumericKeepoutRule(region: any): boolean {
	const raw = Array.isArray(region?.ruleType) ? region.ruleType : [];
	// EasyEDA EPCB_PrimitiveRegionRuleType: 3=NO_VIAS, 5=NO_WIRES,
	// 6=NO_FILLS, 7=NO_POURS, 8=NO_INNER_ELECTRICAL_LAYERS.
	return raw.some((v: any) => [3, 5, 6, 7, 8].includes(Number(v)));
}

function finiteNumber(value: any): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function stringOrUndefined(value: any): string | undefined {
	if (value === undefined || value === null) return undefined;
	const s = String(value).trim();
	return s ? s : undefined;
}

function arrayOf(value: any): any[] {
	return Array.isArray(value) ? value : [];
}

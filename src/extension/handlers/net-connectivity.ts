// Real per-net connectivity: which pads are actually joined by copper.
//
// pcb_connectivity_status used to call a net "routed" when it had ANY track or
// via — a single dangling stub qualified, so floating pads were reported as
// done. This builds the copper graph of each net (pads as their real rotated
// shapes, tracks and arc chords as width-aware segments, vias as discs, drilled
// pads on every layer) and unions everything that touches. Pour copper is NOT
// traced here: nets whose pads are joined only through a pour are reported as
// "pour_dependent", never as connected.

import { flattenStateArray, normalizeLayer } from './_utils';
import { layersTouch, padToObstacle, pointToSegmentDistance, polygonHit, segmentDistance } from './trace-obstacles';

export type ConnectivityStatus = 'connected' | 'incomplete' | 'pour_dependent' | 'unrouted' | 'single_pad';

export interface NetConnectivity {
	net: string;
	status: ConnectivityStatus;
	pads: number;
	tracks: number;
	vias: number;
	pours: number;
	/** Pad groups joined by tracks/vias, when more than one (the open connections). */
	padGroups?: string[][];
	/** Copper groups (tracks/vias) touching no pad at all: dangling stubs / floating copper. */
	floatingCopper: number;
	/** detail mode: every copper group with its pad labels and primitive ids. */
	groups?: Array<{ pads: string[]; ids: string[] }>;
}

export interface ConnectivityInput {
	componentPads: any[];
	standalonePads: any[];
	lines: any[];
	arcs?: any[];
	vias: any[];
	pours: any[];
}

const EPS = 0.01; // mil — touching copper, not "near" copper

interface Item {
	kind: 'pad' | 'track' | 'via';
	label?: string;
	id?: string;
	layer?: unknown;
	// pad
	polygon?: Array<{ x: number; y: number }>;
	bounds?: { minX: number; minY: number; maxX: number; maxY: number };
	// track
	a?: { x: number; y: number };
	b?: { x: number; y: number };
	half?: number;
	// via
	c?: { x: number; y: number };
	r?: number;
}

export function analyzeConnectivity(input: ConnectivityInput, onlyNets?: string[], detail = false): NetConnectivity[] {
	const byNet = new Map<string, Item[]>();
	const want = onlyNets?.length ? new Set(onlyNets) : undefined;
	const add = (net: unknown, item: Item) => {
		if (net == null || net === '') return;
		const key = String(net);
		if (want && !want.has(key)) return;
		if (!byNet.has(key)) byNet.set(key, []);
		byNet.get(key)!.push(item);
	};

	const componentPadIds = new Set(input.componentPads.map((p) => p?.primitiveId).filter(Boolean));
	for (const pad of input.componentPads) {
		const o = padToObstacle(pad, 'component_pad');
		if (o) add(pad.net, { kind: 'pad', label: pad.label ?? o.primitiveId, id: o.primitiveId, layer: o.layer, polygon: o.polygon, bounds: o.bounds });
	}
	for (const pad of input.standalonePads) {
		// Same pad, already counted. getSnapshot no longer repeats component pads
		// here; hand-built and older snapshots still may.
		if (pad?.primitiveId && componentPadIds.has(pad.primitiveId)) continue;
		const o = padToObstacle(pad, 'pad');
		if (o) add(pad.net, { kind: 'pad', label: pad.padNumber ? `${pad.primitiveId}(${pad.padNumber})` : pad.primitiveId, id: o.primitiveId, layer: o.layer, polygon: o.polygon, bounds: o.bounds });
	}
	const segment = (s: any) => ({ a: { x: Number(s.startX), y: Number(s.startY) }, b: { x: Number(s.endX), y: Number(s.endY) } });
	for (const line of [...input.lines, ...(input.arcs ?? [])]) {
		const { a, b } = segment(line);
		if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
		add(line.net, { kind: 'track', id: line.primitiveId, layer: line.layer, a, b, half: Number(line.lineWidth ?? 10) / 2 });
	}
	for (const via of input.vias) {
		const c = { x: Number(via.x), y: Number(via.y) };
		if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
		add(via.net, { kind: 'via', id: via.primitiveId, c, r: Number(via.diameter ?? 24) / 2 });
	}
	const poursByNet = new Map<string, number>();
	for (const pour of input.pours) if (pour?.net) poursByNet.set(String(pour.net), (poursByNet.get(String(pour.net)) ?? 0) + 1);

	const out: NetConnectivity[] = [];
	const nets = new Set<string>([...byNet.keys(), ...(want ? [...want] : [])]);
	for (const net of nets) {
		const items = byNet.get(net) ?? [];
		const parent = items.map((_, i) => i);
		const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
		for (let i = 0; i < items.length; i++) {
			for (let j = i + 1; j < items.length; j++) {
				if (find(i) !== find(j) && touches(items[i], items[j])) parent[find(i)] = find(j);
			}
		}
		const groups = new Map<number, Item[]>();
		items.forEach((item, i) => {
			const root = find(i);
			if (!groups.has(root)) groups.set(root, []);
			groups.get(root)!.push(item);
		});
		const padGroups = [...groups.values()].filter((g) => g.some((it) => it.kind === 'pad')).map((g) => g.filter((it) => it.kind === 'pad').map((it) => String(it.label)));
		const floatingCopper = [...groups.values()].filter((g) => !g.some((it) => it.kind === 'pad')).length;
		const pads = items.filter((it) => it.kind === 'pad').length;
		const tracks = items.filter((it) => it.kind === 'track').length;
		const vias = items.filter((it) => it.kind === 'via').length;
		const pours = poursByNet.get(net) ?? 0;

		let status: ConnectivityStatus;
		if (pads <= 1) status = 'single_pad';
		else if (padGroups.length === 1) status = 'connected';
		else if (pours > 0) status = 'pour_dependent';
		else if (tracks > 0 || vias > 0) status = 'incomplete';
		else status = 'unrouted';

		out.push({
			net,
			status,
			pads,
			tracks,
			vias,
			pours,
			padGroups: padGroups.length > 1 ? padGroups.map((g) => g.slice(0, 12)) : undefined,
			floatingCopper,
			groups: detail ? [...groups.values()].map((g) => ({ pads: g.filter((it) => it.kind === 'pad').map((it) => String(it.label)), ids: g.map((it) => it.id).filter((id): id is string => !!id) })) : undefined,
		});
	}
	return out;
}

function touches(p: Item, q: Item): boolean {
	if (p.kind === 'via' || q.kind === 'via') {
		// Through vias are copper on every layer.
		const [v, o] = p.kind === 'via' ? [p, q] : [q, p];
		if (o.kind === 'via') return Math.hypot(v.c!.x - o.c!.x, v.c!.y - o.c!.y) <= v.r! + o.r! + EPS;
		if (o.kind === 'track') return pointToSegmentDistance(v.c!, o.a!, o.b!) <= v.r! + o.half! + EPS;
		return !!polygonHit(v.c!, v.c!, o.polygon, o.bounds!, v.r!, EPS);
	}
	if (!layersTouch(p.layer, q.layer)) return false;
	if (p.kind === 'track' && q.kind === 'track') return segmentDistance(p.a!, p.b!, q.a!, q.b!) <= p.half! + q.half! + EPS;
	if (p.kind === 'pad' && q.kind === 'pad') {
		const a = p.polygon!, b = q.polygon!;
		return a.some((pt) => !!polygonHit(pt, pt, b, q.bounds!, 0, EPS)) || b.some((pt) => !!polygonHit(pt, pt, a, p.bounds!, 0, EPS));
	}
	const [t, pad] = p.kind === 'track' ? [p, q] : [q, p];
	return !!polygonHit(t.a!, t.b!, pad.polygon, pad.bounds!, t.half!, EPS);
}

/** Arc tracks (not in the board snapshot), as chords for connectivity. */
export async function fetchArcs(): Promise<any[]> {
	const raw = await eda.pcb_PrimitiveArc.getAll(undefined, undefined, undefined).catch(() => []);
	return flattenStateArray((raw as any[]) || []).map((a: any) => ({
		primitiveId: a.primitiveId, net: a.net, layer: normalizeLayer(a.layer),
		startX: Number(a.startX), startY: Number(a.startY), endX: Number(a.endX), endY: Number(a.endY), lineWidth: Number(a.lineWidth),
	}));
}

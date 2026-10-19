// Split planes: several pours on ONE copper layer with different nets (e.g.
// +3V3 on the left, GND on the right). EasyEDA supports any number of pours per
// layer; where outlines overlap, pour priority decides which pour keeps the
// copper and the other clears around it by the clearance rule.
//
//   pcb.splitPour.plan   (READ)  geometry + pad/via coverage checks, nothing written
//   pcb.splitPour.create (WRITE) same checks, then transactional create (rolled back
//                                on any failure), EasyEDA's own copper rebuild, and a
//                                read-back of the copper each pour actually got
//
// Coordinates: every polygon in and out is API mil, canvas convention (Y grows
// upward, negative below the origin — the pad/track getter space). That is what
// pour-fill's board-outline pours feed pcb_PrimitivePour.create; the created
// pour's source comes back in data space (positive-down, data origin), so it is
// mapped through the runtime's own data→canvas affine to prove the pour landed
// where it was asked to. If it landed exactly at the raw numbers instead, the
// create consumed data space on this build: the pour is recreated in data space.
//
// PLANE (inner electrical) layers are refused: EasyEDA cannot draw copper regions
// on them and the SDK has no plane-zone primitive — convert the layer to SIGNAL.

import { didTimeOut, normalizeLayer, normalizePolygon, readWithTimeout } from './_utils';
import { getSnapshot, invalidateBoardSnapshotCache } from './board-context';
import { resolveNativePcbTab, type NativePcbTab } from './native-copper';
import { COORDINATE_SPACE, pourFillHandlers, readPourSource, resolveCanvasTransform, summarizePolygonSource, type PolygonTransform } from './pour-fill';
import { padToObstacle, pointInPolygon, pointToSegmentDistance, resolveClearance, segmentDistance } from './trace-obstacles';

type Point = { x: number; y: number };
type BBox = { minX: number; minY: number; maxX: number; maxY: number };
type Snap = Awaited<ReturnType<typeof getSnapshot>>;
type Issue = { code: string; severity: 'error' | 'warning'; message: string; region?: number; regions?: number[]; items?: unknown[] };
type Terminal = { kind: 'pad' | 'via'; label: string; net?: string; x: number; y: number; drilled: boolean };
type Region = {
	index: number;
	net: string;
	name: string;
	priority?: number;
	fillMethod?: string;
	preserveSilos?: boolean;
	lineWidth?: number;
	origin: 'polygon' | 'rect' | 'split';
	points: Point[];
	bbox: BBox;
	area: number;
	outline?: 'inside' | 'partial' | 'outside' | 'unchecked';
	own: Terminal[];
	foreign: Terminal[];
	otherNets: number;
};
type ExistingPour = { pourId: string; net?: string; name?: string; priority?: number; locked: boolean; bbox?: BBox; overlapsRegions?: number[] };
type Outline = { points?: Point[]; bbox?: BBox; source: string; approximate?: string };
type Plan = {
	layer?: number;
	layerName?: string;
	layerType?: string;
	transform: PolygonTransform;
	gapMil: number;
	gapSource: string;
	outline: Outline;
	regions: Region[];
	nets: Record<string, { onLayer: number; served: number; unserved: number; unservedSample?: string[] }>;
	existing: ExistingPour[];
	replace: ExistingPour[];
	issues: Issue[];
	notes: string[];
};
type CreatedPour = {
	pourId: string;
	region: number;
	net: string;
	name: string;
	space: 'canvas' | 'data';
	outlineCheck?: 'verified' | 'unverified';
	readBackBBox?: BBox;
	priority?: number;
	priorityApplied?: boolean;
};
type Island = { fillId: string; rings: Point[][] };

const OUTLINE_LAYER = 11;
const MULTI_LAYER = 12;
const EPS = 1e-6;
const OUTLINE_TOLERANCE_MIL = 0.5;
const ARC_STEP_DEG = 10;
const BBOX_MATCH_TOL_MIL = 2;
const COPPER_FIT_TOL_MIL = 5;
const SDK_READ_MS = 8_000;
const COPPER_SOURCE_MS = 15_000;
const DEFAULT_BUDGET_MS = 120_000;
const DEADLINE_MARGIN_MS = 5_000;
const CREATE_MAX_MS = 60_000;
const MIN_CREATE_MS = 8_000;
const MIN_REBUILD_MS = 20_000;
const ROLLBACK_RESERVE_MS = 4_000;
const SAMPLE = 12;
const MAX_POINTS_ECHO = 64;
const FILL_METHODS = new Set(['solid', '45grid', '90grid']);

const IDENTITY: PolygonTransform = { coordinateSpace: 'data-space-untransformed', resolved: false, x: (v) => v, y: (v) => v };

export const splitPourHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.splitPour.plan': async (params) => respond('dry-run', await buildPlan(params, false)),
	'pcb.splitPour.create': async (params) => commitSplit(params),
};

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function buildPlan(params: Record<string, any>, fresh: boolean): Promise<Plan> {
	const issues: Issue[] = [];
	const notes: string[] = [];
	const transform = await resolveCanvasTransform();
	const plan: Plan = { transform, gapMil: 0, gapSource: '', outline: { source: 'none' }, regions: [], nets: {}, existing: [], replace: [], issues, notes };

	try {
		const id = params.layer == null ? undefined : Number(normalizeLayer(params.layer));
		if (id == null || !Number.isFinite(id)) throw new Error('`layer` is required (e.g. "TopLayer", "BottomLayer", "Inner1", or a layer id).');
		plan.layer = id;
	} catch (err: any) {
		issues.push({ code: 'LAYER_UNKNOWN', severity: 'error', message: err?.message ?? String(err) });
	}
	if (plan.layer != null && !isCopperLayer(plan.layer)) {
		issues.push({ code: 'LAYER_NOT_COPPER', severity: 'error', message: `Layer ${params.layer} (${plan.layer}) is not a copper layer. Pours go on TopLayer(1), BottomLayer(2) or Inner1..Inner30 (15..44).` });
	}

	const snapshot = await getSnapshot({ forceRefresh: fresh });
	const layerItem = (snapshot.layers || []).find((l: any) => Number(l?.id) === plan.layer);
	plan.layerName = layerItem?.name != null ? String(layerItem.name) : undefined;
	plan.layerType = layerItem?.type != null ? String(layerItem.type) : undefined;
	if (plan.layerType === 'PLANE') {
		issues.push({
			code: 'LAYER_IS_PLANE',
			severity: 'error',
			message: `${plan.layerName ?? `Layer ${plan.layer}`} is a PLANE (inner electrical) layer. EasyEDA cannot draw copper regions on a PLANE layer and the SDK exposes no plane-zone/split-line primitive, so it cannot be split from here. ` +
				'Convert it to a SIGNAL layer first (pcb_set_inner_layer_type {layer, type:"SIGNAL", dryRun:false}) and rerun, or split the plane in the EasyEDA GUI.',
		});
	}

	plan.outline = await readBoardOutline(snapshot, transform);

	// Region specs and their nets come first: the default gap depends on the nets.
	const split = params.split;
	const specs: any[] = Array.isArray(params.regions) ? params.regions : [];
	if (split && specs.length) issues.push({ code: 'BAD_INPUT', severity: 'error', message: 'Give either `regions` or `split`, not both.' });
	if (!split && !specs.length) issues.push({ code: 'BAD_INPUT', severity: 'error', message: 'Give `regions` [{net, polygon|rect}] or `split` {axis, at, nets:[low, high]}.' });
	const splitNets: string[] = Array.isArray(split?.nets) ? split.nets.map((n: any) => String(n ?? '').trim()) : [];
	if (split && (splitNets.length !== 2 || splitNets.some((n) => !n))) issues.push({ code: 'BAD_INPUT', severity: 'error', message: 'split.nets must be two net names: [net below `at`, net above `at`].' });
	const planNets = unique(split ? splitNets.filter(Boolean) : specs.map((s) => String(s?.net ?? '').trim()).filter(Boolean));

	const explicitGap = Number(params.gapMil);
	if (params.gapMil != null && Number.isFinite(explicitGap) && explicitGap >= 0) {
		plan.gapMil = explicitGap;
		plan.gapSource = 'param:gapMil';
	} else {
		const resolver = await resolveClearance(planNets, {});
		let best = { mil: -1, source: '' };
		for (const net of planNets.length ? planNets : [undefined as any]) {
			const rule = resolver.for(net);
			if (rule.clearanceMil > best.mil) best = { mil: rule.clearanceMil, source: `${rule.source}${net ? ` (net ${net})` : ''}` };
		}
		plan.gapMil = Math.max(0, best.mil);
		plan.gapSource = best.source || 'default';
	}

	const defaults = { fillMethod: params.fillMethod, preserveSilos: params.preserveSilos, lineWidth: params.lineWidth };
	const layerLabel = plan.layerName?.replace(/\s+/g, '') ?? `L${plan.layer ?? '?'}`;
	const nameFor = (net: string, i: number, given?: any) => (given != null && String(given).trim() ? String(given) : `${net}_split_${layerLabel}_${i + 1}`);

	if (split && splitNets.length === 2 && splitNets.every(Boolean)) {
		const axis = split.axis === 'y' ? 'y' : split.axis === 'x' ? 'x' : undefined;
		const at = Number(split.at);
		if (!axis || !Number.isFinite(at)) {
			issues.push({ code: 'BAD_INPUT', severity: 'error', message: 'split needs axis "x"|"y" and a finite `at` (mil).' });
		} else if (!plan.outline.points) {
			issues.push({ code: 'NO_BOARD_OUTLINE', severity: 'error', message: 'split cuts the board outline, but no closed BoardOutline (layer 11) was found. Draw the outline or pass explicit `regions`.' });
		} else {
			const half = plan.gapMil / 2;
			const sides: Array<{ net: string; points: Point[] }> = [
				{ net: splitNets[0], points: clipHalfPlane(plan.outline.points, axis, at - half, true) },
				{ net: splitNets[1], points: clipHalfPlane(plan.outline.points, axis, at + half, false) },
			];
			const prios: any[] = Array.isArray(split.priorities) ? split.priorities : [];
			const names: any[] = Array.isArray(split.names) ? split.names : [];
			sides.forEach((side, i) => {
				if (side.points.length < 3 || Math.abs(ringArea(side.points)) < 1) {
					issues.push({ code: 'SPLIT_OUTSIDE_BOARD', severity: 'error', region: i, message: `split ${axis}=${at} leaves no board area for ${side.net} (board ${axis} range ${fmtRange(plan.outline.bbox, axis)}).` });
					return;
				}
				plan.regions.push(makeRegion(i, side.net, nameFor(side.net, i, names[i]), prios[i], defaults, 'split', side.points));
			});
			if (plan.outline.approximate) notes.push(`Split regions follow an approximate outline (${plan.outline.approximate}).`);
		}
	} else {
		specs.forEach((spec, i) => {
			const net = String(spec?.net ?? '').trim();
			if (!net) { issues.push({ code: 'REGION_INVALID', severity: 'error', region: i, message: `regions[${i}] has no net.` }); return; }
			try {
				const { points, origin } = regionPoints(spec);
				plan.regions.push(makeRegion(i, net, nameFor(net, i, spec?.name), spec?.priority, { ...defaults, ...pickDefined(spec, ['fillMethod', 'preserveSilos', 'lineWidth']) }, origin, points));
			} catch (err: any) {
				issues.push({ code: 'REGION_INVALID', severity: 'error', region: i, message: `regions[${i}] (${net}): ${err?.message ?? String(err)}` });
			}
		});
	}

	for (const r of plan.regions) {
		if (r.fillMethod != null && !FILL_METHODS.has(r.fillMethod)) issues.push({ code: 'REGION_INVALID', severity: 'error', region: r.index, message: `fillMethod "${r.fillMethod}" — use solid | 45grid | 90grid.` });
		if (r.priority != null && !Number.isFinite(r.priority)) issues.push({ code: 'REGION_INVALID', severity: 'error', region: r.index, message: 'priority must be a number.' });
		if (r.points.length < 3 || Math.abs(r.area) < 1) { issues.push({ code: 'REGION_INVALID', severity: 'error', region: r.index, message: `${r.net} region has no area.` }); continue; }
		if (selfIntersects(r.points)) issues.push({ code: 'REGION_SELF_INTERSECTS', severity: 'error', region: r.index, message: `${r.net} region outline crosses itself; EasyEDA rejects or mis-fills such pours.` });
		if (!snapshot.nets.includes(r.net)) issues.push({ code: 'NET_NOT_ON_BOARD', severity: 'warning', region: r.index, message: `Net ${r.net} is not on this board: the whole pour would be unconnected (dead) copper.` });
		r.outline = plan.outline.points ? outlineRelation(r.points, plan.outline.points) : 'unchecked';
		if (r.outline === 'outside') issues.push({ code: 'REGION_OFF_BOARD', severity: 'error', region: r.index, message: `${r.net} region lies entirely outside the board outline.` });
		else if (r.outline === 'partial') issues.push({ code: 'REGION_EXCEEDS_OUTLINE', severity: 'warning', region: r.index, message: `${r.net} region extends past the board outline; EasyEDA clips pour copper at the board edge, so only the on-board part gets copper.` });
	}
	if (!plan.outline.points && !split) issues.push({ code: 'NO_BOARD_OUTLINE', severity: 'warning', message: 'No closed BoardOutline found: regions were not checked against the board edge.' });

	checkPairs(plan);
	checkCoverage(plan, snapshot, planNets);
	await checkExisting(plan, params);
	return plan;
}

function makeRegion(index: number, net: string, name: string, priority: any, d: Record<string, any>, origin: Region['origin'], points: Point[]): Region {
	return {
		index,
		net,
		name,
		priority: priority == null || priority === '' ? undefined : Number(priority),
		fillMethod: d.fillMethod != null ? String(d.fillMethod) : undefined,
		preserveSilos: d.preserveSilos != null ? !!d.preserveSilos : undefined,
		lineWidth: Number.isFinite(Number(d.lineWidth)) && d.lineWidth != null ? Number(d.lineWidth) : undefined,
		origin,
		points,
		bbox: bboxOf(points)!,
		area: Math.abs(ringArea(points)),
		own: [],
		foreign: [],
		otherNets: 0,
	};
}

/** Different nets: separated by ≥ gapMil, or overlap resolved by explicit distinct priorities. */
function checkPairs(plan: Plan): void {
	const rs = plan.regions.filter((r) => r.points.length >= 3);
	for (let i = 0; i < rs.length; i++) {
		for (let j = i + 1; j < rs.length; j++) {
			const a = rs[i];
			const b = rs[j];
			const d = ringDistance(a.points, b.points);
			const nested = d > EPS && (pointInPolygon(a.points[0], b.points) || pointInPolygon(b.points[0], a.points));
			const touching = d <= EPS || nested;
			const pair = [a.index, b.index];
			const dist = round2(nested ? 0 : d);
			if (a.net === b.net) {
				if (touching || d < plan.gapMil) plan.issues.push({ code: 'SAME_NET_REGIONS_MERGE', severity: 'warning', regions: pair, message: `Regions ${a.index} and ${b.index} are both ${a.net} and touch/overlap: their copper merges (one polygon would be simpler).` });
				continue;
			}
			if (!touching && d >= plan.gapMil - EPS) continue;
			const prioritized = a.priority != null && b.priority != null && a.priority !== b.priority;
			const what = nested ? `${a.net} region ${a.index} and ${b.net} region ${b.index} are nested` : touching ? `${a.net} region ${a.index} and ${b.net} region ${b.index} touch or overlap` : `${a.net} region ${a.index} and ${b.net} region ${b.index} are ${dist} mil apart (gap ${round2(plan.gapMil)} mil required, ${plan.gapSource})`;
			if (prioritized) {
				plan.issues.push({
					code: 'OVERLAP_RESOLVED_BY_PRIORITY',
					severity: 'warning',
					regions: pair,
					message: `${what}; priorities ${a.priority} vs ${b.priority} decide it: the higher-priority pour is poured first and the other clears around its copper by the clearance rule. The committed read-back shows which pour got the copper.`,
				});
			} else {
				plan.issues.push({
					code: touching ? 'REGIONS_OVERLAP' : 'GAP_TOO_SMALL',
					severity: 'error',
					regions: pair,
					message: `${what}. Separate them by at least gapMil, or give both explicit, different priorities if the overlap is intended (e.g. a +3V3 island inside a GND pour).`,
				});
			}
		}
	}
}

/** Which pads/vias each region serves, and which sit in another plan net's region. */
function checkCoverage(plan: Plan, snapshot: Snap, planNets: string[]): void {
	if (plan.layer == null) return;
	const terminals = collectTerminals(snapshot, plan.layer);
	const nets = new Set(planNets);
	const inside = new Map<Terminal, Region[]>();
	for (const t of terminals) inside.set(t, plan.regions.filter((r) => r.points.length >= 3 && pointInPolygon(t, r.points)));
	for (const r of plan.regions) {
		for (const t of terminals) {
			if (!inside.get(t)!.includes(r)) continue;
			if (t.net === r.net) r.own.push(t);
			else if (t.net && nets.has(t.net) && !inside.get(t)!.some((o) => o.net === t.net)) r.foreign.push(t);
			else r.otherNets++;
		}
		if (r.foreign.length) {
			plan.issues.push({
				code: 'PAD_IN_FOREIGN_REGION',
				severity: 'warning',
				region: r.index,
				message: `${r.foreign.length} pad/via of ${unique(r.foreign.map((t) => t.net!)).join(', ')} sit inside the ${r.net} region: the ${r.net} pour clears around them, so their own pour cannot reach them — route them with a track/via or move the split.`,
				items: r.foreign.slice(0, SAMPLE).map((t) => ({ label: t.label, net: t.net, x: round2(t.x), y: round2(t.y) })),
			});
		}
		if (r.points.length >= 3 && r.own.length === 0) {
			plan.issues.push({
				code: 'REGION_HAS_NO_OWN_TERMINALS',
				severity: 'warning',
				region: r.index,
				message: `No ${r.net} pad or via lies in this region on this layer: its copper would be an unconnected island — ${r.preserveSilos ? 'kept as floating copper (preserveSilos)' : 'removed by EasyEDA as dead copper'}. Add a via of ${r.net} or drop the region.`,
			});
		}
	}
	for (const net of planNets) {
		const onLayer = terminals.filter((t) => t.net === net);
		const unserved = onLayer.filter((t) => !inside.get(t)!.some((r) => r.net === net));
		plan.nets[net] = {
			onLayer: onLayer.length,
			served: onLayer.length - unserved.length,
			unserved: unserved.length,
			unservedSample: unserved.length ? unserved.slice(0, SAMPLE).map((t) => t.label) : undefined,
		};
	}
}

/** Pads/vias that have copper on `layer`: SMD pads on that layer, drilled pads and (through) vias everywhere. */
function collectTerminals(snapshot: Snap, layer: number): Terminal[] {
	const out: Terminal[] = [];
	const add = (raw: any, ob: ReturnType<typeof padToObstacle>, label: string) => {
		if (!ob) return;
		const lay = Number(ob.layer);
		if (!(ob.drilled || lay === MULTI_LAYER || lay === layer)) return;
		out.push({ kind: 'pad', label, net: ob.net ?? raw?.net, x: ob.center.x, y: ob.center.y, drilled: ob.drilled || lay === MULTI_LAYER });
	};
	for (const p of snapshot.componentPads) add(p, padToObstacle(p, 'component_pad', p.componentPrimitiveId, p.reference), p.label ?? String(p.primitiveId ?? '?'));
	for (const p of snapshot.standalonePads) add(p, padToObstacle(p, 'pad'), `pad:${p.primitiveId ?? '?'}`);
	for (const v of snapshot.vias) {
		const x = Number(v.x);
		const y = Number(v.y);
		if (Number.isFinite(x) && Number.isFinite(y)) out.push({ kind: 'via', label: `via:${v.primitiveId ?? '?'}`, net: v.net, x, y, drilled: true });
	}
	return out;
}

async function checkExisting(plan: Plan, params: Record<string, any>): Promise<void> {
	if (plan.layer == null) return;
	const listed = await safeRead(() => eda.pcb_PrimitivePour.getAll(undefined, plan.layer as any, undefined));
	if (listed === undefined) {
		plan.issues.push({ code: 'EXISTING_POURS_UNREAD', severity: 'warning', message: `Existing pours on layer ${plan.layer} could not be listed within ${SDK_READ_MS} ms.` });
		return;
	}
	for (const p of listed) {
		const summary = summarizePolygonSource(readPourSource(p), plan.transform);
		const e: ExistingPour = {
			pourId: idOf(p),
			net: stateOf(p, 'Net', 'net'),
			name: stateOf(p, 'PourName', 'pourName'),
			priority: stateOf(p, 'PourPriority', 'pourPriority'),
			locked: stateOf(p, 'PrimitiveLock', 'primitiveLock') === true,
			bbox: plan.transform.resolved ? summary?.bbox : undefined,
		};
		if (e.bbox) {
			const hits = plan.regions.filter((r) => bboxesOverlap(r.bbox, e.bbox!)).map((r) => r.index);
			if (hits.length) e.overlapsRegions = hits;
		}
		plan.existing.push(e);
	}
	if (params.replaceExisting === true) {
		plan.replace = plan.existing.slice();
		const locked = plan.replace.filter((e) => e.locked);
		if (locked.length && params.force !== true) {
			plan.issues.push({ code: 'EXISTING_POUR_LOCKED', severity: 'error', message: `replaceExisting would delete locked pour(s) ${locked.map((e) => e.pourId).join(', ')}; pass force:true to unlock and replace them.` });
		}
		if (plan.replace.length) plan.notes.push(`replaceExisting: ${plan.replace.length} existing pour(s) on this layer are deleted after the new pours are created and verified. Deleted pours are not restorable by this tool (Ctrl+Z in EasyEDA).`);
		return;
	}
	const overlapping = plan.existing.filter((e) => e.overlapsRegions?.length);
	if (overlapping.length) {
		plan.issues.push({
			code: 'EXISTING_POUR_OVERLAPS',
			severity: 'warning',
			message: `${overlapping.length} existing pour(s) on this layer overlap the new regions; they are kept and rebuilt with the new ones, and pour priority decides who gets the copper. Pass replaceExisting:true to replace them instead.`,
			items: overlapping.slice(0, SAMPLE).map((e) => ({ pourId: e.pourId, net: e.net, priority: e.priority, regions: e.overlapsRegions })),
		});
	}
	if (!plan.transform.resolved && plan.existing.length) plan.notes.push('Canvas origin unreadable: overlap with existing pours was not checked.');
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

async function commitSplit(params: Record<string, any>): Promise<any> {
	const deadline = deadlineOf(params);
	const plan = await buildPlan(params, true);
	if (plan.issues.some((i) => i.severity === 'error')) return respond('invalid', plan);
	if (params.dryRun === true) return respond('dry-run', plan);
	const layer = plan.layer!;
	const beforeIds = new Set(plan.existing.map((e) => e.pourId));
	const names = new Set(plan.regions.map((r) => r.name));
	const created: CreatedPour[] = [];
	let space: 'canvas' | 'data' = 'canvas';

	const rollback = async (code: string, message: string, deletedExisting: string[] = []) => {
		const rb = await rollbackCreated(created, layer, names, beforeIds);
		plan.issues.push({ code, severity: 'error', message });
		if (deletedExisting.length) plan.notes.push(`Existing pour(s) ${deletedExisting.join(', ')} were already deleted and are not restored by the rollback (Ctrl+Z in EasyEDA).`);
		invalidateBoardSnapshotCache();
		return respond('rolled-back', plan, { created, deleted: deletedExisting, rolledBack: { reason: code, ...rb } });
	};

	for (const r of plan.regions) {
		const budget = deadline - Date.now() - ROLLBACK_RESERVE_MS;
		if (budget < MIN_CREATE_MS) return rollback('DEADLINE', `Not enough time left to create ${r.net} region ${r.index} (${Math.max(0, Math.round(budget / 1000))} s). Retry with a larger _timeoutMs.`);
		let made = await createOne(r, layer, space, plan.transform, Math.min(CREATE_MAX_MS, budget));
		if (!made.pourId) return rollback('CREATE_FAILED', `Creating the ${r.net} pour (region ${r.index}) failed: ${made.error}`);
		let entry: CreatedPour = { pourId: made.pourId, region: r.index, net: r.net, name: r.name, space, priority: r.priority };
		created.push(entry);
		let check = outlineCheck(await readPour(made.pourId), r, plan.transform);
		if (check.status === 'mismatch' && check.rawMatches && space === 'canvas') {
			// This build stored our numbers verbatim as data space: redo in data space.
			await rollbackCreated([entry], layer, new Set(), beforeIds);
			created.pop();
			space = 'data';
			plan.notes.push('pcb_PrimitivePour.create consumed data-space coordinates on this build; pours were created from the data-space equivalent of the requested canvas polygons.');
			made = await createOne(r, layer, space, plan.transform, Math.min(CREATE_MAX_MS, deadline - Date.now() - ROLLBACK_RESERVE_MS));
			if (!made.pourId) return rollback('CREATE_FAILED', `Re-creating the ${r.net} pour in data space failed: ${made.error}`);
			entry = { pourId: made.pourId, region: r.index, net: r.net, name: r.name, space, priority: r.priority };
			created.push(entry);
			check = outlineCheck(await readPour(made.pourId), r, plan.transform);
		}
		entry.readBackBBox = check.readBack;
		if (check.status === 'mismatch') {
			return rollback('POUR_LANDED_ELSEWHERE', `The ${r.net} pour came back with bbox ${fmtBBox(check.readBack)} instead of ${fmtBBox(r.bbox)}.`);
		}
		entry.outlineCheck = check.status;
		if (r.priority != null) {
			// EasyEDA may renumber priorities (it auto-raises a pour drawn inside
			// another), so a different read-back is reported, not rolled back:
			// the copper read-back shows which pour actually won.
			const readBack = await ensurePriority(made.pourId, r.priority);
			entry.priorityApplied = readBack === r.priority;
			if (!entry.priorityApplied) {
				plan.issues.push({ code: 'PRIORITY_RENUMBERED', severity: 'warning', region: r.index, message: `Requested priority ${r.priority} on the ${r.net} pour, EasyEDA reports ${Number.isFinite(readBack) ? readBack : 'none'} (it renumbers priorities, e.g. raising a pour nested in another). Check the copper read-back for which pour got the overlap.` });
			}
		}
	}

	const deleted: string[] = [];
	if (plan.replace.length) {
		const res: any = await pourFillHandlers['pcb.delete.pour']({ ids: plan.replace.map((e) => e.pourId), force: params.force === true })
			.catch((err: any) => ({ results: plan.replace.map((e) => ({ primitiveId: e.pourId, deleted: false, reason: err?.message ?? String(err) })) }));
		const failed: any[] = [];
		for (const row of res?.results ?? []) {
			if (row.deleted) deleted.push(String(row.primitiveId));
			else failed.push(row);
		}
		if (failed.length) return rollback('REPLACE_FAILED', `Could not delete existing pour(s): ${failed.map((f) => `${f.primitiveId} (${f.reason ?? 'not deleted'})`).join(', ')}.`, deleted);
	}
	invalidateBoardSnapshotCache();

	// Rebuild the new pours AND the kept pours on this layer, or their copper
	// would not clear around the new ones.
	const replaced = new Set(deleted);
	const pourIds = [...created.map((c) => c.pourId), ...plan.existing.filter((e) => !replaced.has(e.pourId)).map((e) => e.pourId)];
	const remaining = deadline - Date.now();
	let rebuild: any;
	if (params.rebuild === false) rebuild = { status: 'skipped', reason: 'rebuild:false' };
	else if (remaining < MIN_REBUILD_MS) rebuild = { status: 'skipped', reason: `only ${Math.round(remaining / 1000)} s left in the call budget` };
	else {
		const res: any = await pourFillHandlers['pcb.pour.repourAll']({ pourIds, strategy: 'native', _gateDeadlineAt: deadline + DEADLINE_MARGIN_MS, _timeoutMs: remaining })
			.catch((err: any) => ({ status: 'failed', notes: [err?.message ?? String(err)] }));
		rebuild = compactRebuild(res);
	}

	const verify = rebuild.status === 'completed' || rebuild.status === 'partial'
		? await verifyCopper(plan, created, deadline)
		: { copper: 'unverified', reason: `copper was not rebuilt (${rebuild.status}${rebuild.reason ? `: ${rebuild.reason}` : ''}); run pcb_repour_all, then pcb_copper_status` };
	if (verify.copper !== 'verified') plan.notes.push('Pours are created; their copper is NOT verified. Run pcb_repour_all and check pcb_copper_status before saving.');
	return respond(verify.copper === 'verified' ? 'committed' : 'committed-unverified', plan, { created, deleted, rebuild, verify });
}

async function createOne(r: Region, layer: number, space: 'canvas' | 'data', transform: PolygonTransform, timeoutMs: number): Promise<{ pourId?: string; error?: string }> {
	const toData = space === 'data' ? inverseOf(transform) : undefined;
	const points = toData ? r.points.map(toData) : r.points;
	try {
		const out: any = await pourFillHandlers['pcb.create.pour']({
			net: r.net,
			layer,
			polygon: { points },
			pourFillMethod: r.fillMethod,
			preserveSilos: r.preserveSilos,
			pourName: r.name,
			pourPriority: r.priority,
			lineWidth: r.lineWidth,
			timeoutMs,
		});
		const id = out?.primitiveId ?? out?.id;
		return id ? { pourId: String(id) } : { error: 'EasyEDA returned no pour (polygon or layer rejected).' };
	} catch (err: any) {
		return { error: err?.message ?? String(err) };
	}
}

async function readPour(id: string): Promise<any> {
	const got: any = await readWithTimeout(() => eda.pcb_PrimitivePour.get(id as any), SDK_READ_MS).catch(() => undefined);
	if (!got || didTimeOut(got)) return undefined;
	return Array.isArray(got) ? got[0] : got;
}

function outlineCheck(pour: any, r: Region, transform: PolygonTransform): { status: 'verified' | 'unverified' | 'mismatch'; readBack?: BBox; rawMatches?: boolean } {
	const src = pour ? readPourSource(pour) : undefined;
	const mapped: BBox | undefined = summarizePolygonSource(src, transform)?.bbox;
	const raw: BBox | undefined = summarizePolygonSource(src, IDENTITY)?.bbox;
	if (!mapped || !transform.resolved) return { status: 'unverified', readBack: mapped };
	if (bboxClose(mapped, r.bbox, BBOX_MATCH_TOL_MIL)) return { status: 'verified', readBack: mapped };
	return { status: 'mismatch', readBack: mapped, rawMatches: !!raw && bboxClose(raw, r.bbox, BBOX_MATCH_TOL_MIL) };
}

/** Priority the pour reports, after one modify() retry if create did not keep the requested one. */
async function ensurePriority(id: string, priority: number): Promise<number> {
	const read = async () => Number(stateOf(await readPour(id), 'PourPriority', 'pourPriority'));
	const first = await read();
	if (first === priority) return first;
	await readWithTimeout(() => eda.pcb_PrimitivePour.modify(id, { pourPriority: priority }), SDK_READ_MS).catch(() => undefined);
	return read();
}

async function rollbackCreated(created: CreatedPour[], layer: number, names: Set<string>, beforeIds: Set<string>): Promise<{ deleted: string[]; failed: Array<{ pourId: string; reason: string }>; swept: string[] }> {
	const ids = created.map((c) => c.pourId);
	const deleted: string[] = [];
	const failed: Array<{ pourId: string; reason: string }> = [];
	const drop = async (list: string[]) => {
		if (!list.length) return [] as any[];
		const res: any = await pourFillHandlers['pcb.delete.pour']({ ids: list, force: true })
			.catch((err: any) => ({ results: list.map((id) => ({ primitiveId: id, deleted: false, reason: err?.message ?? String(err) })) }));
		return res?.results ?? [];
	};
	for (const row of await drop(ids)) {
		if (row.deleted) deleted.push(String(row.primitiveId));
		else failed.push({ pourId: String(row.primitiveId), reason: row.reason ?? 'not deleted' });
	}
	// A create that timed out can still land: sweep pours this call named.
	const swept: string[] = [];
	if (names.size) {
		const listed = await safeRead(() => eda.pcb_PrimitivePour.getAll(undefined, layer as any, undefined));
		const orphans = (listed ?? []).filter((p) => !beforeIds.has(idOf(p)) && !ids.includes(idOf(p)) && names.has(String(stateOf(p, 'PourName', 'pourName')))).map(idOf);
		for (const row of await drop(orphans)) if (row.deleted) swept.push(String(row.primitiveId));
	}
	return { deleted, failed, swept };
}

function compactRebuild(res: any): any {
	return {
		status: res?.status ?? 'failed',
		jobId: res?.jobId,
		rebuilt: res?.rebuilt,
		empty: res?.empty,
		failed: res?.failed,
		unconfirmed: res?.unconfirmed,
		results: Array.isArray(res?.results)
			? res.results.map((p: any) => ({ pourId: p.primitiveId, net: p.net, status: p.status, islands: p.copper?.islands, error: p.error }))
			: undefined,
		notes: Array.isArray(res?.notes) ? res.notes.slice(0, 4) : undefined,
	};
}

// ---------------------------------------------------------------------------
// Copper read-back (EasyEDA's copper store, per island)
// ---------------------------------------------------------------------------

async function verifyCopper(plan: Plan, created: CreatedPour[], deadline: number): Promise<any> {
	const left = deadline - Date.now() - 1_000;
	if (left < 3_000) return { copper: 'unverified', reason: 'no time left in the call budget to read the copper back' };
	const doc: any = await readWithTimeout(() => eda.dmt_SelectControl.getCurrentDocumentInfo(), 3_000).catch(() => undefined);
	const documentUuid = doc && !didTimeOut(doc) && doc.uuid ? String(doc.uuid) : undefined;
	const resolved = await resolveNativePcbTab(documentUuid);
	if (!resolved.tab) return { copper: 'unverified', reason: resolved.error ?? 'PCB tab not reachable' };
	const copper = await readCopperIslands(resolved.tab, Math.min(COPPER_SOURCE_MS, left));
	if ('error' in copper) return { copper: 'unverified', reason: copper.error };

	// The copper store's coordinate space is undocumented: pick the mapping
	// under which every pour's islands fit inside the outline it was drawn with.
	const candidates: Array<{ name: string; t: PolygonTransform }> = [];
	if (plan.transform.resolved) candidates.push({ name: 'data→canvas affine', t: plan.transform });
	candidates.push({ name: 'identity', t: IDENTITY });
	const regionOf = (c: CreatedPour) => plan.regions.find((r) => r.index === c.region)!;
	const withCopper = created.filter((c) => (copper.byPour.get(c.pourId) ?? []).length > 0);
	const fits = (t: PolygonTransform) => withCopper.every((c) => {
		const box = bboxOf((copper.byPour.get(c.pourId) ?? []).flatMap((isl) => isl.rings.flat().map((p) => mapPoint(p, t))));
		return !!box && bboxInside(box, regionOf(c).bbox, COPPER_FIT_TOL_MIL);
	});
	const chosen = withCopper.length ? candidates.find((c) => fits(c.t)) : candidates[0];
	if (!chosen) return { copper: 'unverified', reason: 'the copper store\'s coordinates could not be matched to the pour outlines (neither the data→canvas affine nor identity fits)', records: copper.records };

	const pours = created.map((c) => {
		const r = regionOf(c);
		const islands = (copper.byPour.get(c.pourId) ?? []).map((isl) => {
			const rings = isl.rings.map((ring) => ring.map((p) => mapPoint(p, chosen.t)));
			const outer = rings.reduce<Point[] | undefined>((best, ring) => (!best || Math.abs(ringArea(ring)) > Math.abs(ringArea(best)) ? ring : best), undefined);
			return { fillId: isl.fillId, outer, bbox: bboxOf(rings.flat()) };
		});
		const reaches = (t: Terminal) => islands.findIndex((isl) => (isl.outer && isl.outer.length >= 3 ? pointInPolygon(t, isl.outer) : !!isl.bbox && pointInBBox(t, isl.bbox)));
		const hit = r.own.map((t) => ({ t, island: reaches(t) }));
		const unreached = hit.filter((h) => h.island < 0).map((h) => h.t.label);
		const perIsland = islands.map((isl, k) => ({ fillId: isl.fillId, bbox: isl.bbox && roundBBox(isl.bbox), ownTerminals: hit.filter((h) => h.island === k).length }));
		const dead = perIsland.filter((isl) => isl.ownTerminals === 0).length;
		if (!islands.length) plan.issues.push({ code: 'POUR_HAS_NO_COPPER', severity: 'warning', region: r.index, message: `The ${r.net} pour got no copper after the rebuild (blocked by clearances/keepouts, or every island removed as unconnected).` });
		else if (unreached.length) plan.issues.push({ code: 'COPPER_MISSES_PADS', severity: 'warning', region: r.index, message: `${unreached.length} ${r.net} pad/via in the region are not inside any island of its copper.`, items: unreached.slice(0, SAMPLE) });
		return {
			pourId: c.pourId,
			net: c.net,
			region: c.region,
			islands: islands.length,
			reached: hit.length - unreached.length,
			ownTerminals: hit.length,
			unreachedSample: unreached.length ? unreached.slice(0, SAMPLE) : undefined,
			deadIslands: dead,
			islandDetail: perIsland.slice(0, SAMPLE),
		};
	});
	return {
		copper: 'verified',
		source: 'editor-copper-store',
		coordinateMapping: chosen.name,
		method: 'pad/via centre inside an island\'s outer ring (arcs as chords; thermal spokes/clearances not modelled) — approximate',
		pours,
	};
}

async function readCopperIslands(tab: NativePcbTab, ms: number): Promise<{ byPour: Map<string, Island[]>; records: number } | { error: string }> {
	const rpc = tab.host.windowBridge.rpcCall;
	if (typeof rpc !== 'function') return { error: 'The host message bridge has no rpcCall; copper cannot be read.' };
	const reply: any = await readWithTimeout(() => rpc.call(tab.host.windowBridge, 'CopperSource', '', tab.target, ms), ms + 1_000)
		.catch((err: any) => ({ __error: err?.message ?? String(err) }));
	if (didTimeOut(reply)) return { error: `The editor did not return its copper within ${ms} ms.` };
	if (reply?.__error) return { error: `CopperSource failed: ${reply.__error}` };
	const chunks = reply?.message;
	if (!Array.isArray(chunks)) return { error: 'CopperSource returned an unexpected payload.' };
	const byPour = new Map<string, Island[]>();
	let records = 0;
	for (const chunk of chunks) {
		if (typeof chunk !== 'string') continue;
		for (const raw of topLevelArrays(chunk)) {
			let rec: any;
			try { rec = JSON.parse(raw); } catch { continue; }
			if (!Array.isArray(rec) || rec[0] !== 'POURED') continue;
			records++;
			const pourId = String(rec[2]);
			const list = byPour.get(pourId) ?? [];
			list.push({ fillId: String(rec[1]), rings: pathRings(rec[5]) });
			byPour.set(pourId, list);
		}
	}
	return { byPour, records };
}

/** CopperSource records are top-level JSON arrays separated by whitespace. */
function topLevelArrays(chunk: string): string[] {
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

/** Rings of an EasyEDA copper path: x,y then "L" pairs / "ARC"|"CARC" angle,x,y / "R" x,y,w,h / "CIRCLE" cx,cy,r. */
function pathRings(node: unknown, out: Point[][] = []): Point[][] {
	if (!Array.isArray(node)) return out;
	if (node.some((v) => Array.isArray(v))) { for (const n of node) pathRings(n, out); return out; }
	const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
	let i = 0;
	let cmd = 'L';
	if (typeof node[0] === 'string') {
		const [head, a, b, c, d] = node as any[];
		if (head === 'R' && [a, b, c, d].every((v) => num(v) != null)) { out.push([{ x: a, y: b }, { x: a + c, y: b }, { x: a + c, y: b + d }, { x: a, y: b + d }]); return out; }
		if (head === 'CIRCLE' && [a, b, c].every((v) => num(v) != null)) { out.push(Array.from({ length: 16 }, (_, k) => ({ x: a + c * Math.cos(k * Math.PI / 8), y: b + c * Math.sin(k * Math.PI / 8) }))); return out; }
		cmd = head;
		i = 1;
	}
	const pts: Point[] = [];
	const push = (x: unknown, y: unknown) => { const px = num(x); const py = num(y); if (px != null && py != null) pts.push({ x: px, y: py }); };
	while (i < node.length) {
		const v = node[i];
		if (typeof v === 'string') { cmd = v; i++; continue; }
		if (cmd === 'ARC' || cmd === 'CARC') { push(node[i + 1], node[i + 2]); i += 3; continue; }
		push(node[i], node[i + 1]);
		i += 2;
	}
	if (pts.length >= 3) out.push(pts);
	return out;
}

// ---------------------------------------------------------------------------
// Board outline (canvas space)
// ---------------------------------------------------------------------------

async function readBoardOutline(snapshot: Snap, transform: PolygonTransform): Promise<Outline> {
	type Seg = { a: Point; b: Point; arc?: number };
	const segs: Seg[] = [];
	for (const l of snapshot.lines) {
		if (Number(l.layer) !== OUTLINE_LAYER) continue;
		const a = { x: Number(l.startX), y: Number(l.startY) };
		const b = { x: Number(l.endX), y: Number(l.endY) };
		if (finite(a) && finite(b) && !near(a, b)) segs.push({ a, b });
	}
	const arcs = await safeRead(() => eda.pcb_PrimitiveArc.getAll(undefined, OUTLINE_LAYER as any, undefined));
	for (const arc of arcs ?? []) {
		const a = { x: num(arc, 'StartX', 'startX'), y: num(arc, 'StartY', 'startY') };
		const b = { x: num(arc, 'EndX', 'endX'), y: num(arc, 'EndY', 'endY') };
		const angle = num(arc, 'ArcAngle', 'arcAngle');
		if (finite(a) && finite(b) && !near(a, b)) segs.push({ a, b, arc: Number.isFinite(angle) ? angle : undefined });
	}
	const loops = chainLoops(segs);
	let polylineSkipped = 0;
	const polylines = await safeRead(() => eda.pcb_PrimitivePolyline.getAll(undefined, OUTLINE_LAYER as any, undefined));
	for (const p of polylines ?? []) {
		if (!transform.resolved) { polylineSkipped++; continue; }
		const ring = pathRings(readPourSource(p))[0];
		if (ring && ring.length >= 3) loops.push(openRing(ring.map((pt) => mapPoint(pt, transform))));
	}
	const best = loops.filter((l) => l.length >= 3).sort((x, y) => Math.abs(ringArea(y)) - Math.abs(ringArea(x)))[0];
	if (best) {
		return {
			points: best,
			bbox: bboxOf(best),
			source: `BoardOutline layer 11 (${segs.length} line/arc segment(s), ${polylines?.length ?? 0} polyline(s))`,
			approximate: segs.some((s) => s.arc) ? `arcs flattened in ${ARC_STEP_DEG}° steps` : undefined,
		};
	}
	const b = snapshot.boardOutline?.bounds;
	if (b && [b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite) && b.maxX > b.minX && b.maxY > b.minY) {
		const points = [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];
		return { points, bbox: bboxOf(points), source: 'BoardOutline bounding box', approximate: polylineSkipped ? 'bbox (outline polylines could not be mapped: canvas origin unreadable)' : 'bbox (outline segments do not close into a loop)' };
	}
	return { source: 'none' };
}

function chainLoops(segs: Array<{ a: Point; b: Point; arc?: number }>): Point[][] {
	const unused = segs.slice();
	const loops: Point[][] = [];
	while (unused.length) {
		const first = unused.shift()!;
		const pts = segPoints(first.a, first.b, first.arc);
		const start = pts[0];
		let cur = pts[pts.length - 1];
		while (!near(cur, start) && unused.length) {
			const k = unused.findIndex((s) => near(s.a, cur) || near(s.b, cur));
			if (k < 0) break;
			const s = unused.splice(k, 1)[0];
			const more = near(s.a, cur) ? segPoints(s.a, s.b, s.arc) : segPoints(s.b, s.a, s.arc == null ? undefined : -s.arc);
			pts.push(...more.slice(1));
			cur = pts[pts.length - 1];
		}
		if (near(cur, start) && pts.length >= 4) loops.push(openRing(pts));
	}
	return loops;
}

/** Straight segment, or an arc flattened in ARC_STEP_DEG steps (centre picked so start rotates onto end). */
function segPoints(a: Point, b: Point, arcDeg?: number): Point[] {
	if (!arcDeg || Math.abs(arcDeg) < 0.01) return [a, b];
	const theta = arcDeg * Math.PI / 180;
	const chord = Math.hypot(b.x - a.x, b.y - a.y);
	if (chord <= 0 || Math.abs(Math.sin(theta / 2)) < 1e-6) return [a, b];
	const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	const perp = { x: -(b.y - a.y) / chord, y: (b.x - a.x) / chord };
	const h = chord / (2 * Math.tan(Math.abs(theta) / 2));
	const centers = [{ x: mid.x + perp.x * h, y: mid.y + perp.y * h }, { x: mid.x - perp.x * h, y: mid.y - perp.y * h }];
	const miss = (c: Point) => { const e = rotate(a, c, theta); return Math.hypot(e.x - b.x, e.y - b.y); };
	const center = miss(centers[0]) <= miss(centers[1]) ? centers[0] : centers[1];
	const steps = Math.max(2, Math.ceil(Math.abs(arcDeg) / ARC_STEP_DEG));
	const pts = Array.from({ length: steps + 1 }, (_, i) => rotate(a, center, theta * i / steps));
	pts[0] = a;
	pts[steps] = b;
	return pts;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

function respond(status: string, plan: Plan, extra: Record<string, any> = {}): any {
	const errors = plan.issues.filter((i) => i.severity === 'error').length;
	const createdByRegion = new Map<number, CreatedPour>((extra.created ?? []).map((c: CreatedPour) => [c.region, c]));
	const verifyByRegion = new Map<number, any>((extra.verify?.pours ?? []).map((p: any) => [p.region, p]));
	return {
		status,
		layer: plan.layer,
		layerName: plan.layerName,
		layerType: plan.layerType,
		units: 'mil',
		coordinateSpace: COORDINATE_SPACE,
		gapMil: round2(plan.gapMil),
		gapSource: plan.gapSource,
		outline: { source: plan.outline.source, vertexCount: plan.outline.points?.length ?? 0, bbox: plan.outline.bbox && roundBBox(plan.outline.bbox), approximate: plan.outline.approximate },
		summary: { errors, warnings: plan.issues.length - errors, regions: plan.regions.length, existingPoursOnLayer: plan.existing.length },
		issues: plan.issues,
		regions: plan.regions.map((r) => {
			const c = createdByRegion.get(r.index);
			const v = verifyByRegion.get(r.index);
			return {
				index: r.index,
				net: r.net,
				name: r.name,
				priority: r.priority,
				fillMethod: r.fillMethod,
				preserveSilos: r.preserveSilos,
				origin: r.origin,
				bbox: roundBBox(r.bbox),
				areaSqMil: Math.round(r.area),
				vertexCount: r.points.length,
				points: r.points.length <= MAX_POINTS_ECHO ? r.points.map((p) => ({ x: round2(p.x), y: round2(p.y) })) : undefined,
				boardOutline: r.outline,
				terminals: {
					own: r.own.length,
					ownSample: r.own.slice(0, SAMPLE).map((t) => t.label),
					foreign: r.foreign.length,
					otherNets: r.otherNets,
				},
				pourId: c?.pourId,
				outlineCheck: c?.outlineCheck,
				priorityApplied: c?.priorityApplied,
				copper: v ? { islands: v.islands, reached: v.reached, ownTerminals: v.ownTerminals, deadIslands: v.deadIslands } : undefined,
			};
		}),
		nets: plan.nets,
		existingPours: plan.existing.map((e) => ({ pourId: e.pourId, net: e.net, name: e.name, priority: e.priority, locked: e.locked || undefined, overlapsRegions: e.overlapsRegions, replace: plan.replace.includes(e) || undefined })),
		created: extra.created ?? [],
		deleted: extra.deleted ?? [],
		rolledBack: extra.rolledBack ?? null,
		rebuild: extra.rebuild ?? null,
		verify: extra.verify ?? null,
		notes: plan.notes,
	};
}

// ---------------------------------------------------------------------------
// Geometry + helpers
// ---------------------------------------------------------------------------

function regionPoints(spec: any): { points: Point[]; origin: 'polygon' | 'rect' } {
	const rect = spec?.rect ?? (isBBoxLike(spec?.polygon) ? spec.polygon : undefined);
	if (rect) {
		const b = { minX: Number(rect.minX), minY: Number(rect.minY), maxX: Number(rect.maxX), maxY: Number(rect.maxY) };
		if (![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite) || b.maxX <= b.minX || b.maxY <= b.minY) throw new Error('rect needs finite minX < maxX and minY < maxY (mil).');
		return { origin: 'rect', points: [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }] };
	}
	if (spec?.polygon == null) throw new Error('needs `polygon` ([{x,y},...] | {points} | ["L",x1,y1,...] | ["R",cx,cy,w,h,rot]) or `rect` {minX,minY,maxX,maxY}.');
	const src = normalizePolygon(spec.polygon) as Array<string | number>;
	if (src[0] === 'R') {
		const [left, top, w, h, rot] = src.slice(1).map(Number);
		const c = { x: left + w / 2, y: top + h / 2 };
		const corners = [{ x: left, y: top }, { x: left + w, y: top }, { x: left + w, y: top + h }, { x: left, y: top + h }];
		return { origin: 'rect', points: rot ? corners.map((p) => rotate(p, c, rot * Math.PI / 180)) : corners };
	}
	const pts: Point[] = [];
	for (let i = 0; i < src.length;) {
		const v = src[i];
		if (typeof v === 'string') {
			if (v.toUpperCase() !== 'L') throw new Error(`polygon command "${v}" is not supported here; give straight-edge vertices.`);
			i++;
			continue;
		}
		const x = Number(v);
		const y = Number(src[i + 1]);
		if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('polygon has a non-numeric coordinate.');
		pts.push({ x, y });
		i += 2;
	}
	return { origin: 'polygon', points: openRing(pts) };
}

/** Sutherland–Hodgman clip against one axis-aligned half-plane (keepLow: value ≤ bound). */
export function clipHalfPlane(poly: Point[], axis: 'x' | 'y', bound: number, keepLow: boolean): Point[] {
	const inside = (p: Point) => (keepLow ? p[axis] <= bound + EPS : p[axis] >= bound - EPS);
	const cross = (a: Point, b: Point): Point => {
		const t = (bound - a[axis]) / (b[axis] - a[axis]);
		const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
		p[axis] = bound;
		return p;
	};
	const out: Point[] = [];
	for (let i = 0; i < poly.length; i++) {
		const cur = poly[i];
		const prev = poly[(i + poly.length - 1) % poly.length];
		if (inside(cur)) {
			if (!inside(prev)) out.push(cross(prev, cur));
			out.push(cur);
		} else if (inside(prev)) {
			out.push(cross(prev, cur));
		}
	}
	return openRing(out);
}

function outlineRelation(points: Point[], outline: Point[]): 'inside' | 'partial' | 'outside' {
	const onOrIn = (p: Point) => pointInPolygon(p, outline) || ringPointDistance(p, outline) <= OUTLINE_TOLERANCE_MIL;
	const inCount = points.filter(onOrIn).length;
	const crosses = edgesOf(points).some(([a, b]) => edgesOf(outline).some(([c, d]) => properCross(a, b, c, d)));
	if (inCount === points.length && !crosses) return 'inside';
	if (inCount === 0 && !crosses && !outline.some((p) => pointInPolygon(p, points))) return 'outside';
	return 'partial';
}

function selfIntersects(ring: Point[]): boolean {
	const edges = edgesOf(ring);
	for (let i = 0; i < edges.length; i++) {
		for (let j = i + 1; j < edges.length; j++) {
			if (j === i + 1 || (i === 0 && j === edges.length - 1)) continue;
			if (segmentDistance(edges[i][0], edges[i][1], edges[j][0], edges[j][1]) <= EPS) return true;
		}
	}
	return false;
}

function ringDistance(a: Point[], b: Point[]): number {
	let best = Infinity;
	for (const [p, q] of edgesOf(a)) {
		for (const [r, s] of edgesOf(b)) {
			best = Math.min(best, segmentDistance(p, q, r, s));
			if (best <= EPS) return 0;
		}
	}
	return best;
}

function ringPointDistance(p: Point, ring: Point[]): number {
	return Math.min(...edgesOf(ring).map(([a, b]) => pointToSegmentDistance(p, a, b)));
}

function properCross(a: Point, b: Point, c: Point, d: Point): boolean {
	const o = (p: Point, q: Point, r: Point) => {
		const v = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
		return Math.abs(v) < 1e-9 ? 0 : Math.sign(v);
	};
	return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

function edgesOf(ring: Point[]): Array<[Point, Point]> {
	return ring.map((p, i) => [p, ring[(i + 1) % ring.length]] as [Point, Point]);
}

function ringArea(ring: Point[]): number {
	let s = 0;
	for (let i = 0; i < ring.length; i++) {
		const a = ring[i];
		const b = ring[(i + 1) % ring.length];
		s += a.x * b.y - b.x * a.y;
	}
	return s / 2;
}

/** Drop consecutive duplicates and the closing repeat of the first point. */
function openRing(points: Point[]): Point[] {
	const out: Point[] = [];
	for (const p of points) if (!out.length || !near(out[out.length - 1], p, EPS)) out.push({ x: p.x, y: p.y });
	while (out.length > 1 && near(out[0], out[out.length - 1], EPS)) out.pop();
	return out;
}

function inverseOf(t: PolygonTransform): (p: Point) => Point {
	const ax = t.x(1) - t.x(0);
	const bx = t.x(0);
	const ay = t.y(1) - t.y(0);
	const by = t.y(0);
	return (p) => ({ x: (p.x - bx) / ax, y: (p.y - by) / ay });
}

function mapPoint(p: Point, t: PolygonTransform): Point {
	return { x: t.x(p.x), y: t.y(p.y) };
}

function rotate(p: Point, c: Point, rad: number): Point {
	const dx = p.x - c.x;
	const dy = p.y - c.y;
	return { x: c.x + dx * Math.cos(rad) - dy * Math.sin(rad), y: c.y + dx * Math.sin(rad) + dy * Math.cos(rad) };
}

function bboxOf(points: Point[]): BBox | undefined {
	if (!points.length) return undefined;
	return {
		minX: Math.min(...points.map((p) => p.x)),
		minY: Math.min(...points.map((p) => p.y)),
		maxX: Math.max(...points.map((p) => p.x)),
		maxY: Math.max(...points.map((p) => p.y)),
	};
}

function bboxClose(a: BBox, b: BBox, tol: number): boolean {
	return Math.abs(a.minX - b.minX) <= tol && Math.abs(a.minY - b.minY) <= tol && Math.abs(a.maxX - b.maxX) <= tol && Math.abs(a.maxY - b.maxY) <= tol;
}

function bboxInside(inner: BBox, outer: BBox, tol: number): boolean {
	return inner.minX >= outer.minX - tol && inner.minY >= outer.minY - tol && inner.maxX <= outer.maxX + tol && inner.maxY <= outer.maxY + tol;
}

function bboxesOverlap(a: BBox, b: BBox): boolean {
	return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

function pointInBBox(p: Point, b: BBox): boolean {
	return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}

function isBBoxLike(v: any): boolean {
	return !!v && typeof v === 'object' && !Array.isArray(v) && ['minX', 'minY', 'maxX', 'maxY'].every((k) => k in v);
}

function isCopperLayer(id: number): boolean {
	return id === 1 || id === 2 || (id >= 15 && id <= 44);
}

function near(a: Point, b: Point, tol = OUTLINE_TOLERANCE_MIL): boolean {
	return Math.hypot(a.x - b.x, a.y - b.y) <= tol;
}

function finite(p: Point): boolean {
	return Number.isFinite(p.x) && Number.isFinite(p.y);
}

function num(obj: any, state: string, flat: string): number {
	try {
		const getter = obj?.[`getState_${state}`];
		if (typeof getter === 'function') {
			const v = Number(getter.call(obj));
			if (Number.isFinite(v)) return v;
		}
	} catch {/* */}
	const v = Number(obj?.[flat] ?? obj?.[flat.startsWith('start') ? 'start' : 'end']?.[flat.slice(-1).toLowerCase()]);
	return Number.isFinite(v) ? v : Number.NaN;
}

function idOf(p: any): string {
	try {
		const v = typeof p?.getState_PrimitiveId === 'function' ? p.getState_PrimitiveId() : undefined;
		if (v) return String(v);
	} catch {/* */}
	return String(p?.primitiveId ?? p?.id ?? 'unknown');
}

function stateOf(p: any, state: string, flat: string): any {
	try {
		const getter = p?.[`getState_${state}`];
		if (typeof getter === 'function') return getter.call(p);
	} catch {/* */}
	return p?.[flat];
}

async function safeRead(fn: () => Promise<any>): Promise<any[] | undefined> {
	const out: any = await readWithTimeout(fn, SDK_READ_MS).catch(() => undefined);
	if (out === undefined || didTimeOut(out)) return undefined;
	return Array.isArray(out) ? out : [];
}

function deadlineOf(params: Record<string, any>): number {
	const gate = Number(params._gateDeadlineAt);
	if (Number.isFinite(gate) && gate > 0) return gate - DEADLINE_MARGIN_MS;
	const budget = Number(params._timeoutMs);
	return Date.now() + (Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET_MS) - DEADLINE_MARGIN_MS;
}

function pickDefined(obj: any, keys: string[]): Record<string, any> {
	const out: Record<string, any> = {};
	for (const k of keys) if (obj?.[k] != null) out[k] = obj[k];
	return out;
}

function unique<T>(values: T[]): T[] {
	return Array.from(new Set(values));
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

function roundBBox(b: BBox): BBox {
	return { minX: round2(b.minX), minY: round2(b.minY), maxX: round2(b.maxX), maxY: round2(b.maxY) };
}

function fmtBBox(b?: BBox): string {
	return b ? `[${round2(b.minX)},${round2(b.minY)} → ${round2(b.maxX)},${round2(b.maxY)}]` : '(unreadable)';
}

function fmtRange(b: BBox | undefined, axis: 'x' | 'y'): string {
	if (!b) return '?';
	return axis === 'x' ? `${round2(b.minX)}..${round2(b.maxX)}` : `${round2(b.minY)}..${round2(b.maxY)}`;
}

import { flattenState, normalizeLayer, normalizeViaType } from './_utils';
import { enforceTraceObstacles } from './trace-obstacles';
import { componentPinScale, componentPinSourceUnits } from './pin-units';
import { cleanPolyline, type Polyline } from '../../mcp-server/analyzers/route-geometry';

type Point = { x: number; y: number };
type Endpoint = Point & {
	label: string;
	net?: string;
	layer?: any;
	reference?: string;
	padNumber?: string;
	primitiveId?: string;
	source: 'pad' | 'point' | 'primitive';
	units: 'mil';
	sourceUnits?: string;
};
type LineSpec = { net: string; layer: any; startX: number; startY: number; endX: number; endY: number; lineWidth?: number; role: string };
type ViaSpec = { net: string; x: number; y: number; holeDiameter: number; diameter: number; viaType: any; role: string };

const DEFAULT_VIA_OFFSET_MIL = 40;
const DEFAULT_VIA_HOLE_MIL = 12;
const DEFAULT_VIA_DIAMETER_MIL = 24;

export const routingHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.route.smart': async (params) => {
		const from = await resolveEndpoint(params.from_pad ?? params.fromPad ?? params.from, 'from_pad');
		const to = await resolveEndpoint(params.to_pad ?? params.toPad ?? params.to, 'to_pad');
		const net = resolveRouteNet(params.net, from, to);
		const layer = normalizeLayer(firstDefined(params.layer, params.layer_preference, params.layerPreference, params.preferredLayer, from.layer, 'TopLayer'));
		const lineWidth = resolveLineWidth(params, net);
		const entryLineWidth = resolveLineWidth({
			...params,
			lineWidth: firstDefined(params.entryLineWidth, params.entry_width_mil, params.entryWidthMil, lineWidth),
		}, net);
		const primitiveLock = !!params.primitiveLock;
		const viaStrategy = String(params.via_strategy ?? params.viaStrategy ?? 'none');
		const dryRun = !!params.dryRun;

		const plan = planFanoutRoute({ params, from, to, net, layer, viaStrategy, entryLineWidth });
		const path = maybeSnap45(buildRoutePath(plan.routeStart, plan.routeEnd, params), params);
		const segmentWidths = Array.isArray(params.segmentWidths) ? params.segmentWidths : [];
		const routeSegments = segmentsFromPath(path, net, layer, lineWidth, 'route')
			.map((s, i) => ({ ...s, lineWidth: segmentWidths[i] ?? s.lineWidth }));
		const lineSpecs = [...plan.stubSegments, ...routeSegments];
		const obstacleCheck = await enforceTraceObstacles({
			...params,
			net,
			layer,
			segments: lineSpecs,
			failOnObstacle: dryRun ? false : params.failOnObstacle,
			ignorePrimitiveIds: [
				...(Array.isArray(params.ignorePrimitiveIds) ? params.ignorePrimitiveIds : []),
				from.primitiveId,
				to.primitiveId,
			].filter(Boolean),
		});

		const created = dryRun
			? { vias: [], lines: [] }
			: await createRoutePrimitives(lineSpecs, plan.vias, primitiveLock);

		return {
			dryRun,
			net,
			layer,
			lineWidth,
			entryLineWidth,
			viaStrategy,
			from,
			to,
			routePoints: path,
			segments: lineSpecs,
			vias: plan.vias,
			obstacleCheck,
			created,
			segmentCount: lineSpecs.length,
			viaCount: plan.vias.length,
			units: 'mil',
		};
	},

	'pcb.route.autoFanout': async (params) => {
		const pad = await resolveEndpoint(params.pad_ref ?? params.padRef ?? params.pad, 'pad_ref');
		if (pad.source !== 'pad') throw new Error('pcb_auto_fanout requires a component pad reference such as "U12.6".');
		const net = String(params.net ?? pad.net ?? '');
		if (!net) throw new Error(`Could not infer net for ${pad.label}; pass net explicitly.`);
		const routeLayer = normalizeLayer(firstDefined(params.layer, params.routeLayer, params.layer_preference, params.layerPreference, pad.layer, 'TopLayer'));
		const lineWidth = resolveLineWidth(params, net);
		const viaOffsetMil = Number(firstDefined(params.viaOffsetMil, params.via_offset_mil, DEFAULT_VIA_OFFSET_MIL));
		const direction = directionVector(firstDefined(params.direction_hint, params.directionHint, params.fanoutDirection), pad, undefined);
		const viaPoint = { x: pad.x + direction.x * viaOffsetMil, y: pad.y + direction.y * viaOffsetMil };
		const stubLayer = copperLayerOr(routeLayer, pad.layer);
		const stub: LineSpec = {
			net,
			layer: stubLayer,
			startX: pad.x,
			startY: pad.y,
			endX: viaPoint.x,
			endY: viaPoint.y,
			lineWidth,
			role: 'fanout_stub',
		};
		const via: ViaSpec = {
			net,
			x: viaPoint.x,
			y: viaPoint.y,
			holeDiameter: Number(params.holeDiameter ?? DEFAULT_VIA_HOLE_MIL),
			diameter: Number(params.diameter ?? DEFAULT_VIA_DIAMETER_MIL),
			viaType: normalizeViaType(params.viaType ?? 'Through'),
			role: 'fanout_via',
		};
		const dryRun = !!params.dryRun;
		const obstacleCheck = await enforceTraceObstacles({
			...params,
			net,
			layer: stubLayer,
			segments: [stub],
			failOnObstacle: dryRun ? false : params.failOnObstacle,
			ignorePrimitiveIds: [
				...(Array.isArray(params.ignorePrimitiveIds) ? params.ignorePrimitiveIds : []),
				pad.primitiveId,
			].filter(Boolean),
		});
		const created = dryRun ? { vias: [], lines: [] } : await createRoutePrimitives([stub], [via], !!params.primitiveLock);
		return {
			dryRun,
			net,
			pad,
			routeLayer,
			lineWidth,
			viaOffsetMil,
			direction,
			stub,
			via,
			obstacleCheck,
			created,
			units: 'mil',
		};
	},

	'pcb.route.diffPair': async (params) => {
		const positiveNet = String(params.positive_net ?? params.positiveNet);
		const negativeNet = String(params.negative_net ?? params.negativeNet);
		if (!positiveNet || !negativeNet) throw new Error('pcb_route_diff_pair requires positive_net and negative_net.');
		const pFrom = await resolveEndpoint(firstDefined(params.positive_from_pad, params.from_positive_pad, params.from_p, params.positiveFrom, params.p_from), 'positive_from_pad');
		const pTo = await resolveEndpoint(firstDefined(params.positive_to_pad, params.to_positive_pad, params.to_p, params.positiveTo, params.p_to), 'positive_to_pad');
		const nFrom = await resolveEndpoint(firstDefined(params.negative_from_pad, params.from_negative_pad, params.from_n, params.negativeFrom, params.n_from), 'negative_from_pad');
		const nTo = await resolveEndpoint(firstDefined(params.negative_to_pad, params.to_negative_pad, params.to_n, params.negativeTo, params.n_to), 'negative_to_pad');
		const layer = normalizeLayer(firstDefined(params.layer, params.layer_preference, params.layerPreference, params.preferredLayer, pFrom.layer, 'TopLayer'));
		const spacing = Number(firstDefined(params.target_spacing_mil, params.targetSpacingMil, params.spacing_mil, distance(pFrom, nFrom)));
		const lineWidthP = resolveLineWidth({ ...params, lineWidth: firstDefined(params.positiveLineWidth, params.positive_width_mil, params.lineWidth) }, positiveNet);
		const lineWidthN = resolveLineWidth({ ...params, lineWidth: firstDefined(params.negativeLineWidth, params.negative_width_mil, params.lineWidth) }, negativeNet);
		const centerStart = midpoint(pFrom, nFrom);
		const centerEnd = midpoint(pTo, nTo);
		const centerPath = maybeSnap45(buildRoutePath(centerStart, centerEnd, params), params);
		const offset = pairOffsetVector(pFrom, nFrom, pTo, nTo, centerStart, centerEnd);
		const half = spacing / 2;
		let positivePath = dedupePoints([pFrom, ...centerPath.map((p) => ({ x: p.x + offset.x * half, y: p.y + offset.y * half })), pTo]);
		let negativePath = dedupePoints([nFrom, ...centerPath.map((p) => ({ x: p.x - offset.x * half, y: p.y - offset.y * half })), nTo]);

		const tolerance = Number(firstDefined(params.tolerance_mil, params.toleranceMil, 5));
		let positiveLength = pathLength(positivePath);
		let negativeLength = pathLength(negativePath);
		let lengthMatch: Record<string, any> = {
			requested: !!(params.length_match ?? params.lengthMatch),
			toleranceMil: tolerance,
			before: { [positiveNet]: positiveLength, [negativeNet]: negativeLength, delta: Math.abs(positiveLength - negativeLength) },
		};
		if (lengthMatch.requested && Math.abs(positiveLength - negativeLength) > tolerance) {
			const shorterPositive = positiveLength < negativeLength;
			const extra = Math.abs(positiveLength - negativeLength);
			const tuned = addSerpentineToPath(shorterPositive ? positivePath : negativePath, extra, params);
			if (shorterPositive) positivePath = tuned.path;
			else negativePath = tuned.path;
			positiveLength = pathLength(positivePath);
			negativeLength = pathLength(negativePath);
			lengthMatch = {
				...lengthMatch,
				tunedNet: shorterPositive ? positiveNet : negativeNet,
				tuning: tuned.summary,
				after: { [positiveNet]: positiveLength, [negativeNet]: negativeLength, delta: Math.abs(positiveLength - negativeLength) },
			};
		}

		const positiveSegments = segmentsFromPath(positivePath, positiveNet, layer, lineWidthP, 'diff_pair_positive');
		const negativeSegments = segmentsFromPath(negativePath, negativeNet, layer, lineWidthN, 'diff_pair_negative');
		const lineSpecs = [...positiveSegments, ...negativeSegments];
		const dryRun = !!params.dryRun;
		const obstacleCheck = await enforceTraceObstacles({
			...params,
			layer,
			segments: lineSpecs,
			failOnObstacle: dryRun ? false : params.failOnObstacle,
			ignorePrimitiveIds: [
				...(Array.isArray(params.ignorePrimitiveIds) ? params.ignorePrimitiveIds : []),
				pFrom.primitiveId,
				pTo.primitiveId,
				nFrom.primitiveId,
				nTo.primitiveId,
			].filter(Boolean),
		});
		const created = dryRun ? { vias: [], lines: [] } : await createRoutePrimitives(lineSpecs, [], !!params.primitiveLock);

		return {
			dryRun,
			positiveNet,
			negativeNet,
			layer,
			targetSpacingMil: spacing,
			lineWidth: { [positiveNet]: lineWidthP, [negativeNet]: lineWidthN },
			offset,
			paths: { [positiveNet]: positivePath, [negativeNet]: negativePath },
			segments: lineSpecs,
			lengthMatch,
			obstacleCheck,
			created,
			units: 'mil',
		};
	},

	'pcb.route.lengthMatch': async (params) => {
		const posNet = String(params.pos_net ?? params.posNet ?? params.positive_net ?? params.positiveNet);
		const negNet = String(params.neg_net ?? params.negNet ?? params.negative_net ?? params.negativeNet);
		if (!posNet || !negNet) throw new Error('pcb_length_match requires pos_net and neg_net.');
		const tolerance = Number(firstDefined(params.tolerance_mil, params.toleranceMil, 5));
		const posLength = Number(await eda.pcb_Net.getNetLength(posNet) ?? 0);
		const negLength = Number(await eda.pcb_Net.getNetLength(negNet) ?? 0);
		const delta = Math.abs(posLength - negLength);
		const shorterNet = posLength <= negLength ? posNet : negNet;
		if (delta <= tolerance) {
			return { matched: true, posNet, negNet, lengths: { [posNet]: posLength, [negNet]: negLength }, delta, toleranceMil: tolerance, created: { lines: [], vias: [] }, units: 'mil' };
		}
		const anchor = params.anchor ?? params.tuning_anchor ?? params.tuningAnchor;
		if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) {
			return {
				matched: false,
				needsAnchor: true,
				shorterNet,
				lengthToAddMil: delta,
				toleranceMil: tolerance,
				lengths: { [posNet]: posLength, [negNet]: negLength },
				note: 'Pass anchor:{x,y} on the shorter net to add an attached serpentine tuning loop.',
				units: 'mil',
			};
		}
		const layer = normalizeLayer(firstDefined(params.layer, params.layer_preference, params.layerPreference, 'TopLayer'));
		const lineWidth = resolveLineWidth(params, shorterNet);
		const anchorPoint = { x: Number(anchor.x), y: Number(anchor.y) };
		const loop = buildAttachedSerpentineLoop(anchorPoint, delta, params);
		const segments = segmentsFromPath(loop.path, shorterNet, layer, lineWidth, 'length_match_serpentine');
		const dryRun = !!params.dryRun;
		// The serpentine attaches AT the anchor, which sits on the shorter net's
		// existing copper. Previously no ids were ignored, so the loop's first
		// segment registered a false self-collision against the very track it
		// branches from. Ignore the shorter net's anchor-adjacent existing
		// line/arc segment ids so the preflight only flags real conflicts.
		const anchorAdjacentIds = await findAnchorAdjacentSegmentIds(shorterNet, anchorPoint, lineWidth);
		const obstacleCheck = await enforceTraceObstacles({
			...params,
			net: shorterNet,
			layer,
			segments,
			failOnObstacle: dryRun ? false : params.failOnObstacle,
			ignorePrimitiveIds: [
				...(Array.isArray(params.ignorePrimitiveIds) ? params.ignorePrimitiveIds : []),
				...anchorAdjacentIds,
			],
		});
		const created = dryRun ? { vias: [], lines: [] } : await createRoutePrimitives(segments, [], !!params.primitiveLock);
		return {
			dryRun,
			matched: false,
			shorterNet,
			lengthToAddMil: delta,
			toleranceMil: tolerance,
			lengths: { [posNet]: posLength, [negNet]: negLength },
			anchor,
			segments,
			tuning: loop.summary,
			obstacleCheck,
			created,
			units: 'mil',
		};
	},
};

async function resolveEndpoint(input: any, label: string): Promise<Endpoint> {
	if (input == null) throw new Error(`${label} is required.`);
	if (typeof input === 'string') return resolvePadEndpoint(input, label);
	if (typeof input !== 'object') throw new Error(`${label} must be a pad reference string or {x,y}.`);
	if (Number.isFinite(input.x) && Number.isFinite(input.y)) {
		return {
			x: Number(input.x),
			y: Number(input.y),
			layer: input.layer != null ? normalizeLayer(input.layer) : undefined,
			net: input.net,
			label: input.label ?? label,
			source: 'point',
			units: 'mil',
		};
	}
	const padRef = input.pad_ref ?? input.padRef ?? input.ref;
	if (typeof padRef === 'string') return resolvePadEndpoint(padRef, label);
	const reference = input.reference ?? input.designator;
	const padNumber = input.padNumber ?? input.pad_number ?? input.pin ?? input.pinNumber;
	if (reference != null && padNumber != null) return resolvePadEndpoint(`${reference}.${padNumber}`, label);
	if (typeof input.primitiveId === 'string') {
		const pad = await eda.pcb_PrimitivePad.get(input.primitiveId);
		const flat: any = flattenState(pad);
		const x = readNumber(pad, 'X', 'x');
		const y = readNumber(pad, 'Y', 'y');
		if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Could not resolve standalone pad ${input.primitiveId}.`);
		return {
			...flat,
			x,
			y,
			layer: flat?.layer != null ? normalizeLayer(flat.layer) : undefined,
			net: flat?.net,
			label,
			primitiveId: input.primitiveId,
			source: 'primitive',
			units: 'mil',
		};
	}
	throw new Error(`${label} must be a pad ref ("U1.3"), {reference,padNumber}, {pad_ref}, or {x,y}.`);
}

async function resolvePadEndpoint(padRef: string, label: string): Promise<Endpoint> {
	const parsed = parsePadRef(padRef);
	const components = await eda.pcb_PrimitiveComponent.getAll();
	const target = (components || []).find((c: any) => String(readAny(c, 'Designator', 'designator') ?? '').toUpperCase() === parsed.reference.toUpperCase());
	if (!target) throw new Error(`Component ${parsed.reference} not found for ${label}.`);
	const componentId = readAny(target, 'PrimitiveId', 'primitiveId');
	if (!componentId) throw new Error(`Could not resolve primitiveId for component ${parsed.reference}.`);
	const pads = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(String(componentId));
	const pad = (pads || []).find((p: any) => String(readAny(p, 'PadNumber', 'padNumber') ?? '') === parsed.padNumber);
	if (!pad) throw new Error(`Pad ${parsed.padNumber} not found on ${parsed.reference}.`);
	const flat: any = flattenState(pad);
	const rawX = readNumber(pad, 'X', 'x');
	const rawY = readNumber(pad, 'Y', 'y');
	if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) throw new Error(`Could not resolve coordinates for ${padRef}.`);
	const pinScale = await componentPinScale();
	return {
		...flat,
		x: rawX * pinScale,
		y: rawY * pinScale,
		layer: flat?.layer != null ? normalizeLayer(flat.layer) : readAny(pad, 'Layer', 'layer'),
		net: flat?.net ?? readAny(pad, 'Net', 'net'),
		reference: parsed.reference,
		padNumber: parsed.padNumber,
		label: `${parsed.reference}.${parsed.padNumber}`,
		source: 'pad',
		units: 'mil',
		sourceUnits: componentPinSourceUnits(pinScale),
	};
}

function parsePadRef(ref: string): { reference: string; padNumber: string } {
	const trimmed = ref.trim();
	const dot = trimmed.lastIndexOf('.');
	const colon = trimmed.lastIndexOf(':');
	const idx = Math.max(dot, colon);
	if (idx <= 0 || idx >= trimmed.length - 1) {
		throw new Error(`Invalid pad reference "${ref}". Use "U12.6" or "U12:6".`);
	}
	return { reference: trimmed.slice(0, idx), padNumber: trimmed.slice(idx + 1) };
}

function resolveRouteNet(explicit: any, from: Endpoint, to: Endpoint): string {
	if (explicit) return String(explicit);
	if (from.net && to.net && from.net !== to.net) throw new Error(`Endpoint nets differ (${from.net} vs ${to.net}); pass net explicitly to override.`);
	const net = from.net ?? to.net;
	if (!net) throw new Error('Could not infer route net from endpoints; pass net explicitly.');
	return String(net);
}

function planFanoutRoute(args: {
	params: Record<string, any>;
	from: Endpoint;
	to: Endpoint;
	net: string;
	layer: any;
	viaStrategy: string;
	entryLineWidth?: number;
}): { routeStart: Point; routeEnd: Point; vias: ViaSpec[]; stubSegments: LineSpec[] } {
	const { params, from, to, net, layer, viaStrategy, entryLineWidth } = args;
	const viaOffsetMil = Number(firstDefined(params.viaOffsetMil, params.via_offset_mil, DEFAULT_VIA_OFFSET_MIL));
	const routeStart = fanoutPoint(from, to, firstDefined(params.fromFanoutDirection, params.from_fanout_direction, params.direction_hint), viaStrategy, viaOffsetMil);
	const routeEnd = fanoutPoint(to, from, firstDefined(params.toFanoutDirection, params.to_fanout_direction, params.direction_hint), viaStrategy, viaOffsetMil);
	const vias: ViaSpec[] = [];
	const stubs: LineSpec[] = [];
	for (const item of [
		{ endpoint: from, point: routeStart, other: to, role: 'from' },
		{ endpoint: to, point: routeEnd, other: from, role: 'to' },
	]) {
		if (!shouldPlaceVia(viaStrategy)) continue;
		vias.push({
			net,
			x: item.point.x,
			y: item.point.y,
			holeDiameter: Number(params.holeDiameter ?? DEFAULT_VIA_HOLE_MIL),
			diameter: Number(params.diameter ?? DEFAULT_VIA_DIAMETER_MIL),
			viaType: normalizeViaType(params.viaType ?? 'Through'),
			role: `${item.role}_via`,
		});
		if (!pointsEqual(item.endpoint, item.point)) {
			stubs.push({
				net,
				layer: copperLayerOr(layer, item.endpoint.layer),
				startX: item.endpoint.x,
				startY: item.endpoint.y,
				endX: item.point.x,
				endY: item.point.y,
				lineWidth: entryLineWidth,
				role: `${item.role}_fanout_stub`,
			});
		}
	}
	return { routeStart, routeEnd, vias, stubSegments: stubs };
}

function shouldPlaceVia(strategy: string): boolean {
	return strategy === 'fanout' || strategy === 'in_pad';
}

function fanoutPoint(endpoint: Point, other: Point, hint: any, strategy: string, offset: number): Point {
	if (strategy === 'fanout') {
		const dir = directionVector(hint, endpoint, other);
		return { x: endpoint.x + dir.x * offset, y: endpoint.y + dir.y * offset };
	}
	return { x: endpoint.x, y: endpoint.y };
}

function buildRoutePath(start: Point, end: Point, params: Record<string, any>): Point[] {
	const waypoints = Array.isArray(params.waypoints)
		? params.waypoints.filter((p: any) => Number.isFinite(p?.x) && Number.isFinite(p?.y)).map((p: any) => ({ x: Number(p.x), y: Number(p.y) }))
		: [];
	const control = [start, ...waypoints, end];
	let out: Point[] = [];
	for (let i = 0; i < control.length - 1; i++) {
		const sub = buildPathBetween(control[i], control[i + 1], params);
		out = out.length === 0 ? sub : [...out, ...sub.slice(1)];
	}
	return dedupePoints(out);
}

// OPT-IN snap45 post-process: when params.snap45 is set, reproject the route
// path's interior legs onto the nearest 45° direction via the shared geometry
// brain (cleanPolyline). Endpoints (pad/via terminals) are pinned, so the route
// still lands exactly on its pads. Default behavior (flag unset) is unchanged.
function maybeSnap45(path: Point[], params: Record<string, any>): Point[] {
	if (!params?.snap45 || path.length < 3) return path;
	const poly: Polyline = {
		points: path.map((p) => ({ x: p.x, y: p.y })),
		arcAngles: new Array(Math.max(0, path.length - 1)).fill(undefined),
		sourceIds: [],
	};
	const cleaned = cleanPolyline(poly, { snap45: true });
	return dedupePoints(cleaned.points.map((p) => ({ x: p.x, y: p.y })));
}

function buildPathBetween(start: Point, end: Point, params: Record<string, any>): Point[] {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	if (Math.abs(dx) < 1e-9 || Math.abs(dy) < 1e-9) return [start, end];
	const preferred = String(params.preferredDirection ?? params.preferred_direction ?? 'auto');
	const horizontalFirst = preferred === 'horizontal_first' || preferred === 'horizontal'
		? true
		: preferred === 'vertical_first' || preferred === 'vertical'
			? false
			: Math.abs(dx) >= Math.abs(dy);
	const style = String(params.style ?? 'miter45');
	if (style === 'orthogonal' || style === 'manhattan') {
		return horizontalFirst ? [start, { x: end.x, y: start.y }, end] : [start, { x: start.x, y: end.y }, end];
	}
	const sx = Math.sign(dx);
	const sy = Math.sign(dy);
	const miter = Math.max(0, Math.min(
		Number(firstDefined(params.miterMil, params.miter_mil, 40)),
		Math.abs(dx) / 2,
		Math.abs(dy) / 2,
	));
	if (miter <= 0.01) return horizontalFirst ? [start, { x: end.x, y: start.y }, end] : [start, { x: start.x, y: end.y }, end];
	if (horizontalFirst) {
		return [
			start,
			{ x: end.x - sx * miter, y: start.y },
			{ x: end.x, y: start.y + sy * miter },
			end,
		];
	}
	return [
		start,
		{ x: start.x, y: end.y - sy * miter },
		{ x: start.x + sx * miter, y: end.y },
		end,
	];
}

function segmentsFromPath(path: Point[], net: string, layer: any, lineWidth: number | undefined, role: string): LineSpec[] {
	const segments: LineSpec[] = [];
	for (let i = 0; i < path.length - 1; i++) {
		const a = path[i], b = path[i + 1];
		if (pointsEqual(a, b)) continue;
		segments.push({ net, layer, startX: a.x, startY: a.y, endX: b.x, endY: b.y, lineWidth, role });
	}
	return segments;
}

async function createRoutePrimitives(lineSpecs: LineSpec[], viaSpecs: ViaSpec[], primitiveLock: boolean): Promise<{ lines: any[]; vias: any[]; primitiveIds: string[] }> {
	const vias: any[] = [];
	const lines: any[] = [];
	for (const via of viaSpecs) {
		const created = await eda.pcb_PrimitiveVia.create(
			via.net,
			via.x,
			via.y,
			via.holeDiameter,
			via.diameter,
			via.viaType,
			undefined,
			undefined,
			primitiveLock,
		);
		vias.push(flattenState(created));
	}
	for (const s of lineSpecs) {
		const created = await eda.pcb_PrimitiveLine.create(s.net, normalizeLayer(s.layer), s.startX, s.startY, s.endX, s.endY, s.lineWidth, primitiveLock);
		lines.push(flattenState(created));
	}
	const primitiveIds = [...vias, ...lines].map((p) => p?.primitiveId).filter(Boolean);
	return { lines, vias, primitiveIds };
}

// Find the ids of `net`'s existing line/arc primitives that touch the anchor
// point (within a small tolerance scaled by trace width). Used to exempt the
// track the serpentine branches from so it doesn't false-positive on itself.
async function findAnchorAdjacentSegmentIds(net: string, anchor: Point, lineWidth?: number): Promise<string[]> {
	const tol = Math.max(Number.isFinite(lineWidth) ? Number(lineWidth) : 10, 10);
	const ids: string[] = [];
	const touches = (sx: number, sy: number, ex: number, ey: number): boolean => {
		const d = pointToSegmentDistance(anchor, { x: sx, y: sy }, { x: ex, y: ey });
		return Number.isFinite(d) && d <= tol;
	};
	try {
		const lines = await eda.pcb_PrimitiveLine.getAll(net, undefined, undefined);
		for (const l of lines || []) {
			const sx = readNumber(l, 'StartX', 'startX');
			const sy = readNumber(l, 'StartY', 'startY');
			const ex = readNumber(l, 'EndX', 'endX');
			const ey = readNumber(l, 'EndY', 'endY');
			if (![sx, sy, ex, ey].every(Number.isFinite)) continue;
			if (touches(sx, sy, ex, ey)) {
				const id = readAny(l, 'PrimitiveId', 'primitiveId');
				if (id) ids.push(String(id));
			}
		}
	} catch {/* best-effort */}
	try {
		const arcs = await eda.pcb_PrimitiveArc.getAll(net, undefined, undefined);
		for (const a of arcs || []) {
			const sx = readNumber(a, 'StartX', 'startX');
			const sy = readNumber(a, 'StartY', 'startY');
			const ex = readNumber(a, 'EndX', 'endX');
			const ey = readNumber(a, 'EndY', 'endY');
			if (![sx, sy, ex, ey].every(Number.isFinite)) continue;
			// Approximate the arc by its chord for the touch test — adequate for
			// "does this segment start/pass near the anchor" exemption.
			if (touches(sx, sy, ex, ey)) {
				const id = readAny(a, 'PrimitiveId', 'primitiveId');
				if (id) ids.push(String(id));
			}
		}
	} catch {/* best-effort */}
	return ids;
}

function pointToSegmentDistance(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	if (len2 <= 1e-12) return distance(p, a);
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
	return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function resolveLineWidth(params: Record<string, any>, net?: string): number | undefined {
	const map = params.lineWidthByNet ?? params.widthByNet ?? params.traceWidthByNet;
	if (net && map && typeof map === 'object' && Number.isFinite(map[net])) return Number(map[net]);
	const value = firstDefined(params.lineWidth, params.traceWidth, params.traceWidthMil, params.trace_width_mil, params.width_mil, params.widthMil);
	return Number.isFinite(value) ? Number(value) : undefined;
}

function directionVector(hint: any, from: Point, to?: Point): Point {
	if (typeof hint === 'string') {
		const key = hint.trim().toLowerCase();
		if (key === 'left' || key === '-x') return { x: -1, y: 0 };
		if (key === 'right' || key === '+x') return { x: 1, y: 0 };
		if (key === 'up' || key === '-y') return { x: 0, y: -1 };
		if (key === 'down' || key === '+y') return { x: 0, y: 1 };
	}
	if (hint && typeof hint === 'object' && Number.isFinite(hint.x) && Number.isFinite(hint.y)) return normalizeVector({ x: Number(hint.x), y: Number(hint.y) });
	if (to) {
		const dx = to.x - from.x;
		const dy = to.y - from.y;
		if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) > 1e-9) return { x: Math.sign(dx), y: 0 };
		if (Math.abs(dy) > 1e-9) return { x: 0, y: Math.sign(dy) };
	}
	return { x: 1, y: 0 };
}

function pairOffsetVector(pFrom: Point, nFrom: Point, pTo: Point, nTo: Point, centerStart: Point, centerEnd: Point): Point {
	const start = normalizeVector({ x: pFrom.x - nFrom.x, y: pFrom.y - nFrom.y });
	const end = normalizeVector({ x: pTo.x - nTo.x, y: pTo.y - nTo.y });
	const combined = normalizeVector({ x: start.x + end.x, y: start.y + end.y });
	if (Number.isFinite(combined.x) && (Math.abs(combined.x) > 1e-9 || Math.abs(combined.y) > 1e-9)) return combined;
	if (Math.abs(start.x) > 1e-9 || Math.abs(start.y) > 1e-9) return start;
	const route = normalizeVector({ x: centerEnd.x - centerStart.x, y: centerEnd.y - centerStart.y });
	return { x: -route.y, y: route.x };
}

function addSerpentineToPath(path: Point[], extraLength: number, params: Record<string, any>): { path: Point[]; summary: Record<string, any> } {
	if (path.length < 2 || extraLength <= 0) return { path, summary: { addedLengthMil: 0, reason: 'no-op' } };
	let best = 0;
	let bestLen = 0;
	for (let i = 0; i < path.length - 1; i++) {
		const len = distance(path[i], path[i + 1]);
		if (len > bestLen) { best = i; bestLen = len; }
	}
	const maxAmp = Number(firstDefined(params.tuningAmplitudeMil, params.tuning_amplitude_mil, 25));
	const requestedCycles = Number(firstDefined(params.tuningCycles, params.tuning_cycles, 0));
	const cycles = requestedCycles > 0 ? Math.floor(requestedCycles) : Math.max(1, Math.ceil(extraLength / Math.max(1, 2 * maxAmp)));
	const amplitude = Math.min(maxAmp, extraLength / Math.max(1, 2 * cycles));
	const a = path[best];
	const b = path[best + 1];
	const seg = normalizeVector({ x: b.x - a.x, y: b.y - a.y });
	const normal = { x: -seg.y, y: seg.x };
	const step = bestLen / (cycles + 1);
	const inserted: Point[] = [a];
	for (let c = 1; c <= cycles; c++) {
		const base = { x: a.x + seg.x * step * c, y: a.y + seg.y * step * c };
		inserted.push(
			{ x: base.x, y: base.y },
			{ x: base.x + normal.x * amplitude, y: base.y + normal.y * amplitude },
			{ x: base.x, y: base.y },
		);
	}
	inserted.push(b);
	const tuned = [...path.slice(0, best), ...inserted, ...path.slice(best + 2)];
	return {
		path: dedupePoints(tuned),
		summary: {
			insertedAfterSegment: best,
			cycles,
			amplitudeMil: amplitude,
			requestedExtraMil: extraLength,
			approxAddedMil: pathLength(tuned) - pathLength(path),
		},
	};
}

function buildAttachedSerpentineLoop(anchor: Point, extraLength: number, params: Record<string, any>): { path: Point[]; summary: Record<string, any> } {
	const direction = directionVector(firstDefined(params.direction_hint, params.directionHint, 'right'), anchor, undefined);
	const normal = { x: -direction.y, y: direction.x };
	const maxAmp = Number(firstDefined(params.amplitude_mil, params.amplitudeMil, params.tuningAmplitudeMil, 25));
	const cycles = Math.max(1, Math.floor(Number(firstDefined(params.cycles, params.tuningCycles, Math.ceil(extraLength / Math.max(1, 2 * maxAmp))))));
	const amplitude = Math.min(maxAmp, extraLength / Math.max(1, 2 * cycles));
	const pitch = Number(firstDefined(params.pitch_mil, params.pitchMil, 30));
	const points: Point[] = [anchor];
	for (let c = 1; c <= cycles; c++) {
		const base = { x: anchor.x + direction.x * pitch * c, y: anchor.y + direction.y * pitch * c };
		points.push(base, { x: base.x + normal.x * amplitude, y: base.y + normal.y * amplitude }, base);
	}
	points.push(anchor);
	return {
		path: dedupePoints(points),
		summary: { cycles, amplitudeMil: amplitude, pitchMil: pitch, requestedExtraMil: extraLength, approxAddedMil: pathLength(points) },
	};
}

function midpoint(a: Point, b: Point): Point {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function pathLength(path: Point[]): number {
	let total = 0;
	for (let i = 0; i < path.length - 1; i++) total += distance(path[i], path[i + 1]);
	return total;
}

function normalizeVector(v: Point): Point {
	const len = Math.hypot(v.x, v.y);
	if (!Number.isFinite(len) || len <= 1e-9) return { x: 0, y: 0 };
	return { x: v.x / len, y: v.y / len };
}

function pointsEqual(a: Point, b: Point): boolean {
	return Math.hypot(a.x - b.x, a.y - b.y) <= 1e-9;
}

function dedupePoints(points: Point[]): Point[] {
	const out: Point[] = [];
	for (const p of points) {
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
		if (out.length === 0 || !pointsEqual(out[out.length - 1], p)) out.push({ x: p.x, y: p.y });
	}
	return out;
}

function readAny(obj: any, stateName: string, flatName: string): any {
	try {
		const getter = obj?.[`getState_${stateName}`];
		if (typeof getter === 'function') return getter.call(obj);
	} catch {/* */}
	return obj?.[flatName];
}

function readNumber(obj: any, stateName: string, flatName: string): number {
	const value = readAny(obj, stateName, flatName);
	return Number.isFinite(value) ? Number(value) : Number.NaN;
}

function copperLayerOr(fallback: any, candidate: any): any {
	const layer = candidate != null ? normalizeLayer(candidate) : undefined;
	if (layer === 1 || layer === 2 || (typeof layer === 'number' && layer >= 15 && layer <= 44)) return layer;
	return fallback;
}

function firstDefined(...values: any[]): any {
	for (const value of values) if (value !== undefined && value !== null) return value;
	return undefined;
}

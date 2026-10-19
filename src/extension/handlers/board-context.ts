import { flattenState, flattenStateArray, mapWithConcurrency, normalizeLayer, normalizeViaType } from './_utils';
import { componentPinScale } from './pin-units';
import {
	normalizePadShapeUnits,
	checkTraceObstacles,
	fetchDrcRules,
	padToObstacle,
	CLEARANCE_TOLERANCE_MIL,
	polygonCanvasTransform,
	polygonHit,
	violatesClearance,
	resolveClearance,
	type PadObstacle,
	type TraceSegmentSpec,
} from './trace-obstacles';
import {
	clearanceForKind,
	clearanceResolverFromRules,
	resolverForRule,
	resolveTrackWidth,
	resolveViaSize,
	ruleConfigName,
	type ClearanceResolver,
	type ClearanceRule,
} from '../../shared/drc-rules';
import { collectIds, extractOffender, flattenDrcTree, pickGroupKey } from './drc';
import { COORDINATE_SPACE, readPourSource, summarizePolygonSource as summarizeCanvasPolygonSource, type PolygonTransform } from './pour-fill';

type Point = { x: number; y: number };
type Bounds = { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
type Endpoint = Point & { label: string; net?: string; layer?: any; primitiveId?: string; reference?: string; padNumber?: string; componentPrimitiveId?: string };
type ComponentPad = Endpoint & { componentPrimitiveId: string; componentDesignator?: string; localX?: number; localY?: number; pad?: any; hole?: any; rotation?: number };
type Component = {
	primitiveId: string;
	designator?: string;
	name?: string;
	layer?: any;
	x: number;
	y: number;
	rotation?: number;
	primitiveLock?: boolean;
	bounds?: Bounds;
	pinCount: number;
};
type Snapshot = {
	createdAt: number;
	lastAccessedAt: number;
	cacheKey: string;
	document: {
		uuid: string;
		name?: string;
		type?: any;
		version: number;
	};
	components: Component[];
	componentPads: ComponentPad[];
	/** Pads that belong to no component. pcb_PrimitivePad.getAll() also returns every component pad; those are excluded here. */
	standalonePads: any[];
	/** How many pcb_PrimitivePad.getAll() records were dropped from standalonePads as duplicates of componentPads. */
	componentPadDuplicatesExcluded?: number;
	lines: any[];
	polylines: any[];
	vias: any[];
	pours: any[];
	regions: any[];
	keepouts: any[];
	layers: any[];
	nets: string[];
	netIndex: Record<string, NetSnapshot>;
	bounds?: Bounds;
	boardOutline?: {
		bounds?: Bounds;
		lineCount: number;
		polylineCount: number;
		segmentCount: number;
		coordinateSpace: string;
		polylines: Array<{ primitiveId?: string; layer?: any; bounds?: Bounds; summary?: any }>;
	};
};
type NetSnapshot = {
	net: string;
	pads: ComponentPad[];
	standalonePads: any[];
	lines: any[];
	vias: any[];
	pours: any[];
	lengthMil: number;
};

const SNAPSHOT_KEY = '__easyeda_agent_board_snapshot__';
const SNAPSHOT_VERSION_KEY = '__easyeda_agent_board_snapshot_versions__';
const DEFAULT_CACHE_TTL_MS = 10_000;
const DEFAULT_CACHE_MAX_ENTRIES = 4;
const DEFAULT_PIN_CONCURRENCY = 4;
const DEFAULT_LINE_WIDTH_MIL = 10;

/**
 * Clearance the grid pathfinder keeps around each obstacle kind for ONE routed
 * net, taken from the board's Safe Spacing rules (see resolveClearance in
 * trace-obstacles.ts) unless the caller passed clearanceMil. Against copper of
 * another net it is the larger of the two nets' rules (`against(net)`,
 * resolver.between), exactly what the final obstacle preflight checks, so
 * planner and check agree. The top-level values are the routed net's own rule
 * (keepouts, reporting).
 */
type KindClearance = { track: number; via: number; smdPad: number; thPad: number };
type PathClearance = KindClearance & { rule: ClearanceRule; against(obstacleNet: string | undefined): KindClearance };

function pathClearanceFor(resolver: ClearanceResolver, net: string): PathClearance {
	const rule = resolver.for(net);
	// Memoized per obstacle net: pointBlocked asks once per grid cell x obstacle.
	const memo = new Map<string, KindClearance>();
	const against = (obstacleNet: string | undefined): KindClearance => {
		const key = obstacleNet ?? '';
		let hit = memo.get(key);
		if (!hit) {
			hit = {
				track: resolver.between(net, obstacleNet, 'track').clearanceMil,
				via: resolver.between(net, obstacleNet, 'via').clearanceMil,
				smdPad: resolver.between(net, obstacleNet, 'smdPad').clearanceMil,
				thPad: resolver.between(net, obstacleNet, 'thPad').clearanceMil,
			};
			memo.set(key, hit);
		}
		return hit;
	};
	return {
		track: clearanceForKind(rule, 'track'),
		via: clearanceForKind(rule, 'via'),
		smdPad: clearanceForKind(rule, 'smdPad'),
		thPad: clearanceForKind(rule, 'thPad'),
		rule,
		against,
	};
}

function clearanceReport(rule: ClearanceRule): { clearanceMil: number; clearanceSource: string; clearanceByKind?: ClearanceRule['byKind'] } {
	return { clearanceMil: rule.clearanceMil, clearanceSource: rule.source, ...(rule.byKind ? { clearanceByKind: rule.byKind } : {}) };
}

const g = globalThis as any;
let snapshotCache: Map<string, Snapshot> = g[SNAPSHOT_KEY] instanceof Map ? g[SNAPSHOT_KEY] : new Map<string, Snapshot>();
g[SNAPSHOT_KEY] = snapshotCache;
let snapshotVersions: Map<string, number> = g[SNAPSHOT_VERSION_KEY] instanceof Map ? g[SNAPSHOT_VERSION_KEY] : new Map<string, number>();
g[SNAPSHOT_VERSION_KEY] = snapshotVersions;

export function invalidateBoardSnapshotCache(documentUuid?: string): void {
	if (documentUuid) {
		const key = String(documentUuid);
		snapshotVersions.set(key, (snapshotVersions.get(key) ?? 0) + 1);
		for (const cacheKey of Array.from(snapshotCache.keys())) {
			if (cacheKey.startsWith(`${key}@`)) snapshotCache.delete(cacheKey);
		}
		return;
	}
	snapshotCache.clear();
	for (const key of Array.from(snapshotVersions.keys())) {
		snapshotVersions.set(key, (snapshotVersions.get(key) ?? 0) + 1);
	}
}

export const boardContextHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.board.refreshCache': async (params) => {
		const doc = await currentDocumentIdentity();
		invalidateBoardSnapshotCache(doc.uuid);
		const snapshot = await getSnapshot({ ...params, forceRefresh: true });
		return snapshotSummary(snapshot);
	},

	'pcb.routing.presets': async (params) => {
		const snapshot = await getSnapshot(params);
		const nets = resolveNetList(params, snapshot);
		const rules = await safeRuleContext();
		const presets: Record<string, any> = {};
		for (const net of nets) presets[net] = presetForNet(net, rules);
		return {
			units: 'mil',
			presets,
			ruleContext: rules.summary,
			note: 'Board DRC rules (Track width, Safe Spacing, Via Size) win; net-name heuristics only fill values without a usable rule. preset.source names the origin of each value. Agents should pass lineWidth/holeDiameter/diameter explicitly to routing tools.',
		};
	},

	'pcb.context.routing': async (params) => {
		const snapshot = await getSnapshot(params);
		const nets = resolveNetList(params, snapshot);
		const endpoints = resolveEndpointInputs(params, snapshot);
		const area = regionFromParams(params);
		const maxItems = Math.max(1, Math.floor(Number(params.maxItems ?? 80)));
		const rules = await safeRuleContext();
		const contextNets = nets.length > 0 ? nets : unique(endpoints.map((e) => e.net).filter(Boolean) as string[]);

		const netContexts = contextNets.map((net) => {
			const ns = snapshot.netIndex[net] ?? emptyNetSnapshot(net);
			const pairs = nearestPadPairs(ns.pads, Math.max(1, Math.floor(Number(params.maxPairsPerNet ?? 12))));
			return {
				net,
				preset: presetForNet(net, rules),
				padCount: ns.pads.length,
				routePrimitiveCount: ns.lines.length + ns.vias.length,
				lineCount: ns.lines.length,
				viaCount: ns.vias.length,
				pourCount: ns.pours.length,
				lengthMil: round(ns.lengthMil, 1),
				pads: ns.pads.slice(0, maxItems).map(summarizePad),
				nearestPairs: pairs,
				lines: ns.lines.slice(0, maxItems).map(summarizeLine),
				vias: ns.vias.slice(0, maxItems).map(summarizeVia),
			};
		});

		const areaItems = area ? inspectSnapshotArea(snapshot, area, maxItems) : undefined;
		return {
			units: 'mil',
			cache: cacheInfo(snapshot),
			board: {
				bounds: snapshot.bounds,
				boardOutline: snapshot.boardOutline,
				componentCount: snapshot.components.length,
				padCount: snapshot.componentPads.length,
				lineCount: snapshot.lines.length,
				viaCount: snapshot.vias.length,
				netCount: snapshot.nets.length,
			},
			layers: snapshot.layers.map((l) => ({ id: l.id, name: l.name, type: l.type, layerStatus: l.layerStatus, locked: l.locked })).slice(0, 80),
			ruleContext: rules.summary,
			endpoints: endpoints.map(summarizeEndpoint),
			nets: netContexts,
			area: area ? { region: area, ...areaItems } : undefined,
			nextSteps: [
				'Use pcb_get_footprint_map / pcb_suggest_component_rotation before routing dense components.',
				'Use pcb_route_pathfind or pcb_route_smart dryRun first; inspect obstacleCheck before committing.',
				'Use pcb_batch_edit dryRun for multi-segment edits so a partial route is not committed.',
			],
		};
	},

	'pcb.context.netWorklist': async (params) => {
		const snapshot = await getSnapshot(params);
		const includeSinglePad = !!params.includeSinglePad;
		const limit = Math.max(1, Math.floor(Number(params.limit ?? 30)));
		const rules = await safeRuleContext();
		const work = snapshot.nets
			.map((net) => scoreNetForWork(snapshot.netIndex[net] ?? emptyNetSnapshot(net), snapshot, rules))
			.filter((row) => includeSinglePad || row.padCount > 1)
			.filter((row) => params.status ? row.status === params.status : true)
			.sort((a, b) => b.priorityScore - a.priorityScore)
			.slice(0, limit);
		return {
			units: 'mil',
			cache: cacheInfo(snapshot),
			totalNetCount: snapshot.nets.length,
			returned: work.length,
			nets: work,
			note: 'Priority favors multi-pad nets with no route primitives, longer nearest-pad spans, many pads, and obstacle density near ratlines.',
		};
	},

	'pcb.context.inspectArea': async (params) => {
		const snapshot = await getSnapshot(params);
		const region = regionFromParams(params);
		if (!region) throw new Error('pcb_inspect_area requires {left,right,top,bottom}, {x,y,radiusMil}, or {startX,startY,endX,endY,marginMil}.');
		const maxItems = Math.max(1, Math.floor(Number(params.maxItems ?? 80)));
		const inspection = inspectSnapshotArea(snapshot, region, maxItems);
		const nets = unique([
			...inspection.componentPads.map((p: any) => p.net).filter(Boolean),
			...inspection.lines.map((l: any) => l.net).filter(Boolean),
			...inspection.vias.map((v: any) => v.net).filter(Boolean),
		]);
		return {
			units: 'mil',
			cache: cacheInfo(snapshot),
			region,
			nets,
			...inspection,
			screenshotHint: {
				tool: 'pcb_screenshot_closeup',
				args: { left: region.minX, right: region.maxX, top: region.minY, bottom: region.maxY, document: params.document },
			},
		};
	},

	'pcb.context.keepouts': async (params) => {
		const snapshot = await getSnapshot(params);
		const region = regionFromParams(params);
		const maxItems = Math.max(1, Math.floor(Number(params.maxItems ?? 100)));
		const rows = (region ? snapshot.keepouts.filter((k) => {
			const b = boundsOfPrimitive(k);
			return b ? boundsOverlap(b, region) : true;
		}) : snapshot.keepouts).slice(0, maxItems);
		return {
			units: 'mil',
			cache: cacheInfo(snapshot),
			totalKeepoutCandidates: snapshot.keepouts.length,
			returned: rows.length,
			truncated: rows.length < snapshot.keepouts.length,
			region,
			keepouts: rows.map(summarizeRegion),
			note: 'EasyEDA exposes keepouts as DRC regions. This tool returns regions whose rule/name fields look like keepout/no-route/no-copper constraints; inspect pcb_get_all_regions if a board uses custom rule labels.',
		};
	},

	'pcb.context.obstacleMap': async (params) => {
		const snapshot = await getSnapshot(params);
		return summarizeObstacleMap(snapshot);
	},

	'pcb.route.pathfind': async (params) => {
		const snapshot = await getSnapshot(params);
		const fromInput = pathfindEndpointInput(params, 'from');
		const toInput = pathfindEndpointInput(params, 'to');
		const from = resolveEndpoint(fromInput, snapshot, 'from_pad');
		const to = resolveEndpoint(toInput, snapshot, 'to_pad');
		if (!params.net && !from.net && !to.net) {
			throw new Error('pcb_route_pathfind: pass net when both ends are points (startX/startY/endX/endY or {x,y}) — a bare point has no net.');
		}
		const net = resolveRouteNet(params.net, from, to);
		const layer = normalizeLayer(firstDefined(params.layer, params.layer_preference, params.layerPreference, from.layer, 'TopLayer'));
		const lineWidth = resolveLineWidth(params, net);
		const clearanceRules = await resolveClearance([net], params);
		const plan = pathfind(snapshot, from, to, {
			net,
			layer,
			lineWidth,
			gridMil: Number(params.gridMil ?? 50),
			clearance: pathClearanceFor(clearanceRules, net),
			searchMarginMil: Number(params.searchMarginMil ?? 1200),
			maxNodes: Math.max(100, Math.floor(Number(params.maxNodes ?? 20000))),
			allowDiagonals: params.allowDiagonals !== false,
			ignoreSameNet: params.ignoreSameNet !== false,
			pullTight: params.pullTight !== false,
			pullTightPasses: Math.max(1, Math.floor(Number(params.pullTightPasses ?? 2))),
			pullTightSampleMil: Number(params.pullTightSampleMil),
			pullTightRequire45: params.pullTightRequire45 !== false,
		});
		const obstacleCheck = await checkTraceObstacles({
			...params,
			net,
			layer,
			lineWidth,
			segments: plan.segments,
			failOnObstacle: false,
			ignorePrimitiveIds: [from.primitiveId, to.primitiveId, ...(Array.isArray(params.ignorePrimitiveIds) ? params.ignorePrimitiveIds : [])].filter(Boolean),
		});
		const dryRun = !!params.dryRun;
		const failOnObstacle = params.failOnObstacle !== false;
		if (!dryRun && failOnObstacle && obstacleCheck.blockingObstacleCount > 0) {
			throw new Error(`Pathfind produced ${obstacleCheck.blockingObstacleCount} residual obstacle(s). Increase clearance/grid resolution or add waypoints. Sample: ${JSON.stringify(obstacleCheck.obstacles.slice(0, 5))}`);
		}
		const created = dryRun ? { lines: [], vias: [], primitiveIds: [] } : await createLineSegments(plan.segments, !!params.primitiveLock);
		if (!dryRun) invalidateSnapshot();
		return {
			dryRun,
			units: 'mil',
			net,
			layer,
			lineWidth,
			from: summarizeEndpoint(from),
			to: summarizeEndpoint(to),
			...plan,
			obstacleCheck,
			created,
		};
	},

	'pcb.route.net': async (params) => {
		const snapshot = await getSnapshot(params);
		const result = await routeNetOnSnapshot(cloneRoutingSnapshot(snapshot), params);
		if (!result.dryRun && result.created.primitiveIds.length > 0) invalidateSnapshot();
		return result;
	},

	'pcb.route.nets': async (params) => {
		const snapshot = await getSnapshot(params);
		const workingSnapshot = cloneRoutingSnapshot(snapshot);
		const selected = selectRouteNetsForRouting(workingSnapshot, params);
		const clearanceRules = await resolveClearance(selected.map((row) => row.net), params);
		const dryRun = params.dryRun !== false;
		const stopOnNetFailure = params.stopOnNetFailure !== false;
		const results: any[] = [];
		const created = { lines: [] as any[], vias: [] as any[], primitiveIds: [] as string[] };
		let routedNetCount = 0;
		let failedNetCount = 0;
		let skippedNetCount = 0;
		let routedPairCount = 0;
		let failedPairCount = 0;
		let totalSegmentCount = 0;
		let estimatedLengthMil = 0;

		for (let index = 0; index < selected.length; index++) {
			const row = selected[index];
			try {
				const result = await routeNetOnSnapshot(workingSnapshot, { ...params, net: row.net }, clearanceRules);
				created.lines.push(...result.created.lines);
				created.vias.push(...result.created.vias);
				created.primitiveIds.push(...result.created.primitiveIds);
				routedPairCount += result.routedPairCount;
				failedPairCount += result.failedPairCount;
				totalSegmentCount += result.totalSegmentCount;
				estimatedLengthMil += Number(result.estimatedLengthMil ?? 0);
				if (result.failedPairCount > 0) failedNetCount += 1;
				else if (result.routedPairCount > 0) routedNetCount += 1;
				else skippedNetCount += 1;
				results.push({ index, source: row.source, worklist: row.worklist, ...result });
				if (result.failedPairCount > 0 && stopOnNetFailure) break;
			} catch (error: any) {
				failedNetCount += 1;
				results.push({
					index,
					status: 'failed',
					net: row.net,
					source: row.source,
					worklist: row.worklist,
					...clearanceReport(clearanceRules.for(row.net)),
					error: String(error?.message ?? error),
				});
				if (stopOnNetFailure) break;
			}
		}
		if (!dryRun && created.primitiveIds.length > 0) invalidateSnapshot();
		return {
			dryRun,
			committed: !dryRun && created.primitiveIds.length > 0,
			units: 'mil',
			selectedNetCount: selected.length,
			attemptedNetCount: results.length,
			routedNetCount,
			failedNetCount,
			skippedNetCount,
			routedPairCount,
			failedPairCount,
			totalSegmentCount,
			estimatedLengthMil: round(estimatedLengthMil, 1),
			clearanceMil: clearanceRules.summary.clearanceMil,
			clearanceSource: clearanceRules.summary.clearanceSource,
			clearanceRules: clearanceRules.summary,
			nets: results,
			created,
			note: 'First-slice multi-net routing uses the worklist order and a shared working snapshot, so accepted earlier net plans become obstacles for later nets. Review dryRun results before committing.',
		};
	},

	'pcb.route.andVerify': async (params) => {
		const route = await boardContextHandlers['pcb.route.nets'](params);
		const dryRun = route.dryRun !== false;
		const routedNets = route.nets.map((row: any) => row.net).filter(Boolean);
		const verifyConnectivity = params.verifyConnectivity === true || (!dryRun && params.verifyConnectivity !== false);
		const runDrc = params.runDrc === true || (!dryRun && params.runDrc !== false);
		const verification: any = {
			scope: dryRun
				? (verifyConnectivity || runDrc ? 'current_board_dry_run_not_applied' : 'dry_run_plan_only')
				: 'committed_board',
			connectivity: verifyConnectivity
				? summarizeSnapshotConnectivity(await getSnapshot({ ...params, forceRefresh: route.committed }), routedNets)
				: { skipped: true, reason: dryRun ? 'dry_run_not_committed' : 'verifyConnectivity_false' },
			drc: runDrc
				? await summarizeDrcForClosure(params)
				: { skipped: true, reason: dryRun ? 'dry_run_not_committed' : 'runDrc_false' },
		};
		const verdict = routeClosureVerdict(route, verification);
		return {
			dryRun,
			committed: route.committed,
			units: 'mil',
			clearanceMil: route.clearanceMil,
			clearanceSource: route.clearanceSource,
			route,
			verification,
			verdict,
			nextActions: routeClosureNextActions(verdict, route, verification),
		};
	},

	'pcb.route.retryPlan': async (params) => {
		const route = firstDefined(params.routeResult?.route, params.routeResult, params.route)
			?? await boardContextHandlers['pcb.route.nets']({ ...params, dryRun: true });
		const snapshot = await getSnapshot(params);
		const plan = planRipupRetry(snapshot, route, params);
		// The clearance the recommended retries will route with (clearanceMil is
		// forwarded to them only when the caller passed it).
		const clearanceRules = await resolveClearance(routeNetResults(route).map((row: any) => stringOrUndefined(row?.net)), params);
		return {
			dryRun: true,
			units: 'mil',
			clearanceMil: clearanceRules.summary.clearanceMil,
			clearanceSource: clearanceRules.summary.clearanceSource,
			clearanceRules: clearanceRules.summary,
			routeSummary: summarizeRouteForRetry(route),
			...plan,
			note: 'Read-only retry planner. Review candidates before deleting copper; use pcb_delete_primitives only when the proposed rip-up is acceptable.',
		};
	},

	'pcb.batch.edit': async (params) => {
		// `edits` is the alias agents kept guessing.
		if (params.operations != null && params.edits != null) throw new Error('pcb_batch_edit: pass operations:[...] or its alias edits:[...], not both.');
		const rawOperations = firstDefined(params.operations, params.edits);
		const operations = Array.isArray(rawOperations) ? rawOperations : [];
		if (operations.length === 0) throw new Error('pcb_batch_edit requires operations:[...] (alias: edits).');
		const dryRun = params.dryRun !== false;
		const failOnObstacle = params.failOnObstacle !== false;
		const normalized = normalizeBatchOperations(operations);
		const unsupported = normalized.filter((op) => op.type === 'unsupported');
		if (unsupported.length) {
			throw new Error(`pcb_batch_edit: unsupported operation type(s) ${unsupported.map((op) => `#${op.index} "${op.originalType}"`).join(', ')} — nothing was executed. Supported: create_track, create_via, modify_component/move_component/apply_component_rotation, delete.`);
		}
		const invalid = normalized.filter((op) => op.type === 'invalid');
		if (invalid.length) {
			throw new Error(`pcb_batch_edit: ${invalid.map((op) => `operation #${op.index} (${op.originalType}): ${op.errors.join('; ')}`).join(' | ')} — nothing was executed.`);
		}
		const trackSegments = normalized
			.filter((op) => op.type === 'create_track')
			.map((op) => op.segment as TraceSegmentSpec);
		// Copper this batch deletes must not block the copper it creates
		// (rip-up and reroute in one batch).
		const deletedIds = normalized.filter((op) => op.type === 'delete').flatMap((op) => (Array.isArray(op.ids) ? op.ids : [op.ids]).map(String));
		const obstacleCheck = trackSegments.length > 0
			? await checkTraceObstacles({
				...params,
				segments: trackSegments,
				failOnObstacle: false,
				maxObstacles: params.maxObstacles ?? 100,
				ignorePrimitiveIds: [...(Array.isArray(params.ignorePrimitiveIds) ? params.ignorePrimitiveIds : []), ...deletedIds],
			})
			: undefined;
		if (failOnObstacle && obstacleCheck && obstacleCheck.blockingObstacleCount > 0) {
			return {
				dryRun: true,
				committed: false,
				reason: 'blocking_obstacles',
				operationCount: operations.length,
				normalized,
				obstacleCheck,
			};
		}
		if (dryRun) {
			return { dryRun: true, committed: false, operationCount: operations.length, normalized, obstacleCheck };
		}
		const commit = await commitBatchOperations(normalized, params.atomic !== false);
		invalidateSnapshot();
		return { dryRun: false, operationCount: operations.length, ...commit, obstacleCheck };
	},

	'pcb.placement.suggestMove': async (params) => {
		const snapshot = await getSnapshot(params);
		const component = resolveComponent(params, snapshot);
		return suggestMove(snapshot, component, params);
	},

	'pcb.placement.reviewPlacement': async (params) => {
		const snapshot = await getSnapshot(params);
		const limit = Math.max(1, Math.floor(Number(params.limit ?? 10)));
		const refs = new Set<string>(Array.isArray(params.references) ? params.references.map((r: any) => String(r).toUpperCase()) : []);
		const candidates = snapshot.components
			.filter((c) => c.pinCount > 1)
			.filter((c) => refs.size === 0 || refs.has(String(c.designator ?? '').toUpperCase()))
			.filter((c) => params.respectLocked === false || !c.primitiveLock)
			.slice(0, Math.max(1, Math.floor(Number(params.maxComponents ?? 150))));
		const recommendations = candidates
			.map((component) => suggestMove(snapshot, component, { ...params, quiet: true }))
			.filter((r) => r.improvementScoreMil > Number(params.minScoreImprovementMil ?? 100))
			.sort((a, b) => b.improvementScoreMil - a.improvementScoreMil)
			.slice(0, limit);
		return {
			units: 'mil',
			scannedComponentCount: candidates.length,
			recommendations,
			note: 'Move suggestions are heuristic: nearest same-net ratline length plus approximate component bbox collisions. Use dry-run apply/move and DRC before routing.',
		};
	},
};

export async function getSnapshot(params: Record<string, any> = {}): Promise<Snapshot> {
	const ttl = Math.max(0, Number(params.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS));
	const maxEntries = Math.max(1, Math.floor(Number(params.cacheMaxEntries ?? params.snapshotCacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES)));
	const document = await currentDocumentIdentity();
	const version = snapshotVersions.get(document.uuid) ?? 0;
	const cacheKey = `${document.uuid}@${version}`;
	const cached = snapshotCache.get(cacheKey);
	if (!params.forceRefresh && cached && Date.now() - cached.createdAt <= ttl) {
		cached.lastAccessedAt = Date.now();
		snapshotCache.delete(cacheKey);
		snapshotCache.set(cacheKey, cached);
		return cached;
	}

	const [rawComponents, rawLines, rawPolylines, rawVias, rawPads, rawPours, rawRegions, rawLayers, rawNets] = await Promise.all([
		eda.pcb_PrimitiveComponent.getAll().catch(() => []),
		eda.pcb_PrimitiveLine.getAll(undefined, undefined, undefined).catch(() => []),
		eda.pcb_PrimitivePolyline.getAll(undefined, undefined, undefined).catch(() => []),
		eda.pcb_PrimitiveVia.getAll(undefined, undefined).catch(() => []),
		eda.pcb_PrimitivePad.getAll(undefined, undefined, undefined).catch(() => []),
		eda.pcb_PrimitivePour.getAll(undefined, undefined, undefined).catch(() => []),
		(eda as any).pcb_PrimitiveRegion?.getAll?.(undefined, undefined, undefined).catch(() => []) ?? [],
		eda.pcb_Layer.getAllLayers().catch(() => []),
		eda.pcb_Net.getAllNetsName().catch(() => []),
	]);

	const componentsFlat = flattenStateArray(rawComponents as any[]);
	const lines = flattenStateArray(rawLines as any[]).map(normalizeLine);
	// Polygon sources (outline polylines, pours, regions) are Y-down relative
	// to the data origin; everything else here is canvas Y-up.
	const polygonTransform = await polygonCanvasTransform();
	const polylines = flattenStateArray(rawPolylines as any[]).map((p, i) => normalizePolylinePrimitive(p, (rawPolylines as any[])[i], polygonTransform));
	const vias = flattenStateArray(rawVias as any[]).map(normalizeVia);
	const allPads = flattenStateArray(rawPads as any[]).map(normalizeStandalonePad);
	const pours =flattenStateArray(rawPours as any[]).map((p, i) => normalizePolygonPrimitive(p, (rawPours as any[])[i], 'pour', polygonTransform));
	const regions = flattenStateArray(rawRegions as any[]).map((r, i) => normalizePolygonPrimitive(r, (rawRegions as any[])[i], 'region', polygonTransform));
	const keepouts = regions.filter(isKeepoutRegion);
	const layers = Array.isArray(rawLayers) ? rawLayers : [];
	const nets = Array.isArray(rawNets) ? rawNets.map(String) : [];
	const components: Component[] = [];
	const componentPads: ComponentPad[] = [];
	const pinConcurrency = Math.max(1, Math.min(8, Math.floor(Number(params.pinConcurrency ?? DEFAULT_PIN_CONCURRENCY))));

	const pinScale = await componentPinScale();
	await mapWithConcurrency(componentsFlat, pinConcurrency, async (flat) => {
		const primitiveId = stringOrUndefined(firstDefined(flat.primitiveId, flat.id));
		if (!primitiveId) return;
		const x = Number(flat.x);
		const y = Number(flat.y);
		const designator = stringOrUndefined(flat.designator);
		const pinsRaw = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId).catch(() => []);
		const pins = flattenStateArray(pinsRaw as any[]).map((pin, index) => normalizeComponentPad(pin, primitiveId, designator, { x, y }, index, pinScale));
		const pinBounds = boundsForPoints(pins);
		components.push({
			primitiveId,
			designator,
			name: stringOrUndefined(firstDefined(flat.name, flat.packageName)),
			layer: normalizeLayerSafe(flat.layer),
			x: Number.isFinite(x) ? x : pinBounds ? (pinBounds.minX + pinBounds.maxX) / 2 : 0,
			y: Number.isFinite(y) ? y : pinBounds ? (pinBounds.minY + pinBounds.maxY) / 2 : 0,
			rotation: Number.isFinite(Number(flat.rotation)) ? Number(flat.rotation) : undefined,
			primitiveLock: !!flat.primitiveLock,
			bounds: pinBounds ? expandBounds(pinBounds, 35) : undefined,
			pinCount: pins.length,
		});
		componentPads.push(...pins);
	});

	// pcb_PrimitivePad.getAll() returns EVERY pad, component pads included (336
	// of 344 on a real board, ~47% of a routing packet), under the same
	// primitiveId as getAllPinsByPrimitiveId. Keep only pads no component
	// reported; a component whose pin fetch failed keeps its pads here, as the
	// only copy.
	const componentPadIds = new Set(componentPads.map((p) => p.primitiveId).filter((id): id is string => !!id));
	const standalonePads = allPads.filter((p) => !(p.primitiveId && componentPadIds.has(p.primitiveId)));
	const componentPadDuplicatesExcluded = allPads.length - standalonePads.length;

	const netSet = new Set<string>(nets);
	for (const item of [...componentPads, ...standalonePads, ...lines, ...vias, ...pours]) {
		if (item?.net) netSet.add(String(item.net));
	}
	const allNets = Array.from(netSet).filter(Boolean).sort();
	const netIndex: Record<string, NetSnapshot> = {};
	await mapWithConcurrency(allNets, 8, async (net) => {
		const ns = emptyNetSnapshot(net);
		ns.pads = componentPads.filter((p) => p.net === net);
		ns.standalonePads = standalonePads.filter((p) => p.net === net);
		ns.lines = lines.filter((l) => l.net === net);
		ns.vias = vias.filter((v) => v.net === net);
		ns.pours = pours.filter((p) => p.net === net);
		ns.lengthMil = Number(await eda.pcb_Net.getNetLength(net).catch(() => 0)) || sumLineLengths(ns.lines);
		netIndex[net] = ns;
	});

	const allBounds = [
		...lines.flatMap((l) => [{ x: l.startX, y: l.startY }, { x: l.endX, y: l.endY }]),
		...vias.map((v) => ({ x: v.x, y: v.y })),
		...standalonePads.map((p) => ({ x: p.x, y: p.y })),
		...componentPads.map((p) => ({ x: p.x, y: p.y })),
	];
	const boardOutlineLines = lines.filter((l) => normalizeLayerSafe(l.layer) === 11);
	const boardOutlinePolylines = polylines.filter((p) => normalizeLayerSafe(p.layer) === 11);
	const outlineBounds = boundsForPoints([
		...boardOutlineLines.flatMap((l) => [{ x: l.startX, y: l.startY }, { x: l.endX, y: l.endY }]),
		...boardOutlinePolylines.flatMap((p) => boundsCorners(p.bounds)),
	]);

	const snapshot: Snapshot = {
		createdAt: Date.now(),
		lastAccessedAt: Date.now(),
		cacheKey,
		document: { ...document, version },
		components,
		componentPads,
		standalonePads,
		componentPadDuplicatesExcluded,
		lines,
		polylines,
		vias,
		pours,
		regions,
		keepouts,
		layers,
		nets: allNets,
		netIndex,
		bounds: boundsForPoints(allBounds),
		boardOutline: {
			bounds: outlineBounds,
			lineCount: boardOutlineLines.length,
			polylineCount: boardOutlinePolylines.length,
			segmentCount: boardOutlineLines.length + boardOutlinePolylines.length,
			coordinateSpace: COORDINATE_SPACE,
			polylines: boardOutlinePolylines.map((p) => ({
				primitiveId: p.primitiveId,
				layer: p.layer,
				bounds: p.bounds,
				summary: p.summary,
			})),
		},
	};
	snapshotCache.set(cacheKey, snapshot);
	evictSnapshotCache(maxEntries, ttl);
	return snapshot;
}

export function invalidateSnapshot(): void {
	invalidateBoardSnapshotCache();
}

async function currentDocumentIdentity(): Promise<{ uuid: string; name?: string; type?: any }> {
	const doc = await (eda as any).dmt_SelectControl?.getCurrentDocumentInfo?.().catch(() => undefined);
	const uuid = stringOrUndefined(firstDefined(doc?.tabId, doc?.uuid, doc?.documentUuid, doc?.currentDocument, doc?.id)) ?? '__active_pcb__';
	return {
		uuid,
		name: stringOrUndefined(firstDefined(doc?.title, doc?.name)),
		type: firstDefined(doc?.documentType, doc?.type),
	};
}

function evictSnapshotCache(maxEntries: number, ttl: number): void {
	const now = Date.now();
	for (const [key, snapshot] of Array.from(snapshotCache.entries())) {
		if (ttl > 0 && now - snapshot.createdAt > ttl) snapshotCache.delete(key);
	}
	while (snapshotCache.size > maxEntries) {
		let oldestKey: string | undefined;
		let oldestAccess = Number.POSITIVE_INFINITY;
		for (const [key, snapshot] of snapshotCache.entries()) {
			if (snapshot.lastAccessedAt < oldestAccess) {
				oldestAccess = snapshot.lastAccessedAt;
				oldestKey = key;
			}
		}
		if (!oldestKey) break;
		snapshotCache.delete(oldestKey);
	}
}

function normalizeLine(line: any): any {
	return {
		...line,
		primitiveId: stringOrUndefined(firstDefined(line.primitiveId, line.id)),
		net: stringOrUndefined(line.net),
		layer: normalizeLayerSafe(line.layer),
		startX: Number(line.startX),
		startY: Number(line.startY),
		endX: Number(line.endX),
		endY: Number(line.endY),
		lineWidth: Number.isFinite(Number(line.lineWidth)) ? Number(line.lineWidth) : undefined,
	};
}

function normalizeVia(via: any): any {
	return {
		...via,
		primitiveId: stringOrUndefined(firstDefined(via.primitiveId, via.id)),
		net: stringOrUndefined(via.net),
		x: Number(via.x),
		y: Number(via.y),
		diameter: Number.isFinite(Number(via.diameter)) ? Number(via.diameter) : undefined,
		holeDiameter: Number.isFinite(Number(via.holeDiameter)) ? Number(via.holeDiameter) : undefined,
	};
}

// Standalone pads report coordinates and `pad` extents in mil, but their
// `hole` tuple is still 10-mil units — normalizePadShapeUnits fixes only that.
function normalizeStandalonePad(pad: any): any {
	return normalizePadShapeUnits({
		...pad,
		primitiveId: stringOrUndefined(firstDefined(pad.primitiveId, pad.id)),
		net: stringOrUndefined(pad.net),
		layer: normalizeLayerSafe(pad.layer),
		x: firstFinite(pad.x, pad.centerX, pad.startX, pad.endX),
		y: firstFinite(pad.y, pad.centerY, pad.startY, pad.endY),
		padNumber: stringOrUndefined(firstDefined(pad.padNumber, pad.pinNumber, pad.number, pad.name)),
	});
}

function normalizePolygonPrimitive(flat: any, raw: any, kind: 'pour' | 'region', transform?: PolygonTransform): any {
	const source = readPolygonSource(raw) ?? readPolygonSource(flat);
	const points = polygonSourcePoints(source).map((p) => (transform ? { x: transform.x(p.x), y: transform.y(p.y) } : p));
	const bounds = (points.length > 0 ? boundsForPoints(points) : undefined) ?? boundsFromAny(flat);
	return {
		...flat,
		primitiveId: stringOrUndefined(firstDefined(flat.primitiveId, flat.id)),
		net: stringOrUndefined(firstDefined(flat.net, flat.netName)),
		layer: normalizeLayerSafe(flat.layer),
		kind,
		sourceSummary: source ? { ...summarizePolygonSource(source), bounds } : undefined,
		bounds,
		coordinateSpace: transform ? COORDINATE_SPACE : undefined,
	};
}

// Polylines carry the board outline on layer 11 (and free-form graphics
// elsewhere). Their geometry only exists in the polygon source, so summarize it
// in the canvas Y convention the rest of the snapshot uses.
function normalizePolylinePrimitive(flat: any, raw: any, transform?: PolygonTransform): any {
	const summary = summarizeCanvasPolygonSource(readPourSource(raw) ?? readPourSource(flat), transform);
	return {
		...flat,
		primitiveId: stringOrUndefined(firstDefined(flat.primitiveId, flat.id)),
		net: stringOrUndefined(firstDefined(flat.net, flat.netName)),
		layer: normalizeLayerSafe(flat.layer),
		kind: 'polyline',
		summary,
		bounds: boundsFromAny(summary?.bbox) ?? boundsFromAny(flat),
		coordinateSpace: COORDINATE_SPACE,
	};
}

function boundsCorners(bounds: Bounds | undefined): Point[] {
	if (!bounds) return [];
	return [
		{ x: bounds.minX, y: bounds.minY },
		{ x: bounds.maxX, y: bounds.maxY },
	];
}

function normalizeComponentPad(pin: any, componentPrimitiveId: string, componentDesignator: string | undefined, origin: Point, index: number, pinScale: number): ComponentPad {
	const flat: Record<string, any> = { ...pin };
	for (const key of ['x', 'y', 'centerX', 'centerY', 'startX', 'startY', 'endX', 'endY']) {
		if (typeof flat[key] === 'number' && Number.isFinite(flat[key])) flat[key] = flat[key] * pinScale;
	}
	normalizePadShapeUnits(flat);
	const x = firstFinite(flat.x, flat.centerX, flat.startX, flat.endX);
	const y = firstFinite(flat.y, flat.centerY, flat.startY, flat.endY);
	const padNumber = stringOrUndefined(firstDefined(flat.padNumber, flat.pinNumber, flat.number, flat.name, index + 1));
	return {
		primitiveId: stringOrUndefined(firstDefined(flat.primitiveId, flat.id)),
		label: componentDesignator && padNumber ? `${componentDesignator}.${padNumber}` : String(flat.primitiveId ?? padNumber ?? index + 1),
		reference: componentDesignator,
		padNumber,
		net: stringOrUndefined(firstDefined(flat.net, flat.netName)),
		layer: normalizeLayerSafe(flat.layer),
		x,
		y,
		localX: Number.isFinite(origin.x) ? x - origin.x : undefined,
		localY: Number.isFinite(origin.y) ? y - origin.y : undefined,
		pad: flat.pad,
		hole: flat.hole,
		rotation: flat.rotation,
		componentPrimitiveId,
		componentDesignator,
	};
}

function resolveNetList(params: Record<string, any>, snapshot: Snapshot): string[] {
	if (Array.isArray(params.nets) && params.nets.length > 0) return unique(params.nets.map(String));
	if (params.net) return [String(params.net)];
	return [];
}

function resolveEndpointInputs(params: Record<string, any>, snapshot: Snapshot): Endpoint[] {
	const inputs = [
		params.from_pad ?? params.fromPad ?? params.from,
		params.to_pad ?? params.toPad ?? params.to,
		...(Array.isArray(params.endpoints) ? params.endpoints : []),
	].filter((x) => x != null);
	const endpoints: Endpoint[] = [];
	for (let i = 0; i < inputs.length; i++) {
		try { endpoints.push(resolveEndpoint(inputs[i], snapshot, `endpoint_${i + 1}`)); } catch { /* optional context input */ }
	}
	return endpoints;
}

/**
 * One pcb_route_pathfind endpoint: from_pad / to_pad (aliases fromPad|from,
 * toPad|to), or the point form agents kept guessing — startX/startY for the
 * start, endX/endY for the end (mil). Both forms for one end is an error.
 */
function pathfindEndpointInput(params: Record<string, any>, side: 'from' | 'to'): any {
	const padKey = side === 'from' ? 'from_pad' : 'to_pad';
	const [xKey, yKey] = side === 'from' ? ['startX', 'startY'] : ['endX', 'endY'];
	const pad = side === 'from'
		? firstDefined(params.from_pad, params.fromPad, params.from)
		: firstDefined(params.to_pad, params.toPad, params.to);
	const hasPoint = params[xKey] != null || params[yKey] != null;
	if (pad != null && hasPoint) throw new Error(`pcb_route_pathfind: pass either ${padKey} or ${xKey}/${yKey}, not both.`);
	if (pad != null) return pad;
	if (!hasPoint) throw new Error(`pcb_route_pathfind requires ${padKey} ("U1.3", {reference,padNumber} or {x,y}) or ${xKey}/${yKey} (mil).`);
	const x = Number(params[xKey]);
	const y = Number(params[yKey]);
	if (params[xKey] == null || params[yKey] == null || !Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error(`pcb_route_pathfind: ${xKey} and ${yKey} must both be numbers (mil).`);
	}
	return { x, y, label: padKey };
}

function resolveEndpoint(input: any, snapshot: Snapshot, label: string): Endpoint {
	if (input == null) throw new Error(`${label} is required.`);
	if (typeof input === 'string') {
		const parsed = parsePadRef(input);
		const pad = snapshot.componentPads.find((p) =>
			String(p.componentDesignator ?? '').toUpperCase() === parsed.reference.toUpperCase() &&
			String(p.padNumber ?? '') === parsed.padNumber,
		);
		if (!pad) throw new Error(`Pad ${input} not found.`);
		return pad;
	}
	if (typeof input !== 'object') throw new Error(`${label} must be a pad reference or {x,y}.`);
	if (Number.isFinite(input.x) && Number.isFinite(input.y)) {
		return {
			x: Number(input.x),
			y: Number(input.y),
			layer: input.layer != null ? normalizeLayerSafe(input.layer) : undefined,
			net: stringOrUndefined(input.net),
			label: stringOrUndefined(input.label) ?? label,
		};
	}
	const padRef = input.pad_ref ?? input.padRef ?? input.ref;
	if (typeof padRef === 'string') return resolveEndpoint(padRef, snapshot, label);
	const reference = input.reference ?? input.designator;
	const padNumber = input.padNumber ?? input.pad_number ?? input.pin ?? input.pinNumber;
	if (reference != null && padNumber != null) return resolveEndpoint(`${reference}.${padNumber}`, snapshot, label);
	throw new Error(`${label} must be "U1.3", {reference,padNumber}, {pad_ref}, or {x,y}.`);
}

function parsePadRef(ref: string): { reference: string; padNumber: string } {
	const trimmed = ref.trim();
	const dot = trimmed.lastIndexOf('.');
	const colon = trimmed.lastIndexOf(':');
	const idx = Math.max(dot, colon);
	if (idx <= 0 || idx >= trimmed.length - 1) throw new Error(`Invalid pad reference "${ref}". Use "U12.6" or "U12:6".`);
	return { reference: trimmed.slice(0, idx), padNumber: trimmed.slice(idx + 1) };
}

function resolveRouteNet(explicit: any, from: Endpoint, to: Endpoint): string {
	if (explicit) return String(explicit);
	if (from.net && to.net && from.net !== to.net) throw new Error(`Endpoint nets differ (${from.net} vs ${to.net}); pass net explicitly.`);
	const net = from.net ?? to.net;
	if (!net) throw new Error('Could not infer route net; pass net explicitly.');
	return net;
}

function pathfind(
	snapshot: Snapshot,
	from: Endpoint,
	to: Endpoint,
	opts: {
		net: string;
		layer: any;
		lineWidth?: number;
		gridMil: number;
		clearance: PathClearance;
		searchMarginMil: number;
		maxNodes: number;
		allowDiagonals: boolean;
		ignoreSameNet: boolean;
		pullTight?: boolean;
		pullTightPasses?: number;
		pullTightSampleMil?: number;
		pullTightRequire45?: boolean;
	},
): any {
	const step = Math.max(10, opts.gridMil || 50);
	const rawBounds = boundsForPoints([from, to])!;
	const region = expandBounds(rawBounds, Math.max(step * 4, opts.searchMarginMil));
	const cols = Math.ceil(region.width / step) + 1;
	const rows = Math.ceil(region.height / step) + 1;
	if (cols * rows > opts.maxNodes) {
		throw new Error(`Pathfind grid would create ${cols * rows} nodes. Increase gridMil or reduce searchMarginMil/maxNodes.`);
	}
	const toGrid = (p: Point) => ({
		c: clamp(Math.round((p.x - region.minX) / step), 0, cols - 1),
		r: clamp(Math.round((p.y - region.minY) / step), 0, rows - 1),
	});
	const toPoint = (n: { c: number; r: number }): Point => ({ x: region.minX + n.c * step, y: region.minY + n.r * step });
	const start = toGrid(from);
	const goal = toGrid(to);
	const blocked = buildBlockedGrid(snapshot, region, opts, toPoint, cols, rows, start, goal);
	const key = (n: { c: number; r: number }) => `${n.c},${n.r}`;
	const open = new Map<string, { c: number; r: number; g: number; f: number; prev?: string }>();
	const closed = new Set<string>();
	open.set(key(start), { ...start, g: 0, f: distance(toPoint(start), toPoint(goal)) });
	const dirs = opts.allowDiagonals
		? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
		: [[1, 0], [-1, 0], [0, 1], [0, -1]];
	let found: string | undefined;
	let expanded = 0;
	while (open.size > 0) {
		let currentKey = '';
		let current: any;
		for (const [k, node] of open) {
			if (!current || node.f < current.f) { current = node; currentKey = k; }
		}
		open.delete(currentKey);
		closed.add(currentKey);
		expanded += 1;
		if (current.c === goal.c && current.r === goal.r) {
			found = currentKey;
			open.set(currentKey, current);
			break;
		}
		for (const [dc, dr] of dirs) {
			const next = { c: current.c + dc, r: current.r + dr };
			if (next.c < 0 || next.r < 0 || next.c >= cols || next.r >= rows) continue;
			const k = key(next);
			if (closed.has(k) || blocked.has(k)) continue;
			const moveCost = Math.hypot(dc, dr) * step + turnPenalty(current, next, open.get(current.prev ?? ''));
			const gScore = current.g + moveCost;
			const existing = open.get(k);
			if (!existing || gScore < existing.g) {
				open.set(k, { ...next, g: gScore, f: gScore + distance(toPoint(next), toPoint(goal)), prev: currentKey });
			}
		}
	}
	if (!found) throw new Error('No grid path found. Try larger searchMarginMil, smaller clearanceMil, larger gridMil, or a different layer/waypoint.');
	const nodes: Array<{ c: number; r: number }> = [];
	let cursor: string | undefined = found;
	while (cursor) {
		const node = open.get(cursor);
		if (!node) break;
		nodes.push({ c: node.c, r: node.r });
		cursor = node.prev;
		if (cursor && closed.has(cursor)) {
			const [c, r] = cursor.split(',').map(Number);
			const prev = Array.from(open.values()).find((n) => n.c === c && n.r === r);
			if (!prev) {
				// Reconstruct from closed nodes is unavailable, so rebuild via cameFrom map would be ideal.
				break;
			}
		}
	}
	// The open-map-only reconstruction above is intentionally supplemented by
	// a second A* parent map to keep output reliable.
	const path = reconstructPath(snapshot, from, to, region, step, cols, rows, opts);
	const rawPoints = compressPath([from, ...path, to]);
	const pullTight = opts.pullTight === false
		? {
			enabled: false,
			inputPointCount: rawPoints.length,
			outputPointCount: rawPoints.length,
			removedPointCount: 0,
			inputLengthMil: round(pathLength(rawPoints), 1),
			outputLengthMil: round(pathLength(rawPoints), 1),
			lengthDeltaMil: 0,
			passCount: 0,
		}
		: pullTightPath(snapshot, rawPoints, region, opts, step);
	const points = compressPath(pullTight.points ?? rawPoints);
	const segments = pointsToSegments(points, opts.net, opts.layer, opts.lineWidth, 'pathfind');
	return {
		gridMil: step,
		...clearanceReport(opts.clearance.rule),
		searchRegion: region,
		expandedNodeCount: expanded,
		rawPointCount: rawPoints.length,
		rawSegmentCount: Math.max(0, rawPoints.length - 1),
		pointCount: points.length,
		routePoints: points,
		segments,
		segmentCount: segments.length,
		estimatedLengthMil: round(pathLength(points), 1),
		pullTight: stripPullTightPoints(pullTight),
	};
}

function pullTightPath(
	snapshot: Snapshot,
	points: Point[],
	region: Bounds,
	opts: any,
	gridStepMil: number,
): any {
	const input = compressPath(points);
	const inputLength = pathLength(input);
	const passes = Math.max(1, Math.floor(Number(opts.pullTightPasses ?? 2)));
	const sampleMil = Number.isFinite(Number(opts.pullTightSampleMil)) && Number(opts.pullTightSampleMil) > 0
		? Number(opts.pullTightSampleMil)
		: Math.max(5, gridStepMil / 2);
	const require45 = opts.pullTightRequire45 !== false;
	let current = input;
	let passCount = 0;
	for (let pass = 0; pass < passes; pass++) {
		const next = shortcutPathOnce(snapshot, current, region, opts, sampleMil, require45);
		passCount += 1;
		if (samePointList(current, next)) break;
		current = compressPath(next);
	}
	const outputLength = pathLength(current);
	return {
		enabled: true,
		points: current,
		inputPointCount: input.length,
		outputPointCount: current.length,
		removedPointCount: Math.max(0, input.length - current.length),
		inputLengthMil: round(inputLength, 1),
		outputLengthMil: round(outputLength, 1),
		lengthDeltaMil: round(outputLength - inputLength, 1),
		passCount,
		sampleMil,
		require45,
	};
}

function shortcutPathOnce(
	snapshot: Snapshot,
	points: Point[],
	region: Bounds,
	opts: any,
	sampleMil: number,
	require45: boolean,
): Point[] {
	if (points.length <= 2) return points;
	const out: Point[] = [points[0]];
	let i = 0;
	while (i < points.length - 1) {
		let best = i + 1;
		for (let j = points.length - 1; j > i + 1; j--) {
			if (canShortcutSegment(snapshot, points, i, j, region, opts, sampleMil, require45)) {
				best = j;
				break;
			}
		}
		out.push(points[best]);
		i = best;
	}
	return out;
}

function canShortcutSegment(
	snapshot: Snapshot,
	points: Point[],
	fromIndex: number,
	toIndex: number,
	region: Bounds,
	opts: any,
	sampleMil: number,
	require45: boolean,
): boolean {
	const a = points[fromIndex];
	const b = points[toIndex];
	if (!a || !b || distance(a, b) <= 1e-6) return false;
	if (require45 && !isOctilinearSegment(a, b)) return false;
	return segmentClearOnGrid(snapshot, a, b, region, opts, sampleMil);
}

function segmentClearOnGrid(
	snapshot: Snapshot,
	a: Point,
	b: Point,
	region: Bounds,
	opts: any,
	sampleMil: number,
): boolean {
	const len = distance(a, b);
	const samples = Math.max(1, Math.ceil(len / Math.max(1, sampleMil)));
	const half = Number(opts.lineWidth ?? DEFAULT_LINE_WIDTH_MIL) / 2;
	const net = String(opts.net ?? '');
	const layer = normalizeLayerSafe(opts.layer);
	const ignoreSameNet = opts.ignoreSameNet !== false;
	for (let i = 1; i < samples; i++) {
		const t = i / samples;
		const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
		if (pointBlocked(snapshot, p, region, net, layer, half, opts.clearance, ignoreSameNet, opts.poursBlock === true)) return false;
	}
	return true;
}

function isOctilinearSegment(a: Point, b: Point): boolean {
	const dx = Math.abs(b.x - a.x);
	const dy = Math.abs(b.y - a.y);
	const tol = 1e-3;
	return dx <= tol || dy <= tol || Math.abs(dx - dy) <= tol;
}

function samePointList(a: Point[], b: Point[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (distance(a[i], b[i]) > 1e-6) return false;
	}
	return true;
}

function stripPullTightPoints(summary: any): any {
	const { points: _points, ...rest } = summary;
	return rest;
}

function reconstructPath(snapshot: Snapshot, from: Endpoint, to: Endpoint, region: Bounds, step: number, cols: number, rows: number, opts: any): Point[] {
	const toGrid = (p: Point) => ({ c: clamp(Math.round((p.x - region.minX) / step), 0, cols - 1), r: clamp(Math.round((p.y - region.minY) / step), 0, rows - 1) });
	const toPoint = (n: { c: number; r: number }): Point => ({ x: region.minX + n.c * step, y: region.minY + n.r * step });
	const start = toGrid(from), goal = toGrid(to);
	const blocked = buildBlockedGrid(snapshot, region, opts, toPoint, cols, rows, start, goal);
	const key = (n: { c: number; r: number }) => `${n.c},${n.r}`;
	const came = new Map<string, string>();
	const gScore = new Map<string, number>([[key(start), 0]]);
	const open = new Set<string>([key(start)]);
	const dirs = opts.allowDiagonals
		? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
		: [[1, 0], [-1, 0], [0, 1], [0, -1]];
	const parse = (k: string) => { const [c, r] = k.split(',').map(Number); return { c, r }; };
	while (open.size > 0) {
		let bestKey = '';
		let bestF = Number.POSITIVE_INFINITY;
		for (const k of open) {
			const n = parse(k);
			const f = (gScore.get(k) ?? Number.POSITIVE_INFINITY) + distance(toPoint(n), toPoint(goal));
			if (f < bestF) { bestF = f; bestKey = k; }
		}
		if (bestKey === key(goal)) {
			const out: Point[] = [];
			let cur = bestKey;
			while (cur !== key(start)) {
				out.push(toPoint(parse(cur)));
				cur = came.get(cur)!;
			}
			out.reverse();
			return out.slice(0, -1);
		}
		open.delete(bestKey);
		const cur = parse(bestKey);
		for (const [dc, dr] of dirs) {
			const next = { c: cur.c + dc, r: cur.r + dr };
			const nk = key(next);
			if (next.c < 0 || next.r < 0 || next.c >= cols || next.r >= rows || blocked.has(nk)) continue;
			const tentative = (gScore.get(bestKey) ?? 0) + Math.hypot(dc, dr) * step;
			if (tentative < (gScore.get(nk) ?? Number.POSITIVE_INFINITY)) {
				came.set(nk, bestKey);
				gScore.set(nk, tentative);
				open.add(nk);
			}
		}
	}
	throw new Error('No grid path found after parent-map reconstruction.');
}

function buildBlockedGrid(snapshot: Snapshot, region: Bounds, opts: any, toPoint: (n: { c: number; r: number }) => Point, cols: number, rows: number, start: any, goal: any): Set<string> {
	const blocked = new Set<string>();
	const half = Number(opts.lineWidth ?? DEFAULT_LINE_WIDTH_MIL) / 2;
	const net = String(opts.net ?? '');
	const layer = normalizeLayerSafe(opts.layer);
	for (let c = 0; c < cols; c++) {
		for (let r = 0; r < rows; r++) {
			if ((c === start.c && r === start.r) || (c === goal.c && r === goal.r)) continue;
			const p = toPoint({ c, r });
			if (pointBlocked(snapshot, p, region, net, layer, half, opts.clearance, opts.ignoreSameNet !== false, opts.poursBlock === true)) {
				blocked.add(`${c},${r}`);
			}
		}
	}
	return blocked;
}

/**
 * Would a track of `lineWidth` centred on `p` violate clearance? The same test
 * the grid pathfinder and pull-tight pass use; exported for the smoke tests.
 * `clearance` is a resolver (per-net rules, larger-of-two-nets), one resolved
 * rule for every net, or a plain mil number for every kind.
 */
export function isPointBlockedForRoute(
	snapshot: Pick<Snapshot, 'lines' | 'vias' | 'standalonePads' | 'componentPads' | 'pours' | 'keepouts'>,
	p: Point,
	opts: { net: string; layer?: any; lineWidth?: number; clearance: ClearanceResolver | ClearanceRule | number; ignoreSameNet?: boolean; poursBlock?: boolean },
): boolean {
	const resolver: ClearanceResolver = typeof opts.clearance === 'number'
		? resolverForRule({ clearanceMil: opts.clearance, source: 'param:clearanceMil' })
		: typeof (opts.clearance as ClearanceResolver).between === 'function'
			? opts.clearance as ClearanceResolver
			: resolverForRule(opts.clearance as ClearanceRule);
	const everywhere = normalizeBounds(-Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE);
	return pointBlocked(
		snapshot as Snapshot,
		p,
		everywhere,
		opts.net,
		normalizeLayerSafe(opts.layer),
		Number(opts.lineWidth ?? DEFAULT_LINE_WIDTH_MIL) / 2,
		pathClearanceFor(resolver, opts.net),
		opts.ignoreSameNet !== false,
		opts.poursBlock === true,
	);
}

// Pad outlines are built once per pad object (snapshot clones share them), not
// once per grid cell. A null entry caches "pad has no usable position".
const padObstacleCache = new WeakMap<object, PadObstacle | null>();

function snapshotPadObstacle(pad: any): PadObstacle | undefined {
	if (!pad || typeof pad !== 'object') return undefined;
	let cached = padObstacleCache.get(pad);
	if (cached === undefined) {
		cached = padToObstacle(pad, pad.componentPrimitiveId ? 'component_pad' : 'pad', pad.componentPrimitiveId, pad.reference) ?? null;
		padObstacleCache.set(pad, cached);
	}
	return cached ?? undefined;
}

function pointBlocked(snapshot: Snapshot, p: Point, region: Bounds, net: string, layer: any, halfWidth: number, clearance: PathClearance, ignoreSameNet: boolean, poursBlock = false): boolean {
	for (const line of snapshot.lines) {
		if (!segmentTouchesBounds(line, region)) continue;
		if (ignoreSameNet && line.net === net) continue;
		if (line.layer != null && layer != null && String(line.layer) !== String(layer)) continue;
		const d = pointToSegmentDistance(p, { x: line.startX, y: line.startY }, { x: line.endX, y: line.endY });
		// Same rule as checkTraceObstacles: exactly at clearance is legal.
		if (violatesClearance(d - halfWidth - Number(line.lineWidth ?? DEFAULT_LINE_WIDTH_MIL) / 2, clearance.against(line.net).track)) return true;
	}
	for (const via of snapshot.vias) {
		if (!pointInBounds(via, region)) continue;
		if (ignoreSameNet && via.net === net) continue;
		if (violatesClearance(distance(p, via) - halfWidth - Number(via.diameter ?? 24) / 2, clearance.against(via.net).via)) return true;
	}
	// Real pad outlines (rotated rect / ellipse / stadium / polygon) instead of
	// an 18-mil circle: the circle under-blocked long rotated pads and
	// over-blocked the empty corners around round ones. Drilled pads are copper
	// on every layer (padToObstacle reports them on layer 12). standalonePads no
	// longer repeats the component pads (getSnapshot drops them).
	for (const pads of [snapshot.standalonePads, snapshot.componentPads]) {
		for (const pad of pads) {
			if (ignoreSameNet && pad.net === net) continue;
			const obstacle = snapshotPadObstacle(pad);
			if (!obstacle || !rectsOverlap(obstacle.bounds, region)) continue;
			if (obstacle.layer != null && layer != null && String(obstacle.layer) !== String(layer) && Number(obstacle.layer) !== 12) continue;
			const against = clearance.against(pad.net);
			const required = obstacle.drilled ? against.thPad : against.smdPad;
			if (polygonHit(p, p, obstacle.polygon, obstacle.bounds, halfWidth, Math.max(0, required - CLEARANCE_TOLERANCE_MIL))) return true;
		}
	}
	// Pours are not walls: their copper re-flows around new tracks on repour.
	// Blocking every cell inside a pour's bounding box left no path at all on
	// boards with board-wide planes. Opt back in with poursBlock:true.
	if (poursBlock) for (const pour of snapshot.pours) {
		if (ignoreSameNet && pour.net === net) continue;
		if (pour.layer != null && layer != null && String(pour.layer) !== String(layer)) continue;
		const b = boundsOfPrimitive(pour);
		if (b && boundsOverlap(b, region) && pointInBounds(p, expandBounds(b, halfWidth + clearance.against(pour.net).track))) return true;
	}
	// Keepouts are not copper and have no net: the routed net's own rule.
	for (const keepout of snapshot.keepouts) {
		if (keepout.layer != null && layer != null && !layersTouch(layer, keepout.layer)) continue;
		const b = boundsOfPrimitive(keepout);
		if (b && boundsOverlap(b, region) && pointInBounds(p, expandBounds(b, halfWidth + clearance.track))) return true;
	}
	return false;
}

function rectsOverlap(a: { minX: number; minY: number; maxX: number; maxY: number }, b: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

// Keys each pcb_batch_edit operation accepts (aliases included). Anything else
// is an error naming the key — a silently ignored `primitiveIds` used to turn a
// delete into delete(["undefined"]).
const BATCH_OP_TYPE_KEYS = ['type', 'op', 'action'];
const BATCH_OP_KEYS: Record<'create_track' | 'create_via' | 'modify_component' | 'delete', string[]> = {
	create_track: ['net', 'layer', 'startX', 'startY', 'endX', 'endY', 'x1', 'y1', 'x2', 'y2', 'fromX', 'fromY', 'toX', 'toY', 'lineWidth', 'width', 'width_mil', 'trace_width_mil'],
	create_via: ['net', 'x', 'y', 'holeDiameter', 'diameter', 'viaType'],
	modify_component: ['primitiveId', 'property', 'x', 'y', 'rotation', 'layer', 'primitiveLock', 'designator'],
	delete: ['primitiveType', 'targetType', 'ids', 'primitiveIds', 'primitiveId', 'id'],
};

function unknownBatchKeys(op: any, type: keyof typeof BATCH_OP_KEYS): string[] {
	const allowed = new Set([...BATCH_OP_TYPE_KEYS, ...BATCH_OP_KEYS[type]]);
	const unknown = Object.keys(op).filter((key) => !allowed.has(key));
	return unknown.length > 0
		? [`unknown key(s) ${unknown.map((k) => `"${k}"`).join(', ')}; accepted: ${BATCH_OP_KEYS[type].join(', ')}`]
		: [];
}

function normalizeBatchOperations(ops: any[]): any[] {
	return ops.map((rawOp, index) => {
		const op = rawOp && typeof rawOp === 'object' ? rawOp : {};
		const type = String(op.type ?? op.op ?? op.action ?? '').trim();
		const invalid = (originalType: string, errors: string[]) => ({ index, type: 'invalid', originalType, errors });
		if (type === 'create_track' || type === 'track') {
			const errors = unknownBatchKeys(op, 'create_track');
			const layer = normalizeLayerSafe(op.layer);
			const lineWidth = Number(firstDefined(op.lineWidth, op.width, op.width_mil, op.trace_width_mil));
			const segment: TraceSegmentSpec = {
				net: String(op.net),
				layer,
				startX: Number(firstDefined(op.startX, op.x1, op.fromX)),
				startY: Number(firstDefined(op.startY, op.y1, op.fromY)),
				endX: Number(firstDefined(op.endX, op.x2, op.toX)),
				endY: Number(firstDefined(op.endY, op.y2, op.toY)),
				lineWidth: Number.isFinite(lineWidth) ? lineWidth : undefined,
				role: `batch_${index}`,
			};
			if (!stringOrUndefined(op.net)) errors.push('net is required');
			if (![segment.startX, segment.startY, segment.endX, segment.endY].every(Number.isFinite)) errors.push('startX/startY/endX/endY must be numbers (mil)');
			return errors.length ? invalid(type, errors) : { index, type: 'create_track', segment };
		}
		if (type === 'create_via' || type === 'via') {
			const errors = unknownBatchKeys(op, 'create_via');
			if (!stringOrUndefined(op.net)) errors.push('net is required');
			if (![op.x, op.y].every((v) => v != null && Number.isFinite(Number(v)))) errors.push('x/y must be numbers (mil)');
			if (errors.length) return invalid(type, errors);
			return {
				index,
				type: 'create_via',
				net: String(op.net),
				x: Number(op.x),
				y: Number(op.y),
				holeDiameter: Number(op.holeDiameter ?? 12),
				diameter: Number(op.diameter ?? 24),
				viaType: normalizeViaType(op.viaType ?? 'Through'),
			};
		}
		if (type === 'modify_component' || type === 'move_component' || type === 'apply_component_rotation') {
			const errors = unknownBatchKeys(op, 'modify_component');
			if (!stringOrUndefined(op.primitiveId)) errors.push('primitiveId is required');
			if (errors.length) return invalid(type, errors);
			return { index, type: 'modify_component', primitiveId: String(op.primitiveId), property: { ...op.property, ...pick(op, ['x', 'y', 'rotation', 'layer', 'primitiveLock', 'designator']) } };
		}
		if (type === 'delete') {
			const errors = unknownBatchKeys(op, 'delete');
			// ids | primitiveIds (alias) | primitiveId / id (one id).
			const rawIds = firstDefined(op.ids, op.primitiveIds, op.primitiveId, op.id);
			const ids = (Array.isArray(rawIds) ? rawIds : rawIds != null ? [rawIds] : [])
				.map((id: any) => stringOrUndefined(id))
				.filter((id: string | undefined): id is string => !!id);
			if (ids.length === 0) errors.push('ids:[...] is required (aliases: primitiveIds, primitiveId, id)');
			if (!stringOrUndefined(op.primitiveType ?? op.targetType)) errors.push('primitiveType is required (track | via | component | pad | pour)');
			return errors.length ? invalid(type, errors) : { index, type: 'delete', primitiveType: op.primitiveType ?? op.targetType, ids };
		}
		return { index, type: 'unsupported', originalType: type };
	});
}

export interface BatchCommitResult {
	/** true = every operation applied; false = nothing left on the board; 'partial' = see created/modified/deleted. */
	committed: true | false | 'partial';
	rolledBack: boolean;
	created: Array<{ index: number; type: 'track' | 'via'; primitiveId: string }>;
	modified: Array<{ index: number; primitiveId: string }>;
	deleted: Array<{ index: number; primitiveType: string; ids: string[] }>;
	failedAt?: { index: number; type: string; error: string };
	rollbackErrors?: string[];
	results: any[];
}

/**
 * Apply a batch so the board never ends up in a state the caller cannot see.
 * Creates and component edits run first and are reversible (created ids are
 * deleted, edited components restored to their exact prior properties);
 * deletes run last because they cannot be undone through the SDK. On a
 * failure with atomic=true the reversible part is rolled back; either way the
 * result lists exactly what is on the board.
 */
export async function commitBatchOperations(ops: any[], atomic: boolean): Promise<BatchCommitResult> {
	const ordered = [...ops.filter((op) => op.type !== 'delete'), ...ops.filter((op) => op.type === 'delete')];
	const created: BatchCommitResult['created'] = [];
	const modified: Array<{ index: number; primitiveId: string; before: Record<string, unknown> }> = [];
	const deleted: BatchCommitResult['deleted'] = [];
	const results: any[] = [];
	const idOf = (value: any): string | undefined => stringOrUndefined(flattenState(value)?.primitiveId);
	for (const op of ordered) {
		try {
			if (op.type === 'create_track') {
				const s = op.segment;
				const made = await eda.pcb_PrimitiveLine.create(s.net, normalizeLayer(s.layer), s.startX, s.startY, s.endX, s.endY, s.lineWidth);
				const id = idOf(made);
				if (!id) throw new Error('EasyEDA returned no track primitive');
				created.push({ index: op.index, type: 'track', primitiveId: id });
				results.push({ index: op.index, type: op.type, created: flattenState(made) });
			} else if (op.type === 'create_via') {
				const made = await eda.pcb_PrimitiveVia.create(op.net, op.x, op.y, op.holeDiameter, op.diameter, op.viaType);
				const id = idOf(made);
				if (!id) throw new Error('EasyEDA returned no via primitive');
				created.push({ index: op.index, type: 'via', primitiveId: id });
				results.push({ index: op.index, type: op.type, created: flattenState(made) });
			} else if (op.type === 'modify_component') {
				const property = { ...op.property };
				if (property.layer != null) property.layer = normalizeLayer(property.layer);
				const prior = flattenState(await eda.pcb_PrimitiveComponent.get(op.primitiveId)) ?? {};
				const before: Record<string, unknown> = {};
				for (const key of Object.keys(property)) if (prior[key] !== undefined) before[key] = prior[key];
				const ok = await eda.pcb_PrimitiveComponent.modify(op.primitiveId, property);
				if (!ok) throw new Error(`EasyEDA did not apply the edit to component ${op.primitiveId}`);
				modified.push({ index: op.index, primitiveId: op.primitiveId, before });
				results.push({ index: op.index, type: op.type, modified: true });
			} else if (op.type === 'delete') {
				const ids = (Array.isArray(op.ids) ? op.ids : [op.ids]).map(String);
				const ok = await deletePrimitive(op.primitiveType, ids);
				if (!ok) throw new Error(`EasyEDA did not delete ${ids.join(', ')}`);
				deleted.push({ index: op.index, primitiveType: String(op.primitiveType), ids });
				results.push({ index: op.index, type: op.type, deleted: true });
			}
		} catch (err: any) {
			const failedAt = { index: op.index, type: op.type, error: err?.message ?? String(err) };
			const publicModified = modified.map(({ index, primitiveId }) => ({ index, primitiveId }));
			// A failed delete happens after every create/edit already succeeded
			// and earlier deletes cannot be restored — keep everything, report it.
			if (!atomic || op.type === 'delete') {
				return { committed: 'partial', rolledBack: false, created, modified: publicModified, deleted, failedAt, results };
			}
			const rollbackErrors: string[] = [];
			for (const m of [...modified].reverse()) {
				try { await eda.pcb_PrimitiveComponent.modify(m.primitiveId, m.before as any); }
				catch (e: any) { rollbackErrors.push(`restore ${m.primitiveId}: ${e?.message ?? e}`); }
			}
			const trackIds = created.filter((c) => c.type === 'track').map((c) => c.primitiveId);
			const viaIds = created.filter((c) => c.type === 'via').map((c) => c.primitiveId);
			if (trackIds.length) { try { await eda.pcb_PrimitiveLine.delete(trackIds); } catch (e: any) { rollbackErrors.push(`delete tracks ${trackIds.join(',')}: ${e?.message ?? e}`); } }
			if (viaIds.length) { try { await eda.pcb_PrimitiveVia.delete(viaIds); } catch (e: any) { rollbackErrors.push(`delete vias ${viaIds.join(',')}: ${e?.message ?? e}`); } }
			const clean = rollbackErrors.length === 0;
			return {
				committed: clean ? false : 'partial',
				rolledBack: clean,
				created: clean ? [] : created,
				modified: clean ? [] : publicModified,
				deleted,
				failedAt,
				rollbackErrors: clean ? undefined : rollbackErrors,
				results,
			};
		}
	}
	return { committed: true, rolledBack: false, created, modified: modified.map(({ index, primitiveId }) => ({ index, primitiveId })), deleted, results };
}

async function deletePrimitive(type: any, ids: any): Promise<any> {
	const t = String(type ?? '').toLowerCase();
	if (t === 'track' || t === 'line') return eda.pcb_PrimitiveLine.delete(ids);
	if (t === 'via') return eda.pcb_PrimitiveVia.delete(ids);
	if (t === 'component') return eda.pcb_PrimitiveComponent.delete(ids);
	if (t === 'pad') return eda.pcb_PrimitivePad.delete(ids);
	if (t === 'pour') return eda.pcb_PrimitivePour.delete(ids);
	throw new Error(`Unsupported delete primitiveType "${type}".`);
}

function suggestMove(snapshot: Snapshot, component: Component, params: Record<string, any>): any {
	const pads = snapshot.componentPads.filter((p) => p.componentPrimitiveId === component.primitiveId);
	const current = scoreMovedComponent(snapshot, component, pads, 0, 0);
	const step = Number(params.stepMil ?? 100);
	const offsets = Array.isArray(params.candidateOffsets)
		? params.candidateOffsets.map((o: any) => ({ dx: Number(o.dx ?? o.x ?? 0), dy: Number(o.dy ?? o.y ?? 0) }))
		: [
			{ dx: 0, dy: 0 },
			{ dx: step, dy: 0 }, { dx: -step, dy: 0 }, { dx: 0, dy: step }, { dx: 0, dy: -step },
			{ dx: step, dy: step }, { dx: step, dy: -step }, { dx: -step, dy: step }, { dx: -step, dy: -step },
			{ dx: step * 2, dy: 0 }, { dx: -step * 2, dy: 0 }, { dx: 0, dy: step * 2 }, { dx: 0, dy: -step * 2 },
		];
	const scored = offsets.map((o: any) => scoreMovedComponent(snapshot, component, pads, o.dx, o.dy));
	const best = scored.slice().sort((a, b) => a.score - b.score)[0] ?? current;
	return {
		units: 'mil',
		component: summarizeComponent(component),
		current,
		recommended: best,
		improvementScoreMil: round(Math.max(0, current.score - best.score), 1),
		recommendedMove: { dx: best.dx, dy: best.dy, x: round(component.x + best.dx, 3), y: round(component.y + best.dy, 3) },
		safeToApply: best.collisionCount === 0 && !component.primitiveLock,
		applyHint: { tool: 'pcb_move_component', args: { primitiveId: component.primitiveId, x: round(component.x + best.dx, 3), y: round(component.y + best.dy, 3) } },
	};
}

function scoreMovedComponent(snapshot: Snapshot, component: Component, pads: ComponentPad[], dx: number, dy: number): any {
	const movedPads = pads.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
	let ratlineLengthMil = 0;
	let targetCount = 0;
	for (const pad of movedPads) {
		if (!pad.net) continue;
		const candidates = (snapshot.netIndex[pad.net]?.pads ?? []).filter((p) => p.componentPrimitiveId !== component.primitiveId);
		let best = Number.POSITIVE_INFINITY;
		for (const candidate of candidates) best = Math.min(best, distance(pad, candidate));
		if (Number.isFinite(best)) { ratlineLengthMil += best; targetCount += 1; }
	}
	const movedBounds = component.bounds ? translateBounds(component.bounds, dx, dy) : boundsForPoints(movedPads);
	let collisionCount = 0;
	const collisions: any[] = [];
	if (movedBounds) {
		for (const other of snapshot.components) {
			if (other.primitiveId === component.primitiveId || !other.bounds) continue;
			if (boundsOverlap(movedBounds, other.bounds)) {
				collisionCount += 1;
				if (collisions.length < 10) collisions.push({ primitiveId: other.primitiveId, designator: other.designator, overlapAreaMil2: round(overlapArea(movedBounds, other.bounds), 1) });
			}
		}
	}
	const score = ratlineLengthMil + collisionCount * 5000;
	return { dx, dy, score: round(score, 1), ratlineLengthMil: round(ratlineLengthMil, 1), targetCount, collisionCount, collisions };
}

function scoreNetForWork(ns: NetSnapshot, snapshot: Snapshot, rules: RuleContext = {}): any {
	const padCount = ns.pads.length + ns.standalonePads.length;
	const routePrimitiveCount = ns.lines.length + ns.vias.length;
	const status = padCount <= 1 ? 'single_pad' : routePrimitiveCount > 0 ? 'partially_or_fully_routed' : ns.pours.length > 0 ? 'pour_only' : 'unrouted';
	const pairs = nearestPadPairs(ns.pads, 6);
	const estimatedSpanMil = pairs.reduce((sum, p) => sum + p.distanceMil, 0);
	const obstacleDensity = pairs.reduce((sum, p) => sum + countObstaclesNearSegment(snapshot, p.a, p.b, ns.net), 0);
	const priorityScore = (status === 'unrouted' ? 5000 : status === 'pour_only' ? 2000 : 0) + padCount * 100 + estimatedSpanMil + obstacleDensity * 50;
	return {
		net: ns.net,
		status,
		priorityScore: round(priorityScore, 1),
		padCount,
		lineCount: ns.lines.length,
		viaCount: ns.vias.length,
		pourCount: ns.pours.length,
		currentLengthMil: round(ns.lengthMil, 1),
		estimatedNearestSpanMil: round(estimatedSpanMil, 1),
		obstacleDensity,
		recommendedPreset: presetForNet(ns.net, rules),
		nearestPairs: pairs,
	};
}

function countObstaclesNearSegment(snapshot: Snapshot, a: Point, b: Point, net: string): number {
	const region = expandBounds(boundsForPoints([a, b])!, 100);
	let count = 0;
	for (const line of snapshot.lines) if (line.net !== net && segmentTouchesBounds(line, region) && segmentDistance(a, b, { x: line.startX, y: line.startY }, { x: line.endX, y: line.endY }) < 80) count += 1;
	for (const via of snapshot.vias) if (via.net !== net && pointInBounds(via, region) && pointToSegmentDistance(via, a, b) < 80) count += 1;
	for (const pad of snapshot.componentPads) if (pad.net !== net && pointInBounds(pad, region) && pointToSegmentDistance(pad, a, b) < 80) count += 1;
	for (const pour of snapshot.pours) if (pour.net !== net && primitiveTouchesBounds(pour, region)) count += 1;
	for (const keepout of snapshot.keepouts) if (primitiveTouchesBounds(keepout, region)) count += 1;
	return count;
}

function inspectSnapshotArea(snapshot: Snapshot, region: Bounds, maxItems: number): any {
	return {
		summary: {
			components: snapshot.components.filter((c) => c.bounds && boundsOverlap(c.bounds, region)).length,
			componentPads: snapshot.componentPads.filter((p) => pointInBounds(p, region)).length,
			tracks: snapshot.lines.filter((l) => segmentTouchesBounds(l, region)).length,
			vias: snapshot.vias.filter((v) => pointInBounds(v, region)).length,
			standalonePads: snapshot.standalonePads.filter((p) => pointInBounds(p, region)).length,
			pours: snapshot.pours.filter((p) => primitiveTouchesBounds(p, region)).length,
			keepouts: snapshot.keepouts.filter((k) => primitiveTouchesBounds(k, region)).length,
		},
		components: snapshot.components.filter((c) => c.bounds && boundsOverlap(c.bounds, region)).slice(0, maxItems).map(summarizeComponent),
		componentPads: snapshot.componentPads.filter((p) => pointInBounds(p, region)).slice(0, maxItems).map(summarizePad),
		lines: snapshot.lines.filter((l) => segmentTouchesBounds(l, region)).slice(0, maxItems).map(summarizeLine),
		vias: snapshot.vias.filter((v) => pointInBounds(v, region)).slice(0, maxItems).map(summarizeVia),
		standalonePads: snapshot.standalonePads.filter((p) => pointInBounds(p, region)).slice(0, maxItems),
		pours: snapshot.pours.filter((p) => primitiveTouchesBounds(p, region)).slice(0, maxItems).map(summarizeRegion),
		keepouts: snapshot.keepouts.filter((k) => primitiveTouchesBounds(k, region)).slice(0, maxItems).map(summarizeRegion),
	};
}

function regionFromParams(params: Record<string, any>): Bounds | undefined {
	if ([params.left, params.right, params.top, params.bottom].every((v) => Number.isFinite(Number(v)))) {
		return normalizeBounds(Number(params.left), Number(params.top), Number(params.right), Number(params.bottom));
	}
	if (Number.isFinite(Number(params.x)) && Number.isFinite(Number(params.y))) {
		const r = Number(params.radiusMil ?? 250);
		return normalizeBounds(Number(params.x) - r, Number(params.y) - r, Number(params.x) + r, Number(params.y) + r);
	}
	if ([params.startX, params.startY, params.endX, params.endY].every((v) => Number.isFinite(Number(v)))) {
		const margin = Number(params.marginMil ?? 250);
		return expandBounds(normalizeBounds(Number(params.startX), Number(params.startY), Number(params.endX), Number(params.endY)), margin);
	}
	return undefined;
}

type RuleContext = { raw?: any; summary?: any; clearance?: ClearanceResolver };

async function safeRuleContext(): Promise<RuleContext> {
	const drc = (eda as any)?.pcb_Drc;
	const [{ ruleConfig, netRules }, netClasses, diffPairs] = await Promise.all([
		fetchDrcRules(),
		Promise.resolve().then(() => drc?.getAllNetClasses?.()).catch(() => undefined),
		Promise.resolve().then(() => drc?.getAllDifferentialPairs?.()).catch(() => undefined),
	]);
	const clearance = clearanceResolverFromRules(ruleConfig, netRules);
	return {
		raw: { ruleConfig, netRules, netClasses, diffPairs },
		clearance,
		summary: {
			ruleConfigName: ruleConfigName(ruleConfig),
			clearanceMil: clearance.summary.clearanceMil,
			clearanceSource: clearance.summary.clearanceSource,
			netRuleCount: Array.isArray(netRules) ? netRules.length : undefined,
			netClassCount: Array.isArray(netClasses) ? netClasses.length : undefined,
			diffPairCount: Array.isArray(diffPairs) ? diffPairs.length : undefined,
		},
	};
}

/**
 * Routing preset for one net. Board DRC rules win (Track default width,
 * Safe Spacing clearance, Via Size diameter/drill — see src/shared/drc-rules.ts);
 * the net-name heuristics only fill values the board has no usable rule for.
 * `source` says, per value, which one was used ('rule:...' vs 'heuristic (...)').
 * One exception: a power/ground net on the board-DEFAULT Track rule keeps its
 * heuristic width clamped to the rule's min/max (the default width is a
 * signal width; a net with its own Track rule always gets that rule).
 */
function presetForNet(net: string, rules: RuleContext): any {
	const upper = net.toUpperCase();
	const diffPairs = Array.isArray(rules.raw?.diffPairs) ? rules.raw.diffPairs : [];
	const isDiff = diffPairs.some((p: any) => [p.positiveNet, p.negativeNet, p.pNet, p.nNet].map(String).includes(net)) || /(_P|_N|DP|DM|D\+|D-)$/.test(upper);
	let heuristic = {
		lineWidth: 8,
		holeDiameter: 12,
		diameter: 24,
		clearanceMil: 6,
		viaStrategy: 'fanout',
		reason: 'default signal',
	};
	let currentCarrying = false;
	if (isDiff || upper.includes('USB')) {
		heuristic = { ...heuristic, lineWidth: 7, clearanceMil: 6, viaStrategy: 'none', reason: 'differential/high-speed heuristic' };
	} else if (upper === 'GND' || upper.includes('GROUND')) {
		heuristic = { ...heuristic, lineWidth: 20, holeDiameter: 14, diameter: 30, clearanceMil: 8, reason: 'ground net heuristic' };
		currentCarrying = true;
	} else if (/(VBUS|VBAT|BAT|VIN|VCC|VDD|\+5V|5V|\+3V3|3V3|3\.3V|POWER)/.test(upper)) {
		heuristic = { ...heuristic, lineWidth: upper.includes('VBUS') || upper.includes('BAT') || upper.includes('VIN') ? 30 : 18, holeDiameter: 14, diameter: 30, clearanceMil: 8, reason: 'power net heuristic' };
		currentCarrying = true;
	}
	const ruleConfig = rules.raw?.ruleConfig;
	const netRules = rules.raw?.netRules;
	const fromHeuristic = (why?: string) => `heuristic (${heuristic.reason}${why ? `; ${why}` : ''})`;

	const width = resolveTrackWidth(ruleConfig, netRules, net);
	let lineWidth = heuristic.lineWidth;
	let lineWidthSource = fromHeuristic(width.reason);
	if (width.rule) {
		if (currentCarrying && !width.rule.assignedBy) {
			lineWidth = clamp(heuristic.lineWidth, width.rule.minMil ?? 0, width.rule.maxMil ?? Number.POSITIVE_INFINITY);
			lineWidthSource = `${fromHeuristic()} within ${width.rule.source} min/max`;
		} else {
			lineWidth = width.rule.widthMil;
			lineWidthSource = width.rule.source;
		}
	}

	const clearanceRule = (rules.clearance ?? clearanceResolverFromRules(ruleConfig, netRules)).for(net);
	const clearanceFromRule = clearanceRule.source.startsWith('rule:');
	const via = resolveViaSize(ruleConfig, netRules, net);
	const anyRule = !!width.rule || clearanceFromRule || !!via.rule;

	return {
		lineWidth,
		...(width.rule?.minMil != null ? { minLineWidth: width.rule.minMil } : {}),
		...(width.rule?.maxMil != null ? { maxLineWidth: width.rule.maxMil } : {}),
		holeDiameter: via.rule?.drillMil ?? heuristic.holeDiameter,
		diameter: via.rule?.diameterMil ?? heuristic.diameter,
		clearanceMil: clearanceFromRule ? clearanceRule.clearanceMil : heuristic.clearanceMil,
		...(clearanceFromRule && clearanceRule.byKind ? { clearanceByKind: clearanceRule.byKind } : {}),
		viaStrategy: heuristic.viaStrategy,
		reason: heuristic.reason,
		source: {
			lineWidth: lineWidthSource,
			clearanceMil: clearanceFromRule ? clearanceRule.source : fromHeuristic(rules.clearance?.summary.fallbackReason ?? 'no usable Safe Spacing rule'),
			diameter: via.rule?.source ?? fromHeuristic(via.reason),
			holeDiameter: via.rule?.source ?? fromHeuristic(via.reason),
			viaStrategy: fromHeuristic(),
		},
		// What the name heuristics alone would suggest, when board rules replaced some of it.
		...(anyRule ? { heuristic: { lineWidth: heuristic.lineWidth, clearanceMil: heuristic.clearanceMil, diameter: heuristic.diameter, holeDiameter: heuristic.holeDiameter } } : {}),
	};
}

function nearestPadPairs(pads: ComponentPad[], limit: number): any[] {
	const pairs: any[] = [];
	for (let i = 0; i < pads.length; i++) {
		let best: ComponentPad | undefined;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let j = 0; j < pads.length; j++) {
			if (i === j || pads[i].componentPrimitiveId === pads[j].componentPrimitiveId) continue;
			const d = distance(pads[i], pads[j]);
			if (d < bestDistance) { best = pads[j]; bestDistance = d; }
		}
		if (best) {
			pairs.push({
				a: { x: pads[i].x, y: pads[i].y },
				b: { x: best.x, y: best.y },
				from: pads[i].label,
				to: best.label,
				distanceMil: round(bestDistance, 1),
			});
		}
	}
	return pairs.sort((a, b) => b.distanceMil - a.distanceMil).slice(0, limit);
}

async function routeNetOnSnapshot(workingSnapshot: Snapshot, params: Record<string, any>, clearanceRules?: ClearanceResolver): Promise<any> {
	const net = String(firstDefined(params.net, params.name, params.netName) ?? '').trim();
	if (!net) throw new Error('pcb_route_net requires net.');
	const clearance = pathClearanceFor(clearanceRules ?? await resolveClearance([net], params), net);
	const ns = workingSnapshot.netIndex[net] ?? emptyNetSnapshot(net);
	const endpoints = routeEndpointsForNet(ns, net);
	if (endpoints.length < 2) throw new Error(`Net ${net} has fewer than 2 routable endpoints.`);
	const maxConnections = Math.max(1, Math.floor(Number(firstDefined(params.maxConnections, params.maxPairs, 8))));
	const pairs = selectRouteNetPairs(endpoints, maxConnections);
	if (pairs.length === 0) {
		return {
			dryRun: params.dryRun !== false,
			units: 'mil',
			net,
			endpointCount: endpoints.length,
			pairCount: 0,
			routedPairCount: 0,
			failedPairCount: 0,
			totalSegmentCount: 0,
			estimatedLengthMil: 0,
			...clearanceReport(clearance.rule),
			pairs: [],
			created: { lines: [], vias: [], primitiveIds: [] },
			note: 'No routable endpoint pairs were selected, usually because all pads are on the same component.',
		};
	}
	const layer = normalizeLayer(firstDefined(params.layer, params.layer_preference, params.layerPreference, endpoints[0].layer, 'TopLayer'));
	const lineWidth = resolveLineWidth(params, net);
	const dryRun = params.dryRun !== false;
	const failOnObstacle = params.failOnObstacle !== false;
	const stopOnFailure = params.stopOnFailure !== false;
	const pairResults: any[] = [];
	const created = { lines: [] as any[], vias: [] as any[], primitiveIds: [] as string[] };
	let routedPairCount = 0;
	let failedPairCount = 0;
	let totalSegmentCount = 0;
	let estimatedLengthMil = 0;

	for (let index = 0; index < pairs.length; index++) {
		const pair = pairs[index];
		try {
			const plan = pathfind(workingSnapshot, pair.from, pair.to, {
				net,
				layer,
				lineWidth,
				gridMil: Number(params.gridMil ?? 50),
				clearance,
				searchMarginMil: Number(params.searchMarginMil ?? 1200),
				maxNodes: Math.max(100, Math.floor(Number(params.maxNodes ?? 20000))),
				allowDiagonals: params.allowDiagonals !== false,
				ignoreSameNet: params.ignoreSameNet !== false,
				pullTight: params.pullTight !== false,
				pullTightPasses: Math.max(1, Math.floor(Number(params.pullTightPasses ?? 2))),
				pullTightSampleMil: Number(params.pullTightSampleMil),
				pullTightRequire45: params.pullTightRequire45 !== false,
			});
			const obstacleCheck = await checkTraceObstacles({
				...params,
				net,
				layer,
				lineWidth,
				segments: plan.segments,
				failOnObstacle: false,
				ignorePrimitiveIds: [pair.from.primitiveId, pair.to.primitiveId, ...(Array.isArray(params.ignorePrimitiveIds) ? params.ignorePrimitiveIds : [])].filter(Boolean),
			});
			if (failOnObstacle && obstacleCheck.blockingObstacleCount > 0) {
				failedPairCount += 1;
				pairResults.push({
					index,
					status: 'blocked',
					from: summarizeEndpoint(pair.from),
					to: summarizeEndpoint(pair.to),
					distanceMil: round(pair.distanceMil, 1),
					plan: summarizeRoutePlan(plan),
					obstacleCheck,
				});
				if (stopOnFailure) break;
				continue;
			}

			const createdForPair = dryRun ? { lines: [], vias: [], primitiveIds: [] } : await createLineSegments(plan.segments, !!params.primitiveLock);
			created.lines.push(...createdForPair.lines);
			created.vias.push(...createdForPair.vias);
			created.primitiveIds.push(...createdForPair.primitiveIds);
			appendPlannedSegmentsToSnapshot(workingSnapshot, net, plan.segments, `route:${net}:${index}`);
			routedPairCount += 1;
			totalSegmentCount += plan.segmentCount;
			estimatedLengthMil += Number(plan.estimatedLengthMil ?? 0);
			pairResults.push({
				index,
				status: dryRun ? 'planned' : 'created',
				from: summarizeEndpoint(pair.from),
				to: summarizeEndpoint(pair.to),
				distanceMil: round(pair.distanceMil, 1),
				plan,
				obstacleCheck,
				created: createdForPair,
			});
		} catch (error: any) {
			failedPairCount += 1;
			pairResults.push({
				index,
				status: 'failed',
				from: summarizeEndpoint(pair.from),
				to: summarizeEndpoint(pair.to),
				distanceMil: round(pair.distanceMil, 1),
				error: String(error?.message ?? error),
			});
			if (stopOnFailure) break;
		}
	}
	return {
		dryRun,
		committed: !dryRun && created.primitiveIds.length > 0,
		units: 'mil',
		net,
		layer,
		lineWidth,
		endpointCount: endpoints.length,
		pairCount: pairs.length,
		routedPairCount,
		failedPairCount,
		totalSegmentCount,
		estimatedLengthMil: round(estimatedLengthMil, 1),
		...clearanceReport(clearance.rule),
		pairs: pairResults,
		created,
		note: 'First-slice net routing uses deterministic nearest-neighbor pad pairs on one layer. Review dryRun results before committing multi-pair routes.',
	};
}

function selectRouteNetsForRouting(snapshot: Snapshot, params: Record<string, any>): Array<{ net: string; source: string; worklist?: any }> {
	const explicit = resolveNetList(params, snapshot);
	const maxNets = Math.max(1, Math.floor(Number(firstDefined(params.maxNets, params.netLimit, params.limit, 6))));
	if (explicit.length > 0) return explicit.slice(0, maxNets).map((net) => ({ net, source: 'explicit' }));
	const includeSinglePad = !!params.includeSinglePad;
	const statusSet = routeStatusSetFromParams(params);
	return snapshot.nets
		.map((net) => scoreNetForWork(snapshot.netIndex[net] ?? emptyNetSnapshot(net), snapshot))
		.filter((row) => includeSinglePad || row.padCount > 1)
		.filter((row) => statusSet.size === 0 || statusSet.has(row.status))
		.sort((a, b) => b.priorityScore - a.priorityScore)
		.slice(0, maxNets)
		.map((row) => ({ net: row.net, source: 'worklist', worklist: row }));
}

function routeStatusSetFromParams(params: Record<string, any>): Set<string> {
	const raw = Array.isArray(params.statuses) && params.statuses.length > 0
		? params.statuses
		: params.status
			? [params.status]
			: ['unrouted', 'pour_only'];
	return new Set(raw.map((status: any) => String(status)));
}

function summarizeSnapshotConnectivity(snapshot: Snapshot, nets: string[]): any {
	const selected = unique((nets.length > 0 ? nets : snapshot.nets).map(String));
	const counts = { routed: 0, pour_only: 0, unrouted: 0, single_pad: 0 };
	const rows = selected.map((net) => {
		const ns = snapshot.netIndex[net] ?? emptyNetSnapshot(net);
		const pads = ns.pads.length + ns.standalonePads.length;
		const lines = ns.lines.length;
		const vias = ns.vias.length;
		const pours = ns.pours.length;
		let status: 'routed' | 'pour_only' | 'unrouted' | 'single_pad';
		if (pads <= 1 && lines === 0 && vias === 0 && pours === 0) status = 'single_pad';
		else if (lines > 0 || vias > 0) status = 'routed';
		else if (pours > 0) status = 'pour_only';
		else status = 'unrouted';
		counts[status] += 1;
		return { net, status, pads, lines, vias, pours, lengthMil: round(ns.lengthMil, 1) };
	});
	const order: Record<string, number> = { unrouted: 0, pour_only: 1, routed: 2, single_pad: 3 };
	rows.sort((a, b) => order[a.status] - order[b.status] || a.net.localeCompare(b.net));
	return { netCount: rows.length, counts, nets: rows };
}

async function summarizeDrcForClosure(params: Record<string, any>): Promise<any> {
	try {
		const raw = await eda.pcb_Drc.check(params.strict !== false, params.ui === true, true);
		const violations = flattenDrcTree(raw);
		const top = Math.max(1, Math.floor(Number(params.drcTop ?? params.top ?? 12)));
		const groupBy = closureDrcGroupBy(params);
		const includeSamples = params.includeSamples !== false;
		type Counter = Map<string, { count: number; offenderIds: Set<string>; samples: any[] }>;
		const counters: Counter = new Map();
		for (const violation of violations) {
			const key = pickGroupKey(violation, groupBy);
			const entry = counters.get(key) ?? { count: 0, offenderIds: new Set<string>(), samples: [] };
			entry.count += 1;
			for (const id of collectIds(violation)) entry.offenderIds.add(id);
			if (includeSamples && entry.samples.length < 3) entry.samples.push(extractOffender(violation));
			counters.set(key, entry);
		}
		const topGroups = Array.from(counters.entries())
			.map(([key, row]) => ({
				key,
				count: row.count,
				offenderIds: Array.from(row.offenderIds).slice(0, 20),
				samples: includeSamples ? row.samples : undefined,
			}))
			.sort((a, b) => b.count - a.count)
			.slice(0, top);
		return { totalViolations: violations.length, groupBy, topGroups };
	} catch (error: any) {
		return { error: String(error?.message ?? error) };
	}
}

function closureDrcGroupBy(params: Record<string, any>): 'category' | 'net' | 'component' {
	const value = String(firstDefined(params.drcGroupBy, params.groupBy, 'category'));
	return value === 'net' || value === 'component' ? value : 'category';
}

function routeClosureVerdict(route: any, verification: any): any {
	const routeFailureCount = Number(route.failedNetCount ?? 0) + Number(route.failedPairCount ?? 0);
	const connectivityCounts = verification.connectivity?.counts;
	const incompleteNetCount = Number(connectivityCounts?.unrouted ?? 0) + Number(connectivityCounts?.pour_only ?? 0);
	const drcViolationCount = Number(verification.drc?.totalViolations ?? 0);
	if (route.dryRun !== false) {
		return { status: 'preview', passed: false, routeFailureCount, incompleteNetCount, drcViolationCount };
	}
	if (routeFailureCount > 0 || incompleteNetCount > 0) {
		return { status: 'needs_reroute', passed: false, routeFailureCount, incompleteNetCount, drcViolationCount };
	}
	if (verification.drc?.error) {
		return { status: 'verify_error', passed: false, routeFailureCount, incompleteNetCount, drcViolationCount, error: verification.drc.error };
	}
	if (drcViolationCount > 0) {
		return { status: 'needs_drc_fix', passed: false, routeFailureCount, incompleteNetCount, drcViolationCount };
	}
	return { status: 'pass', passed: true, routeFailureCount, incompleteNetCount, drcViolationCount };
}

function routeClosureNextActions(verdict: any, route: any, verification: any): string[] {
	if (verdict.status === 'preview') {
		return ['Review route.nets[].pairs obstacle checks, then rerun with dryRun:false to commit acceptable plans.'];
	}
	if (verdict.status === 'needs_reroute') {
		return [
			'Inspect failed route.nets[].pairs entries and their obstacleCheck samples.',
			'Retry blocked nets with a different layer, larger searchMarginMil, smaller gridMil, or manual corridor hints.',
			'Use pcb_inspect_area / pcb_screenshot_closeup around the failed segment before ripping existing copper.',
		];
	}
	if (verdict.status === 'needs_drc_fix') {
		return [
			'Inspect verification.drc.topGroups and fix the highest-count category first.',
			'Run pcb_drc_violations_detailed for repair locations when the grouped summary is not enough.',
		];
	}
	if (verdict.status === 'verify_error') {
		return ['Rerun DRC/connectivity verification separately; route primitives may still have been committed.'];
	}
	if (route.committed && verification.connectivity?.counts?.routed > 0) {
		return ['Route batch is committed and selected routed nets pass the closure checks returned here.'];
	}
	return ['No route edits were committed; inspect route output for skipped nets.'];
}

function planRipupRetry(snapshot: Snapshot, route: any, params: Record<string, any>): any {
	const blockers = collectRouteBlockers(route);
	const byNet = new Map<string, any>();
	for (const blocker of blockers) {
		if (!blocker.blockerNet || blocker.blockerNet === blocker.targetNet) continue;
		const existing = byNet.get(blocker.blockerNet) ?? {
			net: blocker.blockerNet,
			blockedTargets: new Set<string>(),
			obstacleCount: 0,
			obstacleTypes: new Set<string>(),
			samples: [] as any[],
		};
		existing.blockedTargets.add(blocker.targetNet);
		existing.obstacleCount += 1;
		if (blocker.type) existing.obstacleTypes.add(blocker.type);
		if (existing.samples.length < 5) existing.samples.push(blocker.sample);
		byNet.set(blocker.blockerNet, existing);
	}
	const maxCandidates = Math.max(1, Math.floor(Number(params.maxCandidates ?? 5)));
	const candidates = Array.from(byNet.values())
		.map((row) => enrichRipupCandidate(snapshot, row, params))
		.sort((a, b) => a.ripCost - b.ripCost)
		.slice(0, maxCandidates);
	return {
		blockerCount: blockers.length,
		candidateCount: candidates.length,
		candidates,
		recommendedRetries: candidates.map((candidate) => ({
			blockerNet: candidate.net,
			blockedTargets: candidate.blockedTargets,
			sequence: [
				...(candidate.deleteTrackIds.length > 0 ? [{ tool: 'pcb_delete_primitives', args: { type: 'track', ids: candidate.deleteTrackIds } }] : []),
				...(candidate.deleteViaIds.length > 0 ? [{ tool: 'pcb_delete_primitives', args: { type: 'via', ids: candidate.deleteViaIds } }] : []),
				{ tool: 'pcb_route_nets', args: retryRouteArgs(params, candidate) },
				{ tool: 'pcb_route_and_verify', args: { ...retryRouteArgs(params, candidate), dryRun: false } },
			],
		})),
	};
}

function collectRouteBlockers(route: any): any[] {
	const nets = routeNetResults(route);
	const blockers: any[] = [];
	for (const netResult of nets) {
		const targetNet = String(netResult.net ?? '');
		for (const pair of Array.isArray(netResult.pairs) ? netResult.pairs : []) {
			const obstacles = pair?.obstacleCheck?.obstacles;
			if (!Array.isArray(obstacles)) continue;
			for (const obstacle of obstacles) {
				const blockerNet = stringOrUndefined(obstacle.net);
				blockers.push({
					targetNet,
					blockerNet,
					type: obstacle.type,
					sample: {
						targetNet,
						pairIndex: pair.index,
						status: pair.status,
						type: obstacle.type,
						net: blockerNet,
						primitiveId: obstacle.primitiveId,
						reference: obstacle.reference,
						padNumber: obstacle.padNumber,
						distanceMil: obstacle.distanceMil,
						point: obstacle.point,
						reason: obstacle.reason,
					},
				});
			}
		}
	}
	return blockers;
}

function routeNetResults(route: any): any[] {
	if (Array.isArray(route?.nets)) return route.nets;
	if (route?.route) return routeNetResults(route.route);
	if (route?.net) return [route];
	return [];
}

function enrichRipupCandidate(snapshot: Snapshot, row: any, params: Record<string, any>): any {
	const ns = snapshot.netIndex[row.net] ?? emptyNetSnapshot(row.net);
	const trackIds = ns.lines.map((line) => stringOrUndefined(line.primitiveId)).filter((id): id is string => !!id);
	const viaIds = ns.vias.map((via) => stringOrUndefined(via.primitiveId)).filter((id): id is string => !!id);
	const padCount = ns.pads.length + ns.standalonePads.length;
	const primitiveCount = trackIds.length + viaIds.length;
	const powerPenalty = isPowerLikeNet(row.net) ? 100_000 : 0;
	const ripCost = round(powerPenalty + primitiveCount * 500 + ns.lengthMil + padCount * 50, 1);
	const blockedTargets = Array.from(row.blockedTargets).sort();
	return {
		net: row.net,
		blockedTargets,
		obstacleCount: row.obstacleCount,
		obstacleTypes: Array.from(row.obstacleTypes).sort(),
		ripCost,
		costFactors: {
			routePrimitiveCount: primitiveCount,
			lineCount: trackIds.length,
			viaCount: viaIds.length,
			padCount,
			lengthMil: round(ns.lengthMil, 1),
			powerPenalty,
		},
		deleteTrackIds: trackIds,
		deleteViaIds: viaIds,
		samples: row.samples,
		warning: primitiveCount === 0
			? 'Blocking net has no Line/Via primitives in the snapshot; rip-up may require placement change, pour rebuild, or manual corridor selection.'
			: 'Deleting these primitives will disconnect this blocker net until it is rerouted.',
	};
}

function retryRouteArgs(params: Record<string, any>, candidate: any): any {
	return {
		...pick(params, [
			'document', 'instance_id', 'layer', 'layer_preference', 'lineWidth', 'width_mil',
			'trace_width_mil', 'lineWidthByNet', 'maxConnections', 'gridMil', 'clearanceMil',
			'searchMarginMil', 'maxNodes', 'allowDiagonals', 'pullTight', 'pullTightPasses',
			'pullTightSampleMil', 'pullTightRequire45', 'ignoreSameNet', 'failOnObstacle',
			'primitiveLock', 'cacheTtlMs', 'cacheMaxEntries', 'pinConcurrency',
		]),
		nets: unique([...candidate.blockedTargets, candidate.net]),
		dryRun: true,
		stopOnNetFailure: false,
	};
}

function summarizeRouteForRetry(route: any): any {
	const nets = routeNetResults(route);
	return {
		dryRun: route?.dryRun,
		committed: route?.committed,
		netCount: nets.length,
		failedNetCount: route?.failedNetCount,
		failedPairCount: route?.failedPairCount,
		nets: nets.map((row) => ({
			net: row.net,
			routedPairCount: row.routedPairCount,
			failedPairCount: row.failedPairCount,
			blockedPairCount: Array.isArray(row.pairs) ? row.pairs.filter((pair: any) => pair.status === 'blocked').length : 0,
		})),
	};
}

function isPowerLikeNet(net: string): boolean {
	const upper = String(net).toUpperCase();
	return upper === 'GND' || upper.includes('GROUND') || /(VBUS|VBAT|BAT|VIN|VCC|VDD|\+5V|5V|\+3V3|3V3|3\.3V|POWER)/.test(upper);
}

function routeEndpointsForNet(ns: NetSnapshot, net: string): Endpoint[] {
	const endpoints: Endpoint[] = [
		...ns.pads.map((pad) => ({ ...pad, net: pad.net ?? net })),
		...ns.standalonePads
			.map((pad, index) => endpointFromStandalonePad(pad, net, index))
			.filter((endpoint): endpoint is Endpoint => !!endpoint),
	];
	const seen = new Set<string>();
	const out: Endpoint[] = [];
	for (const endpoint of endpoints) {
		const key = endpoint.primitiveId
			? `id:${endpoint.primitiveId}`
			: `xy:${round(endpoint.x, 3)},${round(endpoint.y, 3)},${endpoint.layer ?? ''},${endpoint.label}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(endpoint);
	}
	return out
		.filter((endpoint) => Number.isFinite(endpoint.x) && Number.isFinite(endpoint.y))
		.sort((a, b) => endpointSortKey(a).localeCompare(endpointSortKey(b)));
}

function endpointFromStandalonePad(pad: any, net: string, index: number): Endpoint | undefined {
	const x = Number(pad.x);
	const y = Number(pad.y);
	if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
	const padNumber = stringOrUndefined(firstDefined(pad.padNumber, pad.pinNumber, pad.number, pad.name));
	const reference = stringOrUndefined(firstDefined(pad.reference, pad.designator));
	const label = stringOrUndefined(pad.label)
		?? (reference ? `${reference}.${padNumber ?? index + 1}` : undefined)
		?? stringOrUndefined(firstDefined(pad.primitiveId, pad.id))
		?? `pad_${index + 1}`;
	return {
		label,
		x,
		y,
		net: stringOrUndefined(pad.net) ?? net,
		layer: pad.layer,
		primitiveId: stringOrUndefined(firstDefined(pad.primitiveId, pad.id)),
		reference,
		padNumber,
	};
}

function endpointSortKey(endpoint: Endpoint): string {
	return [
		String(endpoint.reference ?? ''),
		String(endpoint.padNumber ?? ''),
		String(endpoint.label ?? ''),
		String(endpoint.primitiveId ?? ''),
		round(endpoint.x, 3).toFixed(3),
		round(endpoint.y, 3).toFixed(3),
	].join('|');
}

function selectRouteNetPairs(endpoints: Endpoint[], limit: number): Array<{ from: Endpoint; to: Endpoint; distanceMil: number }> {
	if (endpoints.length < 2 || limit <= 0) return [];
	const pairs: Array<{ from: Endpoint; to: Endpoint; distanceMil: number }> = [];
	const connected = new Set<number>([0]);
	while (connected.size < endpoints.length && pairs.length < limit) {
		const best = findNearestUnconnectedPair(endpoints, connected, true) ?? findNearestUnconnectedPair(endpoints, connected, false);
		if (!best) break;
		pairs.push({ from: endpoints[best.fromIndex], to: endpoints[best.toIndex], distanceMil: best.distanceMil });
		connected.add(best.toIndex);
	}
	return pairs;
}

function findNearestUnconnectedPair(
	endpoints: Endpoint[],
	connected: Set<number>,
	skipSameComponent: boolean,
): { fromIndex: number; toIndex: number; distanceMil: number } | undefined {
	let best: { fromIndex: number; toIndex: number; distanceMil: number } | undefined;
	for (const fromIndex of connected) {
		for (let toIndex = 0; toIndex < endpoints.length; toIndex++) {
			if (connected.has(toIndex)) continue;
			const from = endpoints[fromIndex];
			const to = endpoints[toIndex];
			if (skipSameComponent && from.componentPrimitiveId && from.componentPrimitiveId === to.componentPrimitiveId) continue;
			const distanceMil = distance(from, to);
			if (!best || distanceMil < best.distanceMil) best = { fromIndex, toIndex, distanceMil };
		}
	}
	return best;
}

function cloneRoutingSnapshot(snapshot: Snapshot): Snapshot {
	return {
		...snapshot,
		document: { ...snapshot.document },
		components: [...snapshot.components],
		componentPads: [...snapshot.componentPads],
		standalonePads: [...snapshot.standalonePads],
		lines: [...snapshot.lines],
		polylines: [...snapshot.polylines],
		vias: [...snapshot.vias],
		pours: [...snapshot.pours],
		regions: [...snapshot.regions],
		keepouts: [...snapshot.keepouts],
		layers: [...snapshot.layers],
		nets: [...snapshot.nets],
		netIndex: Object.fromEntries(Object.entries(snapshot.netIndex).map(([net, ns]) => [net, {
			...ns,
			pads: [...ns.pads],
			standalonePads: [...ns.standalonePads],
			lines: [...ns.lines],
			vias: [...ns.vias],
			pours: [...ns.pours],
		}])),
		bounds: snapshot.bounds ? { ...snapshot.bounds } : undefined,
		boardOutline: snapshot.boardOutline ? { ...snapshot.boardOutline, bounds: snapshot.boardOutline.bounds ? { ...snapshot.boardOutline.bounds } : undefined } : undefined,
	};
}

function appendPlannedSegmentsToSnapshot(snapshot: Snapshot, net: string, segments: TraceSegmentSpec[], prefix: string): void {
	const lines = segments.map((segment, index) => ({
		primitiveId: `${prefix}:${index}`,
		net: segment.net ?? net,
		layer: normalizeLayerSafe(segment.layer),
		startX: segment.startX,
		startY: segment.startY,
		endX: segment.endX,
		endY: segment.endY,
		lineWidth: segment.lineWidth,
	}));
	snapshot.lines.push(...lines);
	let ns = snapshot.netIndex[net];
	if (!ns) {
		ns = emptyNetSnapshot(net);
		snapshot.netIndex[net] = ns;
		if (!snapshot.nets.includes(net)) snapshot.nets.push(net);
	}
	ns.lines.push(...lines);
	ns.lengthMil += sumLineLengths(lines);
}

function summarizeRoutePlan(plan: any): any {
	return {
		gridMil: plan.gridMil,
		searchRegion: plan.searchRegion,
		expandedNodeCount: plan.expandedNodeCount,
		rawPointCount: plan.rawPointCount,
		rawSegmentCount: plan.rawSegmentCount,
		pointCount: plan.pointCount,
		segmentCount: plan.segmentCount,
		estimatedLengthMil: plan.estimatedLengthMil,
		pullTight: plan.pullTight,
	};
}

async function createLineSegments(segments: TraceSegmentSpec[], primitiveLock: boolean): Promise<any> {
	const lines: any[] = [];
	for (const s of segments) {
		const created = await eda.pcb_PrimitiveLine.create(String(s.net), normalizeLayer(s.layer), s.startX, s.startY, s.endX, s.endY, s.lineWidth, primitiveLock);
		lines.push(flattenState(created));
	}
	return { lines, vias: [], primitiveIds: lines.map((l) => l.primitiveId).filter(Boolean) };
}

function pointsToSegments(points: Point[], net: string, layer: any, lineWidth: number | undefined, role: string): TraceSegmentSpec[] {
	const out: TraceSegmentSpec[] = [];
	for (let i = 0; i < points.length - 1; i++) {
		if (distance(points[i], points[i + 1]) <= 1e-6) continue;
		out.push({ net, layer, startX: points[i].x, startY: points[i].y, endX: points[i + 1].x, endY: points[i + 1].y, lineWidth, role });
	}
	return out;
}

function compressPath(points: Point[]): Point[] {
	const out: Point[] = [];
	for (const p of points) {
		if (out.length === 0 || distance(out[out.length - 1], p) > 1e-6) out.push({ x: round(p.x, 3), y: round(p.y, 3) });
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (let i = 1; i < out.length - 1; i++) {
			const a = out[i - 1], b = out[i], c = out[i + 1];
			const ab = normalizeVector({ x: b.x - a.x, y: b.y - a.y });
			const bc = normalizeVector({ x: c.x - b.x, y: c.y - b.y });
			if (Math.abs(ab.x - bc.x) < 1e-6 && Math.abs(ab.y - bc.y) < 1e-6) {
				out.splice(i, 1);
				changed = true;
				break;
			}
		}
	}
	return out;
}

function snapshotSummary(snapshot: Snapshot): any {
	return {
		cache: cacheInfo(snapshot),
		componentCount: snapshot.components.length,
		componentPadCount: snapshot.componentPads.length,
		standalonePadCount: snapshot.standalonePads.length,
		componentPadDuplicatesExcluded: snapshot.componentPadDuplicatesExcluded ?? 0,
		lineCount: snapshot.lines.length,
		polylineCount: snapshot.polylines.length,
		viaCount: snapshot.vias.length,
		pourCount: snapshot.pours.length,
		regionCount: snapshot.regions.length,
		keepoutCandidateCount: snapshot.keepouts.length,
		netCount: snapshot.nets.length,
		bounds: snapshot.bounds,
		boardOutline: snapshot.boardOutline,
	};
}

function summarizeObstacleMap(snapshot: Snapshot): any {
	const layers = new Map<string, any>();
	const bucket = (layer: any): any => {
		const key = layer == null ? 'unknown' : String(layer);
		let row = layers.get(key);
		if (!row) {
			row = { layer, tracks: 0, vias: 0, pads: 0, pours: 0, keepouts: 0, boardOutlineSegments: 0 };
			layers.set(key, row);
		}
		return row;
	};
	for (const line of snapshot.lines) {
		const row = bucket(line.layer);
		if (line.layer === 11) row.boardOutlineSegments += 1;
		else row.tracks += 1;
	}
	for (const polyline of snapshot.polylines) {
		const row = bucket(polyline.layer);
		if (polyline.layer === 11) row.boardOutlineSegments += 1;
	}
	for (const via of snapshot.vias) bucket('multi').vias += 1;
	for (const pad of [...snapshot.componentPads, ...snapshot.standalonePads]) bucket(pad.layer ?? 'multi').pads += 1;
	for (const pour of snapshot.pours) bucket(pour.layer).pours += 1;
	for (const keepout of snapshot.keepouts) bucket(keepout.layer ?? 'multi').keepouts += 1;
	return {
		units: 'mil',
		cache: cacheInfo(snapshot),
		binModel: 'coarse per-layer obstacle summary; pathfinder consumes the same cached primitives for point blocking',
		totals: {
			tracks: snapshot.lines.filter((l) => l.layer !== 11).length,
			vias: snapshot.vias.length,
			pads: snapshot.componentPads.length + snapshot.standalonePads.length,
			pours: snapshot.pours.length,
			regions: snapshot.regions.length,
			keepoutCandidates: snapshot.keepouts.length,
			boardOutlineSegments: snapshot.boardOutline?.segmentCount ?? 0,
		},
		layers: Array.from(layers.values()).sort((a, b) => String(a.layer).localeCompare(String(b.layer))),
		boardOutline: snapshot.boardOutline,
		note: 'Pours and keepout candidates are included in cached obstacle reasoning. Pour polygon tests are conservative when EasyEDA only exposes bounding geometry.',
	};
}

function cacheInfo(snapshot: Snapshot): any {
	return {
		key: snapshot.cacheKey,
		document: snapshot.document,
		createdAt: new Date(snapshot.createdAt).toISOString(),
		ageMs: Date.now() - snapshot.createdAt,
		entryCount: snapshotCache.size,
		maxEntriesDefault: DEFAULT_CACHE_MAX_ENTRIES,
	};
}

function emptyNetSnapshot(net: string): NetSnapshot {
	return { net, pads: [], standalonePads: [], lines: [], vias: [], pours: [], lengthMil: 0 };
}

function summarizeEndpoint(e: Endpoint): any {
	return { label: e.label, x: round(e.x, 3), y: round(e.y, 3), net: e.net, layer: e.layer, primitiveId: e.primitiveId, reference: e.reference, padNumber: e.padNumber };
}

function summarizePad(p: ComponentPad): any {
	return { label: p.label, reference: p.reference, padNumber: p.padNumber, net: p.net, layer: p.layer, x: round(p.x, 3), y: round(p.y, 3), primitiveId: p.primitiveId, componentPrimitiveId: p.componentPrimitiveId };
}

function summarizeComponent(c: Component): any {
	return { primitiveId: c.primitiveId, designator: c.designator, name: c.name, layer: c.layer, x: round(c.x, 3), y: round(c.y, 3), rotation: c.rotation, primitiveLock: c.primitiveLock, pinCount: c.pinCount, bounds: c.bounds };
}

function summarizeLine(l: any): any {
	return { primitiveId: l.primitiveId, net: l.net, layer: l.layer, startX: round(l.startX, 3), startY: round(l.startY, 3), endX: round(l.endX, 3), endY: round(l.endY, 3), lineWidth: l.lineWidth };
}

function summarizeVia(v: any): any {
	return { primitiveId: v.primitiveId, net: v.net, x: round(v.x, 3), y: round(v.y, 3), diameter: v.diameter, holeDiameter: v.holeDiameter };
}

function summarizeRegion(r: any): any {
	return {
		primitiveId: r.primitiveId,
		kind: r.kind,
		net: r.net,
		layer: r.layer,
		ruleType: r.ruleType,
		regionName: r.regionName ?? r.name,
		pourName: r.pourName,
		primitiveLock: r.primitiveLock,
		bounds: r.bounds,
		sourceSummary: r.sourceSummary,
	};
}

function sumLineLengths(lines: any[]): number {
	return lines.reduce((sum, l) => sum + distance({ x: l.startX, y: l.startY }, { x: l.endX, y: l.endY }), 0);
}

function resolveComponent(params: Record<string, any>, snapshot: Snapshot): Component {
	const primitiveId = stringOrUndefined(firstDefined(params.primitiveId, params.componentPrimitiveId, params.id));
	const ref = stringOrUndefined(firstDefined(params.reference, params.designator, params.ref));
	const found = snapshot.components.find((c) =>
		(primitiveId && c.primitiveId === primitiveId) ||
		(ref && String(c.designator ?? '').toUpperCase() === ref.toUpperCase()),
	);
	if (!found) throw new Error(`Component ${primitiveId ?? ref ?? '(missing target)'} not found.`);
	return found;
}

function resolveLineWidth(params: Record<string, any>, net?: string): number | undefined {
	const map = params.lineWidthByNet ?? params.widthByNet ?? params.traceWidthByNet;
	if (net && map && typeof map === 'object' && Number.isFinite(map[net])) return Number(map[net]);
	const value = firstDefined(params.lineWidth, params.traceWidth, params.traceWidthMil, params.trace_width_mil, params.width_mil, params.widthMil);
	return Number.isFinite(value) ? Number(value) : undefined;
}

function firstDefined(...values: any[]): any {
	for (const value of values) if (value !== undefined && value !== null) return value;
	return undefined;
}

function firstFinite(...values: any[]): number {
	for (const value of values) {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return Number.NaN;
}

function stringOrUndefined(value: any): string | undefined {
	if (value === undefined || value === null) return undefined;
	const s = String(value).trim();
	return s ? s : undefined;
}

function normalizeLayerSafe(layer: any): any {
	try { return layer != null ? normalizeLayer(layer) : undefined; } catch { return layer; }
}

function layersTouch(a: any, b: any): boolean {
	const la = normalizeLayerSafe(a);
	const lb = normalizeLayerSafe(b);
	if (la == null || lb == null) return true;
	if (la === 12 || lb === 12) return true;
	return String(la) === String(lb);
}

function pick(obj: Record<string, any>, keys: string[]): Record<string, any> {
	const out: Record<string, any> = {};
	for (const key of keys) if (obj[key] !== undefined) out[key] = obj[key];
	return out;
}

function unique<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}

function boundsForPoints(points: Point[]): Bounds | undefined {
	const finite = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
	if (finite.length === 0) return undefined;
	let minX = finite[0].x, maxX = finite[0].x, minY = finite[0].y, maxY = finite[0].y;
	for (const p of finite.slice(1)) {
		minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
		minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
	}
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function boundsFromAny(value: any): Bounds | undefined {
	if (!value || typeof value !== 'object') return undefined;
	if ([value.minX, value.minY, value.maxX, value.maxY].every((v) => Number.isFinite(Number(v)))) {
		return normalizeBounds(Number(value.minX), Number(value.minY), Number(value.maxX), Number(value.maxY));
	}
	if ([value.left, value.top, value.right, value.bottom].every((v) => Number.isFinite(Number(v)))) {
		return normalizeBounds(Number(value.left), Number(value.top), Number(value.right), Number(value.bottom));
	}
	if (value.summary?.bbox) return boundsFromAny(value.summary.bbox);
	if (value.bounds) return boundsFromAny(value.bounds);
	const x = firstFinite(value.x, value.centerX);
	const y = firstFinite(value.y, value.centerY);
	if (Number.isFinite(x) && Number.isFinite(y)) return normalizeBounds(x, y, x, y);
	return undefined;
}

function normalizeBounds(x1: number, y1: number, x2: number, y2: number): Bounds {
	const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
	const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function boundsOfPrimitive(value: any): Bounds | undefined {
	return boundsFromAny(value?.bounds) ?? boundsFromAny(value) ?? polygonSourceBounds(readPolygonSource(value));
}

function primitiveTouchesBounds(value: any, region: Bounds): boolean {
	const b = boundsOfPrimitive(value);
	return !!b && boundsOverlap(b, region);
}

function isKeepoutRegion(region: any): boolean {
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

function readPolygonSource(value: any): any {
	if (!value) return undefined;
	for (const fn of ['getState_ComplexPolygon', 'getState_Polygon', 'getState_Source']) {
		try {
			if (typeof value[fn] === 'function') {
				const source = sourceOfPolygon(value[fn]());
				if (source != null) return source;
			}
		} catch {/* ignore */}
	}
	return sourceOfPolygon(value.complexPolygon ?? value.polygon ?? value.source ?? value.sourcePolygon);
}

function sourceOfPolygon(value: any): any {
	if (!value) return value;
	if (typeof value.getSource === 'function') {
		try { return value.getSource(); } catch {/* ignore */ }
	}
	return value;
}

function polygonSourceBounds(source: any): Bounds | undefined {
	const points = polygonSourcePoints(source);
	return points.length > 0 ? boundsForPoints(points) : undefined;
}

function summarizePolygonSource(source: any): any {
	const points = polygonSourcePoints(source);
	const bounds = points.length > 0 ? boundsForPoints(points) : undefined;
	return {
		mode: Array.isArray(source) ? String(source[0] ?? 'unknown') : typeof source,
		vertexCount: points.length,
		bounds,
	};
}

function polygonSourcePoints(source: any): Point[] {
	if (!source) return [];
	if (Array.isArray(source)) {
		if (source.length >= 7 && String(source[0]).toUpperCase() === 'R') {
			const left = Number(source[1]);
			const top = Number(source[2]);
			const width = Number(source[3]);
			const height = Number(source[4]);
			if ([left, top, width, height].every(Number.isFinite)) {
				return [
					{ x: left, y: top },
					{ x: left + width, y: top },
					{ x: left + width, y: top + height },
					{ x: left, y: top + height },
				];
			}
		}
		if (source.length > 0 && typeof source[0] === 'string') {
			const nums = source.slice(1).filter((v) => typeof v === 'number').map(Number);
			return xyPairs(nums);
		}
		if (source.length >= 2 && typeof source[0] === 'number' && typeof source[1] === 'number') {
			const nums = source.filter((v) => typeof v === 'number').map(Number);
			return xyPairs(nums);
		}
		if (source.length > 0 && typeof source[0] === 'object') {
			return source.map((p) => ({ x: Number(p.x), y: Number(p.y) })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
		}
	}
	if (typeof source === 'object' && Array.isArray(source.points)) return polygonSourcePoints(source.points);
	return [];
}

function xyPairs(nums: number[]): Point[] {
	const points: Point[] = [];
	for (let i = 0; i + 1 < nums.length; i += 2) {
		const x = Number(nums[i]);
		const y = Number(nums[i + 1]);
		if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
	}
	return points;
}

function expandBounds(bounds: Bounds, amount: number): Bounds {
	return normalizeBounds(bounds.minX - amount, bounds.minY - amount, bounds.maxX + amount, bounds.maxY + amount);
}

function translateBounds(bounds: Bounds, dx: number, dy: number): Bounds {
	return { minX: bounds.minX + dx, minY: bounds.minY + dy, maxX: bounds.maxX + dx, maxY: bounds.maxY + dy, width: bounds.width, height: bounds.height };
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function overlapArea(a: Bounds, b: Bounds): number {
	const w = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
	const h = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
	return w * h;
}

function pointInBounds(p: Point, b: Bounds): boolean {
	return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}

function segmentTouchesBounds(segment: any, bounds: Bounds): boolean {
	const sb = boundsForPoints([{ x: segment.startX, y: segment.startY }, { x: segment.endX, y: segment.endY }]);
	return !!sb && boundsOverlap(sb, bounds);
}

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function pathLength(points: Point[]): number {
	let total = 0;
	for (let i = 0; i < points.length - 1; i++) total += distance(points[i], points[i + 1]);
	return total;
}

function normalizeVector(v: Point): Point {
	const len = Math.hypot(v.x, v.y);
	return len > 1e-9 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
}

function pointToSegmentDistance(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x, dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	if (len2 <= 1e-12) return distance(p, a);
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
	return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
	if (segmentsIntersect(a, b, c, d)) return 0;
	return Math.min(pointToSegmentDistance(a, c, d), pointToSegmentDistance(b, c, d), pointToSegmentDistance(c, a, b), pointToSegmentDistance(d, a, b));
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
	const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
	return o1 * o2 < 0 && o3 * o4 < 0;
}

function orient(a: Point, b: Point, c: Point): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function turnPenalty(_current: any, _next: any, _previous: any): number {
	return 0;
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function round(value: number, digits = 0): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

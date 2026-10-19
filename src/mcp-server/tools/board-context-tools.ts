import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';
import { buildObstacleMap, summarizeObstacleMap } from '../analyzers/obstacle-map';

const layerSchema = z.union([z.string(), z.number()]);
const pointSchema = z.object({ x: z.number(), y: z.number(), layer: layerSchema.optional(), net: z.string().optional(), label: z.string().optional() }).passthrough();
const endpointSchema = z.union([
	z.string().describe('Pad ref such as "U12.6" or "U12:6"'),
	pointSchema,
	z.object({
		reference: z.string().optional(),
		designator: z.string().optional(),
		padNumber: z.union([z.string(), z.number()]).optional(),
		pad_number: z.union([z.string(), z.number()]).optional(),
		pin: z.union([z.string(), z.number()]).optional(),
		pad_ref: z.string().optional(),
		padRef: z.string().optional(),
	}).passthrough(),
]);

const regionFields = {
	left: z.number().optional(),
	right: z.number().optional(),
	top: z.number().optional(),
	bottom: z.number().optional(),
	x: z.number().optional().describe('Area center x in mil; use with y + radiusMil.'),
	y: z.number().optional().describe('Area center y in mil; use with x + radiusMil.'),
	radiusMil: z.number().positive().optional().default(250),
	startX: z.number().optional().describe('Segment start x in mil; use with startY/endX/endY.'),
	startY: z.number().optional(),
	endX: z.number().optional(),
	endY: z.number().optional(),
	marginMil: z.number().nonnegative().optional().default(250),
} as const;

const cacheFields = {
	forceRefresh: z.boolean().optional().default(false).describe('Rebuild the cached board snapshot before answering.'),
	cacheTtlMs: z.number().int().nonnegative().optional().default(10000).describe('Use cached board snapshot if younger than this many ms.'),
	cacheMaxEntries: z.number().int().positive().optional().default(4).describe('Max document/version snapshot entries retained in the extension LRU.'),
	pinConcurrency: z.number().int().positive().optional().default(4).describe('Bounded component-pin fetch concurrency while refreshing cache.'),
} as const;

const widthFields = {
	lineWidth: z.number().positive().optional().describe('Trace width in mil'),
	width_mil: z.number().positive().optional().describe('Alias for lineWidth'),
	trace_width_mil: z.number().positive().optional().describe('Alias for lineWidth'),
	lineWidthByNet: z.record(z.string(), z.number().positive()).optional().describe('Per-net trace widths in mil'),
} as const;

export function registerBoardContextTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'pcb_refresh_board_cache',
		'Rebuild the extension-side spatial snapshot cache used by context, worklist, obstacle-aware pathfinding, and placement advisors.',
		withDocumentParam({
			pinConcurrency: cacheFields.pinConcurrency,
		}),
		async (params) => {
			const result = await bridge.send('pcb.board.refreshCache', { ...params, forceRefresh: true });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_routing_presets',
		'Return recommended trace width, via size, clearance, and via strategy by net. Uses DRC/net-class data where available, then net-name heuristics.',
		withDocumentParam({
			net: z.string().optional(),
			nets: z.array(z.string()).optional(),
			...cacheFields,
		}),
		async (params) => {
			const result = await bridge.send('pcb.routing.presets', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_routing_context',
		'One-call routing context packet: board/layer/rule summary, selected nets, endpoints, pads, nearest pad pairs, existing routes, vias, and optional area primitives.',
		withDocumentParam({
			net: z.string().optional(),
			nets: z.array(z.string()).optional(),
			from_pad: endpointSchema.optional(),
			to_pad: endpointSchema.optional(),
			endpoints: z.array(endpointSchema).optional(),
			...regionFields,
			maxItems: z.number().int().positive().optional().default(80),
			maxPairsPerNet: z.number().int().positive().optional().default(12),
			...cacheFields,
		}),
		async (params) => {
			const { args, clamped } = clampMaxItems(params);
			const result = await bridge.send('pcb.context.routing', args);
			return { content: [{ type: 'text', text: JSON.stringify(slimAreaPacket(result, clamped)) }] };
		},
	);

	server.tool(
		'pcb_get_net_worklist',
		'Rank nets by routing priority/difficulty using pad count, route coverage, nearest-pad span, and obstacle density near likely ratlines.',
		withDocumentParam({
			limit: z.number().int().positive().optional().default(30),
			status: z.enum(['unrouted', 'pour_only', 'partially_or_fully_routed', 'single_pad']).optional(),
			includeSinglePad: z.boolean().optional().default(false),
			...cacheFields,
		}),
		async (params) => {
			const result = await bridge.send('pcb.context.netWorklist', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_inspect_area',
		'Inspect a PCB area from the cached spatial snapshot: components, pads, tracks, vias, pours, keepout candidates, nets, and a ready-to-call pcb_screenshot_closeup hint.',
		withDocumentParam({
			...regionFields,
			maxItems: z.number().int().positive().optional().default(80),
			...cacheFields,
		}),
		async (params) => {
			const { args, clamped } = clampMaxItems(params);
			const result = await bridge.send('pcb.context.inspectArea', args);
			return { content: [{ type: 'text', text: JSON.stringify(slimAreaPacket(result, clamped)) }] };
		},
	);

	server.tool(
		'pcb_get_keepouts',
		'List DRC region primitives that look like keepouts/no-route/no-copper constraints. Use before routing so path planning can avoid board-specific restricted areas.',
		withDocumentParam({
			...regionFields,
			maxItems: z.number().int().positive().optional().default(100),
			...cacheFields,
		}),
		async (params) => {
			const result = await bridge.send('pcb.context.keepouts', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_obstacle_map_summary',
		'Return a per-layer obstacle summary from the cached board snapshot or a supplied snapshot: tracks, vias, pads, pours, keepout candidates, and board-outline segments. This is the current R1 obstacle-map surface used by pathfinding.',
		withDocumentParam({
			snapshot: z.any().optional().describe('Optional pre-fetched board snapshot/context. If supplied, analysis runs MCP-side without hitting EasyEDA.'),
			binSizeMil: z.number().positive().optional().default(100).describe('Spatial bin size for MCP-side snapshot analysis.'),
			netRules: z.any().optional().describe('Optional net-rule payload from pcb_manage_net_rules/get_net for MCP-side analysis.'),
			...cacheFields,
		}),
		async ({ snapshot, binSizeMil, netRules, ...params }) => {
			// The MCP-side map needs the full rule configuration: net rows only
			// name rules, the values live in the configuration.
			const ruleConfig = snapshot ? await bridge.send('pcb.drc.getRuleConfiguration', { ...params, _timeoutMs: 15_000 }).catch(() => undefined) : undefined;
			const result = snapshot
				? summarizeObstacleMap(buildObstacleMap(snapshot, { binSizeMil, netRules: netRules ?? (ruleConfig as any)?.Net, ruleConfig }))
				: await bridge.send('pcb.context.obstacleMap', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_route_pathfind',
		'Obstacle-aware grid pathfinder for one net on one copper layer. Plans a route around different-net tracks, vias, pads, pours, and keepout candidates; pull-tight shortcuts legal 45-degree grid slack by default; runs final obstacle preflight; and can commit Line primitives.',
		withDocumentParam({
			from_pad: endpointSchema.optional().describe('Start endpoint: "U12.6", {reference,padNumber}, or {x,y}. Or give startX/startY.'),
			to_pad: endpointSchema.optional().describe('End endpoint: "U13.4", {reference,padNumber}, or {x,y}. Or give endX/endY.'),
			startX: z.number().optional().describe('Point form of from_pad (mil); with startY. Needs net.'),
			startY: z.number().optional(),
			endX: z.number().optional().describe('Point form of to_pad (mil); with endY. Needs net.'),
			endY: z.number().optional(),
			net: z.string().optional().describe('Net name; inferred from pads when possible.'),
			layer: layerSchema.optional().describe('Copper layer to route on.'),
			layer_preference: layerSchema.optional().describe('Alias for layer.'),
			...widthFields,
			gridMil: z.number().positive().optional().default(50).describe('Pathfinder grid size in mil. Smaller is more precise but slower.'),
			clearanceMil: z.number().nonnegative().optional().describe('Override (mil) applied to every obstacle kind. Omit to use the board DRC Safe Spacing rule of each routed net (track/pad/via cells); results report clearanceMil and clearanceSource.'),
			searchMarginMil: z.number().positive().optional().default(1200),
			maxNodes: z.number().int().positive().optional().default(20000),
			allowDiagonals: z.boolean().optional().default(true).describe('Allow 45-degree path steps.'),
			pullTight: z.boolean().optional().default(true).describe('Post-process the grid path by shortcutting legal octilinear segments against the same obstacle model.'),
			pullTightPasses: z.number().int().positive().optional().default(2).describe('Max pull-tight shortcut passes.'),
			pullTightSampleMil: z.number().positive().optional().describe('Obstacle sample spacing for pull-tight line-of-sight checks. Default: max(5, gridMil/2).'),
			pullTightRequire45: z.boolean().optional().default(true).describe('Only accept pull-tight shortcuts whose segment is horizontal, vertical, or 45 degrees.'),
			ignoreSameNet: z.boolean().optional().default(true),
			failOnObstacle: z.boolean().optional().default(true),
			primitiveLock: z.boolean().optional(),
			dryRun: z.boolean().optional().default(false).describe('Return route plan only; do not create Line primitives.'),
			...cacheFields,
		}),
		async (params) => {
			// Point aliases are resolved (and validated) by the extension handler.
			const p = params as any;
			const missing = [
				p.from_pad == null && p.startX == null && p.startY == null ? 'from_pad (or startX/startY)' : undefined,
				p.to_pad == null && p.endX == null && p.endY == null ? 'to_pad (or endX/endY)' : undefined,
			].filter(Boolean);
			if (missing.length > 0) {
				return { content: [{ type: 'text', text: JSON.stringify({ error: `pcb_route_pathfind requires ${missing.join(' and ')}.` }) }], isError: true };
			}
			const result = await bridge.send('pcb.route.pathfind', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_route_net',
		'Route multiple selected pad-pair connections for one net on one copper layer using the obstacle-aware pathfinder and pull-tight post-pass. Defaults to dryRun=true; pass dryRun:false to commit planned Line primitives.',
		withDocumentParam({
			net: z.string().describe('Net name to route.'),
			layer: layerSchema.optional().describe('Copper layer to route on.'),
			layer_preference: layerSchema.optional().describe('Alias for layer.'),
			...widthFields,
			maxConnections: z.number().int().positive().optional().default(8).describe('Maximum nearest-neighbor pad-pair connections to plan/create for this net.'),
			stopOnFailure: z.boolean().optional().default(true).describe('Stop at the first blocked/failed pad pair. Pass false to keep trying later pairs.'),
			gridMil: z.number().positive().optional().default(50).describe('Pathfinder grid size in mil. Smaller is more precise but slower.'),
			clearanceMil: z.number().nonnegative().optional().describe('Override (mil) applied to every obstacle kind. Omit to use the board DRC Safe Spacing rule of each routed net (track/pad/via cells); results report clearanceMil and clearanceSource.'),
			searchMarginMil: z.number().positive().optional().default(1200),
			maxNodes: z.number().int().positive().optional().default(20000),
			allowDiagonals: z.boolean().optional().default(true).describe('Allow 45-degree path steps.'),
			pullTight: z.boolean().optional().default(true).describe('Post-process each grid path by shortcutting legal octilinear segments against the same obstacle model.'),
			pullTightPasses: z.number().int().positive().optional().default(2).describe('Max pull-tight shortcut passes per connection.'),
			pullTightSampleMil: z.number().positive().optional().describe('Obstacle sample spacing for pull-tight line-of-sight checks. Default: max(5, gridMil/2).'),
			pullTightRequire45: z.boolean().optional().default(true).describe('Only accept pull-tight shortcuts whose segment is horizontal, vertical, or 45 degrees.'),
			ignoreSameNet: z.boolean().optional().default(true),
			failOnObstacle: z.boolean().optional().default(true),
			primitiveLock: z.boolean().optional(),
			dryRun: z.boolean().optional().default(true).describe('Preview/preflight only by default. Pass false to create Line primitives.'),
			...cacheFields,
		}),
		async (params) => {
			const result = await bridge.send('pcb.route.net', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_route_nets',
		'Route a worklist of nets in priority order using pcb_route_net semantics and one shared working snapshot, so earlier accepted net plans become obstacles for later nets. Defaults to dryRun=true.',
		withDocumentParam({
			net: z.string().optional().describe('Optional single explicit net. If omitted with nets, the tool selects worklist nets.'),
			nets: z.array(z.string()).optional().describe('Optional explicit net order. If omitted, uses the cached net worklist.'),
			maxNets: z.number().int().positive().optional().default(6).describe('Maximum nets to attempt from explicit list or worklist.'),
			status: z.enum(['unrouted', 'pour_only', 'partially_or_fully_routed', 'single_pad']).optional().describe('Worklist status filter. Default: unrouted + pour_only.'),
			statuses: z.array(z.enum(['unrouted', 'pour_only', 'partially_or_fully_routed', 'single_pad'])).optional().describe('Worklist status filters. Default: unrouted + pour_only.'),
			includeSinglePad: z.boolean().optional().default(false),
			layer: layerSchema.optional().describe('Copper layer to route on.'),
			layer_preference: layerSchema.optional().describe('Alias for layer.'),
			...widthFields,
			maxConnections: z.number().int().positive().optional().default(8).describe('Maximum nearest-neighbor pad-pair connections per net.'),
			stopOnFailure: z.boolean().optional().default(true).describe('Within each net, stop at the first blocked/failed pad pair.'),
			stopOnNetFailure: z.boolean().optional().default(true).describe('Stop the multi-net run after a net has a blocked/failed pair.'),
			gridMil: z.number().positive().optional().default(50).describe('Pathfinder grid size in mil. Smaller is more precise but slower.'),
			clearanceMil: z.number().nonnegative().optional().describe('Override (mil) applied to every obstacle kind. Omit to use the board DRC Safe Spacing rule of each routed net (track/pad/via cells); results report clearanceMil and clearanceSource.'),
			searchMarginMil: z.number().positive().optional().default(1200),
			maxNodes: z.number().int().positive().optional().default(20000),
			allowDiagonals: z.boolean().optional().default(true).describe('Allow 45-degree path steps.'),
			pullTight: z.boolean().optional().default(true).describe('Post-process each grid path by shortcutting legal octilinear segments against the same obstacle model.'),
			pullTightPasses: z.number().int().positive().optional().default(2).describe('Max pull-tight shortcut passes per connection.'),
			pullTightSampleMil: z.number().positive().optional().describe('Obstacle sample spacing for pull-tight line-of-sight checks. Default: max(5, gridMil/2).'),
			pullTightRequire45: z.boolean().optional().default(true).describe('Only accept pull-tight shortcuts whose segment is horizontal, vertical, or 45 degrees.'),
			ignoreSameNet: z.boolean().optional().default(true),
			failOnObstacle: z.boolean().optional().default(true),
			primitiveLock: z.boolean().optional(),
			dryRun: z.boolean().optional().default(true).describe('Preview/preflight only by default. Pass false to create Line primitives.'),
			...cacheFields,
		}),
		async (params) => {
			const result = await bridge.send('pcb.route.nets', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_route_and_verify',
		'Run pcb_route_nets, then after committed routes refresh the board snapshot and return connectivity plus optional DRC closure summaries. Defaults to dryRun=true, so pass dryRun:false for a real route-and-verify loop.',
		withDocumentParam({
			net: z.string().optional().describe('Optional single explicit net. If omitted with nets, the tool selects worklist nets.'),
			nets: z.array(z.string()).optional().describe('Optional explicit net order. If omitted, uses the cached net worklist.'),
			maxNets: z.number().int().positive().optional().default(6).describe('Maximum nets to attempt from explicit list or worklist.'),
			status: z.enum(['unrouted', 'pour_only', 'partially_or_fully_routed', 'single_pad']).optional().describe('Worklist status filter. Default: unrouted + pour_only.'),
			statuses: z.array(z.enum(['unrouted', 'pour_only', 'partially_or_fully_routed', 'single_pad'])).optional().describe('Worklist status filters. Default: unrouted + pour_only.'),
			includeSinglePad: z.boolean().optional().default(false),
			layer: layerSchema.optional().describe('Copper layer to route on.'),
			layer_preference: layerSchema.optional().describe('Alias for layer.'),
			...widthFields,
			maxConnections: z.number().int().positive().optional().default(8).describe('Maximum nearest-neighbor pad-pair connections per net.'),
			stopOnFailure: z.boolean().optional().default(true).describe('Within each net, stop at the first blocked/failed pad pair.'),
			stopOnNetFailure: z.boolean().optional().default(true).describe('Stop the multi-net run after a net has a blocked/failed pair.'),
			gridMil: z.number().positive().optional().default(50),
			clearanceMil: z.number().nonnegative().optional().describe('Override (mil) applied to every obstacle kind. Omit to use the board DRC Safe Spacing rule of each routed net (track/pad/via cells); results report clearanceMil and clearanceSource.'),
			searchMarginMil: z.number().positive().optional().default(1200),
			maxNodes: z.number().int().positive().optional().default(20000),
			allowDiagonals: z.boolean().optional().default(true),
			pullTight: z.boolean().optional().default(true),
			pullTightPasses: z.number().int().positive().optional().default(2),
			pullTightSampleMil: z.number().positive().optional(),
			pullTightRequire45: z.boolean().optional().default(true),
			ignoreSameNet: z.boolean().optional().default(true),
			failOnObstacle: z.boolean().optional().default(true),
			primitiveLock: z.boolean().optional(),
			dryRun: z.boolean().optional().default(true).describe('Preview/preflight only by default. Pass false to create Line primitives and verify the committed board.'),
			verifyConnectivity: z.boolean().optional().describe('Verify selected routed nets after commit. Default true after dryRun:false, false for dry-runs unless explicitly true.'),
			runDrc: z.boolean().optional().describe('Run DRC summary after commit. Default true after dryRun:false, false for dry-runs unless explicitly true.'),
			drcGroupBy: z.enum(['category', 'net', 'component']).optional().default('category'),
			drcTop: z.number().int().positive().optional().default(12).describe('Max DRC groups returned in closure summary.'),
			includeSamples: z.boolean().optional().default(true).describe('Include sample DRC offenders in closure summary.'),
			...cacheFields,
		}),
		async (params) => {
			const result = await bridge.send('pcb.route.andVerify', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_route_retry_plan',
		'Read-only rip-up/retry planner. Given a failed pcb_route_nets/pcb_route_and_verify result, or by running a dry route first, extracts blocking obstacle nets and ranks low-cost rip-up candidates. Does not delete copper.',
		withDocumentParam({
			routeResult: z.any().optional().describe('Previous result from pcb_route_nets or pcb_route_and_verify. If omitted, this tool runs pcb_route_nets with dryRun:true first.'),
			route: z.any().optional().describe('Alias for routeResult.'),
			net: z.string().optional().describe('Optional single explicit net when generating a fresh dry-run route.'),
			nets: z.array(z.string()).optional().describe('Optional explicit net order when generating a fresh dry-run route.'),
			maxCandidates: z.number().int().positive().optional().default(5).describe('Maximum rip-up candidates to return.'),
			maxNets: z.number().int().positive().optional().default(6),
			status: z.enum(['unrouted', 'pour_only', 'partially_or_fully_routed', 'single_pad']).optional(),
			statuses: z.array(z.enum(['unrouted', 'pour_only', 'partially_or_fully_routed', 'single_pad'])).optional(),
			layer: layerSchema.optional(),
			layer_preference: layerSchema.optional(),
			...widthFields,
			maxConnections: z.number().int().positive().optional().default(8),
			stopOnFailure: z.boolean().optional().default(true),
			stopOnNetFailure: z.boolean().optional().default(true),
			gridMil: z.number().positive().optional().default(50),
			clearanceMil: z.number().nonnegative().optional().describe('Override (mil) applied to every obstacle kind. Omit to use the board DRC Safe Spacing rule of each routed net (track/pad/via cells); results report clearanceMil and clearanceSource.'),
			searchMarginMil: z.number().positive().optional().default(1200),
			maxNodes: z.number().int().positive().optional().default(20000),
			allowDiagonals: z.boolean().optional().default(true),
			pullTight: z.boolean().optional().default(true),
			pullTightPasses: z.number().int().positive().optional().default(2),
			pullTightSampleMil: z.number().positive().optional(),
			pullTightRequire45: z.boolean().optional().default(true),
			ignoreSameNet: z.boolean().optional().default(true),
			failOnObstacle: z.boolean().optional().default(true),
			...cacheFields,
		}),
		async (params) => {
			const result = await bridge.send('pcb.route.retryPlan', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	const layerArg = z.union([z.string(), z.number()]);
	const terminal = z.union([
		z.string().describe('pad ref, e.g. "U3.12"'),
		z.object({
			pad: z.string().optional(),
			via: z.string().optional().describe('existing via id'),
			track: z.string().optional().describe('existing track id'),
			end: z.enum(['start', 'end']).optional().describe('which end of `track`'),
			x: z.number().optional(),
			y: z.number().optional(),
			layer: layerArg.optional(),
		}),
	]);
	const routePoint = z.object({ x: z.number(), y: z.number(), layer: layerArg.optional().describe('switch to this layer here (places a via)') });
	const viaSize = z.object({ diameter: z.number().positive(), holeDiameter: z.number().positive() });
	server.tool(
		'pcb_route_path',
		`Commit EXACTLY the route you planned — no re-synthesis, no pathfinding — or nothing. Primary routing tool.
from/to: pad ref "U3.12" | {via:id} | {track:id, end:"start"|"end"} | {track:id, x, y} (T-junction) | {x,y,layer} (must touch same-net copper). points: interior vertices in order; a point with "layer" places a via there and continues on that layer. width is required (never guessed). Checks before anything is created: terminal nets match (no shorts), 45° legs, no acute turns, layer continuity at both ends, clearance to different-net copper from the board's DRC rules (pours are plane-cut warnings). Commit is one transaction for all routes in the call; afterwards the new copper must join each route's terminals in the real copper graph (verify:"drc" also requires zero new real DRC violations; stale connection/pour errors are reported separately) or the call removes what it made. Identical existing copper is reused, never duplicated; pass requestId so a retried call after a timeout replays instead of re-committing. Same response shape for dry-run | invalid | blocked | committed | already-present | rolled-back. Coordinates: the API frame of pcb_get_routing_context / pcb_inspect_area (not the GUI ruler).`,
		withDocumentParam({
			net: z.string().optional(),
			from: terminal.optional(),
			to: terminal.optional(),
			points: z.array(routePoint).optional(),
			layer: layerArg.optional().describe('layer of the first leg (default: the starting pad\'s layer)'),
			width: z.number().positive().optional().describe('track width (required here or per route)'),
			via: viaSize.optional().describe('via size for layer changes (default 24/12 mil, flagged)'),
			routes: z.array(z.object({
				net: z.string().optional(),
				from: terminal,
				to: terminal,
				points: z.array(routePoint).optional(),
				layer: layerArg.optional(),
				width: z.number().positive().optional(),
				via: viaSize.optional(),
			})).optional().describe('several routes committed as ONE transaction (e.g. a section or a whole net)'),
			units: z.enum(['mil', 'mm']).optional().default('mil'),
			snap: z.number().positive().optional().describe('merge a first/last point this close to its terminal (default 3 mil)'),
			dryRun: z.boolean().optional().default(true),
			verify: z.enum(['connectivity', 'drc', 'none']).optional().default('connectivity'),
			keepOnVerifyFail: z.boolean().optional(),
			allowAnyAngle: z.boolean().optional(),
			allowAcute: z.boolean().optional(),
			allowFreeEnd: z.boolean().optional(),
			requestId: z.string().optional().describe('idempotency key: a retry with the same id returns the first outcome'),
			clearanceMil: z.number().nonnegative().optional().describe('override; default = board DRC rules'),
			ignorePrimitiveIds: z.array(z.string()).optional().describe('copper to ignore in the clearance check (e.g. what you are about to rip up)'),
		}),
		async (params) => {
			const p = params as any;
			if (!(Array.isArray(p.routes) && p.routes.length) && !(p.from && p.to)) {
				return { content: [{ type: 'text', text: JSON.stringify({ error: 'Pass from + to (one route) or routes:[...].' }) }], isError: true };
			}
			const result = await bridge.send('pcb.route.path', { ...p, _timeoutMs: p._timeoutMs ?? 120_000 });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_batch_edit',
		'Preflight and optionally commit multiple PCB edits as one batch: create_track, create_via, modify/move component, delete. Defaults to dryRun=true. Commit is transactional (atomic, default): creates/edits run first, deletes last; on any failure the batch\'s creates are removed and edited components restored, and the result always lists exactly what is on the board (created/modified/deleted ids, failedAt, rolledBack). Clearance comes from the board\'s DRC rules unless clearanceMil is given.',
		withDocumentParam({
			operations: z.array(z.record(z.string(), z.any())).min(1).optional().describe('Batch operations. Types and keys: create_track {net, layer, startX, startY, endX, endY, lineWidth}; create_via {net, x, y, holeDiameter, diameter, viaType}; modify_component/move_component/apply_component_rotation {primitiveId, property | x, y, rotation, layer, primitiveLock}; delete {primitiveType, ids}. Unknown keys are an error.'),
			edits: z.array(z.record(z.string(), z.any())).min(1).optional().describe('Alias for operations.'),
			dryRun: z.boolean().optional().default(true).describe('Preview/preflight only by default. Pass false to commit.'),
			atomic: z.boolean().optional().default(true).describe('Roll back this batch\'s creates/edits if any operation fails.'),
			failOnObstacle: z.boolean().optional().default(true),
			clearanceMil: z.number().nonnegative().optional().describe('Override; default = board DRC rules (per net).'),
			maxObstacles: z.number().int().positive().optional().default(100),
		}),
		async (params) => {
			const p = params as any;
			if (p.operations == null && p.edits == null) {
				return { content: [{ type: 'text', text: JSON.stringify({ error: 'pcb_batch_edit requires operations:[...] (alias: edits).' }) }], isError: true };
			}
			const result = await bridge.send('pcb.batch.edit', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_suggest_component_move',
		'Suggest small component moves that reduce nearest same-net ratline length while avoiding approximate component bbox collisions.',
		withDocumentParam({
			primitiveId: z.string().optional(),
			reference: z.string().optional(),
			designator: z.string().optional(),
			stepMil: z.number().positive().optional().default(100),
			candidateOffsets: z.array(z.object({ dx: z.number().optional(), dy: z.number().optional(), x: z.number().optional(), y: z.number().optional() })).optional(),
			...cacheFields,
		}),
		async (params) => {
			const result = await bridge.send('pcb.placement.suggestMove', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_review_placement',
		'Board-level placement review for small move opportunities. Complements pcb_review_component_orientations.',
		withDocumentParam({
			limit: z.number().int().positive().optional().default(10),
			maxComponents: z.number().int().positive().optional().default(150),
			minScoreImprovementMil: z.number().nonnegative().optional().default(100),
			references: z.array(z.string()).optional(),
			respectLocked: z.boolean().optional().default(true),
			stepMil: z.number().positive().optional().default(100),
			...cacheFields,
		}),
		async (params) => {
			const result = await bridge.send('pcb.placement.reviewPlacement', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);
}

// Agents asked for whole-board packets with maxItems 2500 (~120k tokens).
// Past a few hundred items a packet stops being "context"; narrow the region.
const MAX_AREA_ITEMS = 400;

function clampMaxItems<T extends { maxItems?: number }>(params: T): { args: T; clamped?: { requested: number; used: number } } {
	const requested = Number(params.maxItems);
	if (!Number.isFinite(requested) || requested <= MAX_AREA_ITEMS) return { args: params };
	return { args: { ...params, maxItems: MAX_AREA_ITEMS }, clamped: { requested, used: MAX_AREA_ITEMS } };
}

const STANDALONE_PAD_KEYS = ['primitiveId', 'net', 'layer', 'padNumber', 'x', 'y', 'rotation', 'pad', 'hole', 'metallization'];

/**
 * Trim standalone pads to geometry + net. The extension snapshot no longer
 * repeats component pads under standalonePads (it used to: 336 of 344
 * "standalone" pads, ~47% of a routing packet); the id filter stays as a
 * harmless guard for an older extension build.
 */
function slimAreaPacket(result: any, clamped?: { requested: number; used: number }): any {
	if (!result || typeof result !== 'object') return result;
	const slimIn = (holder: any) => {
		if (!holder || !Array.isArray(holder.standalonePads)) return holder;
		const componentPadIds = new Set((Array.isArray(holder.componentPads) ? holder.componentPads : []).map((p: any) => p?.primitiveId));
		const standalonePads = holder.standalonePads
			.filter((p: any) => !componentPadIds.has(p?.primitiveId))
			.map((p: any) => Object.fromEntries(STANDALONE_PAD_KEYS.filter((k) => p?.[k] !== undefined).map((k) => [k, p[k]])));
		return { ...holder, standalonePads };
	};
	const out = slimIn(result);
	if (out.area && typeof out.area === 'object') out.area = slimIn(out.area);
	if (clamped) out.maxItemsClamped = { ...clamped, note: 'Narrow the region (left/right/top/bottom) or net filter instead of raising maxItems.' };
	return out;
}

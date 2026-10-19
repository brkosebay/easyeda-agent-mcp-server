import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';

const DELETE_HANDLER_MAP: Record<string, string> = {
	component: 'pcb.delete.component',
	track: 'pcb.delete.line',
	polyline: 'pcb.delete.polyline',
	via: 'pcb.delete.via',
	pad: 'pcb.delete.pad',
	pour: 'pcb.delete.pour',
	fill: 'pcb.delete.fill',
	arc: 'pcb.delete.arc',
	region: 'pcb.delete.region',
};

const MODIFY_HANDLER_MAP: Record<string, string> = {
	via: 'pcb.modify.via',
	polyline: 'pcb.modify.polyline',
	arc: 'pcb.modify.arc',
	pad: 'pcb.modify.pad',
	pour: 'pcb.modify.pour',
	fill: 'pcb.modify.fill',
	region: 'pcb.modify.region',
};

const layerSchema = z.union([z.string(), z.number()]);
const polygonSchema = z.any();
const viaTypeSchema = z.union([z.number(), z.enum(['Through', 'BlindBuried', 'Suture'])]);
const pointSchema = z.object({ x: z.number(), y: z.number(), layer: layerSchema.optional(), net: z.string().optional() }).passthrough();
const endpointSchema = z.union([
	z.string().describe('Pad ref such as "U12.6" / "U12:6"'),
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
const widthFields = {
	lineWidth: z.number().positive().optional().describe('Trace width in mil'),
	width_mil: z.number().positive().optional().describe('Alias for lineWidth'),
	trace_width_mil: z.number().positive().optional().describe('Alias for lineWidth'),
	lineWidthByNet: z.record(z.string(), z.number().positive()).optional().describe('Per-net trace widths in mil, e.g. {"GND":20,"+5V":40}'),
} as const;
const traceSegmentSchema = z.object({
	net: z.string().optional(),
	layer: layerSchema.optional(),
	startX: z.number(),
	startY: z.number(),
	endX: z.number(),
	endY: z.number(),
	lineWidth: z.number().positive().optional(),
	role: z.string().optional(),
	primitiveId: z.string().optional(),
}).passthrough();
const obstacleCheckFields = {
	obstacleCheck: z.boolean().optional().default(true).describe('Preflight the planned trace against existing copper/pads/pours/keepouts before creation. Default true.'),
	failOnObstacle: z.boolean().optional().default(true).describe('When obstacleCheck finds blockers, throw instead of creating. Dry-run route tools always return the obstacle report instead of throwing.'),
	clearanceMil: z.number().nonnegative().optional().describe('Override the clearance (mil) used by obstacle preflight. Omit to resolve it from the active DRC rule configuration and per-net rules; 6 mil is used only when those rules are unreadable. The response reports which source was used in clearanceSource.'),
	obstacleCheckTimeoutMs: z.number().int().positive().optional().default(3000).describe('Fast deadline for obstacle preflight.'),
	ignoreSameNet: z.boolean().optional().default(true).describe('Ignore same-net copper/pads/pours in obstacle preflight.'),
	includeComponentBodies: z.boolean().optional().default(false).describe('Also warn when crossing an approximate component body bbox. Pads are checked by default; body bboxes can be conservative.'),
	includePours: z.boolean().optional().default(true).describe('Check different-net copper pours as filled polygon obstacles.'),
	includeKeepouts: z.boolean().optional().default(true).describe('Check DRC regions that look like keepout/no-route/no-copper constraints.'),
	includeBoardBoundary: z.boolean().optional().default(true).describe('Block segments that leave the board-outline bounds when a board outline is available.'),
	ignorePrimitiveIds: z.array(z.string()).optional().describe('Obstacle primitive/component IDs to ignore, e.g. the track being modified.'),
} as const;

function firstNumber(...values: unknown[]): number | undefined {
	for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) return v;
	return undefined;
}

function mmToMil(mm: unknown): number | undefined {
	return typeof mm === 'number' && Number.isFinite(mm) ? Math.round((mm / 0.0254) * 1000) / 1000 : undefined;
}

// Agents mix up the two via tools' names (transcripts: pcb_create_via_mm
// called with diameter/holeDiameter), so both tools accept both spellings in
// their own unit. A mm "diameter" above 6.35 mm (250 mil) is a mil value sent
// to the mm tool — refuse rather than build a 24 mm via.
function resolveViaSize(unit: 'mil' | 'mm', size: { drill?: number; diameter?: number }): { drill: number; diameter: number } {
	const tool = unit === 'mm' ? 'pcb_create_via_mm' : 'pcb_create_via';
	if (size.drill === undefined || size.diameter === undefined) {
		throw new Error(unit === 'mm'
			? `${tool} needs drill_mm and diameter_mm in mm (aliases: holeDiameter/drill, diameter).`
			: `${tool} needs holeDiameter and diameter in mil (aliases: drill; or drill_mm/diameter_mm in mm).`);
	}
	if (unit === 'mm' && size.diameter > 6.35) {
		throw new Error(`${tool}: diameter ${size.diameter} mm is implausibly large — that looks like mil. Use pcb_create_via for mil values.`);
	}
	if (size.diameter <= size.drill) {
		throw new Error(`${tool}: diameter (${size.diameter} ${unit}) must exceed the drill (${size.drill} ${unit}) to leave an annular ring.`);
	}
	return { drill: size.drill, diameter: size.diameter };
}

export function registerWriteTools(server: McpServer, bridge: WebSocketBridge): void {
	// === Create ===

	server.tool(
		'pcb_check_trace_obstacles',
		'Dry-run obstruction check for one or more trace segments. Finds different-net tracks, vias, standalone pads, component pads, copper pours, keepout regions, and board-boundary escapes before creating copper.',
		withDocumentParam({
			net: z.string().optional(),
			layer: layerSchema.optional().describe('Layer for single-segment input; each segment can also specify layer.'),
			startX: z.number().optional(),
			startY: z.number().optional(),
			endX: z.number().optional(),
			endY: z.number().optional(),
			lineWidth: z.number().positive().optional().default(10),
			segments: z.array(traceSegmentSchema).optional().describe('Route segments to check. If omitted, pass startX/startY/endX/endY.'),
			...obstacleCheckFields,
			includeLines: z.boolean().optional().default(true),
			includeVias: z.boolean().optional().default(true),
			includePads: z.boolean().optional().default(true),
			includeComponentPads: z.boolean().optional().default(true),
			includeStandalonePads: z.boolean().optional().default(true),
			maxObstacles: z.number().int().positive().optional().default(75),
			maxComponentScan: z.number().int().positive().optional().default(120).describe('Max nearby components whose pins will be fetched.'),
			componentScanMarginMil: z.number().nonnegative().optional().default(800).describe('Expanded region around the route used to pick nearby components.'),
			scanAllComponents: z.boolean().optional().default(false).describe('Scan all components instead of nearby component origins; slower but more complete.'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.trace.checkObstacles', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_track',
		'Create a single Line track between two points (mil). Preferred over polyline_track for routed nets.',
		withDocumentParam({
			net: z.string().describe('Net name'),
			layer: layerSchema.describe('Layer ID or name — see pcb_help("layer")'),
			startX: z.number(),
			startY: z.number(),
			endX: z.number(),
			endY: z.number(),
			lineWidth: z.number().optional().describe('mil; uses design rule if omitted. Aliases: width, width_mil'),
			width: z.number().optional().describe('Alias of lineWidth (mil)'),
			width_mil: z.number().optional().describe('Alias of lineWidth (mil)'),
			timeoutMs: z.number().int().positive().optional().describe('Extension-side EasyEDA edit deadline in ms; default 5000. Use only when the editor is legitimately busy.'),
			...obstacleCheckFields,
		}),
		async ({ lineWidth, width, width_mil, ...rest }) => {
			const result = await bridge.send('pcb.create.line', { ...rest, lineWidth: firstNumber(lineWidth, width, width_mil) });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_polyline_track',
		'[LEGACY] Polyline graphic — does NOT carry a net (ratlines stay live). Use pcb_create_track or pcb_route_orthogonal instead.',
		withDocumentParam({
			net: z.string(),
			layer: layerSchema,
			polygon: z.array(z.object({ x: z.number(), y: z.number() })).min(2),
			lineWidth: z.number().optional(),
		}),
		async (params) => {
			const result = await bridge.send('pcb.create.polyline', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_via',
		'Create a via in mil units. For mm input use pcb_create_via_mm (drill_mm/diameter_mm are also accepted here and converted).',
		withDocumentParam({
			net: z.string(),
			x: z.number(),
			y: z.number(),
			holeDiameter: z.number().optional().describe('Drill hole (mil). Alias: drill'),
			diameter: z.number().optional().describe('Pad outer diameter (mil)'),
			drill: z.number().optional().describe('Alias of holeDiameter (mil)'),
			drill_mm: z.number().optional().describe('Drill in mm (converted)'),
			diameter_mm: z.number().optional().describe('Diameter in mm (converted)'),
			viaType: viaTypeSchema.optional().describe('0/Through (default), 1/BlindBuried, 2/Suture'),
		}),
		async ({ holeDiameter, diameter, drill, drill_mm, diameter_mm, ...rest }) => {
			const size = resolveViaSize('mil', {
				drill: firstNumber(holeDiameter, drill, mmToMil(drill_mm)),
				diameter: firstNumber(diameter, mmToMil(diameter_mm)),
			});
			const result = await bridge.send('pcb.create.via', { ...rest, holeDiameter: size.drill, diameter: size.diameter });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_via_mm',
		'Create a via with millimeter dimensions. Returns resolved mil values.',
		withDocumentParam({
			net: z.string(),
			x: z.number(),
			y: z.number(),
			drill_mm: z.number().optional().describe('Drill hole (mm). Aliases: holeDiameter, drill'),
			diameter_mm: z.number().optional().describe('Pad outer diameter (mm). Alias: diameter'),
			holeDiameter: z.number().optional().describe('Alias of drill_mm (mm here)'),
			drill: z.number().optional().describe('Alias of drill_mm (mm)'),
			diameter: z.number().optional().describe('Alias of diameter_mm (mm here)'),
			viaType: viaTypeSchema.optional(),
		}),
		async ({ drill_mm, diameter_mm, holeDiameter, drill, diameter, ...rest }) => {
			const size = resolveViaSize('mm', {
				drill: firstNumber(drill_mm, holeDiameter, drill),
				diameter: firstNumber(diameter_mm, diameter),
			});
			const result = await bridge.send('pcb.create.via.mm', { ...rest, drill_mm: size.drill, diameter_mm: size.diameter });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_move_via',
		'Move a via WITHOUT breaking its routes: every same-net track end on the via is dragged along, like dragging it in the GUI. Use this instead of editing via x,y with pcb_modify_primitive, which moves the via alone and breaks the net. Preflights the moved copper against different-net obstacles (board DRC clearance), commits as one transaction with read-back, and restores everything if EasyEDA refuses part of it or the net splits. dryRun defaults to true. Returns {status: dry-run|blocked|invalid|moved|rolled-back|partial, via:{id,from,to}, dragged[], warnings, obstacles:{blocking,warnings}, verify}.',
		withDocumentParam({
			viaId: z.string().describe('Via primitive id'),
			x: z.number().describe('Target via centre X (mil, or mm with units:"mm")'),
			y: z.number().describe('Target via centre Y'),
			units: z.enum(['mil', 'mm']).optional().default('mil'),
			dryRun: z.boolean().optional().default(true).describe('Preview only (default). Pass false to commit.'),
			dragTracks: z.boolean().optional().default(true).describe('Drag attached track ends with the via (default). false moves the via alone; the connectivity check still applies.'),
			clearanceMil: z.number().nonnegative().optional().describe('Override the preflight clearance (always mil). Default: board DRC rules.'),
			keepOnVerifyFail: z.boolean().optional().default(false).describe('Keep the move even if the net splits into more pad groups.'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.via.moveWithTracks', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_arc',
		'Create an arc track segment.',
		withDocumentParam({
			net: z.string(),
			layer: layerSchema,
			startX: z.number(),
			startY: z.number(),
			endX: z.number(),
			endY: z.number(),
			arcAngle: z.number().describe('Degrees; negative = clockwise'),
			lineWidth: z.number().optional(),
		}),
		async (params) => {
			const result = await bridge.send('pcb.create.arc', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_pad',
		'Create a standalone pad on the PCB.',
		withDocumentParam({
			layer: layerSchema,
			padNumber: z.string(),
			x: z.number(),
			y: z.number(),
			rotation: z.number().optional(),
			net: z.string().optional(),
		}),
		async (params) => {
			const result = await bridge.send('pcb.create.pad', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_pour',
		'Create a copper pour. polygon: see pcb_help("polygon"). Layer must be copper.',
		withDocumentParam({
			net: z.string(),
			layer: layerSchema,
			polygon: polygonSchema,
			pourFillMethod: z.enum(['solid', '45grid', '90grid']).optional(),
			preserveSilos: z.boolean().optional(),
			pourName: z.string().optional(),
			pourPriority: z.number().optional().describe('Higher = poured first'),
			lineWidth: z.number().optional(),
			primitiveLock: z.boolean().optional(),
			timeoutMs: z.number().int().positive().optional().describe('Deadline for EasyEDA fill engine; defaults to the extension-side pour deadline (60s).'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.create.pour', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_fill',
		'Create a fill region. polygon: see pcb_help("polygon").',
		withDocumentParam({
			layer: layerSchema,
			polygon: polygonSchema,
			net: z.string().optional(),
			lineWidth: z.number().optional(),
		}),
		async (params) => {
			const result = await bridge.send('pcb.create.fill', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_region',
		'Create a design rule region (keepout/constraint). polygon: see pcb_help("polygon").',
		withDocumentParam({
			layer: layerSchema,
			polygon: polygonSchema,
			ruleType: z.array(z.union([z.string(), z.number()])).optional(),
			regionName: z.string().optional(),
			lineWidth: z.number().optional(),
		}),
		async (params) => {
			const result = await bridge.send('pcb.create.region', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_route_orthogonal',
		'Route Manhattan path with real Line primitives. 1/2/3 segments depending on alignment + jogX/jogY.',
		withDocumentParam({
			net: z.string(),
			layer: layerSchema,
			fromX: z.number(),
			fromY: z.number(),
			toX: z.number(),
			toY: z.number(),
			lineWidth: z.number().optional(),
			jogX: z.number().optional().describe('Intermediate X for U-shape detour'),
			jogY: z.number().optional().describe('Intermediate Y for U-shape detour'),
			dryRun: z.boolean().optional().default(false).describe('Plan + obstacle-check only; do not create lines.'),
			...obstacleCheckFields,
		}),
		async (params) => {
			const result = await bridge.send('pcb.route.orthogonal', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_route_smart',
		`Route pad-to-pad or point-to-point with real Line/Via primitives. Resolves pad refs like "U12.6", supports mitered 45-degree corners, optional fanout/in-pad vias, dryRun planning, and explicit trace widths.

This is not EasyEDA's hidden interactive router API; the extension SDK exposes Line/Via creation, so this tool synthesizes the route geometry directly.`,
		withDocumentParam({
			from_pad: endpointSchema.describe('Start endpoint: "U12.6", {reference,padNumber}, or {x,y}'),
			to_pad: endpointSchema.describe('End endpoint: "U13.4", {reference,padNumber}, or {x,y}'),
			net: z.string().optional().describe('Net name; inferred from pads when possible'),
			layer: layerSchema.optional().describe('Copper layer to route on'),
			layer_preference: layerSchema.optional().describe('Alias for layer'),
			...widthFields,
			entryLineWidth: z.number().positive().optional().describe('Fanout stub / pad-entry width in mil; defaults to lineWidth'),
			segmentWidths: z.array(z.number().positive()).optional().describe('Optional per-main-route-segment widths in mil'),
			style: z.enum(['miter45', 'orthogonal', 'manhattan']).optional().default('miter45'),
			preferredDirection: z.enum(['auto', 'horizontal_first', 'vertical_first', 'horizontal', 'vertical']).optional().default('auto'),
			miterMil: z.number().nonnegative().optional().default(40),
			snap45: z.boolean().optional().describe('Opt-in: snap the synthesized route legs to the nearest 45-degree direction (endpoints stay on their pads). Off by default — preserves existing geometry.'),
			waypoints: z.array(pointSchema).optional().describe('Optional points the route should pass through, in mil'),
			via_strategy: z.enum(['none', 'fanout', 'in_pad']).optional().default('none'),
			viaOffsetMil: z.number().positive().optional().default(40).describe('Fanout via offset from pad in mil'),
			fromFanoutDirection: z.union([z.enum(['left', 'right', 'up', 'down', '+x', '-x', '+y', '-y']), pointSchema]).optional(),
			toFanoutDirection: z.union([z.enum(['left', 'right', 'up', 'down', '+x', '-x', '+y', '-y']), pointSchema]).optional(),
			holeDiameter: z.number().positive().optional().default(12),
			diameter: z.number().positive().optional().default(24),
			viaType: viaTypeSchema.optional(),
			primitiveLock: z.boolean().optional(),
			dryRun: z.boolean().optional().default(false).describe('Return planned segments/vias without creating primitives'),
			...obstacleCheckFields,
		}),
		async (params) => {
			const result = await bridge.send('pcb.route.smart', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_auto_fanout',
		'Fan out a single component pad: place an offset via plus a short stub. Width, via size, direction, and dryRun are explicit.',
		withDocumentParam({
			pad_ref: endpointSchema.describe('Pad reference such as "U12.6" or {reference,padNumber}'),
			net: z.string().optional().describe('Net; inferred from the pad when omitted'),
			layer: layerSchema.optional().describe('Route/target layer for the via'),
			layer_preference: layerSchema.optional(),
			...widthFields,
			direction_hint: z.union([z.enum(['left', 'right', 'up', 'down', '+x', '-x', '+y', '-y']), pointSchema]).optional(),
			viaOffsetMil: z.number().positive().optional().default(40),
			holeDiameter: z.number().positive().optional().default(12),
			diameter: z.number().positive().optional().default(24),
			viaType: viaTypeSchema.optional(),
			primitiveLock: z.boolean().optional(),
			dryRun: z.boolean().optional().default(false),
			...obstacleCheckFields,
		}),
		async (params) => {
			const result = await bridge.send('pcb.route.autoFanout', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_route_diff_pair',
		`LEGACY — commits immediately; spacing drifts through turns. Prefer pcb_route_pair: you plan the centerline, it offsets both nets with exact gap through corners, reports skew, verifies, and dry-runs by default. Routes a differential pair from four endpoints by routing a shared centerline and offsetting both nets by target_spacing_mil/2. Supports 45-degree mitered geometry, per-net trace widths, dryRun, and optional length matching by adding a serpentine to the shorter leg.`,
		withDocumentParam({
			positive_net: z.string(),
			negative_net: z.string(),
			positive_from_pad: endpointSchema.describe('Positive start endpoint'),
			positive_to_pad: endpointSchema.describe('Positive end endpoint'),
			negative_from_pad: endpointSchema.describe('Negative start endpoint'),
			negative_to_pad: endpointSchema.describe('Negative end endpoint'),
			layer: layerSchema.optional(),
			layer_preference: layerSchema.optional(),
			target_spacing_mil: z.number().positive().optional().describe('Center-to-center pair spacing in mil; defaults to start pad spacing'),
			...widthFields,
			positiveLineWidth: z.number().positive().optional(),
			negativeLineWidth: z.number().positive().optional(),
			style: z.enum(['miter45', 'orthogonal', 'manhattan']).optional().default('miter45'),
			preferredDirection: z.enum(['auto', 'horizontal_first', 'vertical_first', 'horizontal', 'vertical']).optional().default('auto'),
			miterMil: z.number().nonnegative().optional().default(40),
			snap45: z.boolean().optional().describe('Opt-in: snap the shared centerline legs to 45-degree directions before offsetting both nets (endpoints stay on their pads). Off by default.'),
			length_match: z.boolean().optional().default(false),
			tolerance_mil: z.number().positive().optional().default(5),
			tuningAmplitudeMil: z.number().positive().optional().default(25),
			tuningCycles: z.number().int().positive().optional(),
			primitiveLock: z.boolean().optional(),
			dryRun: z.boolean().optional().default(false),
			...obstacleCheckFields,
		}),
		async (params) => {
			const result = await bridge.send('pcb.route.diffPair', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_length_match',
		`LEGACY — can add copper without adding measured path length. Prefer pcb_length_tune: meanders a chosen leg to an exact delta and verifies the shortest copper path grew by it. Compares two net lengths and adds an attached serpentine loop to the shorter net when anchor:{x,y} is provided. Without anchor it returns the shorter net and exact length to add. Use dryRun first on dense boards.`,
		withDocumentParam({
			pos_net: z.string(),
			neg_net: z.string(),
			tolerance_mil: z.number().positive().optional().default(5),
			anchor: pointSchema.optional().describe('Point on the shorter net where the tuning loop should attach'),
			layer: layerSchema.optional(),
			layer_preference: layerSchema.optional(),
			...widthFields,
			amplitude_mil: z.number().positive().optional().default(25),
			pitch_mil: z.number().positive().optional().default(30),
			cycles: z.number().int().positive().optional(),
			direction_hint: z.union([z.enum(['left', 'right', 'up', 'down', '+x', '-x', '+y', '-y']), pointSchema]).optional(),
			primitiveLock: z.boolean().optional(),
			dryRun: z.boolean().optional().default(false),
			...obstacleCheckFields,
		}),
		async (params) => {
			const result = await bridge.send('pcb.route.lengthMatch', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_delete_tracks_by_filter',
		'Bulk-delete Line tracks matching net/layer. preserveLocked skips locked. Returns count + IDs.',
		withDocumentParam({
			net: z.string().optional(),
			layer: layerSchema.optional(),
			preserveLocked: z.boolean().optional(),
		}),
		async (params) => {
			const result = await bridge.send('pcb.deleteByFilter.line', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_cleanup_duplicate_copper',
		`Cluster tracks/vias by net+layer+coordinate+geometry and report (or delete) the redundant copies that pile up after multiple autoroute/import passes. Defaults to dryRun=true so you preview the cluster list first.

Cluster keys:
  line: layer | net | sorted-endpoints | lineWidth
  via:  net | x,y | diameter | holeDiameter
Locked primitives are preferred as the keeper; everything else in a cluster is deleted.

Returns scanned counts, cluster sample (top 50 by size), how many duplicates would be (or were) removed, and whether dryRun was active.`,
		withDocumentParam({
			scope: z.enum(['lines', 'vias', 'all']).optional().default('all').describe('Limit to lines, vias, or both (default all)'),
			net: z.string().optional().describe('Restrict to this net'),
			layer: layerSchema.optional().describe('Restrict line scan to this layer (vias span all)'),
			tolerance: z.number().positive().optional().default(0.01).describe('Coordinate snap tolerance (mil); endpoints within this distance cluster (default 0.01)'),
			dryRun: z.boolean().optional().default(true).describe('Preview only — no deletions when true (default true). Pass false to actually delete.'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.copper.dedupe', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_stitch_perimeter',
		`Place stitching vias around the board outline. Uses the actual BoardOutline loop (Line/Arc/Polyline on layer 11), samples points along the perimeter, offsets them inward by inset_mil, and skips existing same-net vias nearby.

This is intended for GND perimeter stitching. It does not replace DRC: run pcb_drc_summarize after creation, especially near antennas/connectors.`,
		withDocumentParam({
			net: z.string().optional().default('GND').describe('Via net, default GND'),
			pitch_mil: z.number().positive().optional().default(200).describe('Spacing along outline in mil'),
			inset_mil: z.number().optional().default(20).describe('Offset inward from board edge in mil'),
			holeDiameter: z.number().positive().optional().default(12).describe('Via drill in mil'),
			diameter: z.number().positive().optional().default(24).describe('Via pad diameter in mil'),
			viaType: viaTypeSchema.optional(),
			keepout_regions: z.array(z.object({
				minX: z.number(),
				minY: z.number(),
				maxX: z.number(),
				maxY: z.number(),
			})).optional().describe('Rectangular keepouts to skip, in mil'),
			avoidExistingWithinMil: z.number().positive().optional().describe('Skip candidate if same-net via is already within this distance'),
			maxVias: z.number().int().positive().optional().default(500).describe('Hard cap on vias created'),
			toleranceMil: z.number().positive().optional().default(0.5).describe('BoardOutline endpoint matching tolerance'),
			arcStepDegrees: z.number().positive().optional().default(10).describe('Arc approximation step'),
			dryRun: z.boolean().optional().default(false).describe('Return planned points without creating vias'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.via.stitchPerimeter', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_lock_by_filter',
		'Bulk lock or unlock copper primitives by net/layer/type. Useful before autoroute to preserve hand-routed work.',
		withDocumentParam({
			lock: z.boolean().optional().default(true).describe('true=lock, false=unlock'),
			net: z.string().optional().describe('Single net filter'),
			nets: z.array(z.string()).optional().describe('Multiple net filter'),
			layer: layerSchema.optional().describe('Single layer filter'),
			layers: z.array(layerSchema).optional().describe('Multiple layer filter'),
			types: z.array(z.enum(['track', 'via', 'arc', 'polyline', 'pour', 'fill', 'region'])).optional()
				.describe('Primitive types to lock; default track/via/arc/polyline/pour/fill/region'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.lockByFilter', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	// === Modify ===

	server.tool(
		'pcb_move_component',
		'Move/rotate/flip a component or change designator/lock.',
		withDocumentParam({
			primitiveId: z.string(),
			x: z.number().optional(),
			y: z.number().optional(),
			rotation: z.number().optional(),
			layer: layerSchema.optional().describe('"TopLayer"/"BottomLayer" to flip'),
			primitiveLock: z.boolean().optional(),
			designator: z.string().optional(),
		}),
		async ({ primitiveId, instance_id, document, ...property }) => {
			const result = await bridge.send('pcb.modify.component', { primitiveId, property, instance_id, document });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_modify_track',
		'Modify a Line track. Returns {modified, persisted, after, attempted} — re-fetches to verify.',
		withDocumentParam({
			primitiveId: z.string(),
			net: z.string().optional(),
			layer: layerSchema.optional(),
			startX: z.number().optional(),
			startY: z.number().optional(),
			endX: z.number().optional(),
			endY: z.number().optional(),
			lineWidth: z.number().optional(),
		}),
		async ({ primitiveId, instance_id, document, ...property }) => {
			const result = await bridge.send('pcb.modify.line', { primitiveId, property, instance_id, document });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_modify_primitive',
		'Modify any primitive. Property keys depend on type (see pcb_help("primitives")). All types accept primitiveLock. To MOVE a via use pcb_move_via instead — changing a via\'s x/y here moves the via alone and strands its tracks.',
		withDocumentParam({
			type: z.enum(['via', 'polyline', 'arc', 'pad', 'pour', 'fill', 'region']),
			primitiveId: z.string(),
			property: z.record(z.string(), z.any()).describe('Properties to modify'),
		}),
		async ({ type, ...rest }) => {
			const result = await bridge.send(MODIFY_HANDLER_MAP[type], rest);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	// === Delete ===

	server.tool(
		'pcb_delete_primitives',
		'Delete primitives by type and IDs.',
		withDocumentParam({
			type: z.enum(['component', 'track', 'polyline', 'via', 'pad', 'pour', 'fill', 'arc', 'region']),
			ids: z.union([z.string(), z.array(z.string())]),
		}),
		async ({ type, ...rest }) => {
			const result = await bridge.send(DELETE_HANDLER_MAP[type], rest);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	// === Save ===

	server.tool(
		'pcb_save',
		'Save the current PCB document. Resolves the active PCB uuid when omitted (EasyEDA\'s save() requires it), waits at most timeoutMs (default 30000, always below the bridge deadline) and returns {saved:true|false|"unknown", status:"saved"|"failed"|"pending"|"previous-save-pending", uuid}. "pending" means EasyEDA has not answered yet; the bridge queue is released and a repeat call will not stack a second save (force:true overrides).',
		withDocumentParam({
			uuid: z.string().optional().describe('Document UUID (default: current)'),
			timeoutMs: z.number().int().positive().optional().describe('Max wait for EasyEDA to answer (default 30000)'),
			force: z.boolean().optional().describe('Issue a new save even if a previous one is still unanswered'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.document.save', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);
}

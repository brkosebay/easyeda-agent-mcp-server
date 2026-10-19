import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';

const layerArg = z.union([z.string(), z.number()]);
const terminal = z.union([
	z.string().describe('pad ref, e.g. "U3.12"'),
	z.object({
		pad: z.string().optional(),
		via: z.string().optional().describe('existing via id'),
		track: z.string().optional().describe('existing track id'),
		end: z.enum(['start', 'end']).optional(),
		x: z.number().optional(),
		y: z.number().optional(),
		layer: layerArg.optional(),
	}),
]);
const endpoint = z.union([z.string().describe('pad ref'), z.object({ via: z.string() })]);
const send = async (bridge: WebSocketBridge, method: string, params: any, timeoutMs: number) => {
	const result = await bridge.send(method, { ...params, _timeoutMs: params._timeoutMs ?? timeoutMs });
	return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
};

export function registerRoutePairTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'pcb_route_pair',
		`Route a differential pair from the CENTERLINE you planned — both nets, one transaction, verified. Primary diff-pair tool (dryRun defaults to true).
Each net is the centerline offset by ±(width+gap)/2 with miter joins, so every coupled leg keeps exactly \`gap\` (edge to edge) through 45°/90° corners; the inner/outer length difference is reported as skew (P−N, plus the per-corner part). 45° fan-ins join each pad to its offset line; a centerline point with "layer" places paired vias at viaPitch (default via diameter + clearance) with 45° spread/rejoin legs. width/gap default to the board's Differential Pair rule (pair resolved by name or by nets via EasyEDA's pair definitions), else required. The whole plan's P–N spacing is checked here, then both nets go through pcb_route_path's executor: board-clearance preflight, one transaction (if N fails, P is removed too), copper-graph verification, requestId replay. After a commit, \`measured\` gives the real pad-to-pad path lengths and skew. Errors name the leg/terminal and the missing length so the next centerline can fix it. Coordinates: the API frame of pcb_get_routing_context / pcb_inspect_area (not the GUI ruler).`,
		withDocumentParam({
			pair: z.string().optional().describe('EasyEDA differential-pair name (resolves pNet/nNet and the pair rule)'),
			pNet: z.string().optional(),
			nNet: z.string().optional(),
			p: z.object({ from: terminal, to: terminal }).describe('P terminals (pad refs)'),
			n: z.object({ from: terminal, to: terminal }).describe('N terminals (pad refs)'),
			centerline: z.array(z.object({ x: z.number(), y: z.number(), layer: layerArg.optional().describe('paired vias here; continue on this layer') })).min(2)
				.describe('centre of the coupled run, start → end, octilinear; first/last point = where coupling starts/ends near the pads'),
			layer: layerArg.optional().describe('first section\'s layer (default: the start pads\' layer)'),
			width: z.number().positive().optional().describe('track width (default: pair rule)'),
			gap: z.number().positive().optional().describe('edge-to-edge gap (default: pair rule spacing)'),
			pSide: z.enum(['left', 'right']).optional().describe('P side relative to the centerline direction (default: inferred from the pads)'),
			via: z.object({ diameter: z.number().positive(), holeDiameter: z.number().positive() }).optional(),
			viaPitch: z.number().positive().optional().describe('centre-to-centre of the paired vias'),
			maxSkew: z.number().positive().optional().describe('warn above this |P−N| (default: the pair rule\'s length tolerance)'),
			units: z.enum(['mil', 'mm']).optional().default('mil'),
			dryRun: z.boolean().optional().default(true),
			verify: z.enum(['connectivity', 'drc', 'none']).optional().default('connectivity'),
			keepOnVerifyFail: z.boolean().optional(),
			requestId: z.string().optional().describe('idempotency key: a retry with the same id replays the first outcome'),
			clearanceMil: z.number().nonnegative().optional().describe('override; default = board DRC rules'),
			ignorePrimitiveIds: z.array(z.string()).optional(),
		}),
		async (params) => send(bridge, 'pcb.route.pair', params, 150_000),
	);

	server.tool(
		'pcb_length_tune',
		`Add an accordion meander to ONE straight leg (track id) so the net's real signal path grows by exactly the requested amount — or refuse. dryRun defaults to true.
Length = shortest copper path between the net's two endpoints (its two pads, or \`between\`), contacts by copper overlap: a leg that is a stub/redundant branch (LEG_NOT_ON_PATH), a meander whose runs touch, or one that would cut off a branch is refused before anything is created. Target: addLength | targetLength | matchNet | matchPartner (the diff-pair partner). coupled:true tunes the pair together (both legs, gap kept, same added length per net). Bumps/amplitude are solved for the exact delta within maxAmplitude/minAmplitude, spacing (edge gap between meander runs, default max(3×width, clearance)) and the leg's free length; side "auto" tries both sides and smaller amplitudes against obstacles via a pcb_route_path dry-run. Commit = meander created + leg deleted in one transaction, then the path is re-measured; if it did not grow by the plan (within tolerance) the meander is removed and the leg recreated. Returns before/target/delta, plan, geometry, attempts (on insufficient-space), verify.`,
		withDocumentParam({
			track: z.string().describe('id of the straight leg to meander'),
			addLength: z.number().positive().optional(),
			targetLength: z.number().positive().optional().describe('absolute path length to reach'),
			matchNet: z.string().optional().describe('reach this net\'s path length'),
			matchBetween: z.array(endpoint).length(2).optional().describe('endpoints of matchNet when it has more than two pads'),
			matchPartner: z.boolean().optional().describe('reach the diff-pair partner\'s path length'),
			between: z.array(endpoint).length(2).optional().describe('path endpoints when the net has more than two pads'),
			coupled: z.boolean().optional().describe('tune both legs of the pair together'),
			pair: z.string().optional().describe('differential-pair name (default: found from the net)'),
			partnerNet: z.string().optional(),
			partnerTrack: z.string().optional().describe('partner leg (default: nearest parallel leg of the partner net)'),
			partnerBetween: z.array(endpoint).length(2).optional(),
			spacing: z.number().positive().optional().describe('edge gap between adjacent meander runs'),
			maxAmplitude: z.number().positive().optional(),
			minAmplitude: z.number().positive().optional(),
			miter: z.number().nonnegative().optional().describe('45° chamfer size (0 = square corners)'),
			side: z.enum(['left', 'right', 'auto']).optional().default('auto'),
			margin: z.number().nonnegative().optional().describe('straight lead kept at each end of the leg'),
			tolerance: z.number().positive().optional().describe('accepted length error (default 1 mil)'),
			units: z.enum(['mil', 'mm']).optional().default('mil'),
			dryRun: z.boolean().optional().default(true),
			requestId: z.string().optional(),
			clearanceMil: z.number().nonnegative().optional(),
			ignorePrimitiveIds: z.array(z.string()).optional(),
		}),
		async (params) => {
			const p = params as any;
			if ([p.addLength, p.targetLength, p.matchNet, p.matchPartner].filter((v) => v != null && v !== false).length !== 1) {
				return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Pass exactly one of addLength, targetLength, matchNet, matchPartner:true.' }) }], isError: true };
			}
			return send(bridge, 'pcb.route.lengthTune', p, 180_000);
		},
	);
}

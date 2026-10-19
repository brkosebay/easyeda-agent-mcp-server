import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';

const layerSchema = z.union([z.string(), z.number()]);
const pointSchema = z.object({ x: z.number(), y: z.number() });
const rectSchema = z.object({ minX: z.number(), minY: z.number(), maxX: z.number(), maxY: z.number() });
const fillMethodSchema = z.enum(['solid', '45grid', '90grid']);

const splitPourParams = {
	layer: layerSchema.describe('Copper layer to split: "TopLayer", "BottomLayer", "Inner1".. or a layer id. PLANE-type inner layers are refused (convert to SIGNAL first).'),
	regions: z.array(z.object({
		net: z.string().describe('Net this region pours, e.g. "+3V3" or "GND".'),
		polygon: z.union([z.array(pointSchema), z.object({ points: z.array(pointSchema) }), z.array(z.union([z.string(), z.number()]))]).optional()
			.describe('Outline in API mil, canvas convention (Y up, same as pad/track coordinates): [{x,y},...], {points}, ["L",x1,y1,...] or ["R",cx,cy,w,h,rot]. Straight edges only.'),
		rect: rectSchema.optional().describe('Rectangle shorthand {minX,minY,maxX,maxY} (mil) instead of polygon.'),
		priority: z.number().optional().describe('Pour priority. Only needed when regions overlap/nest on purpose; overlapping different-net regions are refused unless both have explicit, different priorities.'),
		name: z.string().optional().describe('Pour name (default <net>_split_<layer>_<n>).'),
		fillMethod: fillMethodSchema.optional(),
		preserveSilos: z.boolean().optional().describe('Keep islands that connect to nothing (default: EasyEDA removes dead copper).'),
	})).optional().describe('Explicit regions, one pour each. Give this OR split.'),
	split: z.object({
		axis: z.enum(['x', 'y']).describe('"x" cuts with a vertical line at x=at (left/right); "y" cuts with a horizontal line at y=at (bottom/top in Y-up canvas coordinates).'),
		at: z.number().describe('Cut position in mil.'),
		nets: z.tuple([z.string(), z.string()]).describe('[net on the side below `at` (left for x, bottom for y), net on the side above `at`].'),
		priorities: z.tuple([z.number(), z.number()]).optional(),
		names: z.tuple([z.string(), z.string()]).optional(),
	}).optional().describe('Helper: cut the board outline into two regions separated by gapMil.'),
	gapMil: z.number().nonnegative().optional().describe('Minimum copper gap between different-net regions (default: the board clearance rule, max over the nets involved).'),
	fillMethod: fillMethodSchema.optional().describe('Default fill for every region (EasyEDA default when omitted).'),
	preserveSilos: z.boolean().optional().describe('Default preserveSilos for every region.'),
	replaceExisting: z.boolean().optional().describe('Delete ALL existing pours on this layer after the new ones are created and verified. Must be explicit; deleted pours are not restored by a rollback.'),
	force: z.boolean().optional().describe('With replaceExisting: also replace locked pours.'),
};

const RESPONSE = 'Response (same shape for every status): {status, layer, layerType, gapMil, gapSource, outline, summary{errors,warnings}, issues[{code,severity,message,region(s),items}], regions[{index, net, bbox, points (≤64), boardOutline, terminals{own, ownSample, foreign, otherNets}, pourId?, outlineCheck?, copper?}], nets{<net>:{onLayer, served, unserved, unservedSample}}, existingPours, created, deleted, rolledBack, rebuild, verify, notes}. Units mil, coordinateSpace canvas-mil-negY.';

const CONCEPT = `Multiple pours on one layer ("split plane"): yes — EasyEDA allows any number of pours per copper layer, each with its own net and outline (e.g. +3V3 on the left, GND on the right of Inner2).
Priority: where pour outlines overlap, the higher-priority pour is poured first and the other clears around its copper by the clearance rule (EasyEDA Copper Manager: top of the list = highest; the GUI auto-raises a pour drawn fully inside another). The SDK does not document which numeric direction of pourPriority is "higher", so prefer non-overlapping regions separated by gapMil; overlaps are accepted only with explicit, different priorities, and the commit reads back the actual copper so you can see which pour won.
Split vs full plane: keep a FULL, unbroken GND plane on the layer next to fast signals (clean return paths, lowest EMI). Split a layer only when it must carry two nets (e.g. a 4-layer board whose power layer feeds +3V3 and +5V, or a local +3V3 island in a GND pour), and never route fast signals across the gap on the adjacent layer. Pads of a net that land in the other net's region are NOT reached by their own pour — route them or move the cut.
PLANE-type inner layers cannot carry pours (EasyEDA rule; the SDK has no plane-zone API) — switch the layer to SIGNAL first: pcb_set_inner_layer_type {layer, type:"SIGNAL", dryRun:false}.`;

export function registerSplitPourTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'pcb_plan_split_pours',
		`Dry-run plan for splitting one copper layer into several pours of different nets. Nothing is written.
${CONCEPT}
Checks: layer is copper and not PLANE; regions valid and on the board; different-net regions ≥ gapMil apart (or overlap resolved by explicit distinct priorities); which pads/vias of each net (SMD pads on this layer, drilled pads and vias on every layer) each region serves; pads of net X sitting in net Y's region (PAD_IN_FOREIGN_REGION); regions with no pad/via of their own net (would be dead copper); existing pours on the layer that overlap.
${RESPONSE} Then commit with pcb_create_split_pours (same arguments).`,
		withDocumentParam(splitPourParams),
		async (params) => {
			const result = await bridge.send('pcb.splitPour.plan', { ...params, _timeoutMs: (params as any)._timeoutMs ?? 60_000 });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_split_pours',
		`Create a split plane: several pours of different nets on ONE copper layer, verified. Runs the same checks as pcb_plan_split_pours and refuses (status "invalid", nothing written) on any error.
${CONCEPT}
Commit: creates every pour (read back to prove each landed on its requested outline; any failure deletes everything this call created → status "rolled-back"), applies priorities, then (replaceExisting) deletes the old pours on the layer, rebuilds the new pours plus the kept pours on that layer with EasyEDA's own copper engine (Shift+B equivalent), and reads the actual copper back per pour: islands, which own-net pads/vias the copper reaches (approximate: pad centre inside an island outline), dead islands. Status "committed" = copper verified; "committed-unverified" = pours exist but copper could not be rebuilt/read (run pcb_repour_all + pcb_copper_status). Saves nothing.
${RESPONSE}`,
		withDocumentParam({
			...splitPourParams,
			rebuild: z.boolean().optional().describe('Rebuild copper after creating (default true). false → status committed-unverified.'),
			dryRun: z.boolean().optional().describe('true = plan only (same as pcb_plan_split_pours).'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.splitPour.create', { ...params, _timeoutMs: (params as any)._timeoutMs ?? 180_000 });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';

const LAYER_HANDLERS: Record<string, string> = {
	get_all: 'pcb.layer.getAll',
	select: 'pcb.layer.select',
	set_visible: 'pcb.layer.setVisible',
	set_invisible: 'pcb.layer.setInvisible',
	lock: 'pcb.layer.lock',
	unlock: 'pcb.layer.unlock',
	set_copper_count: 'pcb.layer.setCopperCount',
	modify: 'pcb.layer.modify',
	add_custom: 'pcb.layer.addCustom',
	remove: 'pcb.layer.remove',
};

export function registerPcbLayerTools(server: McpServer, bridge: WebSocketBridge): void {
	const physicalStackSchema = z.object({ name: z.string(), layerCount: z.number().int().positive(), list: z.array(z.record(z.string(), z.unknown())).min(1) });
	server.tool('pcb_manage_physical_stack', 'Read or explicitly replace the bound PCB physical-stack configuration with guarded host APIs. Read first; overwrite requires exact expectedConfiguration and defaults to dry-run. Unsupported hosts fail without source-import fallback.', withDocumentParam({
		action: z.enum(['get', 'overwrite']),
		configuration: physicalStackSchema.optional(),
		expectedConfiguration: physicalStackSchema.optional(),
		dryRun: z.boolean().optional().default(true),
	}), async ({ action, ...rest }) => {
		const result = await bridge.send(action === 'get' ? 'pcb.layer.physical.get' : 'pcb.layer.physical.overwrite', { ...rest, expectedDocument: rest.document });
		return { content: [{ type: 'text', text: JSON.stringify(result) }] };
	});
	server.tool(
		'pcb_manage_layers',
		`Manage PCB layers. Actions:
- get_all: get all layers with properties
- select: set active layer (layer: string)
- set_visible: show layer(s) (layer optional; setOtherLayerInvisible optional for solo mode)
- set_invisible: hide layer(s) (layer optional; setOtherLayerVisible optional)
- lock: lock layer(s) (layer optional)
- unlock: unlock layer(s) (layer optional)
- set_copper_count: set copper layers (count: 2,4,6,...,32); refuses to drop inner layers that carry copper unless force:true, verifies by re-read (pcb_set_copper_layer_count previews)
- modify: modify layer properties (layer: string, property: {name?, type?, color?, transparency?})
- add_custom: add a new custom layer
- remove: remove a custom layer (layer: string)`,
		withDocumentParam({
			action: z
				.enum([
					'get_all', 'select', 'set_visible', 'set_invisible',
					'lock', 'unlock', 'set_copper_count', 'modify', 'add_custom', 'remove',
				])
				.describe('Action to perform'),
			layer: z
				.union([z.string(), z.array(z.string())])
				.optional()
				.describe('Layer name(s)'),
			setOtherLayerInvisible: z
				.boolean()
				.optional()
				.describe('Hide all other layers (for set_visible)'),
			setOtherLayerVisible: z
				.boolean()
				.optional()
				.describe('Show all other layers (for set_invisible)'),
			count: z.number().optional().describe('Copper layer count (for set_copper_count)'),
			force: z.boolean().optional().describe('set_copper_count: drop inner layers even if they still carry copper'),
			property: z
				.object({
					name: z.string().optional(),
					type: z.string().optional(),
					color: z.string().optional(),
					transparency: z.number().optional(),
				})
				.optional()
				.describe('Properties to modify (for modify action)'),
		}),
		async ({ action, ...rest }) => {
			const result = await bridge.send(LAYER_HANDLERS[action], rest);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	const text = (result: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(result) }] });
	const layerRef = z.union([z.string(), z.number()]);

	server.tool(
		'pcb_layer_report',
		`Copper-layer analysis for layer optimisation (read-only). Per layer: role (signal / signal+flood / flood = lightly routed outer pour / plane / unused), tracks, length, nets, via transitions, pours (net, priority, area %, native copper islands when readable), and for plane layers the plane integrity: other-net tracks cutting it (per net, length), antipads, longest cut, likelySplit. netIssues: nets whose adjacent reference plane is cut under the route (cross) or does not cover it (cov %). recommendations: heuristics with sev/conf (PLANE_CUT, SPLIT_REFERENCE, WEAK_REFERENCE, NO_ADJACENT_PLANE, EMPTY_LAYER, VIA_BOUNCE, STUB_VIA, LAYER_COUNT, STACKUP, …), each with why and a fix. detail:"nets" adds per-net rows (length per layer, vias, ref), "full" adds track ids.`,
		withDocumentParam({
			detail: z.enum(['summary', 'nets', 'full']).optional().default('summary').describe('summary (default): layers + plane integrity + net issues + recommendations; nets: + per-net rows; full: + ids'),
			nets: z.array(z.string()).optional().describe('Only these nets in the per-net rows (also includes plane nets like GND if named)'),
			maxNets: z.number().int().positive().optional().describe('Max per-net rows / net issues (default 20)'),
			nativeCopper: z.boolean().optional().describe('Read actual poured islands from the editor (default true; degrades with a reason when unavailable)'),
			forceRefresh: z.boolean().optional().describe('Bypass the 10 s board snapshot cache'),
		}),
		async (params) => text(await bridge.send('pcb.layer.report', { ...params, _timeoutMs: params._timeoutMs ?? 120_000 })),
	);

	server.tool(
		'pcb_set_copper_layer_count',
		'Change the number of copper layers (2..32, even), guarded. Dry-run by default. Reducing refuses when the inner layers that would be removed (the highest-numbered ones) still carry tracks/arcs/pours/fills/regions/pads — it lists them per layer with nets; force:true accepts losing that copper. Applies via the host API and verifies by re-reading the layer list.',
		withDocumentParam({
			count: z.number().int().min(2).max(32).describe('Target copper layer count: 2, 4, 6, … 32'),
			force: z.boolean().optional().describe('Proceed even though removed layers carry copper'),
			dryRun: z.boolean().optional().default(true),
		}),
		async (params) => text(await bridge.send('pcb.layer.copperCount.set', { ...params, _timeoutMs: params._timeoutMs ?? 60_000 })),
	);

	server.tool(
		'pcb_set_inner_layer_type',
		'Set an inner copper layer to SIGNAL or PLANE (optionally rename it), verified by re-reading. Dry-run by default. Refuses SIGNAL→PLANE when the layer carries tracks unless force:true (on a negative PLANE layer drawn copper may act as plane splits). Layer accepts the board name ("L2_GND"), id (15) or alias ("Inner1").',
		withDocumentParam({
			layer: layerRef.describe('Inner layer: board name, id 15..46, or "Inner1"…'),
			type: z.enum(['SIGNAL', 'PLANE']),
			name: z.string().optional().describe('Optional new layer name'),
			force: z.boolean().optional(),
			dryRun: z.boolean().optional().default(true),
		}),
		async (params) => text(await bridge.send('pcb.layer.innerType.set', { ...params, _timeoutMs: params._timeoutMs ?? 30_000 })),
	);

	server.tool(
		'pcb_move_tracks_to_layer',
		`Move tracks/arcs to another copper layer in place (ids kept), transactionally. Select by trackIds, or by net (+ optional fromLayer, region). Dry-run by default. Refuses (nothing changed) when a moved end lands on an SMD pad not on the target layer (PAD_LAYER) or on same-layer copper that stays behind (ORPHANED) — unless you supply vias at those points; a via inside a pad is a VIA_IN_PAD warning. Checks clearance on the target layer (blocking list) and warns when the move cuts a pour plane there (PLANE_CUT). Commit: modify layer → read back → compare pad groups per net; any failure or worse connectivity restores every track and deletes created vias (status rolled-back).`,
		withDocumentParam({
			toLayer: layerRef.describe('Target copper layer: board name, id, or alias (TopLayer, Inner1, …)'),
			trackIds: z.array(z.string()).optional().describe('Track/arc primitive ids to move'),
			net: z.string().optional().describe('Move this net\'s tracks/arcs (not on toLayer already)'),
			fromLayer: layerRef.optional().describe('With net: only tracks on this layer'),
			region: z.object({ minX: z.number(), minY: z.number(), maxX: z.number(), maxY: z.number() }).optional().describe('With net: only tracks with both ends inside (canvas mil)'),
			vias: z.array(z.object({ x: z.number(), y: z.number(), diameter: z.number().optional(), holeDiameter: z.number().optional() })).optional()
				.describe('Vias to add at moved track ends (net from the track; size from the Via Size rule unless given)'),
			endpointCheck: z.boolean().optional().describe('Default true. false skips the pad/orphan refusal (connectivity is still verified after the move)'),
			keepOnVerifyFail: z.boolean().optional().describe('Keep the move even if connectivity got worse'),
			maxObstacles: z.number().int().positive().optional(),
			dryRun: z.boolean().optional().default(true),
		}),
		async (params) => text(await bridge.send('pcb.layer.moveTracks', { ...params, _timeoutMs: params._timeoutMs ?? 120_000 })),
	);
}

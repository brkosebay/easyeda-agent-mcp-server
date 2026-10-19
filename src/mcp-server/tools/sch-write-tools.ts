import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';

export function registerSchWriteTools(server: McpServer, bridge: WebSocketBridge): void {
	// Schematic writes that hit `eda.sch_PrimitiveComponent.create` etc. typically
	// take 1–3 s on a healthy session, but tab-switching between schematic pages,
	// EasyEDA modal dialogs (e.g. multi-part subPartName prompt), or write-lock
	// contention can push them past the agent's MCP-level timeout. We surface
	// a clean bridge timeout at 30 s for single ops and 60 s for batch — long
	// enough for legitimate slow runs, short enough that the agent gets a
	// useful error before its own timeout fires.
	const SCH_WRITE_TIMEOUT_MS = 30_000;
	const SCH_WRITE_BATCH_TIMEOUT_MS = 60_000;

	// One frame for every schematic tool: component / net flag / net port
	// positions use the same X/Y frame as sch_get_all_wires and
	// sch_get_pin_position, so values can be copied between tools. (EasyEDA's
	// own component API reports Y inverted; the extension converts.)
	const FRAME_NOTE = 'Coordinates use the same frame as sch_get_all_wires / sch_get_pin_position (copy values between them directly).';
	const coordinateFrame = z
		.enum(['canvas', 'api'])
		.optional()
		.describe('Advanced: "canvas" (default) = same frame as wires/pins; "api" = raw EasyEDA component frame (Y inverted on EasyEDA Pro 2.2).');

	function validateLibraryComponent(c: any, ctx: string): void {
		if (!c || typeof c !== 'object') {
			throw new Error(`${ctx}: missing component object. Pass the full library device object from lib_search_device or lib_get_device_by_lcsc.`);
		}
		const required = ['uuid', 'libraryUuid', 'symbolUuid'] as const;
		const missing = required.filter((k) => typeof c[k] !== 'string' || !c[k].trim());
		if (missing.length) {
			throw new Error(`${ctx}: component object is missing ${missing.join(', ')}. Use lib_search_device / lib_get_device_by_lcsc and pass the FULL returned object.`);
		}
	}

	const componentBatchItemSchema = z.object({
		component: z.record(z.string(), z.any()).describe('Full library component object (uuid, symbolUuid, footprintUuid, libraryUuid)'),
		x: z.number(),
		y: z.number(),
		subPartName: z.string().optional(),
		rotation: z.number().optional(),
		mirror: z.boolean().optional(),
		addIntoBom: z.boolean().optional(),
		addIntoPcb: z.boolean().optional(),
	});

	server.tool(
		'sch_create_component',
		`Create one or more schematic components from a library device reference. Use lib_search_device or lib_get_device_by_lcsc first to get the component object.
IMPORTANT: The component object must include uuid, symbolUuid, footprintUuid, AND libraryUuid — passing only {deviceUuid, libraryUuid} will fail with a validation error. Pass the full object returned by lib_get_device_by_lcsc with libraryUuid added (from lib_get_system_library_uuid).
For placing multiple components in one call (e.g. 8 decoupling caps), pass \`batch: [{component, x, y, ...}, ...]\` instead of the individual params. Each placement takes ~1.5s so batch saves real wall-clock time.`,
		withDocumentParam({
			component: z
				.record(z.string(), z.any())
				.optional()
				.describe(
					'Full component object including uuid, symbolUuid, footprintUuid, and libraryUuid (single placement).',
				),
			x: z.number().optional().describe(`X coordinate (single placement). ${FRAME_NOTE}`),
			y: z.number().optional().describe(`Y coordinate (single placement). ${FRAME_NOTE}`),
			coordinateFrame,
			subPartName: z.string().optional().describe('Sub-part name for multi-part components'),
			rotation: z.number().optional().describe('Rotation angle in degrees'),
			mirror: z.boolean().optional().describe('Whether to mirror the component'),
			addIntoBom: z.boolean().optional().describe('Whether to include in BOM (default true)'),
			addIntoPcb: z.boolean().optional().describe('Whether to include in PCB (default true)'),
			batch: z
				.array(componentBatchItemSchema)
				.max(20)
				.optional()
				.describe('Array of components to place in one call (max 20). When provided, the individual params above are ignored.'),
		}),
		async (params) => {
			if (Array.isArray(params.batch) && params.batch.length > 0) {
				for (let i = 0; i < params.batch.length; i++) {
					validateLibraryComponent(params.batch[i].component, `sch_create_component.batch[${i}].component`);
				}
				const result = await bridge.send('sch.component.createBatch', { ...params, _timeoutMs: SCH_WRITE_BATCH_TIMEOUT_MS });
				return { content: [{ type: 'text', text: JSON.stringify(result) }] };
			}
			validateLibraryComponent(params.component, 'sch_create_component.component');
			if (typeof params.x !== 'number' || typeof params.y !== 'number') {
				throw new Error('sch_create_component: x and y are required for single placement.');
			}
			const result = await bridge.send('sch.component.create', { ...params, _timeoutMs: SCH_WRITE_TIMEOUT_MS });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_get_pin_position',
		`Resolve a pin reference to its schematic-page coordinates plus net assignment. Pass {designator, pinNumber} where pinNumber may be the numeric pin number ("3") OR the human-readable pin name ("EN"). Returns {x, y, rotation, net, pinPrimitiveId, componentPrimitiveId}.
This is the foundational lookup for any "wire two pins together" workflow — call this first to know exactly where to place wire endpoints. For the common case of "just wire pin A to pin B" use sch_wire_pins instead, which resolves coordinates and routes the path in one call.`,
		withDocumentParam({
			designator: z.string().describe('Component designator (e.g. "U3", "R19")'),
			pinNumber: z.string().describe('Pin number ("3") or pin name ("EN", "VCC", "GND")'),
		}),
		async (params) => {
			const result = await bridge.send('sch.component.findPin', { ...params, _timeoutMs: SCH_WRITE_TIMEOUT_MS });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_wire_pins',
		`Connect two pins with a wire. Resolves both pin positions automatically, lays a single-corner Manhattan path between them, and creates one wire primitive.
Pin references can be strings ("U3.EN", "R19.2") or objects ({designator, pinNumber}). Pin name OR pin number both work.
The wire's net is inferred from the pins — if both already share the same net it's reused, otherwise pass \`net\` explicitly. Use \`cornerAxis\` to control routing: "h" (horizontal first, default), "v" (vertical first), or "auto" (shortest).`,
		withDocumentParam({
			from: z.union([z.string(), z.object({ designator: z.string(), pinNumber: z.string() })])
				.describe('Source pin: "U3.EN" / "U3.3" / {designator, pinNumber}'),
			to: z.union([z.string(), z.object({ designator: z.string(), pinNumber: z.string() })])
				.describe('Destination pin: "R19.2" / "R19.1" / {designator, pinNumber}'),
			net: z.string().optional().describe('Net name to assign (auto-inferred when both pins share a net)'),
			cornerAxis: z.enum(['h', 'v', 'auto']).optional().describe('Path bend direction: "h"=horizontal-first (default), "v"=vertical-first, "auto"=shortest'),
			color: z.string().nullable().optional(),
			lineWidth: z.number().nullable().optional(),
			lineType: z.enum(['0', '1', '2', '3']).optional().describe('0=Solid, 1=Dashed, 2=Dotted, 3=DotDashed'),
		}),
		async ({ lineType, instance_id, document, ...rest }) => {
			const params: Record<string, any> = { ...rest, instance_id, document, _timeoutMs: SCH_WRITE_TIMEOUT_MS };
			if (lineType !== undefined) params.lineType = Number(lineType);
			const result = await bridge.send('sch.wire.pins', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	const netFlagItemSchema = z.object({
		identification: z
			.enum(['Power', 'Ground', 'AnalogGround', 'ProtectGround'])
			.describe('Net flag type'),
		net: z.string().describe('Net name (e.g. "VCC", "GND", "3V3")'),
		x: z.number().describe(`X coordinate. ${FRAME_NOTE}`),
		y: z.number().describe(`Y coordinate. ${FRAME_NOTE}`),
		rotation: z.number().optional().describe('Rotation angle in degrees'),
		mirror: z.boolean().optional().describe('Whether to mirror'),
		component: z
			.object({ libraryUuid: z.string(), uuid: z.string() })
			.optional()
			.describe('Library device reference override'),
	});

	server.tool(
		'sch_create_net_flag',
		`Create one or more Power/Ground/AnalogGround/ProtectGround net flags in the schematic. Pass individual parameters for a single flag, or use "batch" array for multiple flags in one call. The flag symbol is EasyEDA's own default (resolved from the system library); \`component\` is only needed for a custom symbol. ${FRAME_NOTE} List/move/delete flags with sch_list_net_symbols, sch_modify_component and sch_delete_component.`,
		withDocumentParam({
			identification: z
				.enum(['Power', 'Ground', 'AnalogGround', 'ProtectGround'])
				.optional()
				.describe('Net flag type (for single creation)'),
			net: z.string().optional().describe('Net name (for single creation)'),
			x: z.number().optional().describe('X coordinate (for single creation)'),
			y: z.number().optional().describe('Y coordinate (for single creation)'),
			rotation: z.number().optional().describe('Rotation angle in degrees'),
			mirror: z.boolean().optional().describe('Whether to mirror'),
			component: z
				.object({ libraryUuid: z.string(), uuid: z.string() })
				.optional()
				.describe('Library device reference override'),
			coordinateFrame,
			batch: z
				.array(netFlagItemSchema)
				.max(10)
				.optional()
				.describe('Array of net flags to create in one call (max 10 — each takes ~1.5s). When provided, the individual parameters above are ignored.'),
		}),
		async (params) => {
			const t = Array.isArray(params.batch) && params.batch.length > 1 ? SCH_WRITE_BATCH_TIMEOUT_MS : SCH_WRITE_TIMEOUT_MS;
			const result = await bridge.send('sch.component.createNetFlag', { ...params, _timeoutMs: t });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	const netPortItemSchema = z.object({
		direction: z.enum(['IN', 'OUT', 'BI']).describe('Port direction'),
		net: z.string().describe('Net name'),
		x: z.number().describe(`X coordinate. ${FRAME_NOTE}`),
		y: z.number().describe(`Y coordinate. ${FRAME_NOTE}`),
		rotation: z.number().optional().describe('Rotation angle in degrees'),
		mirror: z.boolean().optional().describe('Whether to mirror'),
		component: z
			.object({ libraryUuid: z.string(), uuid: z.string() })
			.optional()
			.describe('Library device reference override'),
	});

	server.tool(
		'sch_create_net_port',
		`Create one or more IN/OUT/BI directional net ports in the schematic. Pass individual parameters for a single port, or use "batch" array for multiple ports in one call. The port symbol is EasyEDA's own default; \`component\` is only needed for a custom symbol. ${FRAME_NOTE} List/move/delete ports with sch_list_net_symbols, sch_modify_component and sch_delete_component.`,
		withDocumentParam({
			direction: z.enum(['IN', 'OUT', 'BI']).optional().describe('Port direction (for single creation)'),
			net: z.string().optional().describe('Net name (for single creation)'),
			x: z.number().optional().describe('X coordinate (for single creation)'),
			y: z.number().optional().describe('Y coordinate (for single creation)'),
			rotation: z.number().optional().describe('Rotation angle in degrees'),
			mirror: z.boolean().optional().describe('Whether to mirror'),
			component: z
				.object({ libraryUuid: z.string(), uuid: z.string() })
				.optional()
				.describe('Library device reference override'),
			coordinateFrame,
			batch: z
				.array(netPortItemSchema)
				.max(10)
				.optional()
				.describe('Array of net ports to create in one call (max 10 — each takes ~1.5s). When provided, the individual parameters above are ignored.'),
		}),
		async (params) => {
			const t = Array.isArray(params.batch) && params.batch.length > 1 ? SCH_WRITE_BATCH_TIMEOUT_MS : SCH_WRITE_TIMEOUT_MS;
			const result = await bridge.send('sch.component.createNetPort', { ...params, _timeoutMs: t });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_delete_component',
		'Delete one or more schematic components by their primitive IDs. Also deletes net flags and net ports (find their IDs with sch_list_net_symbols).',
		withDocumentParam({
			ids: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of primitive IDs to delete'),
		}),
		async (params) => {
			const result = await bridge.send('sch.component.delete', { ...params, _timeoutMs: SCH_WRITE_TIMEOUT_MS });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_modify_component',
		`Modify a schematic component, net flag or net port. Only the fields you pass change: position, rotation, mirror, BOM/PCB flags, text fields and custom properties are all preserved otherwise (the extension works around EasyEDA's modify() which overwrote supplierId and blanked custom properties). The result is read back; if EasyEDA moved the part (seen with rotation+mirror) it is corrected, and \`corrections\`/\`warnings\` report what happened. Use \`net\` to rename a net flag/port. ${FRAME_NOTE}`,
		withDocumentParam({
			primitiveId: z.string().describe('The component / net flag / net port primitive ID'),
			x: z.number().optional().describe('New X coordinate'),
			y: z.number().optional().describe('New Y coordinate'),
			coordinateFrame,
			rotation: z.number().optional().describe('New rotation angle in degrees'),
			mirror: z.boolean().optional().describe('Whether to mirror'),
			addIntoBom: z.boolean().optional().describe('Whether to include in BOM'),
			addIntoPcb: z.boolean().optional().describe('Whether to include in PCB'),
			designator: z.string().nullable().optional().describe('New designator (e.g. "R1", "U2")'),
			name: z.string().nullable().optional().describe('New component name'),
			uniqueId: z.string().nullable().optional().describe('New unique ID'),
			manufacturer: z.string().nullable().optional().describe('Manufacturer name'),
			manufacturerId: z.string().nullable().optional().describe('Manufacturer part number'),
			supplier: z.string().nullable().optional().describe('Supplier name'),
			supplierId: z.string().nullable().optional().describe('Supplier part number (e.g. LCSC C-number)'),
			net: z.string().optional().describe('Net flag / net port only: new net name'),
			otherProperty: z
				.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
				.optional()
				.describe('Custom properties to set/overwrite; properties not listed are kept'),
		}),
		async ({ primitiveId, instance_id, document, coordinateFrame: frame, ...property }) => {
			const result = await bridge.send('sch.component.modify', { primitiveId, property, coordinateFrame: frame, instance_id, document, _timeoutMs: SCH_WRITE_TIMEOUT_MS });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_create_wire',
		'Create a wire in the schematic defined by a series of coordinate points. `line` may be a flat polyline [x1,y1,x2,y2,...], point pairs [[x1,y1],[x2,y2],...] (joined into one polyline), or several connected flat polylines [[x1,y1,x2,y2],[...]]. Wire coordinates are in the same frame as sch_get_pin_position. EasyEDA stores net names upper-case.',
		withDocumentParam({
			line: z
				.union([
					z.array(z.number()).min(4).describe('Flat array of coordinates [x1,y1,x2,y2,...]'),
					z
						.array(z.array(z.number()).min(2))
						.min(1)
						.describe('Point pairs [[x1,y1],[x2,y2],...] or flat polylines [[x1,y1,x2,y2,...],...]'),
				])
				.describe('Wire path coordinates'),
			net: z.string().optional().describe('Net name to assign to the wire (works with either line format)'),
			color: z.string().nullable().optional().describe('Wire color (null for default)'),
			lineWidth: z.number().nullable().optional().describe('Wire width (null for default)'),
			lineType: z
				.enum(['0', '1', '2', '3'])
				.optional()
				.describe('Line type: 0=Solid, 1=Dashed, 2=Dotted, 3=DotDashed'),
		}),
		async ({ lineType, instance_id, document, ...rest }) => {
			const params: Record<string, any> = { ...rest, instance_id, document, _timeoutMs: SCH_WRITE_TIMEOUT_MS };
			if (lineType !== undefined) {
				params.lineType = Number(lineType);
			}
			const result = await bridge.send('sch.wire.create', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_delete_wire',
		'Delete one or more wires by their primitive IDs',
		withDocumentParam({
			ids: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of primitive IDs to delete'),
		}),
		async (params) => {
			const result = await bridge.send('sch.wire.delete', { ...params, _timeoutMs: SCH_WRITE_TIMEOUT_MS });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_modify_wire',
		'Modify an existing wire. Only the fields you pass change — omitting `net` keeps the wire\'s current net name (it is no longer reset to empty). `line` accepts the same formats as sch_create_wire.',
		withDocumentParam({
			primitiveId: z.string().describe('The wire primitive ID'),
			line: z
				.union([z.array(z.number()), z.array(z.array(z.number()))])
				.optional()
				.describe('New wire path coordinates'),
			net: z.string().optional().describe('New net name (omit to keep the current one; setting it renames the net on this wire)'),
			color: z.string().nullable().optional().describe('New wire color (null for default)'),
			lineWidth: z.number().nullable().optional().describe('New wire width (null for default)'),
			lineType: z
				.enum(['0', '1', '2', '3'])
				.optional()
				.describe('Line type: 0=Solid, 1=Dashed, 2=Dotted, 3=DotDashed'),
		}),
		async ({ primitiveId, lineType, instance_id, document, ...rest }) => {
			const property: Record<string, any> = { ...rest };
			if (lineType !== undefined) {
				property.lineType = Number(lineType);
			}
			const result = await bridge.send('sch.wire.modify', { primitiveId, property, instance_id, document, _timeoutMs: SCH_WRITE_TIMEOUT_MS });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_select_primitives',
		`Select and highlight primitives in the schematic editor by designators, pins, or nets.
Selection is additive — each call adds to the current selection. There is currently no programmatic way to clear the selection; the user must click on empty space in the editor to deselect.
Pin format: "U1_1" (designator_pinNumber). Components selects the whole component, pins highlights just the pin, nets highlights the entire wire/net.`,
		withDocumentParam({
			components: z
				.array(z.string())
				.optional()
				.describe('Component designators to select (e.g. ["U3", "U13"])'),
			pins: z
				.array(z.string())
				.optional()
				.describe('Pins to select as designator_pinNumber (e.g. ["U3_1", "U3_2"])'),
			nets: z
				.array(z.string())
				.optional()
				.describe('Net names to select (e.g. ["GND", "VBUS"])'),
		}),
		async ({ components, pins, nets, instance_id, document }) => {
			const result = await bridge.send('sch.select.crossProbe', {
				components,
				pins,
				nets,
				highlight: true,
				select: true,
				instance_id,
				document,
			});
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_set_netlist',
		'Update the schematic netlist',
		withDocumentParam({
			type: z
				.enum(['Allegro', 'PADS', 'Protel2', 'JLCEDA', 'EasyEDA', 'DISA'])
				.optional()
				.describe('Netlist format type'),
			netlist: z.string().describe('Netlist data string'),
		}),
		async (params) => {
			const result = await bridge.send('sch.netlist.set', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_save',
		'Save the current schematic document',
		withDocumentParam({}),
		async (params) => {
			const result = await bridge.send('sch.document.save', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_import_changes',
		'Import changes from PCB back into the schematic',
		withDocumentParam({}),
		async (params) => {
			const result = await bridge.send('sch.document.importChanges', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);
}

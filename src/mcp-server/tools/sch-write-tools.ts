import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';

export function registerSchWriteTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'sch_create_component',
		'Create a schematic component from a library device reference. Use lib_search_device or lib_get_device_by_lcsc first to get the component object. IMPORTANT: The component object must include uuid, symbolUuid, footprintUuid, AND libraryUuid — passing only {deviceUuid, libraryUuid} will fail with a validation error. Pass the full object returned by lib_get_device_by_lcsc with libraryUuid added (from lib_get_system_library_uuid).',
		withDocumentParam({
			component: z
				.record(z.string(), z.any())
				.describe(
					'Full component object including uuid, symbolUuid, footprintUuid, and libraryUuid. Get the base object from lib_get_device_by_lcsc or lib_search_device, then add libraryUuid from lib_get_system_library_uuid. Passing only {deviceUuid, libraryUuid} will fail.',
				),
			x: z.number().describe('X coordinate for placement (X axis points rightward — higher values = further right)'),
			y: z.number().describe('Y coordinate for placement (Y axis points upward — higher values = higher on screen)'),
			subPartName: z.string().optional().describe('Sub-part name for multi-part components'),
			rotation: z.number().optional().describe('Rotation angle in degrees'),
			mirror: z.boolean().optional().describe('Whether to mirror the component'),
			addIntoBom: z.boolean().optional().describe('Whether to include in BOM (default true)'),
			addIntoPcb: z.boolean().optional().describe('Whether to include in PCB (default true)'),
		}),
		async (params) => {
			const result = await bridge.send('sch.component.create', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	const netFlagItemSchema = z.object({
		identification: z
			.enum(['Power', 'Ground', 'AnalogGround', 'ProtectGround'])
			.describe('Net flag type'),
		net: z.string().describe('Net name (e.g. "VCC", "GND", "3V3")'),
		x: z.number().describe('X coordinate (X axis points rightward — higher values = further right)'),
		y: z.number().describe('Y coordinate (Y axis points upward — higher values = higher on screen)'),
		rotation: z.number().optional().describe('Rotation angle in degrees'),
		mirror: z.boolean().optional().describe('Whether to mirror'),
		component: z
			.object({ libraryUuid: z.string(), uuid: z.string() })
			.optional()
			.describe('Library device reference override'),
	});

	server.tool(
		'sch_create_net_flag',
		'Create one or more Power/Ground/AnalogGround/ProtectGround net flags in the schematic. Pass individual parameters for a single flag, or use "batch" array for multiple flags in one call.',
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
			batch: z
				.array(netFlagItemSchema)
				.max(10)
				.optional()
				.describe('Array of net flags to create in one call (max 10 — each takes ~1.5s). When provided, the individual parameters above are ignored.'),
		}),
		async (params) => {
			const result = await bridge.send('sch.component.createNetFlag', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	const netPortItemSchema = z.object({
		direction: z.enum(['IN', 'OUT', 'BI']).describe('Port direction'),
		net: z.string().describe('Net name'),
		x: z.number().describe('X coordinate'),
		y: z.number().describe('Y coordinate'),
		rotation: z.number().optional().describe('Rotation angle in degrees'),
		mirror: z.boolean().optional().describe('Whether to mirror'),
		component: z
			.object({ libraryUuid: z.string(), uuid: z.string() })
			.optional()
			.describe('Library device reference override'),
	});

	server.tool(
		'sch_create_net_port',
		'Create one or more IN/OUT/BI directional net ports in the schematic. Pass individual parameters for a single port, or use "batch" array for multiple ports in one call.',
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
			batch: z
				.array(netPortItemSchema)
				.max(10)
				.optional()
				.describe('Array of net ports to create in one call (max 10 — each takes ~1.5s). When provided, the individual parameters above are ignored.'),
		}),
		async (params) => {
			const result = await bridge.send('sch.component.createNetPort', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_delete_component',
		'Delete one or more schematic components by their primitive IDs',
		withDocumentParam({
			ids: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of primitive IDs to delete'),
		}),
		async (params) => {
			const result = await bridge.send('sch.component.delete', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_modify_component',
		'Modify properties of a schematic component (position, rotation, designator, etc.)',
		withDocumentParam({
			primitiveId: z.string().describe('The component primitive ID'),
			x: z.number().optional().describe('New X coordinate'),
			y: z.number().optional().describe('New Y coordinate'),
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
		}),
		async ({ primitiveId, instance_id, document, ...property }) => {
			const result = await bridge.send('sch.component.modify', { primitiveId, property, instance_id, document });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_create_wire',
		'Create a wire in the schematic defined by a series of coordinate points',
		withDocumentParam({
			line: z
				.union([
					z.array(z.number()).min(4).describe('Flat array of coordinates [x1,y1,x2,y2,...]'),
					z
						.array(z.array(z.number()).length(2))
						.min(2)
						.describe('Array of point pairs [[x1,y1],[x2,y2],...]'),
				])
				.describe('Wire path coordinates'),
			net: z.string().optional().describe('Net name to assign to the wire'),
			color: z.string().nullable().optional().describe('Wire color (null for default)'),
			lineWidth: z.number().nullable().optional().describe('Wire width (null for default)'),
			lineType: z
				.enum(['0', '1', '2', '3'])
				.optional()
				.describe('Line type: 0=Solid, 1=Dashed, 2=Dotted, 3=DotDashed'),
		}),
		async ({ lineType, instance_id, document, ...rest }) => {
			const params: Record<string, any> = { ...rest, instance_id, document };
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
			const result = await bridge.send('sch.wire.delete', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_modify_wire',
		'Modify properties of an existing wire',
		withDocumentParam({
			primitiveId: z.string().describe('The wire primitive ID'),
			line: z
				.union([z.array(z.number()), z.array(z.array(z.number()))])
				.optional()
				.describe('New wire path coordinates'),
			net: z.string().optional().describe('New net name'),
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
			const result = await bridge.send('sch.wire.modify', { primitiveId, property, instance_id, document });
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

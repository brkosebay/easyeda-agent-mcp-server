import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { exportsDir } from '../exports-dir';
import { withDocumentParam, withQueryParams } from './query-params';

// Same trim as pcb_drc_summarize (pcb-drc-tools.ts): the extension sends up to
// 20 ids + 3 samples per group; keep what an agent acts on. primitiveIds
// supersede a sample's raw `objs`. Older extensions send no primitiveIds —
// the field stays absent then.
export function trimDrcGroups(result: any, maxIds: number, samplesPerGroup: number): any {
	if (!Array.isArray(result?.topGroups)) return result;
	const cut = (ids: unknown) => {
		const list: unknown[] | undefined = Array.isArray(ids) ? ids : undefined;
		return { ids: list?.slice(0, maxIds), more: list && list.length > maxIds ? list.length - maxIds : undefined };
	};
	return {
		...result,
		topGroups: result.topGroups.map((g: any) => {
			const prim = cut(g.primitiveIds);
			const off = cut(g.offenderIds);
			return {
				...g,
				primitiveIds: prim.ids,
				morePrimitiveIds: prim.more,
				offenderIds: off.ids ?? [],
				moreOffenderIds: off.more,
				samples: Array.isArray(g.samples)
					? g.samples.slice(0, samplesPerGroup).map((x: any) => (x && Array.isArray(x.primitiveIds) ? (({ objs, ...rest }) => rest)(x) : x))
					: g.samples,
			};
		}),
	};
}

export function registerSchReadTools(server: McpServer, bridge: WebSocketBridge): void {
	const FRAME_NOTE = 'x/y are in the same frame as sch_get_all_wires and sch_get_pin_position, and are accepted as-is by the sch_create_*/sch_modify_* tools.';
	const coordinateFrame = z
		.enum(['canvas', 'api'])
		.optional()
		.describe('Advanced: "canvas" (default) = same frame as wires/pins; "api" = raw EasyEDA component frame (Y inverted on EasyEDA Pro 2.2).');

	server.tool(
		'sch_get_all_components',
		`Get all components in the schematic with their properties, positions, rotations, designators, etc.
Fields: primitiveId, componentType, designator, name, x, y, rotation, mirror, addIntoBom, addIntoPcb, footprint, manufacturer, net, otherProperty.
componentType "netflag" / "netport" returns power/ground flags and net ports ({primitiveId, componentType, net, x, y, rotation, mirror}) — same as sch_list_net_symbols.
${FRAME_NOTE}
Note: name often contains EasyEDA template expressions like ={Manufacturer Part} rather than resolved values. For resolved names, use sch_get_connectivity.`,
		withQueryParams({
			componentType: z
				.enum(['part', 'sheet', 'netflag', 'netport', 'nonElectrical_symbol', 'short_symbol', 'netlabel'])
				.optional()
				.describe('Filter by component type (e.g. "part", "netflag", "netport")'),
			allSchematicPages: z
				.boolean()
				.optional()
				.describe('If true, get components from all schematic pages instead of just the current page'),
			coordinateFrame,
		}),
		async (params) => {
			const result = await bridge.send('sch.component.getAll', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_get_component',
		`Get one or more schematic components (or net flags / net ports) by primitive ID(s). ${FRAME_NOTE}`,
		withDocumentParam({
			primitiveIds: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of primitive IDs'),
			coordinateFrame,
		}),
		async (params) => {
			const result = await bridge.send('sch.component.get', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_list_net_symbols',
		`List net flags (Power/Ground/AnalogGround/ProtectGround symbols) and net ports (IN/OUT/BI) on the active schematic page, with primitiveId, componentType, net, x, y, rotation, mirror. Use the primitiveId with sch_modify_component (move / rotate / rename net via \`net\`) or sch_delete_component. Returns {total, items, diagnostics?}; componentType may be "unknown" when EasyEDA cannot tell flag from port. An empty result always carries \`diagnostics\` explaining what each lookup strategy saw. ${FRAME_NOTE}`,
		withQueryParams({
			kind: z.enum(['netflag', 'netport']).optional().describe('Only flags or only ports (default: both)'),
			net: z.string().optional().describe('Only symbols on this net (case-insensitive)'),
			allSchematicPages: z.boolean().optional().describe('Include every schematic page (EasyEDA may still return only the active page)'),
			coordinateFrame,
			diagnostics: z.boolean().optional().describe('Always include per-strategy diagnostics (they are included automatically when nothing is found)'),
		}),
		async (params) => {
			const result = await bridge.send('sch.component.listNetSymbols', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_get_component_pins',
		`Get all pins of a schematic component by its primitive ID.
Pin fields: primitiveId, pinNumber, name, net, x, y, rotation.
Each pin includes a net field with the net name it is connected to (empty string if unconnected).
Pins connected to $-prefixed nets (like $R11_1) are on unnamed nets that still carry real signals — use sch_get_connectivity with that net name to see what else is connected.`,
		withQueryParams({
			primitiveId: z.string().describe('The component primitive ID'),
		}),
		async (params) => {
			const result = await bridge.send('sch.component.getAllPins', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_get_all_wires',
		'Get all wires in the schematic, optionally filtered by net name',
		withQueryParams({
			net: z
				.union([z.string(), z.array(z.string())])
				.optional()
				.describe('Filter by net name or array of net names'),
		}),
		async (params) => {
			const result = await bridge.send('sch.wire.getAll', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_get_wire',
		'Get one or more wires by primitive ID(s)',
		withDocumentParam({
			primitiveIds: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of primitive IDs'),
		}),
		async (params) => {
			const result = await bridge.send('sch.wire.get', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_get_selected',
		'Get all currently selected primitives in the schematic editor',
		withQueryParams({}),
		async (params) => {
			const result = await bridge.send('sch.select.getAll', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_get_selected_ids',
		'Get primitive IDs of all currently selected primitives in the schematic editor',
		withDocumentParam({}),
		async (params) => {
			const result = await bridge.send('sch.select.getAllIds', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_get_primitive',
		'Get a schematic primitive by its ID with all properties',
		withDocumentParam({
			id: z.string().describe('The primitive ID'),
		}),
		async (params) => {
			const result = await bridge.send('sch.primitive.get', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_get_primitive_type',
		'Get the type of a schematic primitive by its ID',
		withDocumentParam({
			id: z.string().describe('The primitive ID'),
		}),
		async (params) => {
			const result = await bridge.send('sch.primitive.getType', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_get_primitive_bbox',
		'Get the bounding box of one or more schematic primitives',
		withDocumentParam({
			primitiveIds: z.array(z.string()).describe('Array of primitive IDs'),
		}),
		async (params) => {
			const result = await bridge.send('sch.primitive.getBBox', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_get_netlist',
		`Get the raw schematic netlist in the specified format. WARNING: The JLCEDA format response is very large (100KB+).
Prefer sch_get_connectivity for connectivity questions — it returns the same net/pin data in a much more compact format with resolved part names.
Only use this tool when you need a specific netlist export format (Allegro, PADS, etc.) or the full raw netlist data.`,
		withQueryParams({
			type: z
				.enum(['Allegro', 'PADS', 'Protel2', 'JLCEDA', 'EasyEDA', 'DISA'])
				.optional()
				.describe('Netlist format type'),
		}),
		async (params) => {
			const result = await bridge.send('sch.netlist.get', params);
			if (typeof result !== 'string') return { content: [{ type: 'text', text: JSON.stringify(result) }] };
			// The netlist is already text (often JSON): JSON.stringify-ing it
			// again escaped every quote. Save it for grep/file tools and return
			// it as plain text (the response budget trims it with a handle).
			const dir = await exportsDir();
			await mkdir(dir, { recursive: true });
			const path = join(dir, `netlist-${(params as any).type ?? 'default'}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`);
			await writeFile(path, result);
			return { content: [{ type: 'text', text: `netlist saved to ${path} (${result.length} chars)\n${result}` }] };
		},
	);

	server.tool(
		'sch_get_connectivity',
		`Get compact connectivity data: which nets connect which component pins, with resolved part names.
Much smaller than sch_get_netlist — use this for connectivity questions.
Returns nets (net → pin connections like "U3.2(GND)") and components (designator → part + pin assignments).
Auto-generated net names (starting with $) are hidden from the nets section but still appear in component pin assignments.
IMPORTANT: $-prefixed nets (like $R11_1, $U3_7) represent real electrical connections — they are unnamed nets where the designer didn't assign a net label. When investigating a component's full circuit context, you MUST look at $-prefixed nets in its pin assignments and trace them to see what else is connected. These often carry critical signals (reset lines, boot pins, enable pins) that would otherwise be invisible.
Use the depth parameter (default 1) to automatically trace through $-prefixed nets and discover indirect connections. For example, depth=2 with designators=["U3"] finds U3's neighbors through unnamed nets — great for finding reset/boot/enable circuitry that connects indirectly.
The netlist comes from the last SAVED state; designators are overlaid from the live editor. If parts were changed since the last save the result carries \`staleness\` (renamed / not-yet-in-netlist parts) — pass refreshNetlist:true to save the schematic first and get fresh pin connections.`,
		withDocumentParam({
			designators: z
				.array(z.string())
				.optional()
				.describe('Only include these components and nets touching them (e.g. ["U3", "U8"])'),
			nets: z
				.array(z.string())
				.optional()
				.describe('Only include these nets and components touching them (e.g. ["GND", "VBUS"])'),
			depth: z
				.number()
				.int()
				.min(1)
				.max(5)
				.optional()
				.describe('How many hops to trace through $-prefixed (unnamed) nets from the specified designators. depth=1 (default) shows only direct connections. depth=2 follows unnamed nets one hop out to find indirectly connected components (e.g. buttons, regulators connected through resistors). Only used with designators parameter.'),
			refreshNetlist: z.boolean().optional().describe('If the netlist is stale vs the live editor, save the schematic (sch_save) and re-read it. Default false: report staleness only.'),
		}),
		async (params) => {
			const result = await bridge.send('sch.connectivity.get', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_run_drc',
		`Run Design Rule Check (DRC) on the schematic. Returns {passed, violationCount, violations[]} with the full leaf-violation tree flattened. For projects with many violations prefer sch_drc_summarize — it groups by category/net/component and returns the top-N.`,
		withQueryParams({
			strict: z.boolean().optional().describe('Whether to run strict DRC checks'),
			userInterface: z.boolean().optional().describe('Whether to show DRC results in UI'),
		}),
		async (params) => {
			const result = await bridge.send('sch.drc.check', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_drc_summarize',
		'Run schematic DRC, flatten the violation tree, group by category/net/component, return the top-N. Same shape as pcb_drc_summarize: each group has count, primitiveIds (the offending pins/wires/symbols to act on), offenderIds (DRC error ids like "err12" — they name the violation, not a primitive) and sample violations with errorId, primitiveIds, componentRefs and pads ({component, pad} = designator + pin). Net labels/flags named after their net are not mistaken for components.',
		withQueryParams({
			top: z.number().int().min(1).max(100).optional().describe('Number of top groups to return (default 25)'),
			groupBy: z.enum(['category', 'net', 'component']).optional().describe('How to group violations (default category)'),
			includeSamples: z.boolean().optional().describe('Include sample offenders per group (default true)'),
			maxIds: z.number().int().min(0).max(20).optional().default(5).describe('primitiveIds (and offenderIds) kept per group'),
			samplesPerGroup: z.number().int().min(0).max(3).optional().default(1),
		}),
		async ({ maxIds, samplesPerGroup, ...params }) => {
			const result = await bridge.send('sch.drc.summarize', params);
			return { content: [{ type: 'text', text: JSON.stringify(trimDrcGroups(result, maxIds ?? 5, samplesPerGroup ?? 1)) }] };
		},
	);
}

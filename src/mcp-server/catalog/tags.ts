// Tag inference + category overview shown in the search_tools description.
// Tags let the agent filter (e.g. tags: ["pcb","write"]) without semantic
// search when the request is unambiguous.

export function inferTags(name: string): string[] {
	const n = name.toLowerCase();
	const tags = new Set<string>();

	if (n.startsWith('pcb_')) tags.add('pcb');
	if (n.startsWith('sch_')) tags.add('sch');
	if (n.startsWith('lib_')) tags.add('lib');
	if (n.startsWith('editor_') || n === 'project_get_structure' || n === 'wait_for_extension' || n === 'list_instances' || n === 'server_info') tags.add('editor');

	if (/_get_|_get$|_list/.test(n) || n.endsWith('_help')) tags.add('read');
	if (/_create_|_modify_|_delete_|_save|_import|_export|_move_|_route_|_repour|_refresh/.test(n)) tags.add('write');

	if (n.includes('_analyze_') || n.includes('_drc') || n.includes('_summarize') || n.includes('_extract')) tags.add('analyze');
	// DRC umbrella: includes rule configs, net classes, differential pairs,
	// equal-length groups, pad pair groups — all live in pcb-drc-tools.ts.
	if (
		n.includes('_drc') ||
		n.includes('_rule') ||
		n.includes('_net_class') ||
		n.includes('_diff_pair') ||
		n.includes('_equal_length') ||
		n.includes('_pad_pair')
	) tags.add('drc');
	if (n.includes('_pour') || n.includes('_fill')) tags.add('pour');
	if (n.includes('_via')) tags.add('via');
	if (n.includes('_track') || n.includes('_route')) tags.add('track');
	if (n.includes('_pad')) tags.add('pad');
	if (n.includes('_layer')) tags.add('layer');
	if (n.includes('_net')) tags.add('net');
	if (n.includes('_screenshot') || n.includes('_zoom') || n.includes('_marker')) tags.add('canvas');
	if (n.includes('_export') || n.includes('_import') || n.includes('_autoroute') || n.includes('_manufacture')) tags.add('manufacture');
	if (n.includes('_lcsc') || n.includes('_search') || n === 'lib_get_device') tags.add('lookup');
	if (n.includes('_component')) tags.add('component');
	if (n.includes('_wire')) tags.add('wire');

	return Array.from(tags).sort();
}

export const CATEGORY_OVERVIEW = `Tool catalog by category:

PCB editing — create / modify / delete tracks, vias, pads, pours, fills, regions, components; route_orthogonal; refresh canvas; create_via_mm.
PCB analysis — DRC summarize, connectivity status, repour_all, layer status, canvas filter, design rule queries.
PCB navigation — zoom_to_board, navigate_to, primitive at point / region.
Schematic editing — components (create/modify/delete), wires, net flags / ports, netlist set, schematic save.
Schematic analysis — extract_design (snapshot foundation), analyze_power_tree, analyze_decoupling, analyze_passive_networks, analyze_connectors, analyze_protection, analyze_esd_coverage.
Library lookup — search_device, get_device, get_by_lcsc, system library UUID.
Manufacturing — export (gerber, BOM, dsn, autoroute_json, pdf, …), import (autoroute_ses, autoroute_json), pcb_autoroute (FreeRouting wrapper).
Editor / instance — open tabs, current document, project structure, screenshots, zoom, markers, list instances, wait_for_extension.

Tag filters available: pcb, sch, lib, editor, read, write, analyze, drc, pour, via, track, pad, layer, net, canvas, manufacture, lookup, component, wire.`;

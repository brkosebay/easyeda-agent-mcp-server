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
	if (n.startsWith('bom_')) { tags.add('bom'); tags.add('sch'); }
	if (n.startsWith('sourcing_')) tags.add('sourcing');
	if (n.startsWith('datasheet_')) tags.add('datasheet');
	if (n.startsWith('project_export_') || n.includes('_bundle')) tags.add('bundle');
	if (n.startsWith('emc_')) { tags.add('emc'); tags.add('analyze'); tags.add('sch'); }
	if (n.startsWith('thermal_')) { tags.add('thermal'); tags.add('analyze'); tags.add('sch'); }
	if (n.startsWith('cross_')) { tags.add('cross'); tags.add('analyze'); }
	if (n.startsWith('pcb_emc_')) { tags.add('emc'); tags.add('pcb'); tags.add('analyze'); }
	if (n.startsWith('dfm_')) { tags.add('dfm'); tags.add('analyze'); tags.add('manufacture'); }
	if (n.startsWith('spice_')) { tags.add('spice'); tags.add('analyze'); tags.add('sch'); }
	if (n.startsWith('fab_release_')) { tags.add('release'); tags.add('analyze'); }
	if (n.startsWith('docgen_')) { tags.add('docgen'); tags.add('analyze'); }
	if (n === 'pcb_extract_design') { tags.add('pcb'); tags.add('analyze'); }
	if (n.startsWith('pcb_impedance_')) {
		tags.add('impedance'); tags.add('pcb'); tags.add('track');
		if (n === 'pcb_impedance_compute') tags.add('read'); else tags.add('write');
	}
	if (n.startsWith('functional_')) { tags.add('functional'); tags.add('analyze'); tags.add('sch'); tags.add('read'); }
	if (n === 'pcb_place_cluster' || n === 'pcb_optimize_placement') { tags.add('read'); tags.add('write'); tags.add('analyze'); tags.add('placement'); }
	// pcb_route_geometry_report is read-only (forces dryRun) — the broad _route_
	// write rule below would otherwise mis-tag it.
	if (n === 'pcb_route_geometry_report') tags.add('read');
	if (n === 'pcb_plan_split_pours' || n === 'pcb_layer_report') { tags.add('read'); tags.add('analyze'); }

	if (/_get_|_get$|_list|_inspect|_suggest_|_review_|_check_|_worklist|_context|_presets/.test(n) || n.endsWith('_help')) tags.add('read');
	if (/_create_|_modify_|_delete_|_save|_import|_export|_move_|_place_|_route_|_repour|_rebuild|_refresh|_set_|_stitch|_lock|_fanout|_length_match|_batch_edit|_pathfind/.test(n)) tags.add('write');

	if (n.includes('_analyze_') || n.includes('_drc') || n.includes('_summarize') || n.includes('_extract') || n.includes('_check_') || n.includes('_suggest_') || n.includes('_review_')) tags.add('analyze');
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
	if (n.includes('_via') || n.includes('_stitch')) tags.add('via');
	if (n.includes('_track') || n.includes('_trace') || n.includes('_route') || n.includes('_routing') || n.includes('_fanout') || n.includes('_length_match') || n.includes('_pathfind')) tags.add('track');
	if (n.includes('_footprint') || n.includes('_rotation') || n.includes('_orientation') || n.includes('_place_')) tags.add('placement');
	if (n.includes('_placement') || n.includes('_component_move')) tags.add('placement');
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

export const CATEGORY_OVERVIEW = `Categories:
pcb+write — tracks/vias/pads/pours/regions/components CRUD, routing (smart/pathfind/diff pair), fanout, length match, batch edit, route geometry cleanup (snap-45°/miter/jog removal), set component position.
pcb+analyze — routing context, net worklist, DRC summarize, connectivity, obstacle preflight, placement review (overlap/clearance/decoupling proximity), route geometry report, pour rebuild, layer status.
impedance — controlled-impedance trace-width calc from JLCPCB stackup presets (microstrip/stripline/diff) + apply width to a net or diff pair.
pcb+canvas — zoom/navigate, primitive at point/region, screenshots, markers.
sch+write — components, wires, net flags/ports, netlist, save.
sch+analyze — extract_design snapshot, power tree, decoupling, passives, connectors, protection, ESD.
pcb_extract_design — one-shot PCB snapshot (components, pads→nets, layer stack, counts) feeding PCB-side analyzers.
emc — schematic pre-compliance checks; pcb_emc_run_check for PCB-side (decoupling proximity, plane coverage).
functional — intent-aware review: per-part required-pin contracts (USB D+/D-/CC/VBUS, crystal load caps, I2C/reset pull-ups, IC decoupling) + floating-pin and mounting/shield-pad-credit checks. Catches data lines that look connected but aren't.
cross — sch↔PCB consistency verify, BOM reconcile.
dfm — JLCPCB/PCBWay manufacturability + part-class audit.
spice — auto-generated SPICE testbenches for EasyEDA's simulator.
release — fab_release_gate combined pass-or-hold.
docgen — design review / EMC / manufacturing / HDD markdown reports.
bom — extract, audit gaps, classify, normalize MPN, export CSV.
sourcing — LCSC search/lookup, BOM enrich (stock/pricing/lifecycle), lifecycle audit.
datasheet — LCSC PDF fetch + local cache management.
bundle — verification ZIP export for tool-less verifier agents.
thermal — per-component dissipation estimates.
lib — device search/lookup (incl. by LCSC code).
manufacture — gerber/BOM/dsn/pdf export, autoroute import, fastroute/FreeRouting autoroute (diff pairs, length matching from board rules).
editor — tabs, current document, project structure, instances, wait_for_extension.

Tag filters available: pcb, sch, lib, editor, read, write, analyze, drc, pour, via, track, pad, layer, net, canvas, manufacture, lookup, component, placement, wire, bom, sourcing, datasheet, bundle, emc, thermal, cross, dfm, spice, release, docgen, impedance, functional.`;

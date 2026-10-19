// PCB extract tool — wraps the extension's pcb.extract.design handler.
// Foundation for PCB-side analyzers (cross-analysis, EMC PCB rules, DFM,
// decoupling proximity). Keep payload reasonable: full track listings are
// NOT included by default — pass includeNetLengths/includeAllPads to opt in.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';

export function registerPcbExtractTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'pcb_extract_design',
		'One-shot PCB snapshot: components (with positions, layers, footprints), pads (mapped to nets), nets (with members + power/ground tagging), layer stack, by-layer counts of components/pads/tracks/vias/pours. Foundation for PCB-side analyzers — call once and pass to analyzers via the snapshot field. Track lists are not included by default (potentially 10K+ entries); use existing pcb_get_routing_context or pcb.getAll.line for raw track data.',
		withDocumentParam({
			includeNetLengths: z.boolean().optional().default(false).describe('Compute per-net routed length via getNetLength (slow on large boards — opt in only if you need it)'),
			includeAllPads: z.boolean().optional().default(false).describe('Include the flat pad list (designator/padNumber/net/layer/x/y). Defaults false — pad counts, net members and per-net pinCount are always computed; opt in only when you need per-pad coordinates.'),
			verbose: z.boolean().optional().default(false).describe('Keep each component\'s raw otherProperties bag intact instead of trimming noise props (Datasheet, 3D Model, ...)'),
			fields: z
				.array(z.string())
				.optional()
				.describe('Project the snapshot to these top-level keys only (e.g. ["nets","netCount"]). Cuts response size dramatically — use it whenever you know what you need.'),
			filter: z
				.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
				.optional()
				.describe('Restrict the snapshot to matching nets: {net:"GND"} exact, {net:"VCC*"} prefix, {net:["GND","VCC"]} any-of. Filters the nets map, per-net stats and (when included) the pad list.'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.extract.design', { ...params, _timeoutMs: 180_000 });
			return { content: [{ type: 'text', text: JSON.stringify(params.verbose ? result : slimSnapshot(result)) }] };
		},
	);
}

/**
 * Safety net for extensions older than the pcb-extract.ts fix, which already
 * emits short scalar otherProperties and a single snapshot-level `padUnits` —
 * on current output this is a no-op. Older builds fell back to the raw SDK
 * primitive when a part had no property bag (~85% of components) and repeated
 * unit strings on every pad (~11%). Analyzers call pcb.extract.design directly
 * and never see this.
 */
export function slimSnapshot(result: any): any {
	if (!result || typeof result !== 'object') return result;
	const out = { ...result };
	if (out.components && typeof out.components === 'object') {
		const slim = (c: any) => {
			const props = c?.otherProperties;
			if (!props || typeof props !== 'object') return c;
			const { otherProperties, ...rest } = c;
			// A raw primitive carries SDK bookkeeping; its real bag is `otherProperty`
			// and `manufacturerId` is the MPN.
			const raw = 'primitiveType' in props || 'async' in props;
			if (raw && !rest.mpn && typeof props.manufacturerId === 'string' && props.manufacturerId) rest.mpn = props.manufacturerId;
			const kept = scalarProps(raw ? props.otherProperty : props);
			return kept ? { ...rest, otherProperties: kept } : rest;
		};
		out.components = Array.isArray(out.components)
			? out.components.map(slim)
			: Object.fromEntries(Object.entries(out.components).map(([k, c]) => [k, slim(c)]));
	}
	if (Array.isArray(out.pads) && out.pads.some((p: any) => p?.sourceUnits || p?.units)) {
		out.pads = out.pads.map(({ units, sourceUnits, ...p }: any) => p);
		out.padUnits = 'mil';
	}
	return out;
}

function scalarProps(bag: unknown): Record<string, unknown> | undefined {
	if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return undefined;
	const props: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(bag as Record<string, unknown>)) {
		if (PROP_NOISE.has(k)) continue;
		if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length > 0 && v.length <= 200)) props[k] = v;
	}
	return Object.keys(props).length ? props : undefined;
}

// Library identity that never answers a design question.
const PROP_NOISE = new Set([
	'3D Model', '3D Model Title', '3D Model Transform', 'Symbol', 'Footprint', 'Datasheet', 'Add into BOM', 'Convert to PCB',
]);

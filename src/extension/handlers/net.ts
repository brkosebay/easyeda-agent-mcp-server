import { getSnapshot } from './board-context';
import { analyzeConnectivity, fetchArcs } from './net-connectivity';
import { componentPinScale, componentPinSourceUnits } from './pin-units';
// `getAllPrimitivesByNet` matches on the RUNTIME primitive-type names, which
// differ from the names the type definitions (and most agents) use: line
// primitives report as "Track", filled copper as "Poured". Passing "Line" or
// "line" silently returns nothing. Map every plausible spelling onto the
// runtime name, case-insensitively.
const NET_PRIMITIVE_TYPE_ALIASES: Record<string, string> = {
	line: 'Track', track: 'Track', trace: 'Track', wire: 'Track', segment: 'Track',
	via: 'Via',
	arc: 'Arc',
	polyline: 'Polyline', poly: 'Polyline',
	pour: 'Pour', copperarea: 'Pour', 'copper area': 'Pour',
	poured: 'Poured', pourfill: 'Poured',
	fill: 'Fill', solidregion: 'Fill',
	region: 'Region',
	pad: 'Pad',
	hole: 'Hole',
	component: 'Component', footprint: 'Component',
	text: 'Text',
};

const NET_PRIMITIVE_TYPE_VALUES = Array.from(new Set(Object.values(NET_PRIMITIVE_TYPE_ALIASES))).sort();

function normalizeNetPrimitiveTypes(types: unknown): string[] | undefined {
	if (types == null) return undefined;
	const list = Array.isArray(types) ? types : [types];
	if (list.length === 0) return undefined;
	const out: string[] = [];
	for (const raw of list) {
		const key = String(raw ?? '').trim().toLowerCase();
		const mapped = NET_PRIMITIVE_TYPE_ALIASES[key] ?? NET_PRIMITIVE_TYPE_ALIASES[key.replace(/[\s_-]+/g, '')];
		if (!mapped) {
			throw new Error(
				`Unknown primitive type "${raw}" for pcb.net.getPrimitives. Accepted (case-insensitive): ${NET_PRIMITIVE_TYPE_VALUES.join(', ')}. Aliases: line/trace/wire → Track, copperArea → Pour, footprint → Component.`,
			);
		}
		if (!out.includes(mapped)) out.push(mapped);
	}
	return out;
}

// `getAllPrimitivesByNet` never returns component pads — pads live under their
// components. Reconstruct them by scanning components → pins, same approach
// pcb.net.connectivityStatus uses.
async function padsOnNet(net: string): Promise<Array<Record<string, any>>> {
	const out: Array<Record<string, any>> = [];
	const pinScale = await componentPinScale();
	const components = await eda.pcb_PrimitiveComponent.getAll();
	for (const c of components || []) {
		const ci: any = c;
		let designator: string | undefined;
		try { designator = ci.getState_Designator?.() ?? ci.designator; } catch { designator = ci.designator; }
		const primId = (() => {
			try { return ci.getState_PrimitiveId?.() ?? ci.primitiveId; } catch { return ci.primitiveId; }
		})();
		if (!primId) continue;
		const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(primId);
		for (const pin of pins || []) {
			const pi: any = pin;
			const read = (getter: string, field: string): any => {
				try { if (typeof pi[getter] === 'function') return pi[getter](); } catch {/* */}
				return pi[field];
			};
			const netName: string | undefined = read('getState_Net', 'net');
			if (netName !== net) continue;
			const x = Number(read('getState_X', 'x'));
			const y = Number(read('getState_Y', 'y'));
			out.push({
				primitiveType: 'Pad',
				primitiveId: read('getState_PrimitiveId', 'primitiveId'),
				componentPrimitiveId: primId,
				designator,
				padNumber: String(read('getState_PadNumber', 'padNumber') ?? ''),
				net: netName,
				layer: read('getState_Layer', 'layer'),
				// Component-pad coordinates are 10-mil units on EasyEDA 2.x, mil on 3.x.
				x: Number.isFinite(x) ? x * pinScale : undefined,
				y: Number.isFinite(y) ? y * pinScale : undefined,
				units: 'mil',
				sourceUnits: componentPinSourceUnits(pinScale),
			});
		}
	}
	return out;
}

export const netHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.net.getAllNames': async () => {
		return eda.pcb_Net.getAllNetsName();
	},

	'pcb.net.getPrimitives': async (params) => {
		const requested = normalizeNetPrimitiveTypes(params.types);
		if (!requested) {
			return eda.pcb_Net.getAllPrimitivesByNet(params.net);
		}
		const wantsPads = requested.includes('Pad');
		const runtimeTypes = requested.filter((t) => t !== 'Pad');
		const primitives = runtimeTypes.length > 0
			? ((await eda.pcb_Net.getAllPrimitivesByNet(params.net, runtimeTypes as any)) ?? [])
			: [];
		if (!wantsPads) return primitives;
		const pads = await padsOnNet(String(params.net));
		return [...primitives, ...pads];
	},

	'pcb.net.getLength': async (params) => {
		return eda.pcb_Net.getNetLength(params.net);
	},

	'pcb.net.highlight': async (params) => {
		return eda.pcb_Net.highlightNet(params.net);
	},

	'pcb.net.select': async (params) => {
		return eda.pcb_Net.selectNet(params.net);
	},

	// Per-net connectivity summary. Distinguishes:
	//   - routed: has Line/Track/Via primitives carrying the net
	//   - pour_only: connected only via copper pour (no tracks/vias)
	//   - unrouted: pin members exist but no copper / pour links them
	//   - single_pad: only one pad on the net (often power probes / NC)
	//
	// Notes about EasyEDA Pro internals:
	//   1. The runtime returns `"Track"` for line primitives even though the
	//      type def calls them `Line`. Accept both.
	//   2. `getAllPrimitivesByNet` does NOT return component pads — those
	//      live under their components. We derive pad count from the netlist
	//      so single_pad classification stays correct.
	'pcb.net.connectivityStatus': async (params) => {
		// Real connectivity from the copper graph (net-connectivity.ts). The
		// snapshot is refreshed by default: GUI edits do not invalidate the
		// extension's cache, and a stale "connected" is worse than a slow one.
		const snapshot = await getSnapshot({ ...params, forceRefresh: params?.forceRefresh !== false });
		const arcs = await fetchArcs();
		const onlyNets: string[] | undefined = Array.isArray(params?.nets) && params.nets.length ? params.nets.map(String) : undefined;
		const nets = analyzeConnectivity({ ...snapshot, arcs }, onlyNets);
		const order: Record<string, number> = { incomplete: 0, unrouted: 1, pour_dependent: 2, connected: 3, single_pad: 4 };
		nets.sort((a, b) => order[a.status] - order[b.status] || a.net.localeCompare(b.net));
		const counts = { connected: 0, incomplete: 0, pour_dependent: 0, unrouted: 0, single_pad: 0 };
		for (const n of nets) counts[n.status] += 1;
		return {
			netCount: nets.length,
			counts,
			nets,
			method: 'geometric copper graph: pads (real rotated shapes; drilled pads on every layer), tracks and arc chords (width-aware), through vias',
			note: 'connected = every pad joined by tracks/vias. incomplete = copper exists but padGroups are not joined (floatingCopper counts stubs touching no pad). pour_dependent = pads are joined only if the pour copper links them — confirm with pcb_copper_status / DRC. Pour copper is not traced here.',
		};
	},
};

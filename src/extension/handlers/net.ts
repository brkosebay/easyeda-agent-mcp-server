export const netHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.net.getAllNames': async () => {
		return eda.pcb_Net.getAllNetsName();
	},

	'pcb.net.getPrimitives': async (params) => {
		return eda.pcb_Net.getAllPrimitivesByNet(params.net, params.types);
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
		const includeNets: string[] | undefined = Array.isArray(params?.nets) ? params.nets : undefined;
		const allNets = includeNets || (await eda.pcb_Net.getAllNetsName()) || [];

		// Pre-compute pad counts per net by iterating components → pins. This
		// gives us a true "how many endpoints does this net have" number that
		// the primitives-by-net query can't provide.
		const padCountByNet: Record<string, number> = {};
		try {
			const components = await eda.pcb_PrimitiveComponent.getAll();
			for (const c of components || []) {
				const ci: any = c;
				const primId = ci.getState_PrimitiveId?.() ?? ci.primitiveId;
				if (!primId) continue;
				const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(primId);
				for (const pin of pins || []) {
					const pi: any = pin;
					const netName: string | undefined = pi.getState_Net?.() ?? pi.net;
					if (!netName) continue;
					padCountByNet[netName] = (padCountByNet[netName] ?? 0) + 1;
				}
			}
		} catch {/* best-effort; pad counts will be 0 if this fails */}

		const typeOf = (p: any): string => {
			const fn = p?.getState_PrimitiveType;
			let t: string | undefined;
			try { t = typeof fn === 'function' ? fn.call(p) : undefined; } catch {/* */}
			return t ?? p?.pcbItemPrimitiveType ?? p?.primitiveType ?? '';
		};

		const summaries: Array<Record<string, any>> = [];
		const buckets = { routed: 0, pour_only: 0, unrouted: 0, single_pad: 0 };

		for (const net of allNets) {
			const primitives = await eda.pcb_Net.getAllPrimitivesByNet(net);
			let lines = 0, vias = 0, pours = 0, poured = 0, polylines = 0, otherCopper = 0;
			for (const p of primitives || []) {
				const t = typeOf(p);
				if (t === 'Line' || t === 'Track' || t === 'Arc') lines += 1;
				else if (t === 'Via') vias += 1;
				else if (t === 'Pour') pours += 1;
				else if (t === 'Poured') poured += 1;
				else if (t === 'Polyline') polylines += 1;
				else if (t) otherCopper += 1;
			}

			const length = (await eda.pcb_Net.getNetLength(net)) ?? 0;
			const pads = padCountByNet[net] ?? 0;

			let status: 'routed' | 'pour_only' | 'unrouted' | 'single_pad';
			if (pads <= 1 && lines === 0 && vias === 0 && pours === 0 && poured === 0) {
				status = 'single_pad';
			} else if (lines > 0 || vias > 0) {
				status = 'routed';
			} else if (pours > 0 || poured > 0) {
				status = 'pour_only';
			} else {
				status = 'unrouted';
			}

			buckets[status] += 1;
			summaries.push({ net, status, pads, lines, vias, pours, poured, polylines, otherCopper, length });
		}

		// Unrouted first (action items), then pour_only, routed, single_pad.
		const order: Record<string, number> = { unrouted: 0, pour_only: 1, routed: 2, single_pad: 3 };
		summaries.sort((a, b) => order[a.status] - order[b.status]);

		return {
			netCount: summaries.length,
			counts: buckets,
			nets: summaries,
		};
	},
};

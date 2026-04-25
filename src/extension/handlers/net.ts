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
	//   - routed: has Line/Via primitives carrying the net
	//   - pour_only: connected only via copper pour (no tracks/vias)
	//   - unrouted: has multiple pads but no copper or pour linking them
	//   - single_pad: only one pad on the net (often power probes / NC)
	'pcb.net.connectivityStatus': async (params) => {
		const includeNets: string[] | undefined = Array.isArray(params?.nets) ? params.nets : undefined;
		const allNets = includeNets || (await eda.pcb_Net.getAllNetsName()) || [];

		const summaries: Array<Record<string, any>> = [];
		const buckets = { routed: 0, pour_only: 0, unrouted: 0, single_pad: 0 };

		for (const net of allNets) {
			const primitives = await eda.pcb_Net.getAllPrimitivesByNet(net);
			let pads = 0, lines = 0, vias = 0, pours = 0, poured = 0, polylines = 0;
			for (const p of primitives || []) {
				const t = p?.getState_PrimitiveType?.();
				if (t === 'Pad' || t === 'ComponentPad') pads += 1;
				else if (t === 'Line') lines += 1;
				else if (t === 'Via') vias += 1;
				else if (t === 'Pour') pours += 1;
				else if (t === 'Poured') poured += 1;
				else if (t === 'Polyline') polylines += 1;
			}

			const length = (await eda.pcb_Net.getNetLength(net)) ?? 0;

			let status: 'routed' | 'pour_only' | 'unrouted' | 'single_pad';
			if (pads <= 1) status = 'single_pad';
			else if (lines > 0 || vias > 0) status = 'routed';
			else if (pours > 0 || poured > 0) status = 'pour_only';
			else status = 'unrouted';

			buckets[status] += 1;
			summaries.push({ net, status, pads, lines, vias, pours, poured, polylines, length });
		}

		// Sort: unrouted first (action items), then pour_only, routed, single_pad
		const order: Record<string, number> = { unrouted: 0, pour_only: 1, routed: 2, single_pad: 3 };
		summaries.sort((a, b) => order[a.status] - order[b.status]);

		return {
			netCount: summaries.length,
			counts: buckets,
			nets: summaries,
		};
	},
};

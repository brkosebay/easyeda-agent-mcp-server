import { fetchNetlistText, fetchParsedNetlist, fetchPinNames } from './sch-netlist-utils';
import { flattenDrcTree, pickGroupKey, collectIds, extractOffender, extractDrcOffenders } from './drc';
import { mapWithConcurrency } from './_utils';
import { componentYSign } from './sch-frame';
import { parseSchNetSymbols, pinNetsFromGeometry, type GeoLabel, type GeoPin, type GeoWire } from './sch-geometry';

const SCH_FETCH_CONCURRENCY = 16;

// Schematic DRC leaves share the PCB leaf shape ({errorType, obj1/obj2 with
// suffix "(NET): label", objs, globalIndex}) and pins read like pads
// ("(GND): U3_7" → U3 pin 7), so the PCB parsers in drc.ts apply. One
// schematic-only trap: net labels / flags / ports are named after their net,
// so "(D1): D1" (a data-bus label) or "(VCC3): VCC3" would read as
// components D1 / VCC3. Such labels are dropped before grouping; primitive
// ids ("(D1): e88") are kept.
const SCH_NET_SYMBOL_TYPE = /net\s*(label|flag|port)|wire|bus|junction|no\s*connect/i;
const SCH_PRIMITIVE_ID = /^e\d+(?:e\d+)*$/;

function schSuffixParts(raw: unknown): { net?: string; label?: string } {
	const s = raw === undefined || raw === null ? '' : String(raw).trim();
	const net = s.match(/^\(([^)]*)\)/)?.[1]?.trim();
	const label = s.replace(/^\([^)]*\)\s*:?\s*/, '').trim().split(/\s+/)[0] || undefined;
	return { net, label };
}

export function sanitizeSchDrcLeaf(v: any): any {
	if (!v || typeof v !== 'object') return v;
	let changed = false;
	const clean = (o: any): any => {
		if (!o || typeof o !== 'object') return o;
		const netSymbol = SCH_NET_SYMBOL_TYPE.test(String(o.typeName ?? o.type ?? ''));
		let out = o;
		for (const key of ['suffix', 'name']) {
			const { net, label } = schSuffixParts(o[key]);
			if (!label || SCH_PRIMITIVE_ID.test(label)) continue;
			if (netSymbol || (net !== undefined && label === net)) {
				if (out === o) out = { ...o };
				delete out[key];
			}
		}
		if (out !== o) changed = true;
		return out;
	};
	const obj1 = clean(v.obj1);
	const obj2 = clean(v.obj2);
	return changed ? { ...v, obj1, obj2 } : v;
}

// extractOffender() on the sanitized leaf, but keep the raw obj1/obj2 labels
// for display (`between`) — only the identity fields must ignore net names.
function schDrcSample(v: any, clean: any): any {
	const sample = extractOffender(clean);
	if (clean !== v && sample.between) sample.between = extractOffender(v).between;
	return sample;
}

export const schDocumentHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'sch.document.save': async () => {
		return eda.sch_Document.save();
	},

	'sch.document.importChanges': async () => {
		return eda.sch_Document.importChanges();
	},

	// 3rd param `includeVerboseError` causes the `sch_Drc.check` function to return Array<any> of all DRC errors instead of just a
	// boolean indicating whether or not DRC passed. Added in the @jlceda/pro-api-types NPM
	// package but not yet documented on
	// https://prodocs.easyeda.com/en/api/reference/pro-api.sch_drc.check.html
	//
	// Some EasyEDA Pro builds still return a plain boolean from sch_Drc.check
	// even with verbose=true (vs. PCB DRC which always returns the tree).
	// We always run with verbose=true and, when we get a boolean back,
	// translate it into the same shape as the violation tree so callers
	// don't have to special-case it.
	'sch.drc.check': async (params) => {
		const result: any = await eda.sch_Drc.check(params.strict, params.userInterface, true);
		if (typeof result === 'boolean') {
			return { passed: result, violations: [], note: 'sch_Drc.check returned a boolean — this build does not surface verbose violations.' };
		}
		const violations = flattenDrcTree(result);
		return {
			passed: violations.length === 0,
			violationCount: violations.length,
			violations,
		};
	},

	// Same shape as pcb.drc.summarize: run schematic DRC, flatten the tree,
	// group by category/net/component, surface the top-N. Each group names
	// the offending primitives (primitiveIds) next to the DRC error ids
	// (offenderIds, e.g. "err12"); samples add errorId/componentRefs/pads.
	// Use this instead of sch.drc.check when the violation list is large and
	// you only need the high-level counts.
	'sch.drc.summarize': async (params) => {
		const result: any = await eda.sch_Drc.check(true, false, true);
		if (typeof result === 'boolean') {
			return { passed: result, totalViolations: null, groupBy: params?.groupBy || 'category', topGroups: [], note: 'sch_Drc.check returned a boolean — this build does not surface verbose violations.' };
		}
		const violations = flattenDrcTree(result);
		const top = Number(params?.top) > 0 ? Number(params.top) : 25;
		const groupBy: 'category' | 'net' | 'component' = params?.groupBy || 'category';
		const includeSamples = params?.includeSamples !== false;

		type Counter = Map<string, { count: number; samples: any[]; primitiveIds: Set<string>; offenderIds: Set<string> }>;
		const counters: Counter = new Map();
		for (const v of violations) {
			const clean = sanitizeSchDrcLeaf(v);
			const key = pickGroupKey(clean, groupBy);
			const entry = counters.get(key) || { count: 0, samples: [], primitiveIds: new Set(), offenderIds: new Set() };
			entry.count += 1;
			if (entry.samples.length < 3) entry.samples.push(schDrcSample(v, clean));
			for (const id of extractDrcOffenders(clean).primitiveIds) entry.primitiveIds.add(id);
			for (const id of collectIds(v)) entry.offenderIds.add(id);
			counters.set(key, entry);
		}

		const groups = Array.from(counters.entries())
			.map(([key, data]) => ({
				key,
				count: data.count,
				primitiveIds: Array.from(data.primitiveIds).slice(0, 20),
				offenderIds: Array.from(data.offenderIds).slice(0, 20),
				samples: includeSamples ? data.samples : undefined,
			}))
			.sort((a, b) => b.count - a.count)
			.slice(0, top);

		return {
			passed: violations.length === 0,
			totalViolations: violations.length,
			groupBy,
			topGroups: groups,
		};
	},

	'sch.netlist.get': async (params) => {
		return fetchNetlistText(params.type ?? ESYS_NetlistType.JLCEDA_PRO);
	},

	'sch.netlist.set': async (params) => {
		return eda.sch_Netlist.setNetlist(params.type, params.netlist);
	},

	'sch.connectivity.get': async (params) => {
		const depth: number = (params.depth as number) || 1;
		let designatorFilter: Set<string> | undefined = params.designators
			? new Set(params.designators as string[])
			: undefined;
		const netFilter: Set<string> | undefined = params.nets
			? new Set(params.nets as string[])
			: undefined;

		// 1. Fetch parsed netlist and all components
		let [netlist, allComponents] = await Promise.all([
			fetchParsedNetlist(),
			(eda.sch_PrimitiveComponent as any).getAll('part', true).catch(() => []),
		]);

		// 1b. The netlist is generated from the project's stored documents,
		// while getAll reads the live editor. After an unsaved edit they
		// disagree (a renamed part keeps its old designator and a moved part
		// shows stale connections). Detect that, optionally save to refresh,
		// and always report designators as the live editor has them.
		const liveDesignator = (): Record<string, string> => {
			const out: Record<string, string> = {};
			for (const comp of Array.isArray(allComponents) ? allComponents : []) {
				const c = comp as any;
				const uid = c.getState_UniqueId?.() ?? c.uniqueId;
				const des = c.getState_Designator?.() ?? c.designator;
				if (uid && des) out[uid] = des;
			}
			return out;
		};
		const findStale = () => {
			const live = liveDesignator();
			const renamed: Array<{ uniqueId: string; netlistDesignator: string; liveDesignator: string }> = [];
			const missing: string[] = [];
			for (const [uid, des] of Object.entries(live)) {
				const entry = netlist[uid];
				if (!entry) missing.push(des);
				else if (entry.designator !== des) renamed.push({ uniqueId: uid, netlistDesignator: entry.designator, liveDesignator: des });
			}
			return { renamed, missing };
		};
		let stale = findStale();
		let refreshed = false;
		if ((stale.renamed.length || stale.missing.length) && params.refreshNetlist === true) {
			await eda.sch_Document.save();
			refreshed = true;
			[netlist, allComponents] = await Promise.all([
				fetchParsedNetlist(),
				(eda.sch_PrimitiveComponent as any).getAll('part', true).catch(() => []),
			]);
			stale = findStale();
		}
		for (const r of stale.renamed) netlist[r.uniqueId].designator = r.liveDesignator;
		const staleness = stale.renamed.length || stale.missing.length
			? {
				renamed: stale.renamed,
				notInNetlist: stale.missing,
				warning: `The netlist lags the live editor${refreshed ? ' even after saving' : ''}: ${stale.renamed.length} part(s) renamed and ${stale.missing.length} part(s) missing since the last save. Designators below are live, but pin connections for these parts reflect the last saved state.${refreshed ? '' : ' Pass refreshNetlist:true (saves the schematic) for fresh connectivity.'}`,
			}
			: undefined;

		// 2. Build uniqueId → primitiveId map (active page only — used for
		// pin-name fetching). The netlist itself is project-wide.
		const uniqueToPrimitive: Record<string, string> = {};
		if (Array.isArray(allComponents)) {
			for (const comp of allComponents) {
				const c = comp as any;
				const uid = c.getState_UniqueId?.() ?? c.uniqueId;
				const pid = c.getState_PrimitiveId?.() ?? c.primitiveId;
				if (uid && pid) uniqueToPrimitive[uid] = pid;
			}
		}

		// 2b. If depth > 1 and designators specified, expand designator set by BFS through $-prefixed nets
		if (designatorFilter && depth > 1) {
			const netToDesignators: Record<string, Set<string>> = {};
			const designatorToDollarNets: Record<string, Set<string>> = {};

			for (const [, entry] of Object.entries(netlist)) {
				for (const [, netName] of Object.entries(entry.pins)) {
					if (!netName) continue;
					if (!netToDesignators[netName]) netToDesignators[netName] = new Set();
					netToDesignators[netName].add(entry.designator);
					if (netName.startsWith('$')) {
						if (!designatorToDollarNets[entry.designator]) designatorToDollarNets[entry.designator] = new Set();
						designatorToDollarNets[entry.designator].add(netName);
					}
				}
			}

			let frontier = new Set(designatorFilter);
			for (let hop = 1; hop < depth; hop++) {
				const nextFrontier = new Set<string>();
				for (const des of frontier) {
					const dollarNets = designatorToDollarNets[des];
					if (!dollarNets) continue;
					for (const net of dollarNets) {
						const neighbors = netToDesignators[net];
						if (!neighbors) continue;
						for (const neighbor of neighbors) {
							if (!designatorFilter.has(neighbor)) {
								nextFrontier.add(neighbor);
								designatorFilter.add(neighbor);
							}
						}
					}
				}
				if (nextFrontier.size === 0) break;
				frontier = nextFrontier;
			}
		}

		// 3. Fetch pin names for active-page components with bounded
		// concurrency. Unbounded Promise.all of fetchPinNames over a 500-
		// component netlist used to saturate EasyEDA's runtime.
		const pinNamesMap: Record<string, Record<string, string>> = {}; // uniqueId → pinNumber → pinName
		const fetchTargets: Array<{ uniqueId: string; primitiveId: string }> = [];
		for (const uniqueId of Object.keys(netlist)) {
			const primitiveId = uniqueToPrimitive[uniqueId];
			if (!primitiveId) continue;
			fetchTargets.push({ uniqueId, primitiveId });
		}
		await mapWithConcurrency(fetchTargets, SCH_FETCH_CONCURRENCY, async ({ uniqueId, primitiveId }) => {
			try { pinNamesMap[uniqueId] = await fetchPinNames(primitiveId); }
			catch { /* best-effort */ }
		});

		// 4. Build a complete nets view from EVERY component in the netlist.
		// We need ALL pins on a net to give an honest "what touches this
		// net?" answer — even when a designator filter is in play, the
		// caller wants to see what U3's GND pin is connected to, not just
		// "U3.11 is on GND".
		const netsView: Record<string, string[]> = {};
		// Track auto-named ($-prefixed) nets and the most informative
		// pin-name they touch so we can surface them as e.g. "$1N2856 (FB@U1)".
		const dollarAliases: Record<string, string> = {};
		for (const [uniqueId, entry] of Object.entries(netlist)) {
			const pinNames = pinNamesMap[uniqueId] || {};
			for (const [pinNumber, netName] of Object.entries(entry.pins)) {
				if (!netName) continue;
				const pinName = pinNames[pinNumber] || '';
				if (netName.startsWith('$')) {
					// Capture the first useful function-pin name for this $-net.
					if (!dollarAliases[netName] && pinName && /^[A-Z]/.test(pinName) && !/^\d+$/.test(pinName)) {
						dollarAliases[netName] = `${pinName}@${entry.designator}`;
					}
					continue;
				}
				if (!netsView[netName]) netsView[netName] = [];
				const label = pinName
					? `${entry.designator}.${pinNumber}(${pinName})`
					: `${entry.designator}.${pinNumber}`;
				netsView[netName].push(label);
			}
		}

		// 5. Build components view, applying designator/net filter. The
		// per-pin `net` field is post-processed to inline the $-net alias
		// (e.g. "$1N2856 (FB@U1)") so an agent reading a component's pin
		// list immediately knows what role each unlabeled net plays.
		const aliasedNet = (n: string) =>
			n && n.startsWith('$') && dollarAliases[n] ? `${n} (${dollarAliases[n]})` : n;
		const componentsView: Record<string, { part: string; pins: Record<string, { name: string; net: string; via?: string }>; source?: string }> = {};
		for (const [uniqueId, entry] of Object.entries(netlist)) {
			if (designatorFilter && !designatorFilter.has(entry.designator)) continue;

			const pinNames = pinNamesMap[uniqueId] || {};
			const compPins: Record<string, { name: string; net: string }> = {};
			let hasMatchingNet = false;
			for (const [pinNumber, netName] of Object.entries(entry.pins)) {
				if (netFilter && netName && netFilter.has(netName)) hasMatchingNet = true;
				compPins[pinNumber] = { name: pinNames[pinNumber] || '', net: aliasedNet(netName) };
			}
			if (netFilter && !hasMatchingNet) continue;
			componentsView[entry.designator] = { part: entry.part, pins: compPins };
		}

		// 5b. Live parts the netlist does not know (added/renamed since the last
		// save, or a netlist that lost them): compute pin nets from live
		// geometry — pins on wires, wires named directly or by a net flag/port
		// on one of their vertices — and mark them source:"geometry".
		const geometryParts: string[] = [];
		{
			const renamedIds = new Set(stale.renamed.map((r) => r.uniqueId));
			const targets: Array<{ des: string; pid: string; part: string }> = [];
			for (const comp of Array.isArray(allComponents) ? allComponents : []) {
				const c = comp as any;
				const uid = c.getState_UniqueId?.() ?? c.uniqueId;
				const des = c.getState_Designator?.() ?? c.designator;
				const pid = c.getState_PrimitiveId?.() ?? c.primitiveId;
				if (!des || !pid) continue;
				if (designatorFilter && !designatorFilter.has(des)) continue;
				const entry = uid ? netlist[uid] : undefined;
				const allEmpty = !!entry && Object.values(entry.pins).every((n) => !n);
				if (!entry || renamedIds.has(uid) || allEmpty) targets.push({ des, pid, part: c.getState_Name?.() ?? entry?.part ?? '' });
			}
			if (targets.length) {
				let wires: GeoWire[] = [];
				try {
					wires = ((await eda.sch_PrimitiveWire.getAll()) ?? []).map((w: any) => ({ line: w.getState_Line?.() ?? w.line, net: w.getState_Net?.() ?? w.net }));
				} catch { /* no wires readable */ }
				let labels: GeoLabel[] = [];
				try {
					const src = await eda.sys_FileManager.getDocumentSource();
					const ySign = await componentYSign();
					labels = parseSchNetSymbols(String(src ?? '')).filter((r) => r.name).map((r) => ({ x: r.x, y: ySign * r.y, net: r.name as string }));
				} catch { /* flags/ports unavailable */ }
				for (const t of targets) {
					let pins: GeoPin[] = [];
					try {
						pins = ((await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(t.pid)) ?? []).map((p: any) => ({
							number: String(p.getState_PinNumber?.() ?? p.pinNumber),
							name: p.getState_PinName?.() ?? p.pinName,
							x: Number(p.getState_X?.() ?? p.x),
							y: Number(p.getState_Y?.() ?? p.y),
						}));
					} catch { continue; }
					const geo = pinNetsFromGeometry(pins, wires, labels);
					let matchesNet = !netFilter;
					for (const [num, pin] of Object.entries(geo)) {
						if (!pin.net || pin.net === '(unnamed wire)') continue;
						if (netFilter?.has(pin.net)) matchesNet = true;
						const label = pin.name ? `${t.des}.${num}(${pin.name})` : `${t.des}.${num}`;
						const list = (netsView[pin.net] ??= []);
						if (!list.some((l) => l.startsWith(`${t.des}.${num}`))) list.push(label);
					}
					if (!matchesNet) continue;
					componentsView[t.des] = { part: t.part, pins: geo, source: 'geometry' };
					geometryParts.push(t.des);
				}
			}
		}

		// 6. Filter the nets view.
		let filteredNets = netsView;
		if (netFilter) {
			filteredNets = {};
			for (const netName of netFilter) {
				if (netsView[netName]) filteredNets[netName] = netsView[netName];
			}
		}
		if (designatorFilter && !netFilter) {
			// Keep only nets that any of the filtered designators touch — but
			// each net entry still includes every pin on the net (so the
			// caller can see what U3 connects to, not just U3's pins).
			const relevant: Record<string, string[]> = {};
			for (const [netName, connections] of Object.entries(filteredNets)) {
				if (connections.some((c) => designatorFilter!.has(c.split('.')[0]))) {
					relevant[netName] = connections;
				}
			}
			filteredNets = relevant;
		}

		const geometry = geometryParts.length
			? { parts: geometryParts, note: 'These parts are missing or stale in the netlist; their pin nets were computed from live wires and net flags/ports (source:"geometry").' }
			: undefined;
		return staleness || refreshed || geometry
			? { nets: filteredNets, components: componentsView, netlistRefreshed: refreshed || undefined, staleness, geometry }
			: { nets: filteredNets, components: componentsView };
	},
};

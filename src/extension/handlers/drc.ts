import { flattenState, flattenStateArray, mapWithConcurrency } from './_utils';
import { normalizePadShapeUnits } from './trace-obstacles';
import { componentPinScale } from './pin-units';
import { extractDrcOffenders } from '../../shared/drc-offenders';

// Shared with the MCP process (pcb_run_drc annotation) so both read DRC
// leaves the same way.
export { drcErrorId, extractDrcOffenders } from '../../shared/drc-offenders';
export type { DrcOffenders, DrcPadRef } from '../../shared/drc-offenders';

export const drcHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// === DRC Check ===

	'pcb.drc.check': async (params) => {
		const result = await eda.pcb_Drc.check(params.strict, params.ui, params.verbose);
		return normalizeDrcUnits(result);
	},

	// Run DRC, then group violations by category/net/component and surface
	// the top-N. The DRC payload is a nested {name, list:[...]} tree —
	// flatten to leaf violations (those carrying errorType / errorObjType)
	// before counting so the summary reflects the real violation count.
	'pcb.drc.summarize': async (params) => {
		const result = normalizeDrcUnits(await eda.pcb_Drc.check(true, false, true));
		if (typeof result === 'boolean') return {passed:result,totalViolations:null,groupBy:params?.groupBy || 'category',topGroups:[],note:'Native DRC returned pass/fail only; violation details are unavailable.'};
		if (!Array.isArray(result)) throw new Error('Unexpected native DRC result; cannot determine pass/fail.');
		const violations = flattenDrcTree(result);

		const top = Number(params?.top) > 0 ? Number(params.top) : 25;
		const groupBy: 'category' | 'net' | 'component' = params?.groupBy || 'category';
		const includeSamples = params?.includeSamples !== false;

		// primitiveIds = the offending copper/pads (act on these); offenderIds =
		// collectIds() output, i.e. DRC error ids like "err397" (kept for
		// backward compatibility — they do not map back to primitives).
		type Counter = Map<string, { count: number; samples: any[]; primitiveIds: Set<string>; offenderIds: Set<string> }>;
		const counters: Counter = new Map();

		for (const v of violations) {
			const key = pickGroupKey(v, groupBy);
			const entry = counters.get(key) || { count: 0, samples: [], primitiveIds: new Set(), offenderIds: new Set() };
			entry.count += 1;
			if (entry.samples.length < 3) entry.samples.push(extractOffender(v));
			for (const id of extractDrcOffenders(v).primitiveIds) entry.primitiveIds.add(id);
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

	// Detailed, repair-oriented DRC feed. Native EasyEDA DRC leaves often omit
	// coordinates, so resolve offender IDs/suffixes against the live PCB
	// primitives and return at least one actionable location when possible.
	'pcb.drc.violationsDetailed': async (params) => {
		const strict = params?.strict !== false;
		const ui = params?.ui === true;
		const maxViolations = Math.max(1, Math.floor(Number(params?.maxViolations ?? params?.limit ?? 200)));
		const includeRaw = params?.includeRaw === true;
		const resolveLocations = params?.resolveLocations !== false;

		const result = normalizeDrcUnits(await eda.pcb_Drc.check(strict, ui, true));
		const violations = flattenDrcTree(result);
		const primitiveIndex = resolveLocations ? await buildDrcPrimitiveIndex(params) : new Map<string, ResolvedPrimitive>();

		const detailed = violations.slice(0, maxViolations).map((violation, index) =>
			enrichDrcViolation(violation, index, primitiveIndex, includeRaw),
		);

		return {
			units: 'mil',
			totalViolations: violations.length,
			returned: detailed.length,
			truncated: violations.length > detailed.length,
			locationResolution: resolveLocations
				? {
					indexedPrimitiveCount: primitiveIndex.size,
					note: 'When EasyEDA omitted coordinates, offender IDs/suffixes were resolved against current tracks, vias, pads, components, pours, and regions.',
				}
				: { skipped: true },
			violations: detailed,
		};
	},

	// === Rule Configuration ===

	'pcb.drc.getCurrentRuleConfigName': async () => {
		return eda.pcb_Drc.getCurrentRuleConfigurationName();
	},

	'pcb.drc.getRuleConfiguration': async () => {
		return eda.pcb_Drc.getCurrentRuleConfiguration();
	},

	'pcb.drc.getRuleConfigByName': async (params) => {
		return eda.pcb_Drc.getRuleConfiguration(params.configurationName);
	},

	'pcb.drc.getAllRuleConfigs': async (params) => {
		return eda.pcb_Drc.getAllRuleConfigurations(params.includeSystem);
	},

	'pcb.drc.saveRuleConfig': async (params) => {
		return eda.pcb_Drc.saveRuleConfiguration(
			params.ruleConfiguration,
			params.configurationName,
			params.allowOverwrite,
		);
	},

	'pcb.drc.renameRuleConfig': async (params) => {
		return eda.pcb_Drc.renameRuleConfiguration(params.originalName, params.newName);
	},

	'pcb.drc.deleteRuleConfig': async (params) => {
		return eda.pcb_Drc.deleteRuleConfiguration(params.configurationName);
	},

	'pcb.drc.getDefaultRuleConfigName': async () => {
		return eda.pcb_Drc.getDefaultRuleConfigurationName();
	},

	'pcb.drc.setAsDefaultRuleConfig': async (params) => {
		return eda.pcb_Drc.setAsDefaultRuleConfiguration(params.configurationName);
	},

	// === Net Rules ===

	'pcb.drc.getNetRules': async () => {
		return eda.pcb_Drc.getNetRules();
	},

	'pcb.drc.overwriteNetRules': async (params) => {
		return eda.pcb_Drc.overwriteNetRules(params.netRules);
	},

	'pcb.drc.getNetByNetRules': async () => {
		return eda.pcb_Drc.getNetByNetRules();
	},

	'pcb.drc.overwriteNetByNetRules': async (params) => {
		return eda.pcb_Drc.overwriteNetByNetRules(params.netByNetRules);
	},

	'pcb.drc.getRegionRules': async () => {
		return eda.pcb_Drc.getRegionRules();
	},

	'pcb.drc.overwriteRegionRules': async (params) => {
		return eda.pcb_Drc.overwriteRegionRules(params.regionRules);
	},

	// === Net Class ===

	'pcb.drc.getAllNetClasses': async () => {
		return eda.pcb_Drc.getAllNetClasses();
	},

	'pcb.drc.createNetClass': async (params) => {
		return eda.pcb_Drc.createNetClass(params.netClassName, params.nets, params.color);
	},

	'pcb.drc.deleteNetClass': async (params) => {
		return eda.pcb_Drc.deleteNetClass(params.netClassName);
	},

	'pcb.drc.modifyNetClassName': async (params) => {
		return eda.pcb_Drc.modifyNetClassName(params.originalName, params.newName);
	},

	'pcb.drc.addNetToNetClass': async (params) => {
		return eda.pcb_Drc.addNetToNetClass(params.netClassName, params.net);
	},

	'pcb.drc.removeNetFromNetClass': async (params) => {
		return eda.pcb_Drc.removeNetFromNetClass(params.netClassName, params.net);
	},

	// === Differential Pair ===

	'pcb.drc.getDiffPairs': async () => {
		return eda.pcb_Drc.getAllDifferentialPairs();
	},

	'pcb.drc.createDiffPair': async (params) => {
		return eda.pcb_Drc.createDifferentialPair(params.name, params.positiveNet, params.negativeNet);
	},

	'pcb.drc.deleteDiffPair': async (params) => {
		return eda.pcb_Drc.deleteDifferentialPair(params.name);
	},

	'pcb.drc.modifyDiffPairName': async (params) => {
		return eda.pcb_Drc.modifyDifferentialPairName(params.originalName, params.newName);
	},

	'pcb.drc.modifyDiffPairPositiveNet': async (params) => {
		return eda.pcb_Drc.modifyDifferentialPairPositiveNet(params.name, params.positiveNet);
	},

	'pcb.drc.modifyDiffPairNegativeNet': async (params) => {
		return eda.pcb_Drc.modifyDifferentialPairNegativeNet(params.name, params.negativeNet);
	},

	// === Equal Length Net Group ===

	'pcb.drc.getEqualLengthGroups': async () => {
		return eda.pcb_Drc.getAllEqualLengthNetGroups();
	},

	'pcb.drc.createEqualLengthGroup': async (params) => {
		return eda.pcb_Drc.createEqualLengthNetGroup(params.name, params.nets, params.color);
	},

	'pcb.drc.deleteEqualLengthGroup': async (params) => {
		return eda.pcb_Drc.deleteEqualLengthNetGroup(params.name);
	},

	'pcb.drc.modifyEqualLengthGroupName': async (params) => {
		return eda.pcb_Drc.modifyEqualLengthNetGroupName(params.originalName, params.newName);
	},

	'pcb.drc.addNetToEqualLengthGroup': async (params) => {
		return eda.pcb_Drc.addNetToEqualLengthNetGroup(params.name, params.net);
	},

	'pcb.drc.removeNetFromEqualLengthGroup': async (params) => {
		return eda.pcb_Drc.removeNetFromEqualLengthNetGroup(params.name, params.net);
	},

	// === Pad Pair Group ===

	'pcb.drc.createPadPairGroup': async (params) => {
		return eda.pcb_Drc.createPadPairGroup(params.name, params.padPairs);
	},

	'pcb.drc.deletePadPairGroup': async (params) => {
		return eda.pcb_Drc.deletePadPairGroup(params.name);
	},

	'pcb.drc.modifyPadPairGroupName': async (params) => {
		return eda.pcb_Drc.modifyPadPairGroupName(params.originalName, params.newName);
	},
};

// EasyEDA returns a tree like:
//   [
//     {name:"Differential Pair Error", list:[
//       {name:"Track to Track", list:[
//         {errorType, errorObjType, ruleName, obj1, obj2, objs, pos, globalIndex, explanation, ...}
//         ...
//       ]}
//     ]}
//   ]
// We want the leaf violation objects (those carrying errorType). Recurse.
export function flattenDrcTree(node: any): any[] {
	const out: any[] = [];
	const walk = (n: any) => {
		if (!n) return;
		if (Array.isArray(n)) { for (const x of n) walk(x); return; }
		if (typeof n !== 'object') return;
		const isLeaf = !!(n.errorType && !Array.isArray(n.list));
		if (isLeaf) { out.push(n); return; }
		if (Array.isArray(n.list)) for (const child of n.list) walk(child);
	};
	walk(node);
	return out;
}

export function pickGroupKey(v: any, groupBy: 'category' | 'net' | 'component'): string {
	if (!v || typeof v !== 'object') return 'unknown';
	const objs: string[] | undefined = Array.isArray(v.objs) ? v.objs : undefined;
	switch (groupBy) {
		case 'net':
			return String(v.net || v.netName || v.net1 || objs?.[0] || 'unknown-net');
		case 'component': {
			const refs = extractComponentRefs(v);
			if (refs.length === 0) return 'unknown-component';
			if (refs.length === 1) return refs[0];
			return refs.slice(0, 2).join(' + ');
		}
		case 'category':
		default:
			// Combine errorType + errorObjType for crisper buckets like
			// "Differential Pair Error / Track to Track" instead of just
			// "Differential Pair Error".
			const cat = v.errorType || v.category || v.ruleType || v.rule || v.type || 'unknown';
			const sub = v.errorObjType || v.ruleTypeName;
			return sub && sub !== cat ? `${cat} / ${sub}` : String(cat);
	}
}

export function extractComponentRefs(v: any): string[] {
	return extractDrcOffenders(v).componentRefs;
}

// Recursively collect anything that looks like a primitive / violation ID.
// EasyEDA's DRC payload uses several different field names: `primitiveId`,
// `primitiveIds`, `objIds`, `itemId`, `globalIndex` (e.g. "err2"), etc.
//
// Guards against infinite recursion in two ways: depth limit AND a visited
// set. The visited set is the load-bearing one — EasyEDA occasionally hands
// us object graphs with back-references (a violation referring to its own
// container, e.g. `obj1.parentList`) that depth alone wouldn't catch in time.
export function collectIds(v: any): string[] {
	const ids = new Set<string>();
	if (!v || typeof v !== 'object') return [];

	const isIdKey = (key: string): boolean =>
		/id$|ids$|index$|indexes$|errId/i.test(key);

	const isIdLike = (s: any): boolean => {
		if (typeof s !== 'string' || s.length < 3) return false;
		if (!/^[A-Za-z0-9_-]+$/.test(s)) return false;
		// Either has a digit (e10, err2, gge27) or is long enough to be a hash.
		return /\d/.test(s) || s.length >= 16;
	};

	const visited = new WeakSet<object>();
	const walk = (node: any, depth: number): void => {
		if (!node || depth > 4) return;
		if (typeof node === 'object') {
			if (visited.has(node)) return;
			visited.add(node);
		}
		if (Array.isArray(node)) {
			for (const item of node) walk(item, depth + 1);
			return;
		}
		if (typeof node !== 'object') return;
		for (const [key, value] of Object.entries(node)) {
			if (typeof value === 'string' && isIdKey(key) && isIdLike(value)) ids.add(value);
			else if (Array.isArray(value) && isIdKey(key)) {
				for (const item of value) if (isIdLike(item)) ids.add(item as string);
			} else if (typeof value === 'object') {
				walk(value, depth + 1);
			}
		}
	};
	walk(v, 0);
	return Array.from(ids);
}

// Compact, structured offender info for inclusion in DRC summary samples.
// Keeps anything that looks useful for repair (offending IDs, coordinates,
// measured values) and drops huge nested payloads.
export function extractOffender(v: any): any {
	if (!v || typeof v !== 'object') return v;
	const out: Record<string, any> = {};
	const keep = [
		'errorType', 'errorObjType', 'category', 'ruleType', 'rule', 'ruleName', 'ruleTypeName',
		'message', 'errorMessage', 'description',
		'net', 'netName', 'net1', 'net2', 'objs',
		'component', 'designator', 'refDes',
		'value', 'measured', 'minClearance', 'minimum', 'expected',
		'left', 'right', 'top', 'bottom',
		'layer', 'globalIndex', 'globalIndexIsNet',
	];
	for (const k of keep) if (k in v) out[k] = (v as any)[k];
	if (v.pos && typeof v.pos === 'object') out.pos = { x: v.pos.x, y: v.pos.y };
	if (v.obj1 || v.obj2) out.between = { obj1: simpleObj(v.obj1), obj2: simpleObj(v.obj2) };
	const rendered = renderExplanation(v.explanation);
	if (rendered) out.message = rendered;
	const offenders = extractDrcOffenders(v);
	if (offenders.errorId) out.errorId = offenders.errorId;
	if (offenders.primitiveIds.length > 0) out.primitiveIds = offenders.primitiveIds;
	// Back-compat: collectIds() — mostly the DRC error id ("err397").
	const ids = collectIds(v);
	if (ids.length > 0) out.offenderIds = ids;
	if (offenders.componentRefs.length > 0) out.componentRefs = offenders.componentRefs;
	if (offenders.pads.length > 0) out.pads = offenders.pads;
	return out;
}

function simpleObj(o: any): any {
	if (!o || typeof o !== 'object') return o;
	const out: Record<string, any> = {};
	if (o.suffix) out.suffix = o.suffix;
	if (o.typeName) out.type = o.typeName;
	if (o.id || o.primitiveId) out.id = o.id ?? o.primitiveId;
	return out;
}

// Render explanation.str templates like
//   "Object 1 to object 2 length tolerance is {width}, should be {shouldBe}"
// with their `param` substitutions.
function renderExplanation(e: any): string | undefined {
	if (!e || typeof e !== 'object') return undefined;
	const str = String(e.str ?? '');
	const param = e.param ?? {};
	if (!str) return undefined;
	return str.replace(/\{(\w+)\}/g, (_, k) => (k in param ? String(param[k]) : `{${k}}`));
}

type DrcBounds = { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
type DrcLocation = { x: number; y: number; bounds?: DrcBounds; layer?: any; net?: string; source: string };
type ResolvedPrimitive = {
	id: string;
	type: string;
	primitiveId?: string;
	reference?: string;
	padNumber?: string;
	net?: string;
	layer?: any;
	location?: DrcLocation;
};

async function buildDrcPrimitiveIndex(params: Record<string, any>): Promise<Map<string, ResolvedPrimitive>> {
	const index = new Map<string, ResolvedPrimitive>();
	const pinConcurrency = Math.max(1, Math.min(8, Math.floor(Number(params?.pinConcurrency ?? 4))));

	const add = (keys: any[], primitive: Omit<ResolvedPrimitive, 'id'>): void => {
		for (const key of keys) {
			const id = stringOrUndefined(key);
			if (!id) continue;
			if (!index.has(id)) index.set(id, { id, ...primitive });
		}
	};
	const keyFields = (flat: any): string[] => [
		flat?.primitiveId,
		flat?.id,
		flat?.uuid,
		flat?.globalIndex,
		flat?.suffix,
		flat?.name,
	].map((v) => String(v ?? '')).filter(Boolean);

	const [rawLines, rawVias, rawPads, rawPours, rawRegions, rawComponents] = await Promise.all([
		eda.pcb_PrimitiveLine.getAll(undefined, undefined, undefined).catch(() => []),
		eda.pcb_PrimitiveVia.getAll(undefined, undefined).catch(() => []),
		eda.pcb_PrimitivePad.getAll(undefined, undefined, undefined).catch(() => []),
		eda.pcb_PrimitivePour.getAll(undefined, undefined, undefined).catch(() => []),
		(eda as any).pcb_PrimitiveRegion?.getAll?.(undefined, undefined, undefined).catch(() => []) ?? [],
		eda.pcb_PrimitiveComponent.getAll().catch(() => []),
	]);

	for (const line of flattenStateArray(rawLines as any[])) {
		add(keyFields(line), {
			type: 'track',
			primitiveId: stringOrUndefined(firstDefined(line.primitiveId, line.id)),
			net: stringOrUndefined(line.net),
			layer: line.layer,
			location: lineLocation(line, 'track'),
		});
	}
	for (const via of flattenStateArray(rawVias as any[])) {
		add(keyFields(via), {
			type: 'via',
			primitiveId: stringOrUndefined(firstDefined(via.primitiveId, via.id)),
			net: stringOrUndefined(via.net),
			layer: via.layer,
			location: pointLocation(via, 'via'),
		});
	}
	for (const pad of flattenStateArray(rawPads as any[])) {
		add(keyFields(pad), {
			type: 'pad',
			primitiveId: stringOrUndefined(firstDefined(pad.primitiveId, pad.id)),
			padNumber: stringOrUndefined(firstDefined(pad.padNumber, pad.pinNumber, pad.number, pad.name)),
			net: stringOrUndefined(firstDefined(pad.net, pad.netName)),
			layer: pad.layer,
			location: pointLocation(pad, 'pad'),
		});
	}
	for (const pour of flattenStateArray(rawPours as any[])) {
		add(keyFields(pour), {
			type: 'pour',
			primitiveId: stringOrUndefined(firstDefined(pour.primitiveId, pour.id)),
			net: stringOrUndefined(firstDefined(pour.net, pour.netName)),
			layer: pour.layer,
			location: boundsLocation(boundsFromAny(pour), pour, 'pour'),
		});
	}
	for (const region of flattenStateArray(rawRegions as any[])) {
		add(keyFields(region), {
			type: 'region',
			primitiveId: stringOrUndefined(firstDefined(region.primitiveId, region.id)),
			layer: region.layer,
			location: boundsLocation(boundsFromAny(region), region, 'region'),
		});
	}

	const components = flattenStateArray(rawComponents as any[]);
	for (const component of components) {
		const primitiveId = stringOrUndefined(firstDefined(component.primitiveId, component.id));
		const reference = stringOrUndefined(firstDefined(component.designator, component.name, component.reference));
		add([...keyFields(component), reference], {
			type: 'component',
			primitiveId,
			reference,
			layer: component.layer,
			location: pointLocation(component, 'component'),
		});
	}
	const pinScale = await componentPinScale();
	await mapWithConcurrency(components, pinConcurrency, async (component) => {
		const primitiveId = stringOrUndefined(firstDefined(component.primitiveId, component.id));
		if (!primitiveId) return;
		const reference = stringOrUndefined(firstDefined(component.designator, component.name, component.reference));
		const pinsRaw = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId).catch(() => []);
		for (const rawPin of pinsRaw as any[]) {
			const pin = normalizeComponentPinToMil(flattenState(rawPin), pinScale);
			const padNumber = stringOrUndefined(firstDefined(pin.padNumber, pin.pinNumber, pin.number, pin.name));
			const suffix = reference && padNumber ? `${reference}_${padNumber}` : undefined;
			const dotted = reference && padNumber ? `${reference}.${padNumber}` : undefined;
			add([...keyFields(pin), suffix, dotted], {
				type: 'component_pad',
				primitiveId: stringOrUndefined(firstDefined(pin.primitiveId, pin.id)),
				reference,
				padNumber,
				net: stringOrUndefined(firstDefined(pin.net, pin.netName)),
				layer: pin.layer,
				location: pointLocation(pin, 'component_pad'),
			});
		}
	});

	return index;
}

function enrichDrcViolation(v: any, index: number, primitiveIndex: Map<string, ResolvedPrimitive>, includeRaw: boolean): any {
	const offender = extractOffender(v);
	const offenders = extractDrcOffenders(v);
	const lookupKeys = collectDrcLookupKeys(v);
	// Raw suffixes ("(GND): C1_1") never hit the index, which keys pads as
	// "C1_1"/"C1.1" — resolve via the parsed primitive ids and pad labels too.
	const resolveKeys = new Set<string>([
		...offenders.primitiveIds,
		...offenders.pads.flatMap((p) => [`${p.component}_${p.pad}`, `${p.component}.${p.pad}`]),
		...lookupKeys,
	]);
	const resolved = dedupeResolved(Array.from(resolveKeys).map((key) => primitiveIndex.get(key)).filter((x): x is ResolvedPrimitive => !!x));
	const direct = directDrcLocation(v);
	const resolvedLocation = direct ?? resolved.find((r) => r.location)?.location;
	const out: Record<string, any> = {
		index,
		errorId: offenders.errorId,
		primitiveIds: offenders.primitiveIds,
		category: pickGroupKey(v, 'category'),
		fixCategory: suggestDrcFixCategory(v),
		message: offender.message ?? renderExplanation(v.explanation),
		ruleName: v.ruleName ?? v.rule ?? v.ruleTypeName,
		errorType: v.errorType,
		errorObjType: v.errorObjType,
		nets: collectDrcNets(v, resolved),
		componentRefs: offenders.componentRefs,
		pads: offenders.pads.length > 0 ? offenders.pads : undefined,
		// Mixed lookup keys (DRC error id, raw suffixes, primitive ids); prefer primitiveIds.
		offenderIds: lookupKeys,
		location: resolvedLocation,
		locationSource: direct ? 'native_drc' : resolvedLocation ? 'resolved_from_offender_id' : 'unresolved',
		offenders: resolved.map((r) => ({
			id: r.id,
			type: r.type,
			primitiveId: r.primitiveId,
			reference: r.reference,
			padNumber: r.padNumber,
			net: r.net,
			layer: r.layer,
			location: r.location,
		})),
		suggestedFixHint: suggestedFixHint(v),
	};
	if (includeRaw) out.raw = v;
	return out;
}

function collectDrcLookupKeys(v: any): string[] {
	const keys = new Set<string>(collectIds(v));
	const visit = (node: any, depth: number): void => {
		if (!node || depth > 4) return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item, depth + 1);
			return;
		}
		if (typeof node === 'string') {
			const s = stringOrUndefined(node);
			if (s) keys.add(s);
			return;
		}
		if (typeof node !== 'object') return;
		for (const key of ['primitiveId', 'id', 'uuid', 'globalIndex', 'suffix', 'name', 'padName', 'designator', 'refDes']) {
			const s = stringOrUndefined(node[key]);
			if (s) keys.add(s);
		}
		for (const childKey of ['obj1', 'obj2', 'objs', 'objects']) visit(node[childKey], depth + 1);
	};
	visit(v.obj1, 0);
	visit(v.obj2, 0);
	visit(v.objs, 0);
	return Array.from(keys);
}

function collectDrcNets(v: any, resolved: ResolvedPrimitive[]): string[] {
	const nets = new Set<string>();
	for (const key of ['net', 'netName', 'net1', 'net2']) {
		const s = stringOrUndefined(v?.[key]);
		if (s) nets.add(s);
	}
	for (const r of resolved) if (r.net) nets.add(r.net);
	return Array.from(nets);
}

function dedupeResolved(rows: ResolvedPrimitive[]): ResolvedPrimitive[] {
	const seen = new Set<string>();
	const out: ResolvedPrimitive[] = [];
	for (const row of rows) {
		const key = `${row.type}|${row.primitiveId ?? row.id}|${row.reference ?? ''}|${row.padNumber ?? ''}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(row);
	}
	return out;
}

function directDrcLocation(v: any): DrcLocation | undefined {
	const pos = v?.pos && typeof v.pos === 'object' ? pointFrom(v.pos) : undefined;
	if (pos) return { ...pos, layer: v.layer, net: stringOrUndefined(v.net ?? v.netName), source: 'drc.pos' };
	const point = pointFrom(v);
	if (point) return { ...point, layer: v.layer, net: stringOrUndefined(v.net ?? v.netName), source: 'drc.xy' };
	return boundsLocation(boundsFromAny(v), v, 'drc.bounds');
}

function lineLocation(line: any, source: string): DrcLocation | undefined {
	const startX = Number(line.startX);
	const startY = Number(line.startY);
	const endX = Number(line.endX);
	const endY = Number(line.endY);
	if (![startX, startY, endX, endY].every(Number.isFinite)) return undefined;
	const bounds = normalizeBounds(startX, startY, endX, endY);
	return {
		x: (startX + endX) / 2,
		y: (startY + endY) / 2,
		bounds,
		layer: line.layer,
		net: stringOrUndefined(line.net),
		source,
	};
}

function pointLocation(value: any, source: string): DrcLocation | undefined {
	const p = pointFrom(value);
	if (!p) return undefined;
	return {
		...p,
		layer: value.layer,
		net: stringOrUndefined(value.net ?? value.netName),
		source,
	};
}

function boundsLocation(bounds: DrcBounds | undefined, value: any, source: string): DrcLocation | undefined {
	if (!bounds) return undefined;
	return {
		x: (bounds.minX + bounds.maxX) / 2,
		y: (bounds.minY + bounds.maxY) / 2,
		bounds,
		layer: value?.layer,
		net: stringOrUndefined(value?.net ?? value?.netName),
		source,
	};
}

function pointFrom(value: any): { x: number; y: number } | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const x = firstFinite(value.x, value.centerX);
	const y = firstFinite(value.y, value.centerY);
	return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function boundsFromAny(value: any): DrcBounds | undefined {
	if (!value || typeof value !== 'object') return undefined;
	if ([value.minX, value.minY, value.maxX, value.maxY].every((n) => Number.isFinite(Number(n)))) {
		return normalizeBounds(Number(value.minX), Number(value.minY), Number(value.maxX), Number(value.maxY));
	}
	if ([value.left, value.top, value.right, value.bottom].every((n) => Number.isFinite(Number(n)))) {
		return normalizeBounds(Number(value.left), Number(value.top), Number(value.right), Number(value.bottom));
	}
	if (value.bounds) return boundsFromAny(value.bounds);
	if (value.summary?.bbox) return boundsFromAny(value.summary.bbox);
	return undefined;
}

function normalizeBounds(x1: number, y1: number, x2: number, y2: number): DrcBounds {
	const minX = Math.min(x1, x2);
	const maxX = Math.max(x1, x2);
	const minY = Math.min(y1, y2);
	const maxY = Math.max(y1, y2);
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function normalizeComponentPinToMil(pin: any, pinScale: number): any {
	if (!pin || typeof pin !== 'object') return pin;
	const out: Record<string, any> = { ...pin };
	for (const key of ['x', 'y', 'centerX', 'centerY', 'startX', 'startY', 'endX', 'endY']) {
		if (typeof out[key] === 'number' && Number.isFinite(out[key])) out[key] = out[key] * pinScale;
	}
	normalizePadShapeUnits(out);
	return out;
}

function suggestDrcFixCategory(v: any): string {
	const hay = `${v?.errorType ?? ''} ${v?.errorObjType ?? ''} ${v?.ruleName ?? ''} ${renderExplanation(v?.explanation) ?? ''}`.toLowerCase();
	if (/clearance|spacing|collision|short|track to track|pad to/.test(hay)) return 'clearance_or_short';
	if (/unrouted|ratline|not connected|connect/.test(hay)) return 'route_missing_connection';
	if (/width|track width|line width/.test(hay)) return 'adjust_trace_width';
	if (/via|hole|drill/.test(hay)) return 'adjust_via_or_drill';
	if (/silk|text|legend/.test(hay)) return 'silkscreen_cleanup';
	if (/outline|board edge|edge clearance|outside/.test(hay)) return 'board_outline_or_edge_clearance';
	if (/differential|diff|length|skew/.test(hay)) return 'length_or_diffpair_tuning';
	if (/copper|pour|island|solder mask|mask/.test(hay)) return 'copper_pour_or_mask_cleanup';
	return 'inspect_violation';
}

function suggestedFixHint(v: any): string {
	switch (suggestDrcFixCategory(v)) {
		case 'clearance_or_short':
			return 'Move/reroute one offender, widen the local corridor, or rip up the lower-priority net and reroute with clearance.';
		case 'route_missing_connection':
			return 'Route the named net between the unresolved pads, then rerun connectivity and DRC.';
		case 'adjust_trace_width':
			return 'Apply the active net rule width or change the offending track width, then rerun DRC.';
		case 'adjust_via_or_drill':
			return 'Resize or move the via/drill, checking clearance on every spanned copper layer.';
		case 'length_or_diffpair_tuning':
			return 'Tune pair spacing/length together; avoid independent single-net fixes unless the pair definition is wrong.';
		default:
			return 'Inspect the returned location/offenders and apply the rule-specific correction before rerunning DRC.';
	}
}

function firstDefined(...values: any[]): any {
	for (const value of values) if (value !== undefined && value !== null) return value;
	return undefined;
}

function firstFinite(...values: any[]): number {
	for (const value of values) {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return Number.NaN;
}

function stringOrUndefined(value: any): string | undefined {
	if (value === undefined || value === null) return undefined;
	const s = String(value).trim();
	return s ? s : undefined;
}

export function normalizeDrcUnits<T>(node: T): T {
	// Map original → converted so shared subtrees return the converted value
	// on revisits (a plain visited-set would hand back unconverted units).
	const converted = new WeakMap<object, any>();
	const coordKeys = new Set([
		'x', 'y', 'left', 'right', 'top', 'bottom',
		'startX', 'startY', 'endX', 'endY',
		'minX', 'minY', 'maxX', 'maxY',
	]);
	const walk = (value: any): any => {
		if (!value || typeof value !== 'object') return value;
		if (converted.has(value)) return converted.get(value);
		if (Array.isArray(value)) {
			const outArr: any[] = [];
			converted.set(value, outArr);
			for (const item of value) outArr.push(walk(item));
			return outArr;
		}
		const out: Record<string, any> = {};
		converted.set(value, out);
		for (const [key, v] of Object.entries(value)) {
			// Unverified on EasyEDA 3.x, where component-pin coordinates moved from
			// 10-mil to mil (pin-units.ts); re-check against a located violation.
			if (coordKeys.has(key) && typeof v === 'number' && Number.isFinite(v)) out[key] = v * 10;
			else out[key] = walk(v);
		}
		if (
			'errorType' in value ||
			'errorObjType' in value ||
			'pos' in value ||
			'left' in value ||
			'right' in value ||
			'top' in value ||
			'bottom' in value
		) {
			out.units = 'mil';
			out.sourceUnits = 'EasyEDA DRC units (10 mil); normalized by MCP';
		}
		return out;
	};
	return walk(node);
}

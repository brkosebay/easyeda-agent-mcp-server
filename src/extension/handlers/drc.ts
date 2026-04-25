export const drcHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// === DRC Check ===

	'pcb.drc.check': async (params) => {
		return eda.pcb_Drc.check(params.strict, params.ui, params.verbose);
	},

	// Run DRC, then group violations by category/net/component and surface
	// the top-N. The DRC payload is a nested {name, list:[...]} tree —
	// flatten to leaf violations (those carrying errorType / errorObjType)
	// before counting so the summary reflects the real violation count.
	'pcb.drc.summarize': async (params) => {
		const result = await eda.pcb_Drc.check(true, false, true);
		const violations = flattenDrcTree(result);

		const top = Number(params?.top) > 0 ? Number(params.top) : 25;
		const groupBy: 'category' | 'net' | 'component' = params?.groupBy || 'category';
		const includeSamples = params?.includeSamples !== false;

		type Counter = Map<string, { count: number; samples: any[]; offenderIds: Set<string> }>;
		const counters: Counter = new Map();

		for (const v of violations) {
			const key = pickGroupKey(v, groupBy);
			const entry = counters.get(key) || { count: 0, samples: [], offenderIds: new Set() };
			entry.count += 1;
			if (entry.samples.length < 3) entry.samples.push(extractOffender(v));
			for (const id of collectIds(v)) entry.offenderIds.add(id);
			counters.set(key, entry);
		}

		const groups = Array.from(counters.entries())
			.map(([key, data]) => ({
				key,
				count: data.count,
				offenderIds: Array.from(data.offenderIds).slice(0, 20),
				samples: includeSamples ? data.samples : undefined,
			}))
			.sort((a, b) => b.count - a.count)
			.slice(0, top);

		return {
			totalViolations: violations.length,
			groupBy,
			topGroups: groups,
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
function flattenDrcTree(node: any): any[] {
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

function pickGroupKey(v: any, groupBy: 'category' | 'net' | 'component'): string {
	if (!v || typeof v !== 'object') return 'unknown';
	const objs: string[] | undefined = Array.isArray(v.objs) ? v.objs : undefined;
	switch (groupBy) {
		case 'net':
			return String(v.net || v.netName || v.net1 || objs?.[0] || 'unknown-net');
		case 'component':
			return String(v.component || v.designator || v.refDes || 'unknown-component');
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

// Recursively collect anything that looks like a primitive / violation ID.
// EasyEDA's DRC payload uses several different field names: `primitiveId`,
// `primitiveIds`, `objIds`, `itemId`, `globalIndex` (e.g. "err2"), etc.
function collectIds(v: any): string[] {
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

	const walk = (node: any, depth: number): void => {
		if (!node || depth > 4) return;
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
function extractOffender(v: any): any {
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
	const ids = collectIds(v);
	if (ids.length > 0) out.offenderIds = ids;
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

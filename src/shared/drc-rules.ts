// Pure parsing of EasyEDA Pro DRC rules — no `eda` calls, so both the extension
// (obstacle preflight, grid pathfinder, routing presets) and the MCP server
// (obstacle-map analyzer) share one reading of the rules.
//
// Structure, read from EasyEDA Pro 2.2.47's own pcb.js (the extension RPCs
// "drc-getCurrentRuleConfiguration" / "drc-getNetRules" return these verbatim;
// stored profiles from getRuleConfiguration(name) use `config` instead of `Rule`):
//
//   getCurrentRuleConfiguration() = {
//     Rule: {
//       Spacing: { "Safe Spacing": { [ruleName]: {
//                    editName, unit, isSetDefault,
//                    row: ['Track','SMD Pad','TH Pad','Via','Fill Region/Teardrop',
//                          'Slot Region','Line','Text/Image','Board Outline','Hole'],
//                    column: [...the first 9 of row],
//                    table: number[][]   // lower-triangular, row r has r+1 cells
//                  } },
//                  "Other Spacing": {...} },
//       Physics: { Track: { [ruleName]: { editName, unit, isSetDefault,
//                    form: { strokeWidthMin, strokeWidthDefault, strokeWidthMax } } },
//                  "Via Size": { [ruleName]: { editName, unit, isSetDefault,
//                    form: { viaOuterdiameterMin/Default/Max, viaInnerdiameterMin/Default/Max } } },
//                  "Differential Pair", "Net Length", "Blind/Buried Via" },
//       Plane: {...}, Expansion: {...},
//     },
//     Net: [...same array as getNetRules()...], NetnetList, Region, ...,
//     ruleTemplateName: string,
//   }
//   getNetRules() = [
//     { type: 'netClass', name, 'Safe Spacing': <rule NAME>, Track: <NAME>, 'Via Size': <NAME>, ...,
//       sub: [{ type: 'net', name, 'Safe Spacing': <NAME>, Track: <NAME>, ... }] },
//     { type: 'net', name, 'Safe Spacing': <NAME>, Track: <NAME>, 'Via Size': <NAME>, ... },
//   ]
//
// Units: every value is in its rule's own `unit` ('mil' | 'mm' | 'cm' | 'inch').
// EasyEDA stores 10-mil units internally, scales to mil and converts mil ->
// unit without rounding, so a 6 mil rule reads back as 0.15240000000000001 in
// an "mm" rule (Via Size stores radii: x20 -> diameter in mil, then unit).
// Safe Spacing's track column is column 0: Track-Track = table[0][0],
// SMD Pad-Track = [1][0], TH Pad-Track = [2][0], Via-Track = [3][0].
// A net rule name of "default" (or empty) means "the rule with isSetDefault",
// which is not necessarily called "default" (JLCPCB: "copperThickness1oz").
//
// Spacing between two objects of different nets is EasyEDA's
// max(ruleOf(netA), ruleOf(netB)) per object kind: resolver.between() /
// clearanceBetween(). A net with no net rule — and copper with no net at all —
// is governed by the default (isSetDefault) rule. Only the Track column is read,
// so the routed side of a pair is always a track (true for every caller:
// obstacle preflight, grid pathfinder, pull-tight).
//
// Not modelled (yet): net-to-net rules (NetnetList), region/constraint rules.

export type ClearanceKind = 'track' | 'smdPad' | 'thPad' | 'via';

export type ClearanceRule = {
	/** Track-to-track clearance (mil). Also used for pours, keepouts and any kind missing from byKind. */
	clearanceMil: number;
	/** 'rule:<config>/Safe Spacing/<rule>[ (<net assignment>)]', 'param:clearanceMil' or 'default:6mil (<why>)'. */
	source: string;
	/** Track-to-<kind> clearance (mil) from the same Safe Spacing rule. */
	byKind?: Partial<Record<ClearanceKind, number>>;
};

export type ClearanceSummary = {
	clearanceMil: number;
	clearanceSource: string;
	clearanceByKind?: Partial<Record<ClearanceKind, number>>;
	ruleConfigName?: string;
	/** Safe Spacing rule the base clearance came from, e.g. "copperThickness1oz". */
	ruleName?: string;
	/** Exact path of the value read, e.g. Rule.Spacing["Safe Spacing"]["x"].table[0][0]. */
	ruleKey?: string;
	/** Unit the rule stores its values in (mil | mm | cm | inch). */
	ruleUnit?: string;
	/** The raw number in ruleUnit before conversion to mil. */
	rawValue?: number;
	/** Set whenever the 6-mil default was used instead of a board rule. */
	fallbackReason?: string;
	netRuleCount?: number;
	perNet: Record<string, ClearanceRule>;
};

/** The clearance two objects of (possibly) different nets need, and which net's rule decided it. */
export type ClearanceDecision = {
	/** max(rule of netA, rule of netB) for the object kind, mil. */
	clearanceMil: number;
	/**
	 * The deciding rule's source. When the two nets' rules ask for different
	 * values, it ends with "; larger-of-nets: <winner> <a> mil > <other> <b> mil (<Kind>-Track)".
	 */
	source: string;
	/** Net whose rule decided ('(no net)' for net-less copper); absent for an explicit override. */
	decidingNet?: string;
	/** The deciding rule. */
	rule: ClearanceRule;
};

export type ClearanceResolver = {
	for(net: string | undefined): ClearanceRule;
	/**
	 * Clearance between a track of `netA` and an object of `kind` on `netB`:
	 * the larger of what each net's rule asks for (EasyEDA's DRC semantics).
	 * Ties — including both nets on the same rule — keep netA's rule and its
	 * source unchanged. An undefined net is governed by the default rule.
	 */
	between(netA: string | undefined, netB: string | undefined, kind?: ClearanceKind): ClearanceDecision;
	summary: ClearanceSummary;
};

export type TrackWidthRule = {
	/** The rule's default track width (strokeWidthDefault), mil. */
	widthMil: number;
	minMil?: number;
	maxMil?: number;
	/** 'rule:<config>/Track/<rule>[ (<net assignment>)][ (<note>)]'. */
	source: string;
	ruleName: string;
	ruleKey: string;
	unit: string;
	/** How the net got a non-default rule ('net rule X' | 'net class C -> X'); absent when the board default applies. */
	assignedBy?: string;
};

export type ViaSizeRule = {
	/** Default via outer diameter (viaOuterdiameterDefault), mil. */
	diameterMil: number;
	/** Default via drill (viaInnerdiameterDefault), mil. */
	drillMil: number;
	minDiameterMil?: number;
	maxDiameterMil?: number;
	minDrillMil?: number;
	maxDrillMil?: number;
	/** 'rule:<config>/Via Size/<rule>[ (<net assignment>)][ (<note>)]'. */
	source: string;
	ruleName: string;
	ruleKey: string;
	unit: string;
	/** How the net got a non-default rule; absent when the board default applies. */
	assignedBy?: string;
};

/** A rule value for a net, or why there is none (no config, implausible value, ...). */
export type RuleLookup<T> = { rule: T; reason?: undefined } | { rule?: undefined; reason: string };

export const FALLBACK_CLEARANCE_MIL = 6;
export const RULE_UNIT_TO_MIL: Readonly<Record<string, number>> = { mil: 1, mm: 1 / 0.0254, cm: 1 / 0.00254, inch: 1000 };

type Range = { min: number; max: number };
const PLAUSIBLE_CLEARANCE_MIL: Range = { min: 1, max: 200 };
const PLAUSIBLE_TRACK_WIDTH_MIL: Range = { min: 1, max: 1000 };
const PLAUSIBLE_VIA_DIAMETER_MIL: Range = { min: 2, max: 2000 };
const PLAUSIBLE_VIA_DRILL_MIL: Range = { min: 1, max: 2000 };

const SAFE_SPACING_ROWS = ['Track', 'SMD Pad', 'TH Pad', 'Via', 'Fill Region/Teardrop', 'Slot Region', 'Line', 'Text/Image', 'Board Outline', 'Hole'];
// Pre-split layout (8 rows, one "Pad" row) that EasyEDA's setter still migrates.
const LEGACY_SAFE_SPACING_ROWS = ['Track', 'Pad', 'Via', 'Fill Region/Teardrop', 'Slot Region', 'Line', 'Text/Image', 'Board Outline'];
const CLEARANCE_KIND_ROW_LABELS: Record<ClearanceKind, string[]> = {
	track: ['Track'],
	smdPad: ['SMD Pad', 'Pad'],
	thPad: ['TH Pad', 'Pad'],
	via: ['Via'],
};
const CLEARANCE_KIND_LABEL: Record<ClearanceKind, string> = { track: 'Track', smdPad: 'SMD Pad', thPad: 'TH Pad', via: 'Via' };

type RuleCategory = { section: 'Spacing' | 'Physics'; name: 'Safe Spacing' | 'Track' | 'Via Size' };
const SAFE_SPACING: RuleCategory = { section: 'Spacing', name: 'Safe Spacing' };
const TRACK: RuleCategory = { section: 'Physics', name: 'Track' };
const VIA_SIZE: RuleCategory = { section: 'Physics', name: 'Via Size' };

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/** `value` in `unit` -> mil, or undefined when the value is not a number or the unit is unknown. */
export function ruleValueToMil(value: any, unit: any): number | undefined {
	const n = Number(value);
	const factor = typeof unit === 'string' ? RULE_UNIT_TO_MIL[unit.trim().toLowerCase()] : undefined;
	if (value == null || value === '' || !Number.isFinite(n) || factor == null) return undefined;
	return roundMil(n * factor);
}

/** The configuration's name (`ruleTemplateName` on the live config, `name` on a stored profile). */
export function ruleConfigName(ruleConfig: any): string | undefined {
	return str(firstDefined(ruleConfig?.ruleTemplateName, ruleConfig?.name, ruleConfig?.ruleName));
}

/** Net rows from getNetRules(), falling back to the config's own `Net` array. */
export function netRuleRows(ruleConfig: any, netRules: any): any[] {
	if (Array.isArray(netRules)) return netRules;
	if (Array.isArray(netRules?.netRules)) return netRules.netRules;
	return Array.isArray(ruleConfig?.Net) ? ruleConfig.Net : [];
}

/** Every net named in the net rows (top-level nets and net-class members). */
export function netsWithRules(ruleConfig: any, netRules: any): string[] {
	const out = new Set<string>();
	for (const row of netRuleRows(ruleConfig, netRules)) {
		if (!row || typeof row !== 'object') continue;
		if (Array.isArray(row.sub)) {
			for (const member of row.sub) {
				const name = str(member?.name);
				if (name) out.add(name);
			}
		}
		if (row.type !== 'netClass') {
			const name = str(firstDefined(row.name, row.net, row.netName));
			if (name) out.add(name);
		}
	}
	return Array.from(out);
}

function ruleGroup(ruleConfig: any, category: RuleCategory): { rules: Record<string, any>; path: string } | undefined {
	const candidates: Array<[any, string]> = [
		[ruleConfig?.Rule?.[category.section], `Rule.${category.section}`],
		[ruleConfig?.config?.[category.section], `config.${category.section}`],
		[ruleConfig?.[category.section], category.section],
	];
	for (const [section, path] of candidates) {
		const rules = section?.[category.name];
		if (rules && typeof rules === 'object' && Object.keys(rules).length > 0) return { rules, path: `${path}[${JSON.stringify(category.name)}]` };
	}
	return undefined;
}

/** EasyEDA's getRule(): no name or "default" -> the isSetDefault rule; otherwise by name. */
function pickRule(rules: Record<string, any>, name: string | undefined): { name: string; entry: any; key: string } | undefined {
	const entries = Object.entries(rules).filter(([, entry]) => entry && typeof entry === 'object');
	if (!name || name === 'default') {
		const marked = entries.find(([, entry]) => entry.isSetDefault === true || entry.isDefault === true);
		const picked = marked ?? (entries.length === 1 ? entries[0] : undefined);
		return picked ? { name: String(picked[1].editName ?? picked[0]), entry: picked[1], key: picked[0] } : undefined;
	}
	const picked = entries.find(([key, entry]) => key === name || entry.editName === name);
	return picked ? { name, entry: picked[1], key: picked[0] } : undefined;
}

/** The rule name of `category` assigned to `net` (exact name match; a class member inherits its class's rule). */
function netRuleName(rows: any[], net: string, category: RuleCategory): { ruleName?: string; via: string } | undefined {
	for (const row of rows) {
		if (!row || typeof row !== 'object') continue;
		if (row.type !== 'netClass' && firstDefined(row.name, row.net, row.netName) === net) {
			return { ruleName: str(row[category.name]), via: `net rule ${net}` };
		}
		if (Array.isArray(row.sub)) {
			const member = row.sub.find((s: any) => s && s.name === net);
			if (member) {
				return {
					ruleName: str(firstDefined(member[category.name], row[category.name])),
					via: `net class ${row.name ?? '?'} -> ${net}`,
				};
			}
		}
	}
	return undefined;
}

type Assigned = { group: { rules: Record<string, any>; path: string }; picked: { name: string; entry: any; key: string }; via?: string; note?: string };

/** Which rule of `category` applies to `net`: its net/net-class rule, else the default rule. */
function assignedRule(ruleConfig: any, rows: any[], net: string | undefined, category: RuleCategory): Assigned | { reason: string } {
	if (!ruleConfig || typeof ruleConfig !== 'object') return { reason: 'no DRC rule configuration readable' };
	const group = ruleGroup(ruleConfig, category);
	if (!group) return { reason: `rule configuration has no Rule.${category.section}[${JSON.stringify(category.name)}] rules` };
	const assigned = net ? netRuleName(rows, net, category) : undefined;
	let note: string | undefined;
	if (assigned?.ruleName && assigned.ruleName !== 'default') {
		const picked = pickRule(group.rules, assigned.ruleName);
		if (picked) return { group, picked, via: assigned.via };
		note = `${assigned.via} rule "${assigned.ruleName}" not found; default rule used`;
	}
	const picked = pickRule(group.rules, undefined);
	if (!picked) return { reason: `no ${category.name} rule is marked isSetDefault${note ? `; ${note}` : ''}` };
	return { group, picked, note };
}

function ruleSource(ruleConfig: any, category: RuleCategory, ruleName: string, via?: string, ...notes: Array<string | undefined>): string {
	const extra = notes.filter(Boolean).map((n) => ` (${n})`).join('');
	return `rule:${ruleConfigName(ruleConfig) ?? 'current'}/${category.name}/${ruleName}${via ? ` (${via})` : ''}${extra}`;
}

/** Scale for a rule's unit; an unknown unit is accepted only when `raw` already reads as plausible mil. */
function unitScale(entry: any, key: string, raw: number, range: Range): { factor: number; unit: string; note?: string } | { reason: string } {
	const unitRaw = str(entry?.unit);
	const factor = unitRaw ? RULE_UNIT_TO_MIL[unitRaw.toLowerCase()] : undefined;
	if (factor != null) return { factor, unit: unitRaw! };
	if (raw >= range.min && raw <= range.max) return { factor: 1, unit: unitRaw ?? 'unknown', note: `unit "${unitRaw ?? 'missing'}" unknown, value assumed mil` };
	return { reason: `${key} = ${raw} with unknown unit "${unitRaw ?? ''}" is implausible as mil (outside ${range.min}-${range.max})` };
}

function inRange(mil: number, range: Range): boolean {
	return mil >= range.min && mil <= range.max;
}

function outOfRange(key: string, raw: number, unit: string, mil: number, range: Range): string {
	return `${key} = ${raw} ${unit} = ${mil} mil is outside the plausible ${range.min}-${range.max} mil range`;
}

// ---------------------------------------------------------------------------
// Clearance (Safe Spacing)
// ---------------------------------------------------------------------------

/** Clearance (mil) a routed track needs from an object of `kind`, per the resolved rule. */
export function clearanceForKind(rule: ClearanceRule, kind: ClearanceKind): number {
	const value = rule.byKind?.[kind];
	return typeof value === 'number' && Number.isFinite(value) ? value : rule.clearanceMil;
}

/** params.clearanceMil as an explicit override, or undefined. Number(null) === 0, so null/'' mean "not given". */
export function explicitClearanceMil(params: Record<string, any> | undefined): number | undefined {
	const raw = params?.clearanceMil;
	if (raw == null || raw === '') return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** A resolver that answers `mil` for every net and kind (the clearanceMil override). */
export function explicitClearanceResolver(mil: number): ClearanceResolver {
	return resolverForRule({ clearanceMil: mil, source: 'param:clearanceMil' });
}

/** A resolver that answers one rule for every net and pair (overrides, hand-built rules, tests). */
export function resolverForRule(rule: ClearanceRule): ClearanceResolver {
	return {
		for: () => rule,
		between: (_netA, _netB, kind = 'track') => ({ clearanceMil: clearanceForKind(rule, kind), source: rule.source, rule }),
		summary: { clearanceMil: rule.clearanceMil, clearanceSource: rule.source, ...(rule.byKind ? { clearanceByKind: rule.byKind } : {}), perNet: {} },
	};
}

/**
 * Clearance between a track of `netA` and an object of `kind` on `netB`,
 * from already-fetched rule payloads: max(rule of netA, rule of netB). See
 * ClearanceResolver.between; build one resolver instead when asking many pairs.
 */
export function clearanceBetween(ruleConfig: any, netRules: any, netA: string | undefined, netB: string | undefined, kind: ClearanceKind = 'track'): ClearanceDecision {
	return clearanceResolverFromRules(ruleConfig, netRules, [netA, netB]).between(netA, netB, kind);
}

const NO_NET = '(no net)';

/** resolver.between() over a per-net rule lookup, memoized per (netA, netB, kind) — it runs per grid cell x obstacle. */
function pairwiseClearance(ruleFor: (net: string | undefined) => ClearanceRule): ClearanceResolver['between'] {
	const memo = new Map<string, ClearanceDecision>();
	return (netA, netB, kind = 'track') => {
		const key = `${netA ?? ''}\u0000${netB ?? ''}\u0000${kind}`;
		const cached = memo.get(key);
		if (cached) return cached;
		const ruleA = ruleFor(netA);
		const ruleB = ruleFor(netB);
		const a = clearanceForKind(ruleA, kind);
		const b = clearanceForKind(ruleB, kind);
		const decision: ClearanceDecision = b > a
			? {
				clearanceMil: b,
				source: `${ruleB.source}; larger-of-nets: ${netB ?? NO_NET} ${b} mil > ${netA ?? NO_NET} ${a} mil (${CLEARANCE_KIND_LABEL[kind]}-Track)`,
				decidingNet: netB ?? NO_NET,
				rule: ruleB,
			}
			: { clearanceMil: a, source: ruleA.source, decidingNet: netA ?? NO_NET, rule: ruleA };
		memo.set(key, decision);
		return decision;
	};
}

/**
 * Clearance per net from already-fetched rule payloads. `nets` only decides
 * what summary.perNet pre-reports; resolver.for() works for any net. Falls
 * back to 6 mil, with the reason in the source, when no usable rule exists.
 */
export function clearanceResolverFromRules(ruleConfig: any, netRules: any, nets: Array<string | undefined> = []): ClearanceResolver {
	const name = ruleConfigName(ruleConfig);
	const rows = netRuleRows(ruleConfig, netRules);

	const baseAssigned = assignedRule(ruleConfig, rows, undefined, SAFE_SPACING);
	let baseRead: SafeSpacingRead | undefined;
	let fallbackReason: string | undefined;
	if ('reason' in baseAssigned) fallbackReason = baseAssigned.reason;
	else {
		const read = readSafeSpacingRule(baseAssigned.picked.name, baseAssigned.picked.entry, `${baseAssigned.group.path}[${JSON.stringify(baseAssigned.picked.key)}]`);
		if ('reason' in read) fallbackReason = read.reason;
		else baseRead = read;
	}
	const base: ClearanceRule = baseRead
		? { clearanceMil: baseRead.clearanceMil, source: ruleSource(ruleConfig, SAFE_SPACING, baseRead.ruleName, undefined, baseRead.note), byKind: baseRead.byKind }
		: { clearanceMil: FALLBACK_CLEARANCE_MIL, source: `default:${FALLBACK_CLEARANCE_MIL}mil (${fallbackReason})` };

	// Net-specific rules stay usable even when the default rule is not.
	const group = 'reason' in baseAssigned ? ruleGroup(ruleConfig, SAFE_SPACING) : baseAssigned.group;
	const memo = new Map<string, ClearanceRule>();
	const ruleForNet = (net: string | undefined): ClearanceRule => {
		if (!net || !group) return base;
		const cached = memo.get(net);
		if (cached) return cached;
		let rule = base;
		const assigned = netRuleName(rows, net, SAFE_SPACING);
		if (assigned?.ruleName && assigned.ruleName !== 'default') {
			const picked = pickRule(group.rules, assigned.ruleName);
			const read = picked ? readSafeSpacingRule(picked.name, picked.entry, `${group.path}[${JSON.stringify(picked.key)}]`) : undefined;
			if (read && !('reason' in read)) {
				rule = { clearanceMil: read.clearanceMil, source: ruleSource(ruleConfig, SAFE_SPACING, read.ruleName, assigned.via, read.note), byKind: read.byKind };
			} else {
				// The net names a rule we cannot use; the board default still applies.
				rule = { ...base, source: `${base.source}; ${assigned.via} rule "${assigned.ruleName}" ${read && 'reason' in read ? `unusable: ${read.reason}` : 'not found'}` };
			}
		}
		memo.set(net, rule);
		return rule;
	};

	const perNet: Record<string, ClearanceRule> = {};
	for (const net of new Set(nets.filter((n): n is string => !!n))) perNet[net] = ruleForNet(net);

	return {
		for: ruleForNet,
		between: pairwiseClearance(ruleForNet),
		summary: {
			clearanceMil: base.clearanceMil,
			clearanceSource: base.source,
			...(base.byKind ? { clearanceByKind: base.byKind } : {}),
			ruleConfigName: name,
			...(baseRead ? { ruleName: baseRead.ruleName, ruleKey: baseRead.key, ruleUnit: baseRead.unit, rawValue: baseRead.rawValue } : {}),
			...(fallbackReason ? { fallbackReason } : {}),
			netRuleCount: rows.length > 0 || Array.isArray(netRules) ? rows.length : undefined,
			perNet,
		},
	};
}

/** Clearance for one net (convenience over clearanceResolverFromRules). */
export function clearanceForNet(ruleConfig: any, netRules: any, net: string | undefined): ClearanceRule {
	return clearanceResolverFromRules(ruleConfig, netRules, net ? [net] : []).for(net);
}

type SafeSpacingRead = {
	ruleName: string;
	clearanceMil: number;
	byKind: Partial<Record<ClearanceKind, number>>;
	key: string;
	unit: string;
	rawValue: number;
	note?: string;
};

/** Read the track column of one Safe Spacing rule and convert it to mil, or say why it cannot be used. */
function readSafeSpacingRule(ruleName: string, entry: any, path: string): SafeSpacingRead | { reason: string } {
	const matrix = safeSpacingMatrix(entry);
	if (!matrix) return { reason: `Safe Spacing rule "${ruleName}" has no table` };
	const rows: string[] = Array.isArray(entry.row) && entry.row.length > 0
		? entry.row.map(String)
		: matrix.table.length === LEGACY_SAFE_SPACING_ROWS.length ? LEGACY_SAFE_SPACING_ROWS : SAFE_SPACING_ROWS;
	const columns: string[] = Array.isArray(entry.column) ? entry.column.map(String) : [];
	const trackColumn = columns.includes('Track') ? columns.indexOf('Track') : 0;

	const cell = (kind: ClearanceKind): { raw: number; row: number } | undefined => {
		const row = rows.findIndex((label) => CLEARANCE_KIND_ROW_LABELS[kind].includes(label));
		const raw = row >= 0 ? Number(matrix.table[row]?.[trackColumn]) : Number.NaN;
		return Number.isFinite(raw) ? { raw, row } : undefined;
	};

	const track = cell('track');
	if (!track) return { reason: `Safe Spacing rule "${ruleName}" has no numeric Track-Track cell` };
	const key = `${path}.${matrix.key}[${track.row}][${trackColumn}]`;
	const scale = unitScale(entry, key, track.raw, PLAUSIBLE_CLEARANCE_MIL);
	if ('reason' in scale) return scale;
	const clearanceMil = roundMil(track.raw * scale.factor);
	if (!inRange(clearanceMil, PLAUSIBLE_CLEARANCE_MIL)) return { reason: outOfRange(key, track.raw, scale.unit, clearanceMil, PLAUSIBLE_CLEARANCE_MIL) };

	const byKind: Partial<Record<ClearanceKind, number>> = { track: clearanceMil };
	const dropped: string[] = [];
	for (const kind of ['smdPad', 'thPad', 'via'] as ClearanceKind[]) {
		const c = cell(kind);
		if (!c) continue;
		const mil = roundMil(c.raw * scale.factor);
		if (inRange(mil, PLAUSIBLE_CLEARANCE_MIL)) byKind[kind] = mil;
		else dropped.push(`${CLEARANCE_KIND_LABEL[kind]}-Track=${c.raw}`);
	}
	const note = [scale.note, dropped.length > 0 ? `implausible ${dropped.join(', ')} replaced by Track-Track` : undefined].filter(Boolean).join('; ') || undefined;
	return { ruleName, clearanceMil, byKind, key, unit: scale.unit, rawValue: track.raw, note };
}

/** `table` (2.2.x) or, defensively, the first `tables[*].content` matrix of the newer save format. */
function safeSpacingMatrix(entry: any): { table: any[][]; key: string } | undefined {
	if (Array.isArray(entry?.table) && entry.table.length > 0) return { table: entry.table, key: 'table' };
	const tables = entry?.tables && typeof entry.tables === 'object' ? Object.entries(entry.tables) : [];
	const withContent = tables.filter(([, t]: [string, any]) => Array.isArray(t?.content) && t.content.length > 0) as Array<[string, any]>;
	const picked = withContent.find(([, t]) => !!t.status) ?? withContent[0];
	return picked ? { table: picked[1].content, key: `tables[${JSON.stringify(picked[0])}].content` } : undefined;
}

// ---------------------------------------------------------------------------
// Track width (Physics -> Track)
// ---------------------------------------------------------------------------

/** The Track rule that applies to `net`, in mil, or why there is none. */
export function resolveTrackWidth(ruleConfig: any, netRules: any, net: string | undefined): RuleLookup<TrackWidthRule> {
	const assigned = assignedRule(ruleConfig, netRuleRows(ruleConfig, netRules), net, TRACK);
	if ('reason' in assigned) return assigned;
	const { picked, group } = assigned;
	const form = picked.entry?.form ?? {};
	const key = `${group.path}[${JSON.stringify(picked.key)}].form.strokeWidthDefault`;
	const raw = Number(form.strokeWidthDefault);
	if (form.strokeWidthDefault == null || !Number.isFinite(raw)) return { reason: `Track rule "${picked.name}" has no numeric strokeWidthDefault` };
	const scale = unitScale(picked.entry, key, raw, PLAUSIBLE_TRACK_WIDTH_MIL);
	if ('reason' in scale) return scale;
	const widthMil = roundMil(raw * scale.factor);
	if (!inRange(widthMil, PLAUSIBLE_TRACK_WIDTH_MIL)) return { reason: outOfRange(key, raw, scale.unit, widthMil, PLAUSIBLE_TRACK_WIDTH_MIL) };
	const minMil = positiveMil(form.strokeWidthMin, scale.factor);
	const maxMil = positiveMil(form.strokeWidthMax, scale.factor);
	return {
		rule: {
			widthMil,
			...(minMil != null ? { minMil } : {}),
			...(maxMil != null ? { maxMil } : {}),
			source: ruleSource(ruleConfig, TRACK, picked.name, assigned.via, assigned.note, scale.note),
			ruleName: picked.name,
			ruleKey: key,
			unit: scale.unit,
			...(assigned.via ? { assignedBy: assigned.via } : {}),
		},
	};
}

/** `{ widthMil, minMil, maxMil, source, ... }` for `net`, or undefined when the board has no usable Track rule. */
export function trackWidthForNet(ruleConfig: any, netRules: any, net: string | undefined): TrackWidthRule | undefined {
	return resolveTrackWidth(ruleConfig, netRules, net).rule;
}

// ---------------------------------------------------------------------------
// Via size (Physics -> Via Size)
// ---------------------------------------------------------------------------

/** The Via Size rule that applies to `net`, in mil, or why there is none. */
export function resolveViaSize(ruleConfig: any, netRules: any, net: string | undefined): RuleLookup<ViaSizeRule> {
	const assigned = assignedRule(ruleConfig, netRuleRows(ruleConfig, netRules), net, VIA_SIZE);
	if ('reason' in assigned) return assigned;
	const { picked, group } = assigned;
	const form = picked.entry?.form ?? {};
	const keyBase = `${group.path}[${JSON.stringify(picked.key)}].form`;
	const rawDiameter = Number(form.viaOuterdiameterDefault);
	const rawDrill = Number(form.viaInnerdiameterDefault);
	if (form.viaOuterdiameterDefault == null || !Number.isFinite(rawDiameter) || form.viaInnerdiameterDefault == null || !Number.isFinite(rawDrill)) {
		return { reason: `Via Size rule "${picked.name}" has no numeric viaOuterdiameterDefault/viaInnerdiameterDefault` };
	}
	const scale = unitScale(picked.entry, `${keyBase}.viaOuterdiameterDefault`, rawDiameter, PLAUSIBLE_VIA_DIAMETER_MIL);
	if ('reason' in scale) return scale;
	const diameterMil = roundMil(rawDiameter * scale.factor);
	const drillMil = roundMil(rawDrill * scale.factor);
	if (!inRange(diameterMil, PLAUSIBLE_VIA_DIAMETER_MIL)) return { reason: outOfRange(`${keyBase}.viaOuterdiameterDefault`, rawDiameter, scale.unit, diameterMil, PLAUSIBLE_VIA_DIAMETER_MIL) };
	if (!inRange(drillMil, PLAUSIBLE_VIA_DRILL_MIL)) return { reason: outOfRange(`${keyBase}.viaInnerdiameterDefault`, rawDrill, scale.unit, drillMil, PLAUSIBLE_VIA_DRILL_MIL) };
	if (drillMil >= diameterMil) return { reason: `Via Size rule "${picked.name}" drill ${drillMil} mil is not smaller than its diameter ${diameterMil} mil` };
	const optional = (field: string, name: keyof ViaSizeRule) => {
		const mil = positiveMil(form[field], scale.factor);
		return mil != null ? { [name]: mil } : {};
	};
	return {
		rule: {
			diameterMil,
			drillMil,
			...optional('viaOuterdiameterMin', 'minDiameterMil'),
			...optional('viaOuterdiameterMax', 'maxDiameterMil'),
			...optional('viaInnerdiameterMin', 'minDrillMil'),
			...optional('viaInnerdiameterMax', 'maxDrillMil'),
			source: ruleSource(ruleConfig, VIA_SIZE, picked.name, assigned.via, assigned.note, scale.note),
			ruleName: picked.name,
			ruleKey: `${keyBase}.viaOuterdiameterDefault`,
			unit: scale.unit,
			...(assigned.via ? { assignedBy: assigned.via } : {}),
		},
	};
}

/** `{ diameterMil, drillMil, ..., source }` for `net`, or undefined when the board has no usable Via Size rule. */
export function viaSizeForNet(ruleConfig: any, netRules: any, net: string | undefined): ViaSizeRule | undefined {
	return resolveViaSize(ruleConfig, netRules, net).rule;
}

// ---------------------------------------------------------------------------
// Board outline clearance (Safe Spacing -> "Board Outline" row)
// ---------------------------------------------------------------------------

/** Copper-to-board-edge clearance (Track column of the default Safe Spacing rule's "Board Outline" row), mil. */
export function resolveBoardOutlineClearance(ruleConfig: any): RuleLookup<{ clearanceMil: number; source: string }> {
	return resolveSafeSpacingTrackCell(ruleConfig, 'Board Outline');
}

/**
 * Track column of a row of the default Safe Spacing rule ("Board Outline",
 * "Hole", "Slot Region", ...), mil. These rows are board-wide: EasyEDA applies
 * the default rule's value to every net.
 */
export function resolveSafeSpacingTrackCell(ruleConfig: any, rowLabel: string): RuleLookup<{ clearanceMil: number; source: string }> {
	const group = ruleGroup(ruleConfig, SAFE_SPACING);
	if (!group) return { reason: 'rule configuration has no Safe Spacing rules' };
	const picked = pickRule(group.rules, undefined);
	if (!picked) return { reason: 'no Safe Spacing rule is marked isSetDefault' };
	const matrix = safeSpacingMatrix(picked.entry);
	if (!matrix) return { reason: `Safe Spacing rule "${picked.name}" has no table` };
	const rows: string[] = Array.isArray(picked.entry.row) && picked.entry.row.length > 0
		? picked.entry.row.map(String)
		: matrix.table.length === LEGACY_SAFE_SPACING_ROWS.length ? LEGACY_SAFE_SPACING_ROWS : SAFE_SPACING_ROWS;
	const columns: string[] = Array.isArray(picked.entry.column) ? picked.entry.column.map(String) : [];
	const row = rows.indexOf(rowLabel);
	const column = columns.includes('Track') ? columns.indexOf('Track') : 0;
	const raw = row >= 0 ? Number(matrix.table[row]?.[column]) : Number.NaN;
	if (!Number.isFinite(raw)) return { reason: `Safe Spacing rule "${picked.name}" has no numeric ${rowLabel}-Track cell` };
	const key = `${group.path}[${JSON.stringify(picked.key)}].${matrix.key}[${row}][${column}]`;
	const scale = unitScale(picked.entry, key, raw, PLAUSIBLE_CLEARANCE_MIL);
	if ('reason' in scale) return scale;
	const clearanceMil = roundMil(raw * scale.factor);
	if (!inRange(clearanceMil, PLAUSIBLE_CLEARANCE_MIL)) return { reason: outOfRange(key, raw, scale.unit, clearanceMil, PLAUSIBLE_CLEARANCE_MIL) };
	return { rule: { clearanceMil, source: `${ruleSource(ruleConfig, SAFE_SPACING, picked.name, undefined, scale.note)} ${rowLabel}-Track` } };
}

// ---------------------------------------------------------------------------
// Differential pairs (Physics -> Differential Pair)
// ---------------------------------------------------------------------------

export interface DiffPairDef { name: string; positiveNet: string; negativeNet: string }

/** eda.pcb_Drc.getAllDifferentialPairs(): an array before EDA 3.4, an object keyed by name since. */
export function normalizeDiffPairs(raw: any): DiffPairDef[] {
	let list: any[] = [];
	if (Array.isArray(raw)) list = raw;
	else if (raw && typeof raw === 'object') {
		const inner = raw.list ?? raw.data ?? raw.differentialPairs;
		list = Array.isArray(inner) ? inner : Object.entries(raw).map(([key, v]: [string, any]) => (v && typeof v === 'object' ? { name: v.name ?? key, ...v } : undefined)).filter(Boolean);
	}
	return list
		.map((p: any) => ({ name: String(p?.name ?? ''), positiveNet: String(p?.positiveNet ?? p?.pNet ?? ''), negativeNet: String(p?.negativeNet ?? p?.nNet ?? '') }))
		.filter((p) => p.positiveNet && p.negativeNet);
}

export interface DiffPairRule { widthMil?: number; widthMinMil?: number; gapMil?: number; gapMinMil?: number; lenTolMil?: number; source: string }

/**
 * The Differential Pair rule that governs a pair. EasyEDA stores it under
 * Rule.Physics["Differential Pair"][name].form = { strokeWidthMin/Default/Max,
 * differentailPairSpacingMin/Default/Max, differentailPairLenTolerMax } (keys
 * misspelled as stored, values in the rule's unit) and assigns it per pair on
 * the net-rule rows: { type: "netDifferentail", name: <pair>,
 * "Differential Pair": <rule>, sub: [{ type: "net", name: <P>, ... }, …] }.
 * Spacing is read as the edge-to-edge gap.
 */
export function diffPairRule(ruleConfig: any, netRules: any, pairName: string | undefined, pNet: string): DiffPairRule | { reason: string } {
	const group = ruleConfig?.Rule?.Physics?.['Differential Pair'] ?? ruleConfig?.config?.Physics?.['Differential Pair'] ?? ruleConfig?.Physics?.['Differential Pair'];
	if (!group || typeof group !== 'object' || !Object.keys(group).length) return { reason: 'no Differential Pair rule is readable' };
	const rows = netRuleRows(ruleConfig, netRules);
	let assigned: string | undefined;
	let via = '';
	const pairRow = rows.find((r: any) => r && /diff/i.test(String(r.type)) && ((pairName && r.name === pairName) || (Array.isArray(r.sub) && r.sub.some((s: any) => s?.name === pNet))));
	if (pairRow) {
		assigned = pairRow['Differential Pair'] ?? pairRow.sub?.find((s: any) => s?.name === pNet)?.['Differential Pair'];
		via = `pair ${pairRow.name}`;
	}
	if (!assigned) {
		const netRow = rows.find((r: any) => r && r.type === 'net' && r.name === pNet);
		if (netRow?.['Differential Pair']) { assigned = netRow['Differential Pair']; via = `net ${pNet}`; }
	}
	const entries = Object.entries(group).filter(([, e]) => e && typeof e === 'object') as Array<[string, any]>;
	let picked = assigned && assigned !== 'default' ? entries.find(([key, e]) => key === assigned || e.editName === assigned) : undefined;
	if (!picked) picked = entries.find(([, e]) => e.isSetDefault === true || e.isDefault === true) ?? (entries.length === 1 ? entries[0] : undefined);
	if (!picked) return { reason: 'no Differential Pair rule is marked default' };
	const [key, entry] = picked;
	const form = entry.form ?? {};
	const read = (...keys: string[]) => {
		for (const k of keys) { const v = ruleValueToMil(form[k], entry.unit); if (v != null && v > 0 && v < 2000) return v; }
		return undefined;
	};
	const sp = (suffix: string) => [`differentailPairSpacing${suffix}`, `differentialPairSpacing${suffix}`];
	return {
		widthMil: read('strokeWidthDefault', 'strokeWidthMin'),
		widthMinMil: read('strokeWidthMin'),
		gapMil: read(...sp('Default'), ...sp('Min')),
		gapMinMil: read(...sp('Min')),
		lenTolMil: read('differentailPairLenTolerMax', 'differentialPairLenTolerMax'),
		source: `rule:${ruleConfigName(ruleConfig) ?? 'current'}/Differential Pair/${entry.editName ?? key}${via ? ` (${via})` : ' (default rule)'}`,
	};
}

// ---------------------------------------------------------------------------

function positiveMil(value: any, factor: number): number | undefined {
	const n = Number(value);
	if (value == null || value === '' || !Number.isFinite(n) || n <= 0) return undefined;
	return roundMil(n * factor);
}

function roundMil(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function firstDefined(...values: any[]): any {
	for (const value of values) if (value !== undefined && value !== null) return value;
	return undefined;
}

function str(value: any): string | undefined {
	if (value === undefined || value === null) return undefined;
	const s = String(value).trim();
	return s ? s : undefined;
}

// EasyEDA Pro design rules -> fastroute inputs.
//
// fastroute reads its constraints from the DSN (net classes: width and
// clearance) and from side files (--pairs, --tune, --layer-heights,
// --no-neckdown-classes, --router.copper_to_edge_clearance_um). EasyEDA's DSN
// export carries almost none of it: every net gets its own class whose member
// name is wrapped in single quotes (so no router ever matches it), with
// rounded width/clearance values, and there are no pairs, length groups or
// edge clearance at all. Everything here is computed from the live rule
// configuration instead, with the same resolvers the extension's DRC-aware
// tools use (src/shared/drc-rules.ts), and every value carries its source.
//
// All lengths written for fastroute are real units: the DSN is normalized to
// microns before routing (see specctra.ts), so mm/um values mean what they say.

import {
	clearanceResolverFromRules,
	diffPairRule,
	normalizeDiffPairs,
	resolveBoardOutlineClearance,
	resolveTrackWidth,
	type DiffPairDef,
} from '../../shared/drc-rules';
import type { DsnClassSpec, DsnNetwork } from './specctra';

const UM_PER_MIL = 25.4;

export interface EasyedaRuleInputs {
	ruleConfig: any;
	netRules: any;
	diffPairs: DiffPairDef[];
	equalLengthGroups: Array<{ name: string; nets: string[] }>;
}

export interface PairOverride { positiveNet: string; negativeNet: string; name?: string; gapMm?: number; skewMm?: number }
export interface LengthGroupOverride { name: string; nets: string[]; toleranceMm?: number; targetMm?: number }

export interface FastrouteConfigOptions {
	/** easyeda: rebuild classes and side files from the board's rules; dsn: route the exported DSN as is. */
	rules: 'easyeda' | 'dsn';
	/** Replaces the board's differential pairs ([] = none). */
	diffPairs?: PairOverride[];
	/** Replaces the board's equal-length groups ([] = none). */
	lengthGroups?: LengthGroupOverride[];
	/** Tolerance for equal-length groups that do not specify one (EasyEDA stores none). */
	lengthToleranceMm: number;
	/** Copper layer heights from the top, mm, in physical order (top, inner1.., bottom). Given: vias count in length matching. */
	layerHeightsMm?: number[];
	/** Count via lengths in length matching with the preset stackup for boardThicknessMm (off: EasyEDA's DRC measures tracks only). */
	countViaLengths?: boolean;
	boardThicknessMm: number;
	/** Nets that keep their full width at pins (controlled impedance); default: every routed pair net. */
	keepWidthAtPinsNets?: string[];
	/** Added to every clearance so routed copper does not land exactly on the DRC limit. */
	clearanceMarginUm: number;
}

export interface PairSpec { name: string; positiveNet: string; negativeNet: string; gapMm?: number; skewMm?: number; source: string }
export interface TuneSpec { name: string; nets: string[]; toleranceMm: number; targetMm?: number; source: string }

export interface FastrouteConfig {
	/** Net classes to write into the DSN, or null to keep the exported ones. */
	classes: DsnClassSpec[] | null;
	classSummary: Array<{ name: string; netCount: number; widthUm: number; clearanceUm: number; sample: string[]; source: string }>;
	pairs: PairSpec[];
	tuneGroups: TuneSpec[];
	/** DSN layer order (index = fastroute layer number). */
	layerHeightsMm?: number[];
	layerHeightsSource?: string;
	noNeckdownClasses: string[];
	/** Floor for fastroute's neck-down at pins (--router.min_trace_width_um) and the retry width (--router.neck_width_um). */
	minTraceWidthUm?: number;
	minTraceWidthSource?: string;
	/** Each net's rule minimum track width (um): a routed track below it is a DRC violation. */
	netMinWidthUm: Record<string, number>;
	edgeClearanceUm?: number;
	edgeClearanceSource?: string;
	warnings: string[];
}

/** eda.pcb_Drc.getAllEqualLengthNetGroups(): an array, or an object keyed by name on newer hosts. */
export function normalizeEqualLengthGroups(raw: any): Array<{ name: string; nets: string[] }> {
	let items: any[] = [];
	if (Array.isArray(raw)) items = raw;
	else if (raw && typeof raw === 'object') {
		const inner = raw.list ?? raw.data ?? raw.groups;
		items = Array.isArray(inner) ? inner : Object.entries(raw).map(([key, v]: [string, any]) => (v && typeof v === 'object' ? { name: v.name ?? key, ...v } : undefined)).filter(Boolean);
	}
	return items
		.map((g: any) => ({ name: String(g?.name ?? ''), nets: Array.isArray(g?.nets) ? g.nets.map(String).filter(Boolean) : [] }))
		.filter((g) => g.name);
}

export { normalizeDiffPairs };

/** Round up to 0.1 um, the normalized DSN's resolution. */
function ceilUm(um: number): number {
	return Math.ceil(um * 10 - 1e-6) / 10;
}

function roundMm(mm: number): number {
	return Math.round(mm * 10000) / 10000;
}

/** Side files split on whitespace and treat `#` as a comment. */
function sideFileUnsafe(name: string): boolean {
	return /[\s#]/.test(name);
}

function sanitizeToken(s: string): string {
	const t = s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
	return t || 'x';
}

function fmtUm(um: number): string {
	return String(um).replace('.', 'p');
}

/** Physical position (0 = top) of an EasyEDA copper layer name as written in its DSN, or undefined. */
export function physicalLayerIndex(name: string, layerCount: number): number | undefined {
	const n = name.trim();
	if (/^\d+$/.test(n)) {
		const id = Number(n);
		if (id === 1) return 0;
		if (id === 2) return layerCount - 1;
		if (id >= 15 && id <= 46) return id - 14;
		return undefined;
	}
	const compact = n.replace(/[\s_-]+/g, '').toLowerCase();
	if (compact === 'top' || compact === 'toplayer') return 0;
	if (compact === 'bottom' || compact === 'bottomlayer') return layerCount - 1;
	const inner = compact.match(/^inner(?:layer)?(\d+)$/);
	return inner ? Number(inner[1]) : undefined;
}

/** Physical-order heights: JLC04161H-7628 for 4-layer 1.6 mm, evenly spaced otherwise. */
function presetLayerHeights(layerCount: number, thicknessMm: number): { heights: number[]; source: string } {
	if (layerCount === 4 && Math.abs(thicknessMm - 1.6) < 0.05) {
		return { heights: [0, 0.2454, 1.3256, 1.5512], source: 'preset:JLC04161H-7628 (4L 1.6 mm); EasyEDA does not expose the stackup' };
	}
	const heights = Array.from({ length: layerCount }, (_, i) => roundMm(layerCount > 1 ? (thicknessMm * i) / (layerCount - 1) : 0));
	return { heights, source: `preset:evenly spaced over ${thicknessMm} mm; EasyEDA does not expose the stackup` };
}

export function buildFastrouteConfig(network: DsnNetwork, inputs: EasyedaRuleInputs | undefined, opts: FastrouteConfigOptions): FastrouteConfig {
	const warnings: string[] = [];
	const dsnNets = new Set(network.nets);
	const useRules = opts.rules === 'easyeda';
	const rc = inputs?.ruleConfig;
	const nr = inputs?.netRules;

	// --- differential pairs ---------------------------------------------------
	const pairSource: PairOverride[] = opts.diffPairs ?? (useRules ? (inputs?.diffPairs ?? []) : []);
	const pairs: PairSpec[] = [];
	const pairOfNet = new Map<string, PairSpec>();
	for (const p of pairSource) {
		const name = p.name || `${p.positiveNet}_${p.negativeNet}`;
		const missing = [p.positiveNet, p.negativeNet].filter((n) => !dsnNets.has(n));
		if (missing.length) { warnings.push(`diff pair ${name}: net(s) ${missing.join(', ')} not in the DSN; pair skipped`); continue; }
		const unsafe = [p.positiveNet, p.negativeNet].filter(sideFileUnsafe);
		if (unsafe.length) { warnings.push(`diff pair ${name}: net name(s) ${unsafe.map((n) => JSON.stringify(n)).join(', ')} contain whitespace or '#', which the --pairs file cannot express; pair skipped`); continue; }
		const rule = rc ? diffPairRule(rc, nr, p.name, p.positiveNet) : { reason: 'no rule configuration' };
		const r = 'reason' in rule ? undefined : rule;
		const gapMm = p.gapMm ?? (r?.gapMil != null ? roundMm((r.gapMil * UM_PER_MIL) / 1000) : undefined);
		const skewMm = p.skewMm ?? (r?.lenTolMil != null ? roundMm((r.lenTolMil * UM_PER_MIL) / 1000) : undefined);
		const source = [
			p.gapMm != null ? 'gap:param' : r?.gapMil != null ? `gap:${r.source}` : 'gap:fastroute default (pair clearance)',
			p.skewMm != null ? 'skew:param' : r?.lenTolMil != null ? `skew:${r.source} differentailPairLenTolerMax` : 'skew:fastroute default 0.1 mm',
		].join('; ');
		if ('reason' in rule && p.gapMm == null) warnings.push(`diff pair ${name}: ${rule.reason}; fastroute uses the pair's clearance as gap`);
		const spec: PairSpec = { name, positiveNet: p.positiveNet, negativeNet: p.negativeNet, ...(gapMm != null ? { gapMm } : {}), ...(skewMm != null ? { skewMm } : {}), source };
		pairs.push(spec);
		pairOfNet.set(p.positiveNet, spec);
		pairOfNet.set(p.negativeNet, spec);
	}

	// --- equal-length groups ----------------------------------------------------
	const groupSource: LengthGroupOverride[] = opts.lengthGroups ?? (useRules ? (inputs?.equalLengthGroups ?? []) : []);
	const tuneGroups: TuneSpec[] = [];
	const usedGroupNames = new Set<string>();
	for (const g of groupSource) {
		const present = g.nets.filter((n) => dsnNets.has(n));
		const absent = g.nets.filter((n) => !dsnNets.has(n));
		if (absent.length) warnings.push(`length group ${g.name}: net(s) ${absent.join(', ')} not in the DSN`);
		const unsafe = present.filter(sideFileUnsafe);
		if (unsafe.length) warnings.push(`length group ${g.name}: net name(s) ${unsafe.map((n) => JSON.stringify(n)).join(', ')} contain whitespace or '#' and were left out`);
		const nets = present.filter((n) => !sideFileUnsafe(n));
		if (nets.some((n) => n.includes('*'))) warnings.push(`length group ${g.name}: '*' in a net name is a wildcard in the --tune file and may match more nets`);
		if (nets.length < 2) { warnings.push(`length group ${g.name}: fewer than 2 routable nets; group skipped`); continue; }
		const pairMatch = pairs.find((p) => nets.length === 2 && nets.includes(p.positiveNet) && nets.includes(p.negativeNet));
		if (pairMatch) { warnings.push(`length group ${g.name}: same nets as diff pair ${pairMatch.name}; matched by the pair's skew instead`); continue; }
		let name = sanitizeToken(g.name);
		while (usedGroupNames.has(name)) name += '_';
		usedGroupNames.add(name);
		const toleranceMm = g.toleranceMm ?? opts.lengthToleranceMm;
		tuneGroups.push({
			name,
			nets,
			toleranceMm,
			...(g.targetMm != null ? { targetMm: g.targetMm } : {}),
			source: g.toleranceMm != null ? 'tolerance:param' : `tolerance:${opts.lengthToleranceMm} mm default (EasyEDA equal-length groups carry no tolerance)`,
		});
	}

	// --- net classes ------------------------------------------------------------
	let classes: DsnClassSpec[] | null = null;
	const classSummary: FastrouteConfig['classSummary'] = [];
	const classOfNet = new Map<string, string>();
	let minTraceWidthUm: number | undefined;
	let minTraceWidthSource: string | undefined;
	const netMinWidthUm: Record<string, number> = {};
	if (useRules) {
		const defaultWidth = rc ? resolveTrackWidth(rc, nr, undefined) : { reason: 'no rule configuration' };
		if (!rc || 'reason' in defaultWidth) {
			warnings.push(`net classes: ${'reason' in defaultWidth ? defaultWidth.reason : 'no rule configuration'}; the DSN's structure-level width/clearance apply to every net`);
			classes = [];
		} else {
			const clearance = clearanceResolverFromRules(rc, nr, network.nets);
			const viaOfNet = new Map<string, string>();
			for (const c of network.classes) if (c.useVia) for (const n of c.nets) viaOfNet.set(n, c.useVia);
			const fallbackVia = network.classes.find((c) => c.useVia)?.useVia ?? network.viaPadstacks[0];
			const groups = new Map<string, DsnClassSpec & { sources: Set<string> }>();
			const fallbackClearance: string[] = [];
			let minWidthMil: { mil: number; source: string } | undefined;
			let narrowestClassMil = Number.POSITIVE_INFINITY;
			for (const net of network.nets) {
				const pair = pairOfNet.get(net);
				const pr = pair && rc ? diffPairRule(rc, nr, pair.name, pair.positiveNet) : undefined;
				const pairWidthMil = pr && !('reason' in pr) ? pr.widthMil : undefined;
				const tw = resolveTrackWidth(rc, nr, net);
				const widthMil = pairWidthMil ?? tw.rule?.widthMil ?? defaultWidth.rule.widthMil;
				const netMin = tw.rule?.minMil ?? defaultWidth.rule.minMil;
				if (netMin != null && (!minWidthMil || netMin > minWidthMil.mil)) minWidthMil = { mil: netMin, source: tw.rule?.source ?? defaultWidth.rule.source };
				if (netMin != null) netMinWidthUm[net] = Math.round(netMin * UM_PER_MIL * 10) / 10;
				narrowestClassMil = Math.min(narrowestClassMil, widthMil);
				const cl = clearance.for(net);
				if (cl.source.startsWith('default:')) fallbackClearance.push(net);
				const widthUm = ceilUm(widthMil * UM_PER_MIL);
				const clearanceUm = ceilUm(cl.clearanceMil * UM_PER_MIL + opts.clearanceMarginUm);
				const useVia = viaOfNet.get(net) ?? fallbackVia;
				const key = `${pair?.name ?? ''}|${widthUm}|${clearanceUm}|${useVia ?? ''}`;
				let g = groups.get(key);
				if (!g) {
					g = { name: '', nets: [], widthUm, clearanceUm, ...(useVia ? { useVia } : {}), sources: new Set() };
					groups.set(key, g);
				}
				g.nets.push(net);
				g.sources.add(pairWidthMil != null && pr && !('reason' in pr) ? `width:${pr.source}` : `width:${tw.rule?.source ?? defaultWidth.rule.source}`);
				g.sources.add(`clearance:${cl.source}`);
			}
			if (fallbackClearance.length) {
				warnings.push(`clearance for ${fallbackClearance.length} net(s) (${fallbackClearance.slice(0, 5).join(', ')}${fallbackClearance.length > 5 ? ', ...' : ''}) fell back to ${clearance.for(fallbackClearance[0]).source}`);
			}
			// fastroute necks traces down at pins with no floor of its own. One
			// global floor: the largest rule minimum, never above the narrowest class.
			if (minWidthMil) {
				minTraceWidthUm = ceilUm(Math.min(minWidthMil.mil, narrowestClassMil) * UM_PER_MIL);
				minTraceWidthSource = `${minWidthMil.source} strokeWidthMin`;
			}
			const used = new Set<string>();
			classes = [];
			for (const [key, g] of groups) {
				const pairName = key.split('|')[0];
				let name = pairName ? `pair_${sanitizeToken(pairName)}` : `w${fmtUm(g.widthUm)}_c${fmtUm(g.clearanceUm)}`;
				while (used.has(name)) name += '_';
				used.add(name);
				g.name = name;
				for (const n of g.nets) classOfNet.set(n, name);
				classes.push({ name, nets: g.nets, widthUm: g.widthUm, clearanceUm: g.clearanceUm, ...(g.useVia ? { useVia: g.useVia } : {}) });
				classSummary.push({
					name,
					netCount: g.nets.length,
					widthUm: g.widthUm,
					clearanceUm: g.clearanceUm,
					sample: g.nets.slice(0, 6),
					source: Array.from(g.sources).slice(0, 4).join('; '),
				});
			}
		}
	}

	// --- no neck-down -------------------------------------------------------------
	const noNeckdownClasses: string[] = [];
	const keepNets = opts.keepWidthAtPinsNets ?? pairs.flatMap((p) => [p.positiveNet, p.negativeNet]);
	if (keepNets.length) {
		if (!classes) {
			warnings.push('keepWidthAtPinsNets needs rules:"easyeda" (the exported DSN classes do not match any net); ignored');
		} else if (!classes.length) {
			warnings.push('keepWidthAtPinsNets ignored: no net classes could be built from the board rules');
		} else {
			const missing: string[] = [];
			for (const n of keepNets) {
				const c = classOfNet.get(n);
				if (!c) { missing.push(n); continue; }
				if (!noNeckdownClasses.includes(c)) noNeckdownClasses.push(c);
			}
			if (missing.length) warnings.push(`keepWidthAtPinsNets: ${missing.join(', ')} not in the DSN`);
			// A class is shared by every net with the same width/clearance; pair classes are exclusive.
			const shared = noNeckdownClasses.filter((c) => !c.startsWith('pair_'));
			if (shared.length) warnings.push(`keepWidthAtPinsNets: class(es) ${shared.join(', ')} also hold other nets, which keep their full width at pins too`);
		}
	}

	// --- layer heights (via lengths count in length matching) ---------------------
	// Only on request: EasyEDA's DRC measures pair and group lengths along the
	// tracks, so counting via barrels makes fastroute match lengths EasyEDA
	// then reports as mismatched.
	let layerHeightsMm: number[] | undefined;
	let layerHeightsSource: string | undefined;
	if ((tuneGroups.length || pairs.length) && (opts.layerHeightsMm || opts.countViaLengths)) {
		const n = network.layers.length;
		const physical = opts.layerHeightsMm
			? { heights: opts.layerHeightsMm, source: 'param:layerHeightsMm' }
			: presetLayerHeights(n, opts.boardThicknessMm);
		if (physical.heights.length !== n) {
			warnings.push(`layerHeightsMm has ${physical.heights.length} values but the DSN has ${n} copper layers; via lengths are not counted`);
		} else {
			const idx = network.layers.map((l) => physicalLayerIndex(l, n));
			if (idx.some((i) => i == null || i < 0 || i >= n) || new Set(idx).size !== n) {
				warnings.push(`cannot map DSN layers ${network.layers.join(', ')} to physical order; via lengths are not counted`);
			} else {
				layerHeightsMm = idx.map((i) => physical.heights[i as number]);
				layerHeightsSource = physical.source;
			}
		}
	}

	// --- copper to board edge ------------------------------------------------------
	let edgeClearanceUm: number | undefined;
	let edgeClearanceSource: string | undefined;
	if (useRules && rc) {
		const edge = resolveBoardOutlineClearance(rc);
		if (edge.rule) {
			edgeClearanceUm = ceilUm(edge.rule.clearanceMil * UM_PER_MIL + opts.clearanceMarginUm);
			edgeClearanceSource = edge.rule.source;
		} else {
			warnings.push(`board edge clearance: ${edge.reason}`);
		}
	}

	return { classes, classSummary, pairs, tuneGroups, layerHeightsMm, layerHeightsSource, noNeckdownClasses, minTraceWidthUm, minTraceWidthSource, netMinWidthUm, edgeClearanceUm, edgeClearanceSource, warnings };
}

export function pairsFileText(pairs: PairSpec[]): string {
	return pairs
		.map((p) => {
			const opts = [p.gapMm != null ? `gap=${p.gapMm}` : '', p.skewMm != null ? `skew=${p.skewMm}` : ''].filter(Boolean).join(' ');
			return `pair ${p.positiveNet} ${p.negativeNet}${opts ? ` ${opts}` : ''}  # ${p.name}`;
		})
		.join('\n') + '\n';
}

export function tuneFileText(groups: TuneSpec[]): string {
	return groups
		.map((g) => [`group ${g.name} tolerance=${g.toleranceMm}${g.targetMm != null ? ` target=${g.targetMm}` : ''}`, ...g.nets.map((n) => `  ${n}`)].join('\n'))
		.join('\n') + '\n';
}

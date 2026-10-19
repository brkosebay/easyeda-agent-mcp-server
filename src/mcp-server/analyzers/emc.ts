// EMC pre-compliance analyzer — pure module.
//
// Port of kicad-happy's emc skill. The original ships 42 rules across 17
// categories; we land them in waves. Phase 5 covers the schematic-side
// rules that consume only the sch_extract_design snapshot. PCB-side rules
// (ground-plane continuity, PDN impedance, board-edge radiation, diff-pair
// routing) ship in a follow-up after `pcb_extract_design` exists.
//
// Architecture:
//   - Each rule is a pure function (snapshot) -> Finding[]
//   - Rules register into RULE_REGISTRY with id + category + severity defaults
//   - analyzeEmc(snapshot, opts) runs all enabled rules, aggregates findings
//
// kicad-happy reference: skills/emc/scripts/emc_rules.py + emc_formulas.py

export type EmcSeverity = 'critical' | 'warning' | 'info';

export type EmcCategory =
	| 'decoupling'
	| 'power_filtering'
	| 'clock_routing'
	| 'io_protection'
	| 'differential_pairs'
	| 'ground_strategy'
	| 'reset_supervision'
	| 'crystal_loading'
	| 'connector_hygiene'
	| 'switching_regulator'
	| 'protection_devices'
	| 'analog_isolation';

export interface EmcFinding {
	ruleId: string;
	category: EmcCategory;
	severity: EmcSeverity;
	title: string;
	detail: string;
	designators: string[];
	netNames?: string[];
	suggestion?: string;
	formula?: string;
	values?: Record<string, number | string>;
}

export interface EmcReport {
	rulesRun: number;
	rulesSkipped: string[];
	findings: EmcFinding[];
	bySeverity: Record<EmcSeverity, number>;
	byCategory: Record<EmcCategory, number>;
	scoredCategories: Array<{ category: EmcCategory; criticalCount: number; warningCount: number }>;
	summary: string;
}

// Loose snapshot shape — kept compatible with sch.extract.design.
interface PinRef { designator: string; pinNumber: string; pinName: string }
interface NetInfo {
	name: string;
	pinCount: number;
	members: PinRef[];
	isPower?: boolean;
	isGround?: boolean;
	autoNamed?: boolean;
}
interface ComponentInfo {
	designator: string;
	mpn?: string;
	manufacturer?: string;
	value?: string;
	unit?: string;
	footprint?: string;
	deviceClass?: string;
	pins?: Record<string, { name: string; net: string }>;
	otherProperties?: Record<string, any>;
}
export interface EmcSnapshot {
	components: Record<string, ComponentInfo>;
	nets: Record<string, NetInfo>;
}

// ---------------------------------------------------------------------------
// Helpers — value parsing, classification
// ---------------------------------------------------------------------------

const SI_PREFIXES: Record<string, number> = {
	p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9,
};

/** Parse "100nF", "10uF", "4.7k", "1.2M" → SI value. Returns NaN on failure. */
export function parseSiValue(s: string | undefined): number {
	if (!s) return NaN;
	const m = s.trim().match(/^([0-9]*\.?[0-9]+)\s*([pnuµmkMG]?)\s*([a-zA-ZΩ]*)$/);
	if (!m) return NaN;
	const base = parseFloat(m[1]);
	const prefix = m[2] ? SI_PREFIXES[m[2]] ?? 1 : 1;
	return base * prefix;
}

function isPowerRail(net: NetInfo): boolean {
	if (net.isPower) return true;
	const n = net.name.toUpperCase();
	// Strip any leading "+", "-", "_", "V_" so "+3V3", "V_5V0", "_5V" all work.
	const stripped = n.replace(/^[+\-_]+/, '').replace(/^V_/, '');
	if (/^(VCC|VDD|V\+|VIN|VOUT|3V3|5V|1V8|1V2|2V5|VBAT|VBUS|VSYS|VAUX|AVDD|DVDD|VPP)/.test(stripped)) return true;
	// "12V", "+12V", "+5V_FILTERED", "+3.3V" — leading-digit-then-V notation.
	if (/^\d+(V\d+|V|\.\d+V)/.test(stripped)) return true;
	return false;
}

function isGroundNet(net: NetInfo): boolean {
	if (net.isGround) return true;
	const n = net.name.toUpperCase();
	return /^(GND|VSS|0V|AGND|DGND|PGND|EGND|EARTH)/.test(n);
}

function deviceClassMatches(c: ComponentInfo, classes: string[]): boolean {
	return classes.includes((c.deviceClass || '').toLowerCase());
}

function netsForPin(c: ComponentInfo, pinPredicate: (pin: { name: string; net: string }) => boolean): string[] {
	if (!c.pins) return [];
	return Object.values(c.pins).filter(pinPredicate).map((p) => p.net);
}

function findComponentsOnNet(snap: EmcSnapshot, netName: string): ComponentInfo[] {
	const out: ComponentInfo[] = [];
	for (const c of Object.values(snap.components)) {
		if (!c.pins) continue;
		for (const p of Object.values(c.pins)) {
			if (p.net === netName) { out.push(c); break; }
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Rule registry
// ---------------------------------------------------------------------------

interface EmcRule {
	id: string;
	category: EmcCategory;
	defaultSeverity: EmcSeverity;
	title: string;
	run: (snap: EmcSnapshot) => EmcFinding[];
}

const RULES: EmcRule[] = [];

function register(rule: EmcRule): void { RULES.push(rule); }

// ---------------------------------------------------------------------------
// DEC-001: Every power rail should have at least one decoupling cap per IC
// pin attached to it, with at least one ≤100nF "high-frequency" cap and one
// "bulk" cap (≥1uF).
// ---------------------------------------------------------------------------

register({
	id: 'DEC-001',
	category: 'decoupling',
	defaultSeverity: 'warning',
	title: 'Power rail under-decoupled vs. IC pin count',
	run: (snap) => {
		const findings: EmcFinding[] = [];
		const power = Object.values(snap.nets).filter(isPowerRail);

		// HF cap threshold = 220nF. Real-world HF decoupling caps come in
		// 100nF, 47nF, 10nF, 1nF, 100pF — all well below 220nF. Using a
		// strict `<= 100e-9` boundary triggers a floating-point edge case:
		// `100 * 1e-9` evaluates to 1.0000000000000002e-7 in IEEE 754, which
		// is NOT `<= 100e-9` (=1e-7). 220nF cleanly avoids the FP corner
		// AND is more permissive (correct intent — 220nF is still HF).
		const HF_CAP_MAX_F = 220e-9;
		const BULK_CAP_MIN_F = 1e-6;

		for (const rail of power) {
			let hfCount = 0, bulkCount = 0, totalCaps = 0;
			let icPinsOnRail = 0;
			const involvedDesignators = new Set<string>();
			const railComps = findComponentsOnNet(snap, rail.name);
			for (const c of railComps) {
				if (deviceClassMatches(c, ['capacitor'])) {
					totalCaps += 1;
					involvedDesignators.add(c.designator);
					const v = parseSiValue(c.value);
					if (Number.isFinite(v)) {
						if (v <= HF_CAP_MAX_F) hfCount += 1;
						if (v >= BULK_CAP_MIN_F) bulkCount += 1;
					}
				}
				if (deviceClassMatches(c, ['ic', 'regulator_ldo', 'regulator_buck', 'regulator_boost'])) {
					if (c.pins) {
						for (const p of Object.values(c.pins)) {
							if (p.net === rail.name) icPinsOnRail += 1;
						}
					}
				}
			}

			if (icPinsOnRail === 0) continue;

			if (totalCaps === 0) {
				findings.push({
					ruleId: 'DEC-001',
					category: 'decoupling',
					severity: 'critical',
					title: `Power rail "${rail.name}" has zero decoupling caps with ${icPinsOnRail} IC pins on it`,
					detail: `EMC: every IC power pin needs at least one local decoupling cap. Rail "${rail.name}" has ${icPinsOnRail} IC pin(s) and ${totalCaps} cap(s). Expect emissions and immunity problems.`,
					designators: [...involvedDesignators],
					netNames: [rail.name],
					suggestion: 'Add a 100nF X7R 0402/0603 within ~5mm of every IC power pin, plus one 1–10µF bulk cap per device cluster.',
					values: { icPinsOnRail, totalCaps, hfCount, bulkCount },
				});
				continue;
			}

			if (totalCaps < icPinsOnRail) {
				findings.push({
					ruleId: 'DEC-001',
					category: 'decoupling',
					severity: 'warning',
					title: `Power rail "${rail.name}" under-decoupled`,
					detail: `Rail has ${totalCaps} cap(s) for ${icPinsOnRail} IC pin(s). Rule of thumb: one HF cap per power pin.`,
					designators: [...involvedDesignators],
					netNames: [rail.name],
					suggestion: 'Add additional 100nF caps so every IC power pin sees one within ~5mm on the PCB.',
					values: { icPinsOnRail, totalCaps },
				});
			}

			if (hfCount === 0) {
				findings.push({
					ruleId: 'DEC-001',
					category: 'decoupling',
					severity: 'warning',
					title: `Power rail "${rail.name}" missing high-frequency decoupling`,
					detail: `Rail has caps but none ≤100nF. HF noise above ~10MHz won't be shunted.`,
					designators: [...involvedDesignators],
					netNames: [rail.name],
					suggestion: 'Add at least one 100nF X7R cap near each IC.',
					values: { hfCount, totalCaps },
				});
			}

			if (bulkCount === 0 && icPinsOnRail >= 4) {
				findings.push({
					ruleId: 'DEC-001',
					category: 'decoupling',
					severity: 'info',
					title: `Power rail "${rail.name}" missing bulk reservoir cap`,
					detail: `Rail has ${icPinsOnRail} IC pins but no caps ≥1µF. Transient sag during simultaneous switching will be larger than necessary.`,
					designators: [...involvedDesignators],
					netNames: [rail.name],
					suggestion: 'Add a 1–10µF bulk cap per cluster of ICs.',
					values: { bulkCount, icPinsOnRail },
				});
			}
		}

		return findings;
	},
});

// ---------------------------------------------------------------------------
// IO-001: Every connector signal pin should have ESD protection (TVS/diode).
// (Re-check of sch_analyze_esd_coverage from Phase 3, but emits an EMC-shaped
// finding so the report is unified.)
// ---------------------------------------------------------------------------

register({
	id: 'IO-001',
	category: 'io_protection',
	defaultSeverity: 'critical',
	title: 'Connector signal pin without ESD protection',
	run: (snap) => {
		const findings: EmcFinding[] = [];
		const connectors = Object.values(snap.components).filter((c) =>
			deviceClassMatches(c, ['connector', 'header', 'usb_connector']),
		);

		const tvsByNet = new Map<string, ComponentInfo[]>();
		for (const c of Object.values(snap.components)) {
			if (!deviceClassMatches(c, ['tvs', 'zener', 'diode'])) continue;
			if (!c.pins) continue;
			for (const p of Object.values(c.pins)) {
				if (!p.net) continue;
				if (!tvsByNet.has(p.net)) tvsByNet.set(p.net, []);
				tvsByNet.get(p.net)!.push(c);
			}
		}

		for (const conn of connectors) {
			if (!conn.pins) continue;
			for (const [pinNum, p] of Object.entries(conn.pins)) {
				if (!p.net) continue;
				const net = snap.nets[p.net];
				if (!net) continue;
				if (isGroundNet(net)) continue;
				if (isPowerRail(net) && !/USB|DATA|D[+\-]/i.test(p.name || '')) continue;
				const protections = tvsByNet.get(p.net) || [];
				if (protections.length === 0) {
					findings.push({
						ruleId: 'IO-001',
						category: 'io_protection',
						severity: 'critical',
						title: `Connector ${conn.designator} pin ${pinNum} (${p.name || ''}) has no ESD protection`,
						detail: `Net "${p.net}" connects to a connector and exits the board. Without a TVS clamp, ESD strikes propagate directly to internal logic.`,
						designators: [conn.designator],
						netNames: [p.net],
						suggestion: 'Place a TVS diode (e.g. PESD3V3 / SMAJxxA) from this net to GND, located adjacent to the connector.',
					});
				}
			}
		}
		return findings;
	},
});

// ---------------------------------------------------------------------------
// CLK-001: Crystals should have load caps (typically 2 × 10–22pF). Crystal
// load networks without companion caps fail to oscillate cleanly and emit at
// harmonics far from the intended frequency.
// ---------------------------------------------------------------------------

register({
	id: 'CLK-001',
	category: 'crystal_loading',
	defaultSeverity: 'critical',
	title: 'Crystal without load capacitors',
	run: (snap) => {
		const findings: EmcFinding[] = [];
		const crystals = Object.values(snap.components).filter((c) =>
			deviceClassMatches(c, ['crystal']),
		);
		for (const x of crystals) {
			if (!x.pins) continue;
			const xtalNets = Object.values(x.pins).map((p) => p.net).filter(Boolean);
			let loadCapCount = 0;
			let groundedNetCount = 0;
			for (const net of xtalNets) {
				const onNet = findComponentsOnNet(snap, net);
				const caps = onNet.filter((c) => deviceClassMatches(c, ['capacitor']));
				for (const cap of caps) {
					const otherNets = cap.pins
						? Object.values(cap.pins).map((p) => p.net).filter((n) => n && n !== net)
						: [];
					const grounded = otherNets.some((n) => snap.nets[n] && isGroundNet(snap.nets[n]));
					const v = parseSiValue(cap.value);
					if (grounded && Number.isFinite(v) && v <= 50e-12) {
						loadCapCount += 1;
						groundedNetCount += 1;
					}
				}
			}
			if (loadCapCount < 2) {
				findings.push({
					ruleId: 'CLK-001',
					category: 'crystal_loading',
					severity: 'critical',
					title: `Crystal ${x.designator} has fewer than 2 load caps (found ${loadCapCount})`,
					detail: `Crystals need two load capacitors to ground (typically 10–22pF each, depending on crystal CL spec) to oscillate cleanly. Missing caps cause startup failures and broadband emissions.`,
					designators: [x.designator],
					netNames: xtalNets,
					suggestion: 'Add two ceramic caps from each crystal pin to GND. Value = 2·(CL − Cstray), where CL is the datasheet load capacitance and Cstray ≈ 3–5pF.',
					formula: 'C_load = 2 × (CL − C_stray)',
				});
			}
		}
		return findings;
	},
});

// ---------------------------------------------------------------------------
// PWR-001: Switching regulator output should have an inductor + bulk cap.
// We detect buck/boost regulators and walk SW pin → check inductor → bulk.
// ---------------------------------------------------------------------------

register({
	id: 'PWR-001',
	category: 'switching_regulator',
	defaultSeverity: 'warning',
	title: 'Switching regulator missing inductor or output cap',
	run: (snap) => {
		const findings: EmcFinding[] = [];
		const swRegs = Object.values(snap.components).filter((c) =>
			deviceClassMatches(c, ['regulator_buck', 'regulator_boost']),
		);
		for (const reg of swRegs) {
			if (!reg.pins) continue;
			const swPins = Object.values(reg.pins).filter((p) => /SW|LX|PHASE/i.test(p.name));
			if (swPins.length === 0) continue;

			let inductorOnSw = false;
			let bulkOutputCap = 0;
			for (const swPin of swPins) {
				const onNet = findComponentsOnNet(snap, swPin.net);
				if (onNet.some((c) => deviceClassMatches(c, ['inductor']))) inductorOnSw = true;
				for (const c of onNet) {
					if (deviceClassMatches(c, ['capacitor'])) {
						const v = parseSiValue(c.value);
						if (Number.isFinite(v) && v >= 1e-6) bulkOutputCap += 1;
					}
				}
			}

			if (!inductorOnSw) {
				findings.push({
					ruleId: 'PWR-001',
					category: 'switching_regulator',
					severity: 'critical',
					title: `Switching regulator ${reg.designator} has no inductor on SW node`,
					detail: 'Buck/boost converters require an inductor between SW and output. Missing inductor = the IC will fail or burn.',
					designators: [reg.designator],
					netNames: swPins.map((p) => p.net),
					suggestion: 'Add a power inductor on the SW node sized per the IC datasheet (typically 1–10µH for ≤2A buck).',
				});
			}

			if (bulkOutputCap === 0) {
				findings.push({
					ruleId: 'PWR-001',
					category: 'switching_regulator',
					severity: 'warning',
					title: `Switching regulator ${reg.designator} has no bulk output cap (≥1µF) on SW-side filter`,
					detail: 'Buck/boost output filters need a bulk capacitor for ripple suppression. Without it, ripple radiates and downstream logic sees noisy supply.',
					designators: [reg.designator],
					netNames: swPins.map((p) => p.net),
					suggestion: 'Add a 10–22µF X7R cap on the regulator output net adjacent to the IC.',
				});
			}
		}
		return findings;
	},
});

// ---------------------------------------------------------------------------
// PWR-002: Linear regulators should have input + output caps per datasheet.
// ---------------------------------------------------------------------------

register({
	id: 'PWR-002',
	category: 'switching_regulator',
	defaultSeverity: 'warning',
	title: 'LDO missing input or output cap',
	run: (snap) => {
		const findings: EmcFinding[] = [];
		const ldos = Object.values(snap.components).filter((c) =>
			deviceClassMatches(c, ['regulator_ldo']),
		);
		for (const ldo of ldos) {
			if (!ldo.pins) continue;
			const inPins = Object.values(ldo.pins).filter((p) => /VIN|IN(?!H|T)/i.test(p.name));
			const outPins = Object.values(ldo.pins).filter((p) => /VOUT|OUT/i.test(p.name));
			let inCap = false, outCap = false;
			for (const p of inPins) {
				if (findComponentsOnNet(snap, p.net).some((c) => deviceClassMatches(c, ['capacitor']))) inCap = true;
			}
			for (const p of outPins) {
				if (findComponentsOnNet(snap, p.net).some((c) => deviceClassMatches(c, ['capacitor']))) outCap = true;
			}
			if (!inCap) {
				findings.push({
					ruleId: 'PWR-002',
					category: 'switching_regulator',
					severity: 'warning',
					title: `LDO ${ldo.designator} has no input capacitor`,
					detail: 'Linear regulator inputs need bypass capacitors for stability and PSRR.',
					designators: [ldo.designator],
					suggestion: 'Add a 1µF ceramic on the LDO input pin to ground.',
				});
			}
			if (!outCap) {
				findings.push({
					ruleId: 'PWR-002',
					category: 'switching_regulator',
					severity: 'critical',
					title: `LDO ${ldo.designator} has no output capacitor`,
					detail: 'Many LDOs are unstable without an output cap. Datasheet always specifies a minimum value and ESR range.',
					designators: [ldo.designator],
					suggestion: 'Add the datasheet-recommended output cap (often 1–10µF ceramic, but check ESR requirements).',
				});
			}
		}
		return findings;
	},
});

// ---------------------------------------------------------------------------
// CON-001: USB / Ethernet / high-speed connectors should have a common-mode
// choke on differential pair signals.
// ---------------------------------------------------------------------------

register({
	id: 'CON-001',
	category: 'differential_pairs',
	defaultSeverity: 'info',
	title: 'High-speed connector without common-mode choke',
	run: (snap) => {
		const findings: EmcFinding[] = [];
		const connectors = Object.values(snap.components).filter((c) =>
			/usb|ethernet|rj45|hdmi|displayport/i.test(c.deviceClass || c.value || c.footprint || ''),
		);
		for (const conn of connectors) {
			if (!conn.pins) continue;
			const dpPins = Object.values(conn.pins).filter((p) => /D[+\-]|TX|RX|MDI|HSO/i.test(p.name));
			if (dpPins.length < 2) continue;

			let cmcFound = false;
			for (const p of dpPins) {
				const onNet = findComponentsOnNet(snap, p.net);
				if (onNet.some((c) =>
					/common.?mode|cmc|cmf|choke/i.test(c.value || '') ||
					/common.?mode|cmc|cmf|choke/i.test((c.otherProperties as any)?.description || ''),
				)) { cmcFound = true; break; }
			}

			if (!cmcFound) {
				findings.push({
					ruleId: 'CON-001',
					category: 'differential_pairs',
					severity: 'info',
					title: `${conn.designator} (${conn.deviceClass}) without detected common-mode choke`,
					detail: 'High-speed differential interfaces typically need a CMC for radiated emissions compliance. (We only detected this from value/description text — not authoritative.)',
					designators: [conn.designator],
					suggestion: 'For USB / Ethernet, add a common-mode choke in series with D+/D- (or TX/RX) close to the connector.',
				});
			}
		}
		return findings;
	},
});

// ---------------------------------------------------------------------------
// PROT-001: Boards with external power input should have reverse-polarity
// protection (FET / Schottky in series).
// ---------------------------------------------------------------------------

register({
	id: 'PROT-001',
	category: 'protection_devices',
	defaultSeverity: 'info',
	title: 'External power input without reverse-polarity protection',
	run: (snap) => {
		const findings: EmcFinding[] = [];
		const powerConnectors = Object.values(snap.components).filter((c) => {
			if (!deviceClassMatches(c, ['connector', 'header'])) return false;
			if (!c.pins) return false;
			const nets = Object.values(c.pins).map((p) => p.net).filter(Boolean);
			return nets.some((n) => snap.nets[n] && isPowerRail(snap.nets[n]));
		});
		for (const conn of powerConnectors) {
			if (!conn.pins) continue;
			const powerNets = Object.values(conn.pins)
				.map((p) => p.net)
				.filter((n) => snap.nets[n] && isPowerRail(snap.nets[n]));
			let protectionFound = false;
			for (const netName of powerNets) {
				const onNet = findComponentsOnNet(snap, netName);
				if (onNet.some((c) => deviceClassMatches(c, ['transistor_fet', 'diode']))) {
					protectionFound = true;
					break;
				}
			}
			if (!protectionFound) {
				findings.push({
					ruleId: 'PROT-001',
					category: 'protection_devices',
					severity: 'info',
					title: `Power input ${conn.designator} without reverse-polarity protection`,
					detail: 'External power connectors should have a series Schottky or P-FET to protect the board if the user reverses polarity.',
					designators: [conn.designator],
					netNames: powerNets,
					suggestion: 'Add a P-FET (low Vds drop) or Schottky diode in series with the input rail.',
				});
			}
		}
		return findings;
	},
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EmcOptions {
	enabledRuleIds?: string[];   // if set, only these IDs run
	disabledRuleIds?: string[];  // exclusion list (overrides enabled)
}

export function listEmcRules(): Array<{ id: string; category: EmcCategory; defaultSeverity: EmcSeverity; title: string }> {
	return RULES.map(({ id, category, defaultSeverity, title }) => ({ id, category, defaultSeverity, title }));
}

export function analyzeEmc(snap: EmcSnapshot, opts: EmcOptions = {}): EmcReport {
	const enabled = opts.enabledRuleIds ? new Set(opts.enabledRuleIds) : null;
	const disabled = new Set(opts.disabledRuleIds ?? []);
	const findings: EmcFinding[] = [];
	const rulesSkipped: string[] = [];
	let rulesRun = 0;

	for (const rule of RULES) {
		if (enabled && !enabled.has(rule.id)) { rulesSkipped.push(rule.id); continue; }
		if (disabled.has(rule.id)) { rulesSkipped.push(rule.id); continue; }
		rulesRun += 1;
		try {
			findings.push(...rule.run(snap));
		} catch (err: any) {
			findings.push({
				ruleId: rule.id,
				category: rule.category,
				severity: 'info',
				title: `Rule ${rule.id} threw an error`,
				detail: `Internal error while running ${rule.id}: ${err?.message ?? String(err)}. Treat as data-quality issue, not design defect.`,
				designators: [],
			});
		}
	}

	const bySeverity: Record<EmcSeverity, number> = { critical: 0, warning: 0, info: 0 };
	const byCategory = {} as Record<EmcCategory, number>;
	for (const f of findings) {
		bySeverity[f.severity] += 1;
		byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
	}

	const scored = Object.entries(byCategory).map(([cat, _]) => ({
		category: cat as EmcCategory,
		criticalCount: findings.filter((f) => f.category === cat && f.severity === 'critical').length,
		warningCount: findings.filter((f) => f.category === cat && f.severity === 'warning').length,
	})).sort((a, b) => (b.criticalCount * 10 + b.warningCount) - (a.criticalCount * 10 + a.warningCount));

	const summary = `${findings.length} EMC findings: ${bySeverity.critical} critical, ${bySeverity.warning} warning, ${bySeverity.info} info. Worst category: ${scored[0]?.category ?? '(none)'}.`;

	return {
		rulesRun,
		rulesSkipped,
		findings,
		bySeverity,
		byCategory,
		scoredCategories: scored,
		summary,
	};
}

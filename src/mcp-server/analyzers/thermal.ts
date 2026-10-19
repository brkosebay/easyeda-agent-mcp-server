// Thermal analyzer — pure module.
//
// Estimates per-component power dissipation from a sch.extract.design
// snapshot using closed-form rules that don't need datasheet lookup.
// Anything that needs absolute-max ratings or junction-to-ambient θ values
// is flagged as `needsDatasheet:true` and the verifier (or a follow-up tool
// that reads the cached PDF) can fill it in.
//
// Categories:
//   - resistor: P = V²/R when net voltage known; else approximated from
//     "voltage across R = Vrail" if R bridges a power rail and ground
//   - LDO: P = (Vin − Vout) × Iout, where Iout is summed downstream load
//   - switching regulator: P = Iout × Vout × (1/η − 1) using η=0.85 default
//   - LED: P ≈ Vf × If, with If from the series resistor if present
//   - ICs: needsDatasheet (absolute power not derivable from schematic alone)
//
// kicad-happy reference: skills/kicad/scripts/analyze_thermal.py

import { parseSiValue } from './emc';

export interface ThermalSnapshot {
	components: Record<string, {
		designator: string;
		mpn?: string;
		value?: string;
		deviceClass?: string;
		pins?: Record<string, { name: string; net: string }>;
		otherProperties?: Record<string, any>;
	}>;
	nets: Record<string, {
		name: string;
		isPower?: boolean;
		isGround?: boolean;
	}>;
}

export interface ThermalEstimate {
	designator: string;
	deviceClass: string;
	mpn?: string;
	value?: string;
	powerWatts: number | null;     // null = couldn't estimate
	method: 'V_over_R' | 'LDO_drop' | 'switcher_loss' | 'led_drive' | 'unknown' | 'datasheet_needed';
	assumptions: string[];
	needsDatasheet: boolean;
	severity: 'critical' | 'warning' | 'info' | 'ok';
	notes: string[];
}

export interface ThermalReport {
	totalEstimatedWatts: number | null; // subtotal of modeled components, never whole-board power
	coverage: { totalComponents: number; estimatedComponents: number; unknownComponents: number };
	estimates: ThermalEstimate[];
	hottest: ThermalEstimate[];   // top 5 by absolute power
	bySeverity: Record<'critical' | 'warning' | 'info' | 'ok', number>;
	componentsNeedingDatasheet: string[];
	summary: string;
}

// ---------------------------------------------------------------------------
// Rail voltage inference — best effort. We pattern-match net names to a
// nominal voltage. Better: walk power tree. For now the regex-based pass is
// enough to cover 90% of designs.
// ---------------------------------------------------------------------------

const RAIL_VOLTAGE_PATTERNS: Array<{ re: RegExp; volts: number }> = [
	{ re: /^V?\+?12V?\b/i, volts: 12 },
	{ re: /^V?\+?9V?\b/i, volts: 9 },
	{ re: /^V?\+?5V?\b/i, volts: 5 },
	{ re: /^V?3V3\b|^VCC3V3|^VDD3V3\b/i, volts: 3.3 },
	{ re: /^V?2V5\b/i, volts: 2.5 },
	{ re: /^V?1V8\b|^VCC1V8|^VDD1V8\b/i, volts: 1.8 },
	{ re: /^V?1V2\b/i, volts: 1.2 },
	{ re: /^V?1V0\b|^V?1V\b/i, volts: 1.0 },
	{ re: /^V?0V8\b/i, volts: 0.8 },
];

export function inferRailVoltage(netName: string): number | null {
	for (const { re, volts } of RAIL_VOLTAGE_PATTERNS) {
		if (re.test(netName)) return volts;
	}
	// "NVM" notation (3V3 = 3.3V, 1V8 = 1.8V, +3V3, V_3V3, etc.)
	const mNvm = netName.match(/[+\-_]?(?:V_?)?(\d+)V(\d+)\b/i);
	if (mNvm) return parseFloat(`${mNvm[1]}.${mNvm[2]}`);
	// Fallback "5V", "12V", "+5V" → 5, 12, 5
	const m = netName.match(/[+\-_]?(?:V_?)?(\d+(?:[.,]\d+)?)\s*[Vv]/);
	if (m) return parseFloat(m[1].replace(',', '.'));
	return null;
}

// ---------------------------------------------------------------------------
// Resistor power: P = V²/R when R sits between a known rail and ground.
// ---------------------------------------------------------------------------

function estimateResistor(c: ThermalSnapshot['components'][string], snap: ThermalSnapshot): ThermalEstimate {
	const out: ThermalEstimate = {
		designator: c.designator,
		deviceClass: 'resistor',
		mpn: c.mpn,
		value: c.value,
		powerWatts: null,
		method: 'unknown',
		assumptions: [],
		needsDatasheet: false,
		severity: 'ok',
		notes: [],
	};

	const r = parseSiValue(c.value);
	if (!Number.isFinite(r) || r <= 0) {
		out.notes.push('resistance not parseable from value field');
		return out;
	}

	if (!c.pins) return out;
	const nets = Object.values(c.pins).map((p) => p.net).filter(Boolean);
	if (nets.length < 2) return out;

	// Find rail+ground pairing
	let railVolts: number | null = null;
	let bridgesGround = false;
	for (const n of nets) {
		const net = snap.nets[n];
		if (!net) continue;
		if (net.isGround) bridgesGround = true;
		else if (net.isPower) {
			const v = inferRailVoltage(net.name);
			if (v != null) railVolts = v;
		}
	}

	if (railVolts != null && bridgesGround) {
		const p = (railVolts * railVolts) / r;
		out.powerWatts = p;
		out.method = 'V_over_R';
		out.assumptions.push(`Resistor bridges power rail (${railVolts}V) and GND`);
		// Severity classification — assume 0603 ≈ 0.1W, 0805 ≈ 0.125W rated.
		if (p >= 0.5) out.severity = 'critical';
		else if (p >= 0.25) out.severity = 'warning';
		else if (p >= 0.1) out.severity = 'info';
		else out.severity = 'ok';
		if (out.severity !== 'ok') {
			out.notes.push(`Verify resistor package power rating ≥ ${p.toFixed(3)}W (typical 0603=0.1W, 0805=0.125W, 1206=0.25W).`);
		}
	} else {
		out.notes.push('No rail-to-ground bridge detected — power not estimated. Likely a signal/divider resistor with negligible dissipation.');
	}
	return out;
}

// ---------------------------------------------------------------------------
// LDO dissipation. Output current isn't known from the schematic; we try to
// estimate downstream load by counting components on the output rail and
// multiplying by per-IC rough current (conservative 50mA each).
// ---------------------------------------------------------------------------

const LDO_LOAD_PER_IC_AMPS = 0.05;  // very rough, per-IC default downstream
const LDO_DEFAULT_OUTPUT = 0.1;     // safety floor 100mA when we can't estimate

function estimateLdo(c: ThermalSnapshot['components'][string], snap: ThermalSnapshot): ThermalEstimate {
	const out: ThermalEstimate = {
		designator: c.designator,
		deviceClass: 'regulator_ldo',
		mpn: c.mpn,
		value: c.value,
		powerWatts: null,
		method: 'LDO_drop',
		assumptions: [],
		needsDatasheet: false,
		severity: 'ok',
		notes: [],
	};

	if (!c.pins) return out;
	const inPin = Object.values(c.pins).find((p) => /VIN|^IN$/i.test(p.name));
	const outPin = Object.values(c.pins).find((p) => /VOUT|^OUT$/i.test(p.name));
	if (!inPin || !outPin) {
		out.notes.push('VIN/VOUT pins not labeled — cannot estimate drop');
		return out;
	}

	const vin = inferRailVoltage(inPin.net);
	const vout = inferRailVoltage(outPin.net);
	if (vin == null || vout == null) {
		out.notes.push('Could not infer Vin/Vout from net names');
		return out;
	}
	if (vin <= vout) {
		out.notes.push(`Vin (${vin}V) ≤ Vout (${vout}V) — net naming likely backwards`);
		return out;
	}

	// Estimate downstream load on the output rail.
	let downstreamIcs = 0;
	for (const o of Object.values(snap.components)) {
		if (!o.pins) continue;
		for (const p of Object.values(o.pins)) {
			if (p.net === outPin.net && /VCC|VDD|V\+|VIN/i.test(p.name)) {
				if (/^(ic|regulator_)/i.test(o.deviceClass || '')) downstreamIcs += 1;
			}
		}
	}
	const iout = Math.max(downstreamIcs * LDO_LOAD_PER_IC_AMPS, LDO_DEFAULT_OUTPUT);
	const p = (vin - vout) * iout;
	out.powerWatts = p;
	out.assumptions.push(`Estimated downstream load: ${downstreamIcs} IC(s) × ${LDO_LOAD_PER_IC_AMPS}A = ${iout.toFixed(3)}A (floor ${LDO_DEFAULT_OUTPUT}A)`);
	out.assumptions.push(`Drop: ${vin}V − ${vout}V = ${(vin - vout).toFixed(2)}V`);
	if (p >= 1.0) out.severity = 'critical';
	else if (p >= 0.5) out.severity = 'warning';
	else if (p >= 0.2) out.severity = 'info';

	if (out.severity !== 'ok') {
		out.notes.push(`Verify LDO package thermal rating. SOT-23 ≈ 0.4W, SOT-223 ≈ 1.5W, TO-220 ≈ 5W (with heatsink).`);
		out.needsDatasheet = true;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Switching regulator loss = Iout × Vout × (1/η - 1)
// ---------------------------------------------------------------------------

const SWITCHER_DEFAULT_EFFICIENCY = 0.85;

function estimateSwitcher(c: ThermalSnapshot['components'][string], snap: ThermalSnapshot, efficiency = SWITCHER_DEFAULT_EFFICIENCY): ThermalEstimate {
	const out: ThermalEstimate = {
		designator: c.designator,
		deviceClass: c.deviceClass || 'regulator_buck',
		mpn: c.mpn,
		value: c.value,
		powerWatts: null,
		method: 'switcher_loss',
		assumptions: [],
		needsDatasheet: false,
		severity: 'ok',
		notes: [],
	};
	if (!c.pins) return out;
	const outPin = Object.values(c.pins).find((p) => /VOUT|^OUT$/i.test(p.name));
	if (!outPin) {
		out.notes.push('VOUT pin not labeled — cannot estimate');
		return out;
	}
	const vout = inferRailVoltage(outPin.net);
	if (vout == null) {
		out.notes.push('Could not infer Vout from net name');
		return out;
	}

	let downstreamIcs = 0;
	for (const o of Object.values(snap.components)) {
		if (!o.pins) continue;
		for (const p of Object.values(o.pins)) {
			if (p.net === outPin.net && /VCC|VDD|V\+|VIN/i.test(p.name)) {
				if (/^(ic|regulator_)/i.test(o.deviceClass || '')) downstreamIcs += 1;
			}
		}
	}
	const iout = Math.max(downstreamIcs * 0.1, 0.2); // switchers usually drive heavier rails
	const p = vout * iout * (1 / efficiency - 1);
	out.powerWatts = p;
	out.assumptions.push(`Assumed efficiency η=${efficiency}, Iout≈${iout.toFixed(2)}A`);
	if (p >= 1.5) out.severity = 'critical';
	else if (p >= 0.8) out.severity = 'warning';
	else if (p >= 0.3) out.severity = 'info';
	if (out.severity !== 'ok') out.needsDatasheet = true;
	return out;
}

// ---------------------------------------------------------------------------
// LED drive — Vf × If, where If is set by the series resistor.
// ---------------------------------------------------------------------------

function estimateLed(c: ThermalSnapshot['components'][string], snap: ThermalSnapshot): ThermalEstimate {
	const out: ThermalEstimate = {
		designator: c.designator,
		deviceClass: 'led',
		mpn: c.mpn,
		value: c.value,
		powerWatts: null,
		method: 'led_drive',
		assumptions: [],
		needsDatasheet: false,
		severity: 'ok',
		notes: [],
	};
	if (!c.pins) return out;
	const nets = Object.values(c.pins).map((p) => p.net);

	// Find series resistor on either net.
	let seriesR: number | null = null;
	let railVolts: number | null = null;
	for (const n of nets) {
		for (const r of Object.values(snap.components)) {
			if ((r.deviceClass || '') !== 'resistor' || !r.pins) continue;
			const rNets = Object.values(r.pins).map((p) => p.net);
			if (!rNets.includes(n)) continue;
			const rVal = parseSiValue(r.value);
			if (!Number.isFinite(rVal)) continue;
			seriesR = rVal;
			// other net of the resistor likely connects to a rail
			const otherNet = rNets.find((nn) => nn !== n);
			if (otherNet) {
				const v = inferRailVoltage(otherNet);
				if (v != null) railVolts = v;
			}
			break;
		}
		if (seriesR && railVolts) break;
	}

	const Vf = 2.0; // generic red/green LED forward voltage default
	if (seriesR && railVolts) {
		const If = (railVolts - Vf) / seriesR;
		const p = Vf * If;
		out.powerWatts = p;
		out.assumptions.push(`Vf=${Vf}V (default), Vrail=${railVolts}V, Rseries=${seriesR}Ω → If=${(If * 1000).toFixed(1)}mA`);
		if (If > 0.025) out.severity = 'warning';
		if (If > 0.05) out.severity = 'critical';
		if (out.severity !== 'ok') out.notes.push('Forward current looks high — verify Vf from datasheet and confirm package can dissipate.');
	} else {
		out.notes.push('Could not find series resistor + rail voltage — power not estimated');
	}
	return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ThermalOptions {
	switcherEfficiency?: number;
	includeOk?: boolean; // default false — skip 0-power signal resistors etc.
}

export function analyzeThermal(snap: ThermalSnapshot, opts: ThermalOptions = {}): ThermalReport {
	const estimates: ThermalEstimate[] = [];
	const needsDs: Set<string> = new Set();

	for (const c of Object.values(snap.components)) {
		const dc = (c.deviceClass || '').toLowerCase();
		let est: ThermalEstimate | null = null;
		if (dc === 'resistor') est = estimateResistor(c, snap);
		else if (dc === 'regulator_ldo') est = estimateLdo(c, snap);
		else if (dc === 'regulator_buck' || dc === 'regulator_boost') est = estimateSwitcher(c, snap, opts.switcherEfficiency);
		else if (dc === 'led') est = estimateLed(c, snap);
		else if (dc === 'ic') {
			est = {
				designator: c.designator,
				deviceClass: 'ic',
				mpn: c.mpn,
				value: c.value,
				powerWatts: null,
				method: 'datasheet_needed',
				assumptions: [],
				needsDatasheet: true,
				severity: 'info',
				notes: ['IC dissipation requires datasheet (Iq, dynamic current vs. clock, θ_JA). See datasheet_fetch / datasheet_get_cached for the PDF.'],
			};
		}

		if (!est) continue;
		estimates.push(est);
		if (est.needsDatasheet) needsDs.add(c.designator);
	}

	estimates.sort((a, b) => (b.powerWatts ?? 0) - (a.powerWatts ?? 0));

	const known = estimates.filter(e => e.powerWatts !== null && Number.isFinite(e.powerWatts));
	const totalWatts = known.length ? known.reduce((acc, e) => acc + e.powerWatts!, 0) : null;
	const coverage = { totalComponents: Object.keys(snap.components).length, estimatedComponents: known.length, unknownComponents: Object.keys(snap.components).length - known.length };
	const bySeverity = { critical: 0, warning: 0, info: 0, ok: 0 } as Record<'critical' | 'warning' | 'info' | 'ok', number>;
	for (const e of estimates) bySeverity[e.severity] += 1;

	return {
		totalEstimatedWatts: totalWatts,
		coverage,
		estimates: estimates.filter(e => opts.includeOk || e.powerWatts === null || e.severity !== 'ok' || e.powerWatts >= 0.05),
		hottest: known.slice(0, 5),
		bySeverity,
		componentsNeedingDatasheet: [...needsDs],
		summary: `${totalWatts === null ? 'Power cannot be estimated from the available inputs.' : `Modeled subtotal ${totalWatts.toFixed(3)} W across ${known.length} components; this is not total board dissipation.`} ${coverage.unknownComponents} of ${coverage.totalComponents} components have no power estimate. ${needsDs.size} require datasheet data. No junction temperatures are established.`,
	};
}

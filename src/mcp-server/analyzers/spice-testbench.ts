// SPICE testbench generator. Detects subcircuits in a sch_extract_design
// snapshot and emits text-mode SPICE testbenches the user can paste into
// EasyEDA's built-in simulator (or run with ngspice externally).
//
// kicad-happy reference: skills/spice/scripts/spice_templates.py

import { parseSiValue } from './emc';
import type { DesignSnapshotMinimal } from './bom';

export interface SpiceTestbench {
	name: string;
	subcircuit: 'voltage_divider' | 'rc_filter' | 'ldo_regulator' | 'buck_regulator' | 'current_limit_resistor' | 'led_drive';
	description: string;
	netlist: string;     // SPICE netlist text
	stimulus: string;    // .tran / .ac / .dc command
	expected: { metric: string; value: string; tolerance?: string }[];
	involvedDesignators: string[];
}

interface Comp {
	designator: string;
	mpn?: string;
	value?: string;
	deviceClass?: string;
	pins?: Record<string, { name: string; net: string }>;
}

function isPowerNet(name: string): boolean {
	const n = (name ?? '').toUpperCase();
	const stripped = n.replace(/^[+\-_]+/, '').replace(/^V_/, '');
	if (/^(VCC|VDD|V\+|VIN|VOUT|3V3|5V|1V8|1V2|2V5|VBAT|VBUS|VSYS|AVDD|DVDD)/.test(stripped)) return true;
	if (/^\d+(V\d+|V|\.\d+V)/.test(stripped)) return true;
	return false;
}
function isGroundNet(name: string): boolean { return /^(GND|VSS|0V|AGND|DGND|PGND|EGND)/i.test(name); }

function siFmt(v: number, unit = ''): string {
	if (!Number.isFinite(v)) return `${v}${unit}`;
	const abs = Math.abs(v);
	const tiers: Array<[number, string]> = [[1e9, 'G'], [1e6, 'Meg'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p']];
	for (const [scale, suffix] of tiers) {
		if (abs >= scale || scale === 1e-12) {
			return `${(v / scale).toFixed(3).replace(/\.?0+$/, '')}${suffix}${unit}`;
		}
	}
	return `${v}${unit}`;
}

/** Detect resistive voltage dividers (R from a power rail to GND with a tap node). */
export function generateDividerTestbenches(snap: DesignSnapshotMinimal): SpiceTestbench[] {
	const out: SpiceTestbench[] = [];
	const components = Object.values(snap.components ?? {}) as Comp[];
	const resistors = components.filter((c) => c.deviceClass === 'resistor' && c.pins);

	// Pair-of-resistors pattern: two resistors share one pin and the other ends are power+gnd.
	const byNet = new Map<string, Comp[]>();
	for (const r of resistors) {
		for (const p of Object.values(r.pins!)) {
			if (!byNet.has(p.net)) byNet.set(p.net, []);
			byNet.get(p.net)!.push(r);
		}
	}

	const seen = new Set<string>();
	for (const [midNet, rs] of byNet) {
		if (rs.length < 2) continue;
		// Find R_top (other pin on power) and R_bot (other pin on gnd)
		const tops: Comp[] = [];
		const bots: Comp[] = [];
		for (const r of rs) {
			const otherPins = Object.values(r.pins!).filter((p) => p.net !== midNet);
			if (otherPins.some((p) => isPowerNet(p.net))) tops.push(r);
			if (otherPins.some((p) => isGroundNet(p.net))) bots.push(r);
		}
		if (tops.length === 0 || bots.length === 0) continue;
		const rtop = tops[0], rbot = bots[0];
		const key = [rtop.designator, rbot.designator].sort().join('+');
		if (seen.has(key)) continue;
		seen.add(key);
		const r1 = parseSiValue(rtop.value);
		const r2 = parseSiValue(rbot.value);
		if (!Number.isFinite(r1) || !Number.isFinite(r2)) continue;
		const vinNet = Object.values(rtop.pins!).find((p) => p.net !== midNet && isPowerNet(p.net))?.net ?? 'VIN';
		const ratio = r2 / (r1 + r2);
		out.push({
			name: `divider_${rtop.designator}_${rbot.designator}`,
			subcircuit: 'voltage_divider',
			description: `Voltage divider ${rtop.designator} (${siFmt(r1, 'Ω')}) / ${rbot.designator} (${siFmt(r2, 'Ω')}) at net ${midNet}.`,
			netlist: [
				`* Voltage divider ${rtop.designator}/${rbot.designator}`,
				`V1 ${vinNet} 0 DC 5`,
				`R_top ${vinNet} ${midNet} ${siFmt(r1, '')}`,
				`R_bot ${midNet} 0 ${siFmt(r2, '')}`,
				`.op`,
				`.print op v(${midNet})`,
				`.end`,
			].join('\n'),
			stimulus: '.op',
			expected: [{ metric: `v(${midNet})`, value: `${ratio.toFixed(4)} × Vin`, tolerance: '5%' }],
			involvedDesignators: [rtop.designator, rbot.designator],
		});
	}
	return out;
}

/** RC low-pass filter detection. STRICT — only flags genuine series-pass
 *  topologies: R between two distinct non-power, non-ground nets, with a
 *  cap from one of those nets to GND. Without strictness the analyzer
 *  returns every R+C pair sharing a power rail (cartesian explosion). */
export function generateRcFilterTestbenches(snap: DesignSnapshotMinimal): SpiceTestbench[] {
	const out: SpiceTestbench[] = [];
	const components = Object.values(snap.components ?? {}) as Comp[];
	const resistors = components.filter((c) => c.deviceClass === 'resistor' && c.pins);
	const capacitors = components.filter((c) => c.deviceClass === 'capacitor' && c.pins);

	// Index caps that bridge an arbitrary net to GND (quick lookup).
	const capsByNonGndNet = new Map<string, Comp[]>();
	for (const c of capacitors) {
		const cPins = Object.values(c.pins!);
		if (cPins.length !== 2) continue;
		const grounded = cPins.find((p) => isGroundNet(p.net));
		const other = cPins.find((p) => p !== grounded);
		if (!grounded || !other) continue;
		if (isPowerNet(other.net)) continue; // bulk-decoupling cap, not a filter element
		if (!capsByNonGndNet.has(other.net)) capsByNonGndNet.set(other.net, []);
		capsByNonGndNet.get(other.net)!.push(c);
	}

	for (const r of resistors) {
		const rPins = Object.values(r.pins!);
		if (rPins.length !== 2) continue;
		const [pA, pB] = rPins;
		// Reject resistors that bridge power+gnd (those are voltage dividers, not filters)
		const isAGnd = isGroundNet(pA.net), isBGnd = isGroundNet(pB.net);
		const isAPwr = isPowerNet(pA.net), isBPwr = isPowerNet(pB.net);
		if (isAGnd || isBGnd) continue;

		// One pin should be on a power rail (input), the other on a non-power
		// non-ground signal (output) that also has a cap-to-GND.
		let inputPin: { name: string; net: string } | null = null;
		let outputPin: { name: string; net: string } | null = null;
		if (isAPwr && !isBPwr) { inputPin = pA; outputPin = pB; }
		else if (isBPwr && !isAPwr) { inputPin = pB; outputPin = pA; }
		else continue; // need exactly-one power pin

		const filterCaps = capsByNonGndNet.get(outputPin.net);
		if (!filterCaps || filterCaps.length === 0) continue;
		// Use the first matching cap; pick the smallest value (most likely the filter cap, not bulk).
		const c = filterCaps.reduce((acc, x) => (parseSiValue(x.value) < parseSiValue(acc.value) ? x : acc));

		const R = parseSiValue(r.value), C = parseSiValue(c.value);
		if (!Number.isFinite(R) || !Number.isFinite(C)) continue;
		const fc = 1 / (2 * Math.PI * R * C);
		out.push({
			name: `rc_filter_${r.designator}_${c.designator}`,
			subcircuit: 'rc_filter',
			description: `RC low-pass: ${r.designator} (${siFmt(R, 'Ω')}) + ${c.designator} (${siFmt(C, 'F')}). Vin=${inputPin.net} → Vout=${outputPin.net}. fc = ${siFmt(fc, 'Hz')}`,
			netlist: [
				`* RC filter ${r.designator}/${c.designator}`,
				`V1 ${inputPin.net} 0 DC 0 AC 1`,
				`R1 ${inputPin.net} ${outputPin.net} ${siFmt(R, '')}`,
				`C1 ${outputPin.net} 0 ${siFmt(C, '')}`,
				`.ac dec 20 ${siFmt(fc / 100, '')} ${siFmt(fc * 100, '')}`,
				`.print ac vdb(${outputPin.net}) vp(${outputPin.net})`,
				`.end`,
			].join('\n'),
			stimulus: '.ac decade sweep',
			expected: [{ metric: 'fc (-3dB)', value: siFmt(fc, 'Hz'), tolerance: '10%' }],
			involvedDesignators: [r.designator, c.designator],
		});
	}
	return out;
}

/** LED + series resistor drive: V = (Vrail - Vf) / R. */
export function generateLedDriveTestbenches(snap: DesignSnapshotMinimal): SpiceTestbench[] {
	const out: SpiceTestbench[] = [];
	const components = Object.values(snap.components ?? {}) as Comp[];
	const leds = components.filter((c) => c.deviceClass === 'led' && c.pins);
	const resistors = components.filter((c) => c.deviceClass === 'resistor' && c.pins);

	for (const led of leds) {
		const ledNets = Object.values(led.pins!).map((p) => p.net);
		for (const r of resistors) {
			const rPins = Object.values(r.pins!);
			const sharedNet = rPins.find((p) => ledNets.includes(p.net));
			if (!sharedNet) continue;
			const railPin = rPins.find((p) => p !== sharedNet && isPowerNet(p.net));
			if (!railPin) continue;
			const R = parseSiValue(r.value);
			if (!Number.isFinite(R)) continue;
			const Vrail = /3V3/i.test(railPin.net) ? 3.3 : /5V/i.test(railPin.net) ? 5 : /12V/i.test(railPin.net) ? 12 : 5;
			const Vf = 2.0;
			const If = (Vrail - Vf) / R * 1000;
			out.push({
				name: `led_${led.designator}_${r.designator}`,
				subcircuit: 'led_drive',
				description: `LED ${led.designator} drive via ${r.designator} (${siFmt(R, 'Ω')}). Estimated If=${If.toFixed(1)}mA on ${railPin.net}.`,
				netlist: [
					`* LED drive ${led.designator}/${r.designator}`,
					`V1 ${railPin.net} 0 DC ${Vrail}`,
					`R1 ${railPin.net} ${sharedNet.net} ${siFmt(R, '')}`,
					`Dled ${sharedNet.net} 0 LED`,
					`.model LED D (IS=1e-15 N=1.5)`,
					`.op`,
					`.print op i(R1)`,
					`.end`,
				].join('\n'),
				stimulus: '.op',
				expected: [{ metric: 'If', value: `${If.toFixed(1)}mA`, tolerance: '20%' }],
				involvedDesignators: [led.designator, r.designator],
			});
		}
	}
	return out;
}

export interface SpiceReport {
	testbenches: SpiceTestbench[];
	stats: { total: number; bySubcircuit: Record<string, number> };
	summary: string;
}

export function generateSpiceTestbenches(snap: DesignSnapshotMinimal): SpiceReport {
	const all = [
		...generateDividerTestbenches(snap),
		...generateRcFilterTestbenches(snap),
		...generateLedDriveTestbenches(snap),
	];
	const bySub: Record<string, number> = {};
	for (const t of all) bySub[t.subcircuit] = (bySub[t.subcircuit] ?? 0) + 1;
	return {
		testbenches: all,
		stats: { total: all.length, bySubcircuit: bySub },
		summary: `${all.length} testbenches generated: ${Object.entries(bySub).map(([k, v]) => `${k}=${v}`).join(', ')}.`,
	};
}

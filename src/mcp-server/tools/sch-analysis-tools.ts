// Schematic-side analyzers. All run in the MCP server process consuming
// the snapshot from sch_extract_design — no extension round-trip per check.
//
// This module is the foundation for the kicad-happy port: power tree,
// decoupling audit, passive-network detection, ESD / connector audit, etc.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';

// ---------------------------------------------------------------------------
// Snapshot types (mirror what sch.extract.design produces server-side).
// Kept loose so we don't fail on shape drift.

interface PinRef {
	designator: string;
	pinNumber: string;
	pinName: string;
}

interface NetInfo {
	name: string;
	pinCount: number;
	members: PinRef[];
	isPower: boolean;
	isGround: boolean;
	autoNamed: boolean;
}

interface ComponentInfo {
	designator: string;
	primitiveId: string;
	uniqueId?: string;
	name?: string;
	mpn?: string;
	manufacturer?: string;
	supplier?: string;
	supplierId?: string;
	value?: string;
	unit?: string;
	footprint?: string;
	position?: { x: number; y: number; rotation: number; mirror?: boolean };
	pins?: Record<string, { name: string; net: string }>;
	deviceClass?: string;
	otherProperties?: Record<string, any>;
}

interface DesignSnapshot {
	project?: { name?: string; uuid?: string };
	page: { uuid?: string; name?: string };
	componentCount: number;
	netCount: number;
	components: Record<string, ComponentInfo>;
	nets: Record<string, NetInfo>;
	/** Not read by any analyzer; dropped from sch_extract_design output unless requested. */
	pinIndex?: PinRef[];
	stats: {
		byClass: Record<string, number>;
		passiveByValue: { resistors: number; capacitors: number; inductors: number };
		nets: { power: number; ground: number; signal: number; autoNamed: number };
	};
}

// ---------------------------------------------------------------------------
// Helpers

const SI: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9 };

function parseQuantity(formatted: string | undefined): number | undefined {
	if (!formatted) return undefined;
	const m = formatted.match(/(-?\d+(?:\.\d+)?)\s*([pnuµmkMG]?)/);
	if (!m) return undefined;
	const num = parseFloat(m[1]);
	const scale = SI[m[2] || ''] ?? 1;
	if (!Number.isFinite(num)) return undefined;
	return num * scale;
}

function formatHz(hz: number): string {
	if (hz >= 1e9) return `${(hz / 1e9).toFixed(2)} GHz`;
	if (hz >= 1e6) return `${(hz / 1e6).toFixed(2)} MHz`;
	if (hz >= 1e3) return `${(hz / 1e3).toFixed(2)} kHz`;
	if (hz >= 1) return `${hz.toFixed(2)} Hz`;
	return `${(hz * 1e3).toFixed(2)} mHz`;
}

function isGroundNet(net: NetInfo | undefined): boolean {
	return !!net?.isGround;
}

function nonGroundPins(component: ComponentInfo): Array<{ pinNumber: string; net: string; name: string }> {
	const out: Array<{ pinNumber: string; net: string; name: string }> = [];
	for (const [pinNumber, info] of Object.entries(component.pins || {})) {
		out.push({ pinNumber, net: info.net, name: info.name });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Analyzers

interface PowerTreeNode {
	rail: string;
	source: string; // designator | "EXTERNAL"
	regulatorClass?: 'ldo' | 'buck' | 'boost';
	regulatorMpn?: string;
	inputRail?: string;
	feedback?: { topResistor?: string; bottomResistor?: string; ratio?: number; vrefAssumed?: number; voutComputed?: number };
	loads: Array<{ designator: string; pinNumber: string; deviceClass?: string }>;
	children: PowerTreeNode[];
}

function analyzePowerTree(snap: DesignSnapshot): { rails: PowerTreeNode[]; orphanedRails: string[] } {
	const components = snap.components || {};
	const nets = snap.nets || {};

	const powerRails = Object.values(nets).filter((n) => n.isPower).map((n) => n.name);

	// For each power rail, find a regulator whose OUTPUT connects to that rail.
	// "OUTPUT" detection heuristic: pin name in {OUT, VOUT, SW, LX, FB optional}.
	const regulators = Object.values(components).filter((c) =>
		c.deviceClass === 'regulator_ldo' ||
		c.deviceClass === 'regulator_buck' ||
		c.deviceClass === 'regulator_boost',
	);

	const railToRegulator: Record<string, ComponentInfo> = {};
	for (const reg of regulators) {
		for (const [, pin] of Object.entries(reg.pins || {})) {
			const upper = (pin.name || '').toUpperCase();
			if (/^V?OUT|^SW$|^LX$|^OUT_/i.test(upper) && powerRails.includes(pin.net)) {
				railToRegulator[pin.net] = reg;
			}
		}
	}

	// Feedback divider: find R1 + R2 forming a divider from rail → FB → GND.
	const findFeedback = (reg: ComponentInfo): PowerTreeNode['feedback'] => {
		// Find a pin named FB or VFB on the regulator.
		const fbPin = Object.entries(reg.pins || {}).find(([, p]) => /^V?FB|^FEEDBACK/i.test((p.name || '').toUpperCase()));
		if (!fbPin) return undefined;
		const fbNet = fbPin[1].net;
		if (!fbNet) return undefined;

		// Resistors with one end on fbNet — find the two that form a divider to GND and Vout.
		const resistorsOnFb = Object.values(components).filter((c) =>
			c.deviceClass === 'resistor' && Object.values(c.pins || {}).some((p) => p.net === fbNet),
		);
		if (resistorsOnFb.length < 2) return undefined;

		// One has the other end on a power rail (top), the other has it on GND (bottom).
		let top: ComponentInfo | undefined;
		let bottom: ComponentInfo | undefined;
		for (const r of resistorsOnFb) {
			const otherNets = Object.values(r.pins || {}).map((p) => p.net).filter((n) => n && n !== fbNet);
			for (const n of otherNets) {
				const netMeta = nets[n];
				if (!netMeta) continue;
				if (netMeta.isGround) bottom = r;
				else if (netMeta.isPower) top = r;
			}
		}
		if (!top || !bottom) return undefined;

		const r1 = parseQuantity(top.value);
		const r2 = parseQuantity(bottom.value);
		if (!r1 || !r2) return undefined;
		const ratio = r2 / (r1 + r2);
		// Most fixed-output regulators feedback at ~0.6V (buck) or 1.225V (LDO).
		const vrefAssumed = reg.deviceClass === 'regulator_buck' ? 0.6 : 1.225;
		const voutComputed = vrefAssumed / ratio;
		return {
			topResistor: `${top.designator} (${top.value ?? '?'})`,
			bottomResistor: `${bottom.designator} (${bottom.value ?? '?'})`,
			ratio: Number(ratio.toFixed(4)),
			vrefAssumed,
			voutComputed: Number(voutComputed.toFixed(3)),
		};
	};

	const rails: PowerTreeNode[] = [];
	const seenRails = new Set<string>();

	for (const railName of powerRails) {
		if (seenRails.has(railName)) continue;
		seenRails.add(railName);

		const reg = railToRegulator[railName];
		const railLoads = (nets[railName]?.members || [])
			.filter((m) => !regulators.some((r) => r.designator === m.designator))
			.map((m) => ({
				designator: m.designator,
				pinNumber: m.pinNumber,
				deviceClass: components[m.designator]?.deviceClass,
			}));

		// Find input rail: regulator's IN pin's net.
		let inputRail: string | undefined;
		if (reg) {
			const inPin = Object.entries(reg.pins || {}).find(([, p]) => /^V?IN|^INPUT/i.test((p.name || '').toUpperCase()));
			if (inPin) inputRail = inPin[1].net;
		}

		rails.push({
			rail: railName,
			source: reg?.designator ?? 'EXTERNAL',
			regulatorClass: reg ? (reg.deviceClass!.replace(/^regulator_/, '') as 'ldo' | 'buck' | 'boost') : undefined,
			regulatorMpn: reg?.mpn,
			inputRail,
			feedback: reg ? findFeedback(reg) : undefined,
			loads: railLoads,
			children: [],
		});
	}

	// Build hierarchy: rails whose source-regulator's input is another rail nest under that rail.
	const railByName: Record<string, PowerTreeNode> = {};
	for (const r of rails) railByName[r.rail] = r;
	const roots: PowerTreeNode[] = [];
	for (const r of rails) {
		const parent = r.inputRail ? railByName[r.inputRail] : undefined;
		if (parent) parent.children.push(r);
		else roots.push(r);
	}

	const orphanedRails = powerRails.filter((r) => !railToRegulator[r] && !rails.find((node) => node.rail === r && node.children.length > 0));

	return { rails: roots, orphanedRails };
}

interface DecouplingReport {
	rails: Array<{
		rail: string;
		capCount: number;
		totalCapacitance?: string;
		caps: Array<{ designator: string; value?: string; nearestIcPin?: string }>;
		warnings: string[];
	}>;
}

function analyzeDecoupling(snap: DesignSnapshot): DecouplingReport {
	const components = snap.components || {};
	const nets = snap.nets || {};
	const groundNetNames = new Set(Object.values(nets).filter((n) => n.isGround).map((n) => n.name));
	const powerNetNames = Object.values(nets).filter((n) => n.isPower).map((n) => n.name);

	const result: DecouplingReport['rails'] = [];

	for (const rail of powerNetNames) {
		const caps: Array<ComponentInfo> = [];
		for (const comp of Object.values(components)) {
			if (comp.deviceClass !== 'capacitor') continue;
			const netsOnCap = Object.values(comp.pins || {}).map((p) => p.net);
			if (netsOnCap.includes(rail) && netsOnCap.some((n) => groundNetNames.has(n))) {
				caps.push(comp);
			}
		}

		const total = caps.reduce((sum, c) => sum + (parseQuantity(c.value) || 0), 0);
		const ics = (nets[rail]?.members || [])
			.filter((m) => components[m.designator]?.deviceClass === 'ic')
			.map((m) => `${m.designator}.${m.pinNumber}`);

		const warnings: string[] = [];
		if (caps.length === 0) {
			warnings.push(`No decoupling capacitors found on ${rail}.`);
		} else if (ics.length > 0 && caps.length < ics.length) {
			warnings.push(`${caps.length} cap(s) for ${ics.length} IC pin(s) on this rail — typical guideline is 1 cap per IC pin.`);
		}

		result.push({
			rail,
			capCount: caps.length,
			totalCapacitance: total > 0 ? formatFarads(total) : undefined,
			caps: caps.map((c) => ({
				designator: c.designator,
				value: c.value,
				nearestIcPin: ics[0],
			})),
			warnings,
		});
	}

	return { rails: result };
}

function formatFarads(f: number): string {
	if (f >= 1) return `${f.toFixed(2)} F`;
	if (f >= 1e-3) return `${(f * 1e3).toFixed(2)} mF`;
	if (f >= 1e-6) return `${(f * 1e6).toFixed(2)} µF`;
	if (f >= 1e-9) return `${(f * 1e9).toFixed(2)} nF`;
	return `${(f * 1e12).toFixed(2)} pF`;
}

interface PassiveNetwork {
	type: 'rc_filter' | 'voltage_divider' | 'crystal_load';
	components: string[];
	computed: Record<string, string | number>;
	notes?: string;
}

function analyzePassiveNetworks(snap: DesignSnapshot): { detections: PassiveNetwork[] } {
	const components = snap.components || {};
	const nets = snap.nets || {};
	const groundNetNames = new Set(Object.values(nets).filter((n) => n.isGround).map((n) => n.name));

	const detections: PassiveNetwork[] = [];

	// 1. RC low-pass: signal --R-- midNet --C-- GND. R has one pin on signalNet,
	//    other on midNet; C has one pin on midNet, other on GND.
	const resistors = Object.values(components).filter((c) => c.deviceClass === 'resistor' && c.value);
	const caps = Object.values(components).filter((c) => c.deviceClass === 'capacitor' && c.value);

	for (const r of resistors) {
		const rPins = Object.entries(r.pins || {});
		if (rPins.length < 2) continue;
		const [pinA, pinB] = [rPins[0][1], rPins[1][1]];
		// neither end on GND/power for an RC filter on a signal
		if (groundNetNames.has(pinA.net) || groundNetNames.has(pinB.net)) continue;
		if (nets[pinA.net]?.isPower || nets[pinB.net]?.isPower) continue;

		for (const midNet of [pinA.net, pinB.net]) {
			const otherNet = midNet === pinA.net ? pinB.net : pinA.net;
			// Find a cap with one pin on midNet and the other on GND.
			const cap = caps.find((c) => {
				const pins = Object.values(c.pins || {});
				if (pins.length < 2) return false;
				return pins.some((p) => p.net === midNet) && pins.some((p) => groundNetNames.has(p.net));
			});
			if (!cap) continue;

			const R = parseQuantity(r.value);
			const C = parseQuantity(cap.value);
			if (!R || !C) continue;
			const fc = 1 / (2 * Math.PI * R * C);
			detections.push({
				type: 'rc_filter',
				components: [r.designator, cap.designator],
				computed: {
					R: r.value!,
					C: cap.value!,
					fc_Hz: Number(fc.toFixed(2)),
					fc: formatHz(fc),
					signal: otherNet,
					midNet,
				},
			});
			break; // one detection per resistor
		}
	}

	// 2. Voltage divider on a signal net: R-R between two non-GND nets meeting in the middle.
	for (let i = 0; i < resistors.length; i++) {
		const r1 = resistors[i];
		const r1Pins = Object.values(r1.pins || {});
		if (r1Pins.length < 2) continue;
		for (let j = i + 1; j < resistors.length; j++) {
			const r2 = resistors[j];
			const r2Pins = Object.values(r2.pins || {});
			if (r2Pins.length < 2) continue;

			// Find a shared midNet
			const r1Nets = new Set(r1Pins.map((p) => p.net));
			const sharedMid = r2Pins.map((p) => p.net).find((n) => r1Nets.has(n));
			if (!sharedMid) continue;

			const r1OtherNet = r1Pins.find((p) => p.net !== sharedMid)?.net;
			const r2OtherNet = r2Pins.find((p) => p.net !== sharedMid)?.net;
			if (!r1OtherNet || !r2OtherNet) continue;
			if (r1OtherNet === r2OtherNet) continue;

			// Skip if the midNet is GND/power — that's an RC fb path or rail tie.
			if (groundNetNames.has(sharedMid) || nets[sharedMid]?.isPower) continue;

			const R1 = parseQuantity(r1.value);
			const R2 = parseQuantity(r2.value);
			if (!R1 || !R2) continue;

			// Top resistor: ratio = R2 / (R1 + R2). Top is the one connected to the higher-impedance / supply side.
			const r1OnPower = !!nets[r1OtherNet]?.isPower;
			const r2OnGnd = groundNetNames.has(r2OtherNet);
			let topR: ComponentInfo, botR: ComponentInfo;
			if (r1OnPower && r2OnGnd) { topR = r1; botR = r2; }
			else if (groundNetNames.has(r1OtherNet) && nets[r2OtherNet]?.isPower) { topR = r2; botR = r1; }
			else { topR = r1; botR = r2; }
			const Rt = parseQuantity(topR.value)!;
			const Rb = parseQuantity(botR.value)!;
			const ratio = Rb / (Rt + Rb);

			detections.push({
				type: 'voltage_divider',
				components: [topR.designator, botR.designator],
				computed: {
					top: `${topR.designator} (${topR.value})`,
					bottom: `${botR.designator} (${botR.value})`,
					ratio: Number(ratio.toFixed(4)),
					mid_net: sharedMid,
				},
			});
		}
	}

	// 3. Crystal load caps: crystal Y* with two pins, each tied to a load cap to GND.
	const crystals = Object.values(components).filter((c) => c.deviceClass === 'crystal');
	for (const xtal of crystals) {
		const pins = Object.values(xtal.pins || {});
		if (pins.length < 2) continue;
		const loadCaps: ComponentInfo[] = [];
		for (const p of pins) {
			const cap = caps.find((c) => {
				const cps = Object.values(c.pins || {});
				return cps.some((cp) => cp.net === p.net) && cps.some((cp) => groundNetNames.has(cp.net));
			});
			if (cap) loadCaps.push(cap);
		}
		if (loadCaps.length < 2) continue;
		const cValues = loadCaps.map((c) => parseQuantity(c.value)).filter((v): v is number => v != null);
		if (cValues.length < 2) continue;
		const Cseries = (cValues[0] * cValues[1]) / (cValues[0] + cValues[1]);
		// Datasheet target is typically 12-22 pF. Without datasheet lookup we
		// can only compute the effective load; we'll flag the value.
		detections.push({
			type: 'crystal_load',
			components: [xtal.designator, ...loadCaps.map((c) => c.designator)],
			computed: {
				crystal: xtal.designator,
				caps: loadCaps.map((c) => `${c.designator} (${c.value})`).join(' + '),
				CL_effective_pF: Number((Cseries * 1e12).toFixed(2)),
			},
			notes: 'Effective load CL = (Cseries) + ~3 pF stray. Compare to crystal datasheet target.',
		});
	}

	return { detections };
}

interface ConnectorAudit {
	connectors: Array<{
		designator: string;
		mpn?: string;
		pinCount: number;
		signalPins: number;
		groundPins: number;
		signalToGroundRatio: number;
		warnings: string[];
	}>;
	totalsigToGroundRatio?: number;
}

function analyzeConnectors(snap: DesignSnapshot): ConnectorAudit {
	const components = snap.components || {};
	const nets = snap.nets || {};
	const connectors = Object.values(components).filter((c) =>
		c.deviceClass === 'connector' || c.deviceClass === 'usb_connector' || c.deviceClass === 'header',
	);

	const audit: ConnectorAudit['connectors'] = [];
	let totalSignal = 0, totalGround = 0;

	for (const conn of connectors) {
		const pins = Object.values(conn.pins || {});
		const groundPins = pins.filter((p) => nets[p.net]?.isGround).length;
		const signalPins = pins.filter((p) => p.net && !nets[p.net]?.isGround && !nets[p.net]?.isPower).length;
		const ratio = groundPins > 0 ? signalPins / groundPins : Infinity;
		const warnings: string[] = [];
		if (groundPins === 0) warnings.push('No ground pin on this connector.');
		if (ratio > 3) warnings.push(`Signal:ground ratio ${ratio.toFixed(1)}:1 (recommend ≤3:1)`);

		audit.push({
			designator: conn.designator,
			mpn: conn.mpn,
			pinCount: pins.length,
			signalPins,
			groundPins,
			signalToGroundRatio: Number(ratio.toFixed(2)),
			warnings,
		});
		totalSignal += signalPins;
		totalGround += groundPins;
	}

	return {
		connectors: audit,
		totalsigToGroundRatio: totalGround > 0 ? Number((totalSignal / totalGround).toFixed(2)) : undefined,
	};
}

interface ProtectionReport {
	fuses: Array<{ designator: string; mpn?: string; value?: string; rail?: string }>;
	tvsClamps: Array<{ designator: string; mpn?: string; protectingNet?: string }>;
	reversePolarityDiodes: Array<{ designator: string; mpn?: string }>;
}

function analyzeProtection(snap: DesignSnapshot): ProtectionReport {
	const components = Object.values(snap.components || {});
	const nets = snap.nets || {};
	const groundNetNames = new Set(Object.values(nets).filter((n) => n.isGround).map((n) => n.name));

	const fuses = components.filter((c) => c.deviceClass === 'fuse' || c.deviceClass === 'ptc').map((c) => {
		const railPin = Object.values(c.pins || {}).find((p) => nets[p.net]?.isPower);
		return { designator: c.designator, mpn: c.mpn, value: c.value, rail: railPin?.net };
	});

	const tvsClamps = components.filter((c) => c.deviceClass === 'tvs').map((c) => {
		const protectingNet = Object.values(c.pins || {}).find((p) => !groundNetNames.has(p.net))?.net;
		return { designator: c.designator, mpn: c.mpn, protectingNet };
	});

	// Reverse-polarity diodes: D* with one pin on a power rail.
	const reversePolarityDiodes = components.filter((c) => c.deviceClass === 'diode').filter((c) => {
		const pins = Object.values(c.pins || {});
		return pins.some((p) => nets[p.net]?.isPower);
	}).map((c) => ({ designator: c.designator, mpn: c.mpn }));

	return { fuses, tvsClamps, reversePolarityDiodes };
}

interface EsdReport {
	connectorsAudited: number;
	connectorsCovered: number;
	gaps: Array<{ designator: string; reason: string }>;
}

function analyzeEsdCoverage(snap: DesignSnapshot): EsdReport {
	const components = snap.components || {};
	const nets = snap.nets || {};
	const groundNetNames = new Set(Object.values(nets).filter((n) => n.isGround).map((n) => n.name));

	const tvsList = Object.values(components).filter((c) => c.deviceClass === 'tvs');
	const tvsProtectedNets = new Set<string>();
	for (const tvs of tvsList) {
		for (const p of Object.values(tvs.pins || {})) {
			if (!groundNetNames.has(p.net)) tvsProtectedNets.add(p.net);
		}
	}

	const connectors = Object.values(components).filter((c) =>
		c.deviceClass === 'connector' || c.deviceClass === 'usb_connector' || c.deviceClass === 'header',
	);

	const gaps: EsdReport['gaps'] = [];
	let covered = 0;

	for (const conn of connectors) {
		const exposedSignals = Object.values(conn.pins || {}).filter((p) =>
			p.net && !groundNetNames.has(p.net) && !nets[p.net]?.isPower,
		);
		if (exposedSignals.length === 0) {
			covered++;
			continue;
		}
		const protectedSignals = exposedSignals.filter((p) => tvsProtectedNets.has(p.net));
		if (protectedSignals.length === exposedSignals.length) {
			covered++;
		} else {
			gaps.push({
				designator: conn.designator,
				reason: `${exposedSignals.length - protectedSignals.length} of ${exposedSignals.length} signal pins lack TVS coverage`,
			});
		}
	}

	return {
		connectorsAudited: connectors.length,
		connectorsCovered: covered,
		gaps,
	};
}

// ---------------------------------------------------------------------------
// Component-context inference: turn the raw {pin: net} map for one part
// into "what is this component DOING here?" — pull-up to +3.3V, decoupling
// on +5V, series resistor between U3.3V and the ESP32 EN, etc.

interface ExplainedPin {
	pinNumber: string;
	pinName: string;
	net: string;
	role?: string; // pull_up | pull_down | decoupling | series | divider_top | ...
	connectsTo: string[]; // sibling component pins on the same net (e.g. ["U3.EN", "+3.3V"])
}

interface ComponentExplanation {
	designator: string;
	deviceClass?: string;
	mpn?: string;
	value?: string;
	footprint?: string;
	role: string; // one-liner inferred role
	pins: ExplainedPin[];
	notes: string[];
}

function siblingsOnNet(snap: DesignSnapshot, net: string, excludeDes: string): Array<{ designator: string; pinNumber: string; pinName: string }> {
	const members = snap.nets[net]?.members ?? [];
	return members.filter((m) => m.designator !== excludeDes);
}

function labelMember(m: { designator: string; pinNumber: string; pinName: string }): string {
	return m.pinName ? `${m.designator}.${m.pinName}` : `${m.designator}.${m.pinNumber}`;
}

function explainComponent(snap: DesignSnapshot, designator: string): ComponentExplanation {
	const comp = snap.components[designator];
	if (!comp) {
		return { designator, role: 'NOT FOUND', pins: [], notes: [`No component named "${designator}" in this project.`] };
	}
	const nets = snap.nets;
	const groundNetNames = new Set(Object.values(nets).filter((n) => n.isGround).map((n) => n.name));
	const powerNetNames = new Set(Object.values(nets).filter((n) => n.isPower).map((n) => n.name));

	const pins: ExplainedPin[] = [];
	for (const [pinNumber, pin] of Object.entries(comp.pins || {})) {
		const sibs = siblingsOnNet(snap, pin.net, designator);
		pins.push({
			pinNumber,
			pinName: pin.name,
			net: pin.net,
			connectsTo: sibs.map(labelMember).slice(0, 8), // cap to keep response compact
		});
	}

	const notes: string[] = [];
	let role = `${comp.deviceClass ?? 'component'} ${comp.value ?? comp.mpn ?? ''}`.trim();

	// Two-pin passive heuristics — covers ~80% of "what is this resistor/cap for"
	const pinList = Object.values(comp.pins || {});
	if (pinList.length === 2 && comp.deviceClass === 'resistor') {
		const [a, b] = pinList;
		const aGnd = groundNetNames.has(a.net);
		const bGnd = groundNetNames.has(b.net);
		const aPwr = powerNetNames.has(a.net);
		const bPwr = powerNetNames.has(b.net);

		if ((aPwr && !bPwr && !bGnd) || (bPwr && !aPwr && !aGnd)) {
			const railNet = aPwr ? a.net : b.net;
			const sigNet = aPwr ? b.net : a.net;
			const sigSibs = siblingsOnNet(snap, sigNet, designator);
			const target = sigSibs[0] ? labelMember(sigSibs[0]) : sigNet;
			role = `pull-up ${comp.value ?? ''} on ${target} → ${railNet}`.trim();
			pins[0].role = 'pull_up';
		} else if ((aGnd && !bGnd && !bPwr) || (bGnd && !aGnd && !aPwr)) {
			const sigNet = aGnd ? b.net : a.net;
			const sigSibs = siblingsOnNet(snap, sigNet, designator);
			const target = sigSibs[0] ? labelMember(sigSibs[0]) : sigNet;
			role = `pull-down ${comp.value ?? ''} on ${target} → GND`.trim();
			pins[0].role = 'pull_down';
		} else if (aPwr && bGnd) {
			role = `bleeder/load resistor ${comp.value ?? ''} between ${a.net} and ${b.net}`;
		} else if (!aPwr && !bPwr && !aGnd && !bGnd) {
			// Both ends on signal nets — series element. Identify driver/load.
			const aSibs = siblingsOnNet(snap, a.net, designator);
			const bSibs = siblingsOnNet(snap, b.net, designator);
			const aLabel = aSibs[0] ? labelMember(aSibs[0]) : a.net;
			const bLabel = bSibs[0] ? labelMember(bSibs[0]) : b.net;
			role = `series ${comp.value ?? ''} between ${aLabel} and ${bLabel}`.trim();
		}
	}

	if (pinList.length === 2 && comp.deviceClass === 'capacitor') {
		const [a, b] = pinList;
		const aGnd = groundNetNames.has(a.net);
		const bGnd = groundNetNames.has(b.net);
		const aPwr = powerNetNames.has(a.net);
		const bPwr = powerNetNames.has(b.net);

		if ((aPwr && bGnd) || (bPwr && aGnd)) {
			const rail = aPwr ? a.net : b.net;
			role = `decoupling ${comp.value ?? ''} on ${rail}`.trim();
			pins[0].role = 'decoupling';
		} else if (aGnd || bGnd) {
			const sigNet = aGnd ? b.net : a.net;
			const sigSibs = siblingsOnNet(snap, sigNet, designator);
			const target = sigSibs[0] ? labelMember(sigSibs[0]) : sigNet;
			role = `bypass/filter ${comp.value ?? ''} on ${target} → GND`.trim();
		} else {
			// Both ends on signal nets — AC coupling / DC blocking / feedback
			const aSibs = siblingsOnNet(snap, a.net, designator);
			const bSibs = siblingsOnNet(snap, b.net, designator);
			const aLabel = aSibs[0] ? labelMember(aSibs[0]) : a.net;
			const bLabel = bSibs[0] ? labelMember(bSibs[0]) : b.net;
			role = `series cap ${comp.value ?? ''} between ${aLabel} and ${bLabel} (AC coupling / feedback)`.trim();
		}
	}

	if (comp.deviceClass === 'tvs' || comp.deviceClass === 'zener') {
		const protectedNets = pinList.map((p) => p.net).filter((n) => !groundNetNames.has(n));
		role = `${comp.deviceClass.toUpperCase()} ${comp.mpn ?? ''} clamping ${protectedNets.join(' / ') || 'unknown net'} to GND`.trim();
	}

	if (comp.deviceClass === 'fuse' || comp.deviceClass === 'ptc') {
		const railPin = pinList.find((p) => powerNetNames.has(p.net));
		role = `${comp.deviceClass.toUpperCase()} ${comp.mpn ?? ''} on ${railPin?.net ?? 'unknown rail'}`.trim();
	}

	if (comp.deviceClass?.startsWith('regulator')) {
		const outPin = Object.entries(comp.pins || {}).find(([, p]) => /^V?OUT|^SW$|^LX$/i.test(p.name || ''));
		const inPin = Object.entries(comp.pins || {}).find(([, p]) => /^V?IN|^INPUT/i.test(p.name || ''));
		role = `${comp.deviceClass.replace('regulator_', '').toUpperCase()} regulator ${comp.mpn ?? ''}: ${inPin?.[1].net ?? '?'} → ${outPin?.[1].net ?? '?'}`.trim();
	}

	if (comp.deviceClass === 'ic' && pinList.length > 4) {
		// Big IC — note rails it touches and how many signals.
		const railsTouched = new Set<string>();
		const groundsTouched = new Set<string>();
		let signalPins = 0;
		for (const p of pinList) {
			if (powerNetNames.has(p.net)) railsTouched.add(p.net);
			else if (groundNetNames.has(p.net)) groundsTouched.add(p.net);
			else if (p.net) signalPins += 1;
		}
		role = `IC ${comp.mpn ?? ''} (${pinList.length} pins): ${signalPins} signals, rails [${[...railsTouched].join(', ')}], ${groundsTouched.size} ground pins`.trim();
	}

	// $-net warning — agents often misread these as garbage.
	const dollarPins = pinList.filter((p) => p.net.startsWith('$'));
	if (dollarPins.length > 0) {
		notes.push(`${dollarPins.length} pin(s) sit on auto-named ($-prefixed) nets — these are real electrical connections, just unlabeled by the designer. The "connectsTo" lists show what's actually wired.`);
	}

	return {
		designator,
		deviceClass: comp.deviceClass,
		mpn: comp.mpn,
		value: comp.value,
		footprint: comp.footprint,
		role,
		pins,
		notes,
	};
}

// ---------------------------------------------------------------------------
// Net trace: drivers / loads / passives in series / pages spanned. The
// agent-friendly view of "what is this signal?".

interface NetTrace {
	net: string;
	memberCount: number;
	isPower: boolean;
	isGround: boolean;
	autoNamed: boolean;
	semanticAlias?: string; // e.g. "FB@U1" for a $-net touching a pin named FB
	drivers: Array<{ designator: string; pinNumber: string; pinName: string; reason: string }>;
	loads: Array<{ designator: string; pinNumber: string; pinName: string }>;
	passives: Array<{ designator: string; deviceClass: string; value?: string; otherNet: string }>;
	pages?: string[]; // populated only when the snapshot includes per-page data
	allMembers: string[];
}

const DRIVER_PIN_RE = /^V?OUT|^SW$|^LX$|^TX$|^MISO$|^SDO$|^SCL$|^SDA$|^DOUT$|^OUT_/i;

function traceNet(snap: DesignSnapshot, netName: string): NetTrace {
	const net = snap.nets[netName];
	if (!net) {
		return {
			net: netName,
			memberCount: 0,
			isPower: false,
			isGround: false,
			autoNamed: netName.startsWith('$'),
			drivers: [],
			loads: [],
			passives: [],
			allMembers: [],
		};
	}

	const drivers: NetTrace['drivers'] = [];
	const loads: NetTrace['loads'] = [];
	const passives: NetTrace['passives'] = [];
	let semanticAlias: string | undefined;

	for (const m of net.members) {
		const comp = snap.components[m.designator];
		if (!comp) continue;
		// Track the most informative pin name — typically the one nearest
		// to a function on an IC. Used as the alias for $-prefixed nets.
		if (net.autoNamed && m.pinName && /^[A-Z]/.test(m.pinName) && !semanticAlias) {
			semanticAlias = `${m.pinName}@${m.designator}`;
		}

		if (comp.deviceClass?.startsWith('regulator') && /^V?OUT|^SW$|^LX$/i.test(m.pinName)) {
			drivers.push({ designator: m.designator, pinNumber: m.pinNumber, pinName: m.pinName, reason: `${comp.deviceClass.replace('regulator_', '')} regulator output` });
			continue;
		}
		if (comp.deviceClass === 'ic' && DRIVER_PIN_RE.test(m.pinName)) {
			drivers.push({ designator: m.designator, pinNumber: m.pinNumber, pinName: m.pinName, reason: `IC output pin (${m.pinName})` });
			continue;
		}
		if (comp.deviceClass === 'fuse' || comp.deviceClass === 'ptc') {
			drivers.push({ designator: m.designator, pinNumber: m.pinNumber, pinName: m.pinName, reason: `protection element passing rail` });
			continue;
		}
		if (comp.deviceClass === 'resistor' || comp.deviceClass === 'capacitor' || comp.deviceClass === 'inductor' || comp.deviceClass === 'ferrite_bead') {
			const otherPin = Object.values(comp.pins || {}).find((p) => p.net !== netName);
			passives.push({
				designator: m.designator,
				deviceClass: comp.deviceClass,
				value: comp.value,
				otherNet: otherPin?.net ?? '(unknown)',
			});
			continue;
		}
		// Default: treat as load
		loads.push({ designator: m.designator, pinNumber: m.pinNumber, pinName: m.pinName });
	}

	return {
		net: netName,
		memberCount: net.members.length,
		isPower: net.isPower,
		isGround: net.isGround,
		autoNamed: net.autoNamed,
		semanticAlias,
		drivers,
		loads,
		passives,
		allMembers: net.members.map(labelMember),
	};
}

// Agent-facing shape of sch_extract_design. Connectivity is already in
// components[].pins and nets[].members; the flat pinIndex repeats it (~14% of
// the payload) and no analyzer reads it, so it ships only on request.
// Analyzers fetch sch.extract.design themselves and keep the full snapshot.
export function projectSchSnapshot(result: any, fields?: string[]): any {
	if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
	if (Array.isArray(fields) && fields.length > 0) {
		const out: Record<string, any> = {};
		for (const f of fields) if (f in result) out[f] = result[f];
		out._availableFields = Object.keys(result);
		return out;
	}
	const { pinIndex, ...rest } = result;
	return rest;
}

// ---------------------------------------------------------------------------
// MCP tool registration

export function registerSchAnalysisTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'sch_extract_design',
		'One-shot snapshot of the active project: components (with MPN/value/footprint/position/deviceClass and pins → net), nets (with members + power/ground tagging), and stats. Foundation for analyze_* tools — call once and pass the result around if you have one. The flat pinIndex (same connectivity a third time) is omitted unless named in fields.',
		withDocumentParam({
			allPages: z.boolean().optional().default(true).describe('Include components from every schematic page (default true)'),
			fields: z
				.array(z.string())
				.optional()
				.describe('Project the snapshot to these top-level keys only (e.g. ["nets","netCount"]; add "pinIndex" for the flat pin list). Analyzers need components + nets — pass them an unprojected snapshot.'),
		}),
		async ({ fields, ...params }) => {
			const result = await bridge.send('sch.extract.design', { ...params, _timeoutMs: 120_000 });
			return { content: [{ type: 'text', text: JSON.stringify(projectSchSnapshot(result, fields)) }] };
		},
	);

	server.tool(
		'sch_analyze_power_tree',
		'Build the power tree: regulator detection by MPN/designator, feedback-divider math (Vout = Vref / (R2/(R1+R2))), input-rail nesting. Pass a snapshot from sch_extract_design as the snapshot field, or omit to fetch fresh.',
		withDocumentParam({
			snapshot: z.any().optional().describe('Pre-fetched snapshot from sch_extract_design'),
		}),
		async ({ snapshot, ...rest }) => {
			const snap = snapshot ?? (await bridge.send('sch.extract.design', { ...rest, _timeoutMs: 120_000 }));
			const result = analyzePowerTree(snap as DesignSnapshot);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_analyze_decoupling',
		'Per-rail decoupling cap inventory: count, total capacitance, warnings if cap count < IC pin count or zero caps on a power rail.',
		withDocumentParam({
			snapshot: z.any().optional(),
		}),
		async ({ snapshot, ...rest }) => {
			const snap = snapshot ?? (await bridge.send('sch.extract.design', { ...rest, _timeoutMs: 120_000 }));
			const result = analyzeDecoupling(snap as DesignSnapshot);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_analyze_passive_networks',
		'Detect RC filters (computes fc), voltage dividers (computes ratio + mid net), and crystal load caps (computes CL_effective).',
		withDocumentParam({
			snapshot: z.any().optional(),
		}),
		async ({ snapshot, ...rest }) => {
			const snap = snapshot ?? (await bridge.send('sch.extract.design', { ...rest, _timeoutMs: 120_000 }));
			const result = analyzePassiveNetworks(snap as DesignSnapshot);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_analyze_connectors',
		'Audit each connector: pin count, signal:ground ratio, warnings (no GND, ratio >3:1).',
		withDocumentParam({
			snapshot: z.any().optional(),
		}),
		async ({ snapshot, ...rest }) => {
			const snap = snapshot ?? (await bridge.send('sch.extract.design', { ...rest, _timeoutMs: 120_000 }));
			const result = analyzeConnectors(snap as DesignSnapshot);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_analyze_protection',
		'List fuses/PTCs (with rail), TVS clamps (with protected net), reverse-polarity diodes.',
		withDocumentParam({
			snapshot: z.any().optional(),
		}),
		async ({ snapshot, ...rest }) => {
			const snap = snapshot ?? (await bridge.send('sch.extract.design', { ...rest, _timeoutMs: 120_000 }));
			const result = analyzeProtection(snap as DesignSnapshot);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_analyze_esd_coverage',
		'For each connector, check whether every signal pin has a TVS clamp on its net. Flags gaps.',
		withDocumentParam({
			snapshot: z.any().optional(),
		}),
		async ({ snapshot, ...rest }) => {
			const snap = snapshot ?? (await bridge.send('sch.extract.design', { ...rest, _timeoutMs: 120_000 }));
			const result = analyzeEsdCoverage(snap as DesignSnapshot);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_get_pages',
		`Lightweight orientation tool: lists every schematic page in the project (UUID, title, sheet order, isActive). Call this FIRST when starting work on a multi-page project — much cheaper than sch_extract_design and tells you which page UUIDs you can hand to other tools.`,
		{},
		async () => {
			const result = await bridge.send('editor.sch.pages', {});
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_explain_component',
		`Semantic role inference for ONE component. Returns "what is this part doing here" — pull-up, pull-down, decoupling, series, divider, regulator I/O, TVS clamp, etc. — plus a per-pin breakdown showing exactly which sibling pins each pin connects to (e.g. "U3.EN", "+3.3V"). This is the fastest way to make sense of a component WITHOUT reading the schematic visually.
Use whenever an agent needs to answer "what is R19 for?" or "is this cap in the right place?". Cross-page connections are included automatically — the project-wide netlist is the source of truth.`,
		withDocumentParam({
			designator: z.string().describe('Component designator (e.g. "U3", "R19", "C24")'),
			snapshot: z.any().optional().describe('Pre-fetched snapshot from sch_extract_design (skip the round-trip)'),
		}),
		async ({ snapshot, designator, ...rest }) => {
			const snap = snapshot ?? (await bridge.send('sch.extract.design', { ...rest, _timeoutMs: 120_000 }));
			const result = explainComponent(snap as DesignSnapshot, designator);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'sch_trace_net',
		`Trace ONE signal across the entire project: drivers (regulator outputs, IC output pins, fuses), loads (input pins), passives in series (R/C/L between this net and another), and a semanticAlias hint when the net is auto-named ($-prefixed) but actually corresponds to a function pin like FB or EN.
Use this when an agent asks "what's on this net?" or "where does this signal go?" — especially for a multi-page schematic where the named net (e.g. +3.3V, CAN_RX) crosses sheet boundaries. Project-wide; no per-page filtering needed.`,
		withDocumentParam({
			net: z.string().describe('Net name (e.g. "+3.3V", "CAN_RX", "$1N2856"). Use the exact name from sch_extract_design or sch_get_connectivity.'),
			snapshot: z.any().optional().describe('Pre-fetched snapshot from sch_extract_design'),
		}),
		async ({ snapshot, net, ...rest }) => {
			const snap = snapshot ?? (await bridge.send('sch.extract.design', { ...rest, _timeoutMs: 120_000 }));
			const result = traceNet(snap as DesignSnapshot, net);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);
}

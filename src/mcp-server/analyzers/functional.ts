// Functional review rule engine — the bug-fix analyzer.
//
// WHY THIS EXISTS
// ---------------
// emc.ts checks *electrical continuity*, never *functional intent*. A real
// board shipped with a USB-C connector whose D+/D- were NOT functionally
// connected, yet review passed: the connector's shield / standoff / mounting
// pads were netlisted to GND, so every connectivity/DRC check saw
// "everything connected." emc.ts even does the WRONG thing for this case at
// `emc.ts:298`:
//
//     if (isGroundNet(net)) continue;   // <- skips ground-tied pins
//
// i.e. a data pin tied to GND is SKIPPED, masking the defect. This engine
// does the DELIBERATE OPPOSITE for data/signal pins: a data pin on a ground
// (or power) net is a CRITICAL functional failure, never a skip — see
// `evaluateDataPin` below.
//
// THE CORE FIX
// ------------
// Connectivity "credit" must come from a *functional* peer. Shield, standoff,
// mounting-hole, test-point and net-label members do NOT count toward a data
// line being "connected" (see EXCLUDED_FROM_CREDIT + the shield/mount name
// heuristic). So a USB-C whose only non-data connectivity is its GND-tied
// mounting pads now correctly FAILS.
//
// Architecture mirrors emc.ts:
//   - A contract library describes, per device class, what each pin role must
//     reach to be "functionally connected."
//   - analyzeFunctional(snapshot, opts) runs the contracts, aggregates
//     FunctionalFinding[] (EmcFinding + confidence).
//   - Consumes the SAME snapshot type emc.ts consumes (sch.extract.design), so
//     it plugs straight into the existing pipeline / fab-release / docgen.

import type { EmcFinding, EmcSeverity, EmcCategory } from './emc';

// ---------------------------------------------------------------------------
// Finding shape — EmcFinding + a confidence band. Shield/standoff detection is
// a name heuristic, so some findings are deliberately marked 'medium'.
// `category` stays a valid EmcCategory so these merge cleanly into the
// emc-style aggregators (fab-release gate, docgen design review).
// ---------------------------------------------------------------------------

export interface FunctionalFinding extends EmcFinding {
	confidence: 'high' | 'medium' | 'low';
}

export interface FunctionalReport {
	rulesRun: number;
	rulesSkipped: string[];
	findings: FunctionalFinding[];
	bySeverity: Record<EmcSeverity, number>;
	byConfidence: Record<'high' | 'medium' | 'low', number>;
	summary: string;
}

// ---------------------------------------------------------------------------
// Loose snapshot shape — identical to what emc.ts / sch.extract.design produce.
// Kept structurally compatible so EmcSnapshot can be passed in directly.
// ---------------------------------------------------------------------------

interface PinRef { designator: string; pinNumber: string; pinName: string }
interface NetInfo {
	name: string;
	pinCount?: number;
	members?: PinRef[];
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
export interface FunctionalSnapshot {
	components: Record<string, ComponentInfo>;
	nets: Record<string, NetInfo>;
}

// ---------------------------------------------------------------------------
// Contract data model — declarative, per the approved plan.
// ---------------------------------------------------------------------------

export interface PinContract {
	/** Matches the pin NAME (e.g. "D+", "SDA", "XIN"). */
	match: RegExp;
	role: 'data' | 'power' | 'ground' | 'signal' | 'clock';
	/** For data/signal: the net must reach ≥1 active member of one of these classes. */
	mustReachClass?: string[];
	/** Minimum active (non-excluded) members on the net beyond the pin itself. */
	minActiveMembers?: number;
	/** A companion part the pin's net must connect to (e.g. crystal load cap to GND). */
	companion?: { match: RegExp; toClass?: string[]; toNetRole?: 'ground' | 'power' };
	/** The net must have a pull-up/pull-down resistor to this rail role. */
	pullup?: { toRole: 'power' | 'ground' };
	severity: EmcSeverity;
	ruleId: string;
	/** EmcCategory bucket so findings merge into the unified report. */
	category: EmcCategory;
	description: string;
}

export interface DeviceContract {
	deviceClass: string;
	pins: PinContract[];
}

// ---------------------------------------------------------------------------
// THE CORE FIX — exclusion sets & primitives.
// ---------------------------------------------------------------------------

/** Device classes that NEVER count as a functional peer for "is this pin
 *  connected to something that does work?" Mounting holes, test points and
 *  net-labels are mechanical/diagnostic, not functional sinks/sources. */
const EXCLUDED_FROM_CREDIT = new Set<string>([
	'mounting_hole',
	'test_point',
	'net_label',
]);

/** Name heuristic for shield / standoff / chassis / mounting pads. These pins
 *  are mechanical even when they live on a "real" component (a USB-C body has
 *  4–6 shield/mount tabs alongside its signal pins). They must NOT grant a
 *  data line "connected" credit. Confidence on shield-driven findings is
 *  'medium' because this is heuristic. */
const SHIELD_MOUNT_RE = /shield|shld|gnd_?mount|mount(?:ing)?|standoff|case|chassis|^mh\d|^mp\d|^sh\d/i;

function isShieldOrMountPin(designator: string, pinName: string): boolean {
	return SHIELD_MOUNT_RE.test(pinName || '') || SHIELD_MOUNT_RE.test(designator || '');
}

/** Mirrors emc.ts isPowerRail — used here to FLAG (never skip) a data pin. */
function isPowerRail(net: NetInfo | undefined): boolean {
	if (!net) return false;
	if (net.isPower) return true;
	const n = (net.name ?? '').toUpperCase();
	const stripped = n.replace(/^[+\-_]+/, '').replace(/^V_/, '');
	if (/^(VCC|VDD|V\+|VIN|VOUT|3V3|5V|1V8|1V2|2V5|VBAT|VBUS|VSYS|VAUX|AVDD|DVDD|VPP)/.test(stripped)) return true;
	if (/^\d+(V\d+|V|\.\d+V)/.test(stripped)) return true;
	return false;
}

/** Mirrors emc.ts isGroundNet — used here to FLAG (never skip) a data pin. */
function isGroundNet(net: NetInfo | undefined): boolean {
	if (!net) return false;
	if (net.isGround) return true;
	const n = (net.name ?? '').toUpperCase();
	return /^(GND|VSS|0V|AGND|DGND|PGND|EGND|EARTH)/.test(n);
}

function deviceClassMatches(c: ComponentInfo, classes: string[]): boolean {
	return classes.includes((c.deviceClass || '').toLowerCase());
}

/** Members on a net that actually constitute a functional connection, i.e.
 *  excluding the connector itself, its shield/mount pads, mounting holes,
 *  test points and net-labels. THIS is what closes the trap: the USB-C's only
 *  non-data connectivity (GND-tied mounting tabs) yields ZERO active members,
 *  so the data line reads as floating/unconnected. */
function activeMembers(
	snap: FunctionalSnapshot,
	netName: string,
	selfDesignator: string,
): ComponentInfo[] {
	const out: ComponentInfo[] = [];
	const seen = new Set<string>();
	for (const c of Object.values(snap.components)) {
		if (!c.pins) continue;
		if (c.designator === selfDesignator) continue;          // not the part itself
		if (EXCLUDED_FROM_CREDIT.has((c.deviceClass || '').toLowerCase())) continue;
		for (const [pinNum, p] of Object.entries(c.pins)) {
			if (p.net !== netName) continue;
			if (isShieldOrMountPin(c.designator, p.name) || /^(MH|MP|SH)\d/i.test(pinNum)) continue;
			if (seen.has(c.designator)) break;
			seen.add(c.designator);
			out.push(c);
			break;
		}
	}
	return out;
}

/** A net is functionally floating when it has ≤1 non-excluded member (i.e.
 *  nothing else of substance hangs off it), or the net is missing entirely. */
function isFloating(snap: FunctionalSnapshot, netName: string | undefined, selfDesignator: string): boolean {
	if (!netName) return true;
	const net = snap.nets[netName];
	if (!net) {
		// Net not in the table — fall back to a pad scan.
		return activeMembers(snap, netName, selfDesignator).length === 0;
	}
	return activeMembers(snap, netName, selfDesignator).length === 0;
}

/** All non-excluded components reachable on a net (any pin), excluding self.
 *  Used for companion / pull-up / decoupling lookups. */
function componentsOnNet(snap: FunctionalSnapshot, netName: string): ComponentInfo[] {
	const out: ComponentInfo[] = [];
	for (const c of Object.values(snap.components)) {
		if (!c.pins) continue;
		for (const p of Object.values(c.pins)) {
			if (p.net === netName) { out.push(c); break; }
		}
	}
	return out;
}

/** Does this net (via a resistor) pull up/down to a rail of the given role? */
function hasPullToRail(snap: FunctionalSnapshot, netName: string, role: 'power' | 'ground'): boolean {
	for (const c of componentsOnNet(snap, netName)) {
		if (!deviceClassMatches(c, ['resistor'])) continue;
		if (!c.pins) continue;
		const otherNets = Object.values(c.pins).map((p) => p.net).filter((n) => n && n !== netName);
		for (const n of otherNets) {
			const net = snap.nets[n];
			if (role === 'power' && isPowerRail(net)) return true;
			if (role === 'ground' && isGroundNet(net)) return true;
		}
	}
	return false;
}

/** Does this net connect to a companion part (e.g. a load cap to GND)? */
function hasCompanion(
	snap: FunctionalSnapshot,
	netName: string,
	companion: NonNullable<PinContract['companion']>,
): boolean {
	for (const c of componentsOnNet(snap, netName)) {
		if (companion.toClass && companion.toClass.length && !deviceClassMatches(c, companion.toClass)) continue;
		if (companion.match && !companion.match.test(c.designator) && !companion.match.test(c.value || '')) {
			// Allow match against designator OR value (e.g. "/^C/" or "/22p/").
			const pinNameHit = c.pins
				? Object.values(c.pins).some((p) => companion.match.test(p.name || ''))
				: false;
			if (!pinNameHit) continue;
		}
		if (companion.toNetRole && c.pins) {
			const otherNets = Object.values(c.pins).map((p) => p.net).filter((n) => n && n !== netName);
			const ok = otherNets.some((n) => {
				const net = snap.nets[n];
				return companion.toNetRole === 'ground' ? isGroundNet(net) : isPowerRail(net);
			});
			if (!ok) continue;
		}
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Contract library — real, sensible functional contracts.
// ---------------------------------------------------------------------------

export const CONTRACTS: DeviceContract[] = [
	{
		deviceClass: 'usb_connector',
		pins: [
			{
				// D+ / D- / DP / DM / USB_DP / USB_DM — the data pair.
				match: /^(D[+\-]|DP|DM|USB_?D[PM])$/i,
				role: 'data',
				mustReachClass: ['ic', 'mcu', 'usb_hub', 'transistor', 'transistor_bjt', 'transistor_fet', 'mosfet', 'fet', 'esd', 'tvs', 'zener', 'diode'],
				minActiveMembers: 1,
				severity: 'critical',
				ruleId: 'CON-USB-002',
				category: 'connector_hygiene',
				description: 'USB D+/D- must be functionally connected to a host/device IC, hub, or ESD/transistor — not floating, and not tied to GND/power.',
			},
			{
				// CC1 / CC2 — Type-C configuration channel; needs Rd/Rp or a PD IC.
				match: /^CC[12]?$/i,
				role: 'signal',
				mustReachClass: ['resistor', 'ic', 'mcu'],
				minActiveMembers: 1,
				severity: 'warning',
				ruleId: 'CON-USB-003',
				category: 'connector_hygiene',
				description: 'USB Type-C CC1/CC2 should reach a Rd/Rp resistor or a PD/role controller IC; otherwise the port cannot negotiate.',
			},
			{
				// VBUS / BUS — bus power.
				match: /^V?BUS$|^VBUS$/i,
				role: 'power',
				minActiveMembers: 1,
				severity: 'warning',
				ruleId: 'CON-USB-004',
				category: 'connector_hygiene',
				description: 'USB VBUS should reach a regulator, load, or power switch.',
			},
		],
	},
	{
		// Generic connectors / headers: every non-power/non-ground signal pin
		// should reach ≥1 active member, else it is a floating I/O.
		deviceClass: 'connector',
		pins: [
			{
				match: /.*/,
				role: 'signal',
				minActiveMembers: 1,
				severity: 'warning',
				ruleId: 'CON-001',
				category: 'connector_hygiene',
				description: 'Connector signal pin appears floating — it reaches no functional component (mounting/shield/test-point peers do not count).',
			},
		],
	},
	{
		deviceClass: 'header',
		pins: [
			{
				match: /.*/,
				role: 'signal',
				minActiveMembers: 1,
				severity: 'warning',
				ruleId: 'CON-001',
				category: 'connector_hygiene',
				description: 'Header signal pin appears floating — it reaches no functional component (mounting/shield/test-point peers do not count).',
			},
		],
	},
	{
		deviceClass: 'crystal',
		pins: [
			{
				// XIN / XOUT / X1 / X2 / OSC1 / OSC2 — each needs a load cap to GND.
				match: /^(XIN|XOUT|X[12]|OSC[12]?)$/i,
				role: 'clock',
				companion: { match: /^C/i, toClass: ['capacitor'], toNetRole: 'ground' },
				severity: 'critical',
				ruleId: 'XTAL-001',
				category: 'crystal_loading',
				description: 'Crystal terminal needs a companion load capacitor to GND; without it the oscillator will not start cleanly.',
			},
		],
	},
];

// Net-name-driven contracts (i2c, reset) — keyed off the net name rather than a
// host pin, because pull-ups belong to the bus, not a single device.
interface NetContract {
	match: RegExp;
	pullup?: { toRole: 'power' | 'ground' };
	severity: EmcSeverity;
	ruleId: string;
	category: EmcCategory;
	description: string;
	confidence: 'high' | 'medium' | 'low';
}

const NET_CONTRACTS: NetContract[] = [
	{
		match: /^(SDA|SCL|I2C_?(SDA|SCL))$/i,
		pullup: { toRole: 'power' },
		severity: 'warning',
		ruleId: 'I2C-001',
		category: 'reset_supervision',
		description: 'I2C net (SDA/SCL) has no pull-up resistor to a power rail; the open-drain bus cannot idle high.',
		confidence: 'high',
	},
	{
		match: /^(N?RST|N?RESET|RESET_?N|MR|POR)$/i,
		pullup: { toRole: 'power' },
		severity: 'warning',
		ruleId: 'RST-001',
		category: 'reset_supervision',
		description: 'Reset net has no pull-up resistor to a power rail; the device may reset spuriously or never release reset.',
		confidence: 'medium',
	},
];

// ---------------------------------------------------------------------------
// Pin evaluation.
// ---------------------------------------------------------------------------

const NC_RE = /^(NC|DNC|N\.?C\.?|NO_?CONNECT|RES(ERVED)?)$/i;

/** Evaluate a single contract pin on a single device. Returns 0..1 findings.
 *
 *  For a `data` pin we evaluate ROLE FIRST (the deliberate inversion of
 *  emc.ts:298):
 *    1. floating/undefined net      -> CRITICAL  (line truly unconnected)
 *    2. tied to GND or a power rail -> CRITICAL  (not a functional data conn)
 *    3. otherwise require activeMembers >= minActiveMembers reaching one of
 *       mustReachClass, else WARNING.
 */
function evaluatePin(
	snap: FunctionalSnapshot,
	comp: ComponentInfo,
	pinNum: string,
	pinName: string,
	netName: string,
	contract: PinContract,
): FunctionalFinding | null {
	// NC / DNC pins are intentionally unconnected — never flag.
	if (NC_RE.test(pinName)) return null;

	const net = netName ? snap.nets[netName] : undefined;
	const floating = isFloating(snap, netName, comp.designator);

	// ---- DATA / SIGNAL / CLOCK liveness (the trap closer) ----
	if (contract.role === 'data' || contract.role === 'signal' || contract.role === 'clock') {
		// 1) Truly floating / unconnected.
		if (floating) {
			return {
				ruleId: contract.ruleId,
				category: contract.category,
				severity: contract.role === 'data' ? 'critical' : contract.severity,
				confidence: 'high',
				title: `${comp.designator} pin ${pinNum} (${pinName}) — ${contract.role === 'data' ? 'D+/D- floating/unconnected' : 'signal pin floating/unconnected'}`,
				detail: `Net "${netName || '(none)'}" on ${comp.designator}.${pinNum} reaches no functional component. ${contract.description}`,
				designators: [comp.designator],
				netNames: netName ? [netName] : [],
				suggestion: contract.mustReachClass?.length
					? `Route this ${contract.role} pin to one of: ${contract.mustReachClass.join(', ')}.`
					: 'Route this pin to a functional net (mounting/shield/test-point connections do not count).',
			};
		}

		// 2) Data line tied to GND or power — THE motivating bug. Shield/mount
		//    pads on GND already failed the floating check above; but if the
		//    *named* net is itself GND/power (e.g. D+ wired to GND directly),
		//    catch it explicitly with a clearer message.
		if (contract.role === 'data' && (isGroundNet(net) || isPowerRail(net))) {
			const rail = isGroundNet(net) ? 'GND' : 'a power rail';
			return {
				ruleId: contract.ruleId,
				category: contract.category,
				severity: 'critical',
				confidence: 'high',
				title: `${comp.designator} pin ${pinNum} (${pinName}) — USB data line tied to ${rail}`,
				detail: `Net "${netName}" is ${rail}. A USB data line ${pinName} tied to GND/power is NOT a functional data connection — it is the failure mode this engine exists to catch (cf. emc.ts:298 which would skip it). ${contract.description}`,
				designators: [comp.designator],
				netNames: [netName],
				suggestion: 'Connect this data line to the host/device controller (or ESD diode + controller), not to GND/power.',
			};
		}

		// 3) Reaches *something*, but does it reach the RIGHT class?
		const members = activeMembers(snap, netName, comp.designator);
		const minMembers = contract.minActiveMembers ?? 1;

		// Companion requirement (e.g. crystal load cap to GND).
		if (contract.companion) {
			if (!hasCompanion(snap, netName, contract.companion)) {
				return {
					ruleId: contract.ruleId,
					category: contract.category,
					severity: contract.severity,
					confidence: 'high',
					title: `${comp.designator} pin ${pinNum} (${pinName}) — missing companion connection`,
					detail: `Net "${netName}" lacks the required companion (${contract.companion.toClass?.join('/') ?? 'part'}${contract.companion.toNetRole ? ` to ${contract.companion.toNetRole}` : ''}). ${contract.description}`,
					designators: [comp.designator],
					netNames: [netName],
					suggestion: contract.description,
				};
			}
			return null;
		}

		if (members.length < minMembers) {
			return {
				ruleId: contract.ruleId,
				category: contract.category,
				severity: contract.severity,
				confidence: 'high',
				title: `${comp.designator} pin ${pinNum} (${pinName}) — under-connected (${members.length} active peer${members.length === 1 ? '' : 's'})`,
				detail: `Net "${netName}" has ${members.length} active member(s); ${minMembers} required. ${contract.description}`,
				designators: [comp.designator],
				netNames: [netName],
				suggestion: contract.mustReachClass?.length
					? `Ensure this net reaches one of: ${contract.mustReachClass.join(', ')}.`
					: contract.description,
			};
		}

		if (contract.mustReachClass?.length) {
			const reaches = members.some((m) => deviceClassMatches(m, contract.mustReachClass!));
			if (!reaches) {
				return {
					ruleId: contract.ruleId,
					category: contract.category,
					severity: 'warning',
					confidence: 'medium',
					title: `${comp.designator} pin ${pinNum} (${pinName}) — does not reach a functional sink`,
					detail: `Net "${netName}" connects only to ${members.map((m) => `${m.designator}(${m.deviceClass})`).join(', ')}, none of which is ${contract.mustReachClass.join('/')}. ${contract.description}`,
					designators: [comp.designator, ...members.map((m) => m.designator)],
					netNames: [netName],
					suggestion: `Route this ${contract.role} pin to one of: ${contract.mustReachClass.join(', ')}.`,
				};
			}
		}

		return null;
	}

	// ---- POWER pin: should reach at least one active member (load/source) ----
	if (contract.role === 'power') {
		if (floating) {
			return {
				ruleId: contract.ruleId,
				category: contract.category,
				severity: contract.severity,
				confidence: 'high',
				title: `${comp.designator} pin ${pinNum} (${pinName}) — power pin floating/unconnected`,
				detail: `Net "${netName || '(none)'}" reaches no functional component. ${contract.description}`,
				designators: [comp.designator],
				netNames: netName ? [netName] : [],
				suggestion: contract.description,
			};
		}
		return null;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export interface FunctionalOptions {
	enabledRules?: string[];   // if set, only these rule IDs run
	disabledRules?: string[];  // exclusion list (overrides enabled)
	minSeverity?: EmcSeverity; // filter findings by severity floor
}

/** Run the full functional review over a sch.extract.design snapshot. */
export function analyzeFunctional(
	snapshot: FunctionalSnapshot,
	opts: FunctionalOptions = {},
): FunctionalFinding[] {
	const enabled = opts.enabledRules ? new Set(opts.enabledRules) : null;
	const disabled = new Set(opts.disabledRules ?? []);
	const ruleAllowed = (id: string) => (!enabled || enabled.has(id)) && !disabled.has(id);

	const findings: FunctionalFinding[] = [];

	// --- Device-pin contracts ---
	for (const comp of Object.values(snapshot.components ?? {})) {
		const klass = (comp.deviceClass || '').toLowerCase();
		const contract = CONTRACTS.find((c) => c.deviceClass === klass);
		if (!contract || !comp.pins) continue;

		for (const [pinNum, pin] of Object.entries(comp.pins)) {
			const pinName = pin.name || '';
			// Skip the part's own shield/mount pads — they are not functional pins
			// and should never themselves be flagged as "floating signal."
			if (isShieldOrMountPin(comp.designator, pinName) || /^(MH|MP|SH)\d/i.test(pinNum)) continue;

			for (const pc of contract.pins) {
				if (!ruleAllowed(pc.ruleId)) continue;
				// Generic ".*" connector contracts only apply to non-power/non-ground pins.
				if (pc.match.source === '(?:)' || pc.match.source === '.*') {
					const net = pin.net ? snapshot.nets[pin.net] : undefined;
					if (isPowerRail(net) || isGroundNet(net)) continue;
				} else if (!pc.match.test(pinName)) {
					continue;
				}
				const f = evaluatePin(snapshot, comp, pinNum, pinName, pin.net, pc);
				if (f) findings.push(f);
				// First matching contract pin wins for this physical pin.
				if (pc.match.source !== '(?:)' && pc.match.source !== '.*') break;
			}
		}
	}

	// --- Net-name contracts (i2c, reset pull-ups) ---
	for (const net of Object.values(snapshot.nets ?? {})) {
		if (net.autoNamed) continue;          // skip auto-named nets — false-positive prone
		for (const nc of NET_CONTRACTS) {
			if (!ruleAllowed(nc.ruleId)) continue;
			if (!nc.match.test(net.name)) continue;
			if (nc.pullup && hasPullToRail(snapshot, net.name, nc.pullup.toRole)) continue;
			const members = componentsOnNet(snapshot, net.name);
			findings.push({
				ruleId: nc.ruleId,
				category: nc.category,
				severity: nc.severity,
				confidence: nc.confidence,
				title: `Net "${net.name}" — ${nc.ruleId === 'I2C-001' ? 'missing I2C pull-up' : 'missing pull-up'}`,
				detail: nc.description,
				designators: members.map((m) => m.designator),
				netNames: [net.name],
				suggestion: `Add a pull-${nc.pullup?.toRole === 'ground' ? 'down' : 'up'} resistor from "${net.name}" to ${nc.pullup?.toRole === 'ground' ? 'GND' : 'the rail it idles to'}.`,
			});
		}
	}

	// --- IC power-pin decoupling (schematic-level, confidence: medium) ---
	if (ruleAllowed('IC-DEC-001')) {
		findings.push(...icDecouplingFindings(snapshot));
	}

	// --- severity filter ---
	let out = findings;
	if (opts.minSeverity) {
		const order = { critical: 3, warning: 2, info: 1 } as const;
		const threshold = order[opts.minSeverity];
		out = out.filter((f) => order[f.severity] >= threshold);
	}
	return out;
}

/** IC-DEC-001 (schematic-level): for each power rail an IC connects to, there
 *  should be at least one decoupling cap between that rail and GND somewhere on
 *  the schematic. This is the schematic-level companion to pcb-emc's proximity
 *  check; kept at confidence 'medium' because it does not consider placement. */
function icDecouplingFindings(snap: FunctionalSnapshot): FunctionalFinding[] {
	const findings: FunctionalFinding[] = [];
	// Map rail -> true if a cap bridges rail<->GND.
	const railHasCap = new Map<string, boolean>();
	const railHasCapValue = (rail: string): boolean => {
		if (railHasCap.has(rail)) return railHasCap.get(rail)!;
		let found = false;
		for (const c of componentsOnNet(snap, rail)) {
			if (!deviceClassMatches(c, ['capacitor']) || !c.pins) continue;
			const otherNets = Object.values(c.pins).map((p) => p.net).filter((n) => n && n !== rail);
			if (otherNets.some((n) => isGroundNet(snap.nets[n]))) { found = true; break; }
		}
		railHasCap.set(rail, found);
		return found;
	};

	for (const comp of Object.values(snap.components)) {
		if (!deviceClassMatches(comp, ['ic', 'regulator_ldo', 'regulator_buck', 'regulator_boost']) || !comp.pins) continue;
		const railsSeen = new Set<string>();
		for (const p of Object.values(comp.pins)) {
			if (!p.net) continue;
			const net = snap.nets[p.net];
			if (!isPowerRail(net)) continue;
			railsSeen.add(p.net);
		}
		for (const rail of railsSeen) {
			if (railHasCapValue(rail)) continue;
			findings.push({
				ruleId: 'IC-DEC-001',
				category: 'decoupling',
				severity: 'warning',
				confidence: 'medium',
				title: `${comp.designator} power rail "${rail}" has no decoupling cap to GND`,
				detail: `IC ${comp.designator} draws from "${rail}" but no capacitor bridges that rail to GND anywhere on the schematic. Schematic-level check only (placement not considered).`,
				designators: [comp.designator],
				netNames: [rail],
				suggestion: `Add a 100nF (and bulk) cap between "${rail}" and GND near ${comp.designator}.`,
			});
		}
	}
	return findings;
}

/** Build a report (bySeverity / byConfidence / summary) around the raw
 *  findings — for fab-release gate + docgen consumption. */
export function summarizeFunctional(findings: FunctionalFinding[]): FunctionalReport {
	const bySeverity: Record<EmcSeverity, number> = { critical: 0, warning: 0, info: 0 };
	const byConfidence: Record<'high' | 'medium' | 'low', number> = { high: 0, medium: 0, low: 0 };
	for (const f of findings) {
		bySeverity[f.severity] += 1;
		byConfidence[f.confidence] += 1;
	}
	const summary = `${findings.length} functional findings: ${bySeverity.critical} critical, ${bySeverity.warning} warning, ${bySeverity.info} info (${byConfidence.high} high / ${byConfidence.medium} medium / ${byConfidence.low} low confidence).`;
	return {
		rulesRun: listFunctionalRules().length,
		rulesSkipped: [],
		findings,
		bySeverity,
		byConfidence,
		summary,
	};
}

/** Convenience: run + summarize in one call (used by fab-release/docgen). */
export function analyzeFunctionalReport(
	snapshot: FunctionalSnapshot,
	opts: FunctionalOptions = {},
): FunctionalReport {
	return summarizeFunctional(analyzeFunctional(snapshot, opts));
}

/** List every functional rule for discovery (mirrors listEmcRules). */
export function listFunctionalRules(): Array<{ ruleId: string; deviceClass: string; description: string; severity: EmcSeverity }> {
	const out: Array<{ ruleId: string; deviceClass: string; description: string; severity: EmcSeverity }> = [];
	for (const dc of CONTRACTS) {
		for (const pc of dc.pins) {
			out.push({ ruleId: pc.ruleId, deviceClass: dc.deviceClass, description: pc.description, severity: pc.severity });
		}
	}
	for (const nc of NET_CONTRACTS) {
		out.push({ ruleId: nc.ruleId, deviceClass: '(net-name)', description: nc.description, severity: nc.severity });
	}
	out.push({ ruleId: 'IC-DEC-001', deviceClass: 'ic', description: 'IC power rail has no decoupling cap to GND (schematic-level).', severity: 'warning' });
	// De-dup repeated ruleIds (CON-001 appears for connector + header).
	const seen = new Set<string>();
	return out.filter((r) => (seen.has(r.ruleId) ? false : (seen.add(r.ruleId), true)));
}

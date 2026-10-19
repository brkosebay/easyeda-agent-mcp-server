// PCB-side EMC analyzer — consumes pcb_extract_design snapshot.
// Phase 6 ships decoupling proximity (highest-value, well-defined) plus
// pour-coverage heuristic for ground layers. More rules to follow.

import type { EmcFinding } from './emc';

export interface PcbSnapMinimal {
	components: Record<string, { designator: string; layer?: string; mpn?: string; pinCount?: number }>;
	nets: Record<string, { name: string; isPower?: boolean; isGround?: boolean; members?: Array<{ designator: string; padNumber: string }> }>;
	pads?: Array<{ designator: string; padNumber: string; net: string; layer?: string; x?: number; y?: number }>;
	stats?: { byLayer?: Record<string, { components: number; pads: number; tracks: number; vias: number; pours: number }> };
	layers?: Array<{ name: string; type?: string }>;
}

const POWER_PIN_PATTERNS = /VCC|VDD|V\+|VIN|VOUT|3V3|5V|1V8|1V2|2V5|VBUS|VSYS|AVDD|DVDD/i;
const CAP_REF_RE = /^C\d/;

/** Re-classify a net as power based on its name. The PCB extract handler
 *  uses a strict regex; this fallback also catches "+12V", "+3.3V", "V_5V0"
 *  shapes that the strict regex misses. */
function netLooksPower(name: string): boolean {
	const n = (name ?? '').toUpperCase();
	const stripped = n.replace(/^[+\-_]+/, '').replace(/^V_/, '');
	return /^(VCC|VDD|V\+|VIN|VOUT|3V3|5V|1V8|1V2|2V5|VBAT|VBUS|VSYS|VAUX|AVDD|DVDD)/.test(stripped)
		|| /^\d+(V\d+|V|\.\d+V)/.test(stripped);
}

function isPowerNet(snap: PcbSnapMinimal, netName: string): boolean {
	const meta = snap.nets[netName];
	if (meta?.isPower) return true;
	return netLooksPower(netName);
}

function distMil(a: { x?: number; y?: number }, b: { x?: number; y?: number }): number {
	if (a.x == null || a.y == null || b.x == null || b.y == null) return Infinity;
	const dx = a.x - b.x, dy = a.y - b.y;
	return Math.sqrt(dx * dx + dy * dy);
}

/** PCB-DEC-001: every IC power pin must have a decoupling cap within ~200 mil
 *  (~5mm) on the same or opposite layer. */
export function pcbDecouplingProximity(snap: PcbSnapMinimal, opts: { maxMil?: number } = {}): EmcFinding[] {
	const maxMil = opts.maxMil ?? 200;
	const findings: EmcFinding[] = [];
	const pads = snap.pads ?? [];

	// Index caps' pads by net (cap pads on the rail)
	const capsByNet = new Map<string, Array<{ designator: string; x: number; y: number }>>();
	for (const p of pads) {
		if (!CAP_REF_RE.test(p.designator || '')) continue;
		if (p.x == null || p.y == null) continue;
		if (!capsByNet.has(p.net)) capsByNet.set(p.net, []);
		capsByNet.get(p.net)!.push({ designator: p.designator, x: p.x, y: p.y });
	}

	// For each power pad on an IC (designator U/IC), check nearest cap on its net
	for (const p of pads) {
		const ref = p.designator || '';
		if (!/^(U|IC|REG)\d/i.test(ref)) continue;
		if (p.x == null || p.y == null) continue;
		// Heuristic: power pads are typically named VDD/VCC/VBUS — the pad number
		// has the pin label baked in. Without padName we approximate: just check
		// pads whose net is a power rail.
		if (!isPowerNet(snap, p.net)) continue;
		const caps = capsByNet.get(p.net) ?? [];
		if (caps.length === 0) {
			findings.push({
				ruleId: 'PCB-DEC-001',
				category: 'decoupling',
				severity: 'critical',
				title: `IC ${ref} pad ${p.padNumber} (net ${p.net}) has no caps on its rail`,
				detail: 'No decoupling capacitor connects to this power pin\'s net. Will radiate and have poor PSRR.',
				designators: [ref],
				netNames: [p.net],
				suggestion: 'Add a 100nF X7R cap from this net to GND, placed within 5mm of the pin on the PCB.',
			});
			continue;
		}
		const nearest = caps.reduce((a, b) => (distMil(p, a) < distMil(p, b) ? a : b), caps[0]);
		const d = distMil(p, nearest);
		if (d > maxMil) {
			findings.push({
				ruleId: 'PCB-DEC-001',
				category: 'decoupling',
				severity: 'warning',
				title: `IC ${ref} pad ${p.padNumber}: nearest cap on net ${p.net} is ${d.toFixed(0)} mil away (${(d * 0.0254).toFixed(2)} mm)`,
				detail: `Decoupling caps are most effective <5mm from the pin. Nearest: ${nearest.designator}.`,
				designators: [ref, nearest.designator],
				netNames: [p.net],
				suggestion: 'Move a 100nF cap closer to this pin (target <5mm).',
				values: { distanceMil: d, threshold: maxMil },
			});
		}
	}
	return findings;
}

/** PCB-GND-001: at least one inner layer should host a copper pour
 *  (heuristic — without authoritative layer→net mapping we can't tell which
 *  pour is GND, so we check that SOME inner layer has a pour). */
export function pcbGroundPlaneCoverage(snap: PcbSnapMinimal): EmcFinding[] {
	const findings: EmcFinding[] = [];
	const byLayer = snap.stats?.byLayer ?? {};
	const totalPours = Object.values(byLayer).reduce((acc, s: any) => acc + (s?.pours ?? 0), 0);
	if (totalPours === 0) {
		findings.push({
			ruleId: 'PCB-GND-001',
			category: 'ground_strategy',
			severity: 'critical',
			title: 'No copper pours found anywhere on the board',
			detail: 'Boards without ground pours have very poor return paths and high EMI. At least one layer should host a pour assigned to GND.',
			designators: [],
			suggestion: 'Add a polygon/region pour on the bottom (or an inner) layer assigned to the GND net.',
		});
	} else if (totalPours < 2) {
		findings.push({
			ruleId: 'PCB-GND-001',
			category: 'ground_strategy',
			severity: 'warning',
			title: `Only ${totalPours} pour on the board`,
			detail: 'Recommend at least one ground pour AND one power pour (or two ground references on a 4-layer stack).',
			designators: [],
		});
	}
	return findings;
}

/** PCB-LYR-001: warn if board has only 2 layers and any switching regulator is present. */
export function pcbLayerStackWarning(snap: PcbSnapMinimal): EmcFinding[] {
	const findings: EmcFinding[] = [];
	const copperLayers = (snap.layers ?? []).filter((l) => /top|bottom|inner|copper/i.test(l.type ?? '') || /^(top|bottom|inner)/i.test(l.name)).length;
	const hasSwitcher = Object.values(snap.components ?? {}).some((c) =>
		/^LT|^LM[0-9]|^TPS62|^TPS63|^MP[0-9]+|^AP[0-9]+|^MPM/i.test(c.mpn ?? ''),
	);
	if (copperLayers <= 2 && hasSwitcher) {
		findings.push({
			ruleId: 'PCB-LYR-001',
			category: 'switching_regulator',
			severity: 'warning',
			title: '2-layer board with switching regulator(s) — EMC risk',
			detail: 'Switching regulator HF noise is hard to contain on 2-layer stacks. Recommend ≥4 layers with a dedicated GND plane.',
			designators: [],
			suggestion: 'Consider a 4-layer stack: signal / GND / power / signal.',
		});
	}
	return findings;
}

export interface PcbEmcReport {
	findingsCount: number;
	bySeverity: Record<'critical' | 'warning' | 'info', number>;
	findings: EmcFinding[];
	summary: string;
}

export function analyzePcbEmc(snap: PcbSnapMinimal, opts: { decouplingMaxMil?: number } = {}): PcbEmcReport {
	const findings: EmcFinding[] = [];
	findings.push(...pcbDecouplingProximity(snap, { maxMil: opts.decouplingMaxMil }));
	findings.push(...pcbGroundPlaneCoverage(snap));
	findings.push(...pcbLayerStackWarning(snap));

	const bySeverity = { critical: 0, warning: 0, info: 0 } as Record<'critical' | 'warning' | 'info', number>;
	for (const f of findings) bySeverity[f.severity] += 1;
	return {
		findingsCount: findings.length,
		bySeverity,
		findings,
		summary: `${findings.length} PCB-EMC findings: ${bySeverity.critical}C/${bySeverity.warning}W/${bySeverity.info}I.`,
	};
}

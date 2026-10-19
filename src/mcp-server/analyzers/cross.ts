// Cross-analysis — schematic ↔ PCB consistency checks. Pure analyzer.

import { buildBom, type DesignSnapshotMinimal } from './bom';

export interface SchSnap extends DesignSnapshotMinimal {
	nets?: Record<string, { name: string; members?: Array<{ designator: string; pinNumber: string }> }>;
}

export interface PcbSnap {
	components: Record<string, { designator: string; mpn?: string; footprint?: string; layer?: string; pinCount?: number }>;
	nets: Record<string, { name: string; members?: Array<{ designator: string; padNumber: string }>; pinCount?: number }>;
	pads?: Array<{ designator: string; padNumber: string; net: string }>;
}

export type CrossSeverity = 'critical' | 'warning' | 'info';

export interface CrossFinding {
	severity: CrossSeverity;
	rule: string;
	title: string;
	detail: string;
	designators?: string[];
	netNames?: string[];
}

export interface CrossReport {
	bySeverity: Record<CrossSeverity, number>;
	findings: CrossFinding[];
	summary: string;
	stats: {
		schComponents: number;
		pcbComponents: number;
		schNets: number;
		pcbNets: number;
		bomMpnMismatches: number;
		footprintMismatches: number;
		designatorsMissingFromPcb: number;
		designatorsMissingFromSch: number;
		netsMissingFromPcb: number;
		netsMissingFromSch: number;
	};
}

function indexByDesignator(comps: Record<string, any>): Map<string, any> {
	const m = new Map<string, any>();
	for (const c of Object.values(comps)) {
		if (c?.designator) m.set(String(c.designator).toUpperCase(), c);
	}
	return m;
}

export function crossVerify(sch: SchSnap, pcb: PcbSnap): CrossReport {
	const findings: CrossFinding[] = [];
	const schByRef = indexByDesignator(sch.components ?? {});
	const pcbByRef = indexByDesignator(pcb.components ?? {});

	// Designator presence
	const schRefs = new Set(schByRef.keys());
	const pcbRefs = new Set(pcbByRef.keys());
	const missingFromPcb = [...schRefs].filter((r) => !pcbRefs.has(r));
	const missingFromSch = [...pcbRefs].filter((r) => !schRefs.has(r));

	for (const r of missingFromPcb) {
		findings.push({
			severity: 'critical',
			rule: 'XREF-001',
			title: `Designator ${r} present in schematic but missing from PCB`,
			detail: 'Component placed on schematic but not on PCB. Either place it or remove from schematic.',
			designators: [r],
		});
	}
	for (const r of missingFromSch) {
		findings.push({
			severity: 'warning',
			rule: 'XREF-002',
			title: `Designator ${r} placed on PCB but missing from schematic`,
			detail: 'PCB has a component with no matching schematic entry. Likely a stale placement; remove or sync.',
			designators: [r],
		});
	}

	// MPN + footprint reconciliation for designators on both sides
	let mpnMismatches = 0, fpMismatches = 0;
	for (const ref of schRefs) {
		if (!pcbRefs.has(ref)) continue;
		const s = schByRef.get(ref);
		const p = pcbByRef.get(ref);
		const sMpn = String(s?.mpn ?? '').trim();
		const pMpn = String(p?.mpn ?? '').trim();
		if (sMpn && pMpn && sMpn.toUpperCase() !== pMpn.toUpperCase()) {
			mpnMismatches++;
			findings.push({
				severity: 'critical',
				rule: 'XREF-003',
				title: `MPN mismatch on ${ref}: schematic="${sMpn}" pcb="${pMpn}"`,
				detail: 'Manufacturer part number diverged between schematic and PCB. The manufactured board will not match the schematic BOM.',
				designators: [ref],
			});
		}
		const sFp = String(s?.footprint ?? '').trim();
		const pFp = String(p?.footprint ?? '').trim();
		if (sFp && pFp && sFp.toUpperCase() !== pFp.toUpperCase()) {
			fpMismatches++;
			findings.push({
				severity: 'warning',
				rule: 'XREF-004',
				title: `Footprint mismatch on ${ref}: schematic="${sFp}" pcb="${pFp}"`,
				detail: 'Footprint differs. Re-link footprints or update one side.',
				designators: [ref],
			});
		}
	}

	// Net presence
	const schNets = new Set(Object.keys(sch.nets ?? {}));
	const pcbNets = new Set(Object.keys(pcb.nets ?? {}));
	const netsMissingFromPcb = [...schNets].filter((n) => !pcbNets.has(n) && !n.startsWith('$'));
	const netsMissingFromSch = [...pcbNets].filter((n) => !schNets.has(n) && !n.startsWith('$'));

	for (const n of netsMissingFromPcb.slice(0, 30)) {
		findings.push({
			severity: 'warning',
			rule: 'XREF-005',
			title: `Net "${n}" exists in schematic but not on PCB`,
			detail: 'Connectivity ambiguous. Verify routing or net naming.',
			netNames: [n],
		});
	}
	if (netsMissingFromPcb.length > 30) {
		findings.push({
			severity: 'info',
			rule: 'XREF-005',
			title: `${netsMissingFromPcb.length - 30} more nets missing from PCB (truncated)`,
			detail: 'Many missing nets — likely a naming convention difference (auto-named nets often differ).',
			netNames: netsMissingFromPcb.slice(30, 60),
		});
	}

	const bySeverity: Record<CrossSeverity, number> = { critical: 0, warning: 0, info: 0 };
	for (const f of findings) bySeverity[f.severity] += 1;

	return {
		bySeverity,
		findings,
		summary: `${findings.length} cross-analysis findings: ${bySeverity.critical}C/${bySeverity.warning}W/${bySeverity.info}I. Designator mismatches: ${missingFromPcb.length} sch→pcb, ${missingFromSch.length} pcb→sch. MPN: ${mpnMismatches}, footprint: ${fpMismatches}.`,
		stats: {
			schComponents: Object.keys(sch.components ?? {}).length,
			pcbComponents: Object.keys(pcb.components ?? {}).length,
			schNets: schNets.size,
			pcbNets: pcbNets.size,
			bomMpnMismatches: mpnMismatches,
			footprintMismatches: fpMismatches,
			designatorsMissingFromPcb: missingFromPcb.length,
			designatorsMissingFromSch: missingFromSch.length,
			netsMissingFromPcb: netsMissingFromPcb.length,
			netsMissingFromSch: netsMissingFromSch.length,
		},
	};
}

/** BOM-level reconciliation — used when sch and pcb manufacture-export-bom diverge. */
export function reconcileBom(sch: SchSnap, pcbBomRows: Array<{ designators?: string; mpn?: string; qty?: number }>): {
	totalSch: number;
	totalPcb: number;
	mismatches: Array<{ designator: string; schMpn: string; pcbMpn: string }>;
} {
	const schBom = buildBom(sch);
	const schByRef = new Map<string, string>();
	for (const row of schBom.rows) for (const d of row.designators) schByRef.set(d.toUpperCase(), row.mpn);

	const mismatches: Array<{ designator: string; schMpn: string; pcbMpn: string }> = [];
	let pcbCount = 0;
	for (const r of pcbBomRows) {
		const refs = (r.designators || '').split(/[,;\s]+/).filter(Boolean);
		pcbCount += refs.length || (r.qty || 0);
		for (const ref of refs) {
			const u = ref.toUpperCase();
			const sMpn = schByRef.get(u) ?? '';
			const pMpn = (r.mpn || '').trim();
			if (sMpn && pMpn && sMpn.toUpperCase() !== pMpn.toUpperCase()) {
				mismatches.push({ designator: u, schMpn: sMpn, pcbMpn: pMpn });
			}
		}
	}
	return { totalSch: schBom.componentCount, totalPcb: pcbCount, mismatches };
}

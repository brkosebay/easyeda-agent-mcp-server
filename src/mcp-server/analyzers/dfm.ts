// DFM analyzer — JLCPCB + PCBWay manufacturing constraint checks.
// Combines BOM-side (basic vs extended parts) and PCB-side (trace widths,
// drill sizes, board size, layer counts) checks. Pure module.

import { resolveLcsc } from '../sourcing/lcsc';
import { buildBom, type DesignSnapshotMinimal } from './bom';

export type DfmSeverity = 'critical' | 'warning' | 'info';

export interface DfmFinding {
	ruleId: string;
	category: 'parts' | 'pcb_geometry' | 'assembly' | 'pricing' | 'general';
	severity: DfmSeverity;
	title: string;
	detail: string;
	designators?: string[];
	suggestion?: string;
	values?: Record<string, number | string>;
}

export interface DfmTier {
	name: 'jlcpcb' | 'pcbway';
	minTraceWidthMil: number;
	minClearanceMil: number;
	minDrillMm: number;
	maxBoardLayers: number;
	maxBoardSizeMm: { x: number; y: number };
	supportsAssembly: boolean;
}

export const JLCPCB_TIER: DfmTier = {
	name: 'jlcpcb',
	minTraceWidthMil: 4,
	minClearanceMil: 4,
	minDrillMm: 0.3,
	maxBoardLayers: 8,
	maxBoardSizeMm: { x: 400, y: 500 },
	supportsAssembly: true,
};

export const PCBWAY_TIER: DfmTier = {
	name: 'pcbway',
	minTraceWidthMil: 3,
	minClearanceMil: 3,
	minDrillMm: 0.2,
	maxBoardLayers: 32,
	maxBoardSizeMm: { x: 580, y: 580 },
	supportsAssembly: true,
};

interface PcbSnapForDfm {
	stats?: { byLayer?: Record<string, any>; trackCount?: number };
	layers?: Array<{ name: string; type?: string }>;
	components: Record<string, { designator: string; mpn?: string }>;
}

export interface DfmReport {
	tier: DfmTier['name'];
	findingsCount: number;
	bySeverity: Record<DfmSeverity, number>;
	findings: DfmFinding[];
	summary: string;
	pricingHints?: { extendedPartCount: number; estimatedSetupFeeUsd?: number };
}

/** Check JLCPCB basic-vs-extended parts. Extended parts add a per-SKU setup
 *  fee (~$3 per unique extended part). */
export async function checkPartsDfm(sch: DesignSnapshotMinimal, tier: DfmTier): Promise<{ findings: DfmFinding[]; extendedPartCount: number }> {
	const findings: DfmFinding[] = [];
	if (tier.name !== 'jlcpcb') return { findings, extendedPartCount: 0 };
	const bom = buildBom(sch);
	const candidates = bom.rows.filter((r) => r.distributorId && /^c\d+/i.test(r.distributorId));
	let extendedCount = 0;
	const concurrency = 4;
	let i = 0;
	const workers = Array.from({ length: concurrency }, async () => {
		while (i < candidates.length) {
			const row = candidates[i++];
			try {
				const part = await resolveLcsc(row.distributorId, { enrich: true });
				if (part?.basicPart === false) {
					extendedCount += 1;
					if (extendedCount <= 30) {
						findings.push({
							ruleId: 'DFM-PART-001',
							category: 'pricing',
							severity: 'info',
							title: `${row.designators.join(', ')} — extended part on JLCPCB`,
							detail: `${row.mpn || row.distributorId} is JLCPCB extended (not in basic library). Each unique extended SKU adds setup fee (~$3) per assembly order.`,
							designators: row.designators,
							suggestion: 'If a basic-tier equivalent exists (same value/footprint), substitute to save assembly cost.',
						});
					}
				}
			} catch { /* network failures don't kill the analysis */ }
		}
	});
	await Promise.all(workers);
	if (extendedCount > 30) {
		findings.push({
			ruleId: 'DFM-PART-002',
			category: 'pricing',
			severity: 'warning',
			title: `${extendedCount} extended parts (showed first 30)`,
			detail: 'Many extended parts will significantly inflate assembly setup cost.',
		});
	}
	return { findings, extendedPartCount: extendedCount };
}

/** PCB-side DFM checks against the snapshot. */
export function checkPcbDfm(pcb: PcbSnapForDfm, tier: DfmTier): DfmFinding[] {
	const findings: DfmFinding[] = [];
	const layers = pcb.layers ?? [];
	// Count only copper layers that ACTUALLY have stuff routed/poured/placed
	// on them. EasyEDA exposes 32 inner-layer "slots" by default; counting
	// them all flags every board as exceeding the JLCPCB layer cap.
	const byLayer = pcb.stats?.byLayer ?? {};
	const isCopperLayer = (l: { name: string; type?: string }) =>
		/top|bottom|inner|copper/i.test(l.type ?? '') || /^(top|bottom|inner)/i.test(l.name);
	const layerHasCopperContent = (key: string): boolean => {
		const s: any = (byLayer as any)[key];
		if (!s) return false;
		return (s.components ?? 0) > 0 || (s.tracks ?? 0) > 0 || (s.pours ?? 0) > 0 || (s.pads ?? 0) > 0;
	};
	const usedCopperLayers = layers.filter(isCopperLayer).filter((l) => {
		// byLayer is keyed by either layer name or numeric ID — try both.
		return layerHasCopperContent(l.name)
			|| ((l as any).id != null && layerHasCopperContent(String((l as any).id)));
	}).length;
	const copperLayers = usedCopperLayers > 0 ? usedCopperLayers : layers.filter(isCopperLayer).length;
	if (copperLayers > tier.maxBoardLayers) {
		findings.push({
			ruleId: 'DFM-LAY-001',
			category: 'pcb_geometry',
			severity: 'critical',
			title: `Board has ${copperLayers} copper layers, exceeds ${tier.name} max ${tier.maxBoardLayers}`,
			detail: `Manufacturing tier "${tier.name}" supports up to ${tier.maxBoardLayers} layers.`,
			suggestion: `Reduce layer count or pick a higher tier.`,
		});
	}

	// Track-width / clearance / drill checks need trace data we don't include
	// in the snapshot by default. Surface them as informational TODOs.
	findings.push({
		ruleId: 'DFM-PCB-INFO',
		category: 'pcb_geometry',
		severity: 'info',
		title: `${tier.name} geometry envelope: minTrack=${tier.minTraceWidthMil}mil, minClearance=${tier.minClearanceMil}mil, minDrill=${tier.minDrillMm}mm`,
		detail: 'Run pcb_drc_run with the appropriate rule preset to enforce trace width, clearance, and drill against this tier.',
	});

	return findings;
}

export async function analyzeDfm(sch: DesignSnapshotMinimal, pcb: PcbSnapForDfm | null, tier: DfmTier): Promise<DfmReport> {
	const partsResult = await checkPartsDfm(sch, tier);
	const findings: DfmFinding[] = [...partsResult.findings];
	if (pcb) findings.push(...checkPcbDfm(pcb, tier));
	const bySeverity = { critical: 0, warning: 0, info: 0 } as Record<DfmSeverity, number>;
	for (const f of findings) bySeverity[f.severity] += 1;
	return {
		tier: tier.name,
		findingsCount: findings.length,
		bySeverity,
		findings,
		summary: `${tier.name.toUpperCase()} DFM: ${findings.length} findings (${bySeverity.critical}C/${bySeverity.warning}W/${bySeverity.info}I). Extended parts: ${partsResult.extendedPartCount}.`,
		pricingHints: { extendedPartCount: partsResult.extendedPartCount, estimatedSetupFeeUsd: tier.name === 'jlcpcb' ? partsResult.extendedPartCount * 3 : undefined },
	};
}

export function getTier(name: string): DfmTier {
	if (name === 'pcbway') return PCBWAY_TIER;
	return JLCPCB_TIER;
}

// Fab-release-gate analyzer — combines BOM, EMC, thermal, DFM, datasheet
// coverage, and cross-analysis into a single pass/fail with a punch list.
// Pure orchestration over existing analyzers.

import type { BomReport } from './bom';
import type { EmcReport } from './emc';
import type { ThermalReport } from './thermal';
import type { DfmReport } from './dfm';
import type { CrossReport } from './cross';
import type { PcbEmcReport } from './pcb-emc';
import type { FunctionalReport } from './functional';

export type GateSeverity = 'pass' | 'warning' | 'critical' | 'inconclusive' | 'error';

export interface GateCheck {
	id: string;
	title: string;
	severity: GateSeverity;
	detail: string;
	count?: number;
}

export interface FabReleaseGate {
	pass: boolean;
	status: 'pass' | 'fail' | 'inconclusive' | 'error';
	coverage: Array<{ check: EvidenceKind; status: 'present' | 'not-run' | 'error'; detail?: string }>;
	criticalCount: number;
	warningCount: number;
	checks: GateCheck[];
	summary: string;
}

export type EvidenceKind = 'bom' | 'emc' | 'functional' | 'thermal' | 'pcbEmc' | 'dfm' | 'cross' | 'datasheetCoverage';
const REQUIRED_EVIDENCE: EvidenceKind[] = ['bom', 'emc', 'functional', 'thermal', 'pcbEmc', 'dfm', 'cross', 'datasheetCoverage'];

export interface GateInputs {
	evidenceErrors?: Partial<Record<EvidenceKind, string>>;
	bom?: BomReport;
	emc?: EmcReport;
	functional?: FunctionalReport;
	thermal?: ThermalReport;
	pcbEmc?: PcbEmcReport;
	dfm?: DfmReport;
	cross?: CrossReport;
	datasheetCoverage?: { withDatasheet: number; withoutDatasheet: number };
}

export function evaluateFabRelease(inputs: GateInputs): FabReleaseGate {
	const checks: GateCheck[] = [];
	const coverage = REQUIRED_EVIDENCE.map(check => ({
		check,
		status: inputs.evidenceErrors?.[check] ? 'error' as const : inputs[check] ? 'present' as const : 'not-run' as const,
		detail: inputs.evidenceErrors?.[check],
	}));
	for (const evidence of coverage) {
		if (evidence.status !== 'present') checks.push({
			id: `COVERAGE-${evidence.check}`, title: `${evidence.check} evidence`,
			severity: evidence.status === 'error' ? 'error' : 'inconclusive',
			detail: evidence.detail || 'Required evidence was not supplied.',
		});
	}

	if (inputs.bom) {
		const gaps = inputs.bom.gapsSummary;
		const uncertain = inputs.bom.rows.filter(row => row.population === 'unknown' || row.conflicts?.length).length;
		if (!inputs.bom.componentCount || uncertain) checks.push({
			id: 'BOM-UNCERTAIN', title: 'BOM population and part identity', severity: 'inconclusive',
			detail: !inputs.bom.componentCount ? 'The extracted BOM is empty.' : `${uncertain} rows have unknown population or conflicting metadata.`,
		});
		const criticalGaps = (gaps.mpn ?? 0) + (gaps.footprint ?? 0);
		checks.push({
			id: 'BOM-COMPLETE',
			title: 'BOM has no critical gaps',
			severity: criticalGaps === 0 ? 'pass' : 'critical',
			detail: criticalGaps === 0 ? 'All rows have MPN + footprint.' : `${gaps.mpn} rows missing MPN, ${gaps.footprint} missing footprint.`,
			count: criticalGaps,
		});
		const distGaps = gaps.distributor ?? 0;
		checks.push({
			id: 'BOM-DISTRIBUTOR',
			title: 'All BOM rows have a distributor',
			severity: distGaps === 0 ? 'pass' : 'warning',
			detail: `${distGaps} rows lack distributor classification.`,
			count: distGaps,
		});
	}

	if (inputs.emc) {
		const c = inputs.emc.bySeverity.critical;
		checks.push({
			id: 'EMC-SCH-CRITICAL',
			title: 'No critical schematic-EMC findings',
			severity: c === 0 ? 'pass' : 'critical',
			detail: c === 0 ? 'Clean.' : `${c} critical EMC issues. Worst category: ${inputs.emc.scoredCategories[0]?.category}.`,
			count: c,
		});
	}

	if (inputs.functional) {
		const c = inputs.functional.bySeverity.critical;
		checks.push({
			id: 'FUNCTIONAL-CRITICAL',
			title: 'No critical functional-review findings',
			severity: c === 0 ? 'pass' : 'critical',
			detail: c === 0
				? 'No critical findings from the implemented functional heuristics.'
				: `${c} critical functional defects (e.g. USB D+/D- floating or tied to GND — connectivity masked by shield/mounting pads). ${inputs.functional.summary}`,
			count: c,
		});
	}

	if (inputs.pcbEmc) {
		const c = inputs.pcbEmc.bySeverity.critical;
		checks.push({
			id: 'EMC-PCB-CRITICAL',
			title: 'No critical PCB-EMC findings',
			severity: c === 0 ? 'pass' : 'critical',
			detail: c === 0 ? 'Clean.' : `${c} critical PCB-EMC issues (e.g. missing ground pour, no decoupling on IC).`,
			count: c,
		});
	}

	if (inputs.thermal) {
		const c = inputs.thermal.bySeverity?.critical ?? 0;
		checks.push({
			id: 'THERMAL-CRITICAL',
			title: 'No critical thermal hot-spots',
			severity: c > 0 ? 'critical' : 'warning',
			detail: c === 0 ? `No critical flags from the heuristic model. ${inputs.thermal.summary} Thermal qualification remains unverified.` : `${c} components flagged critical (need thermal mitigation).`,
			count: c,
		});
	}

	if (inputs.dfm) {
		const c = inputs.dfm.bySeverity.critical;
		const w = inputs.dfm.bySeverity.warning;
		checks.push({
			id: `DFM-${inputs.dfm.tier.toUpperCase()}`,
			title: `${inputs.dfm.tier.toUpperCase()} DFM clean (no criticals)`,
			severity: c === 0 ? (w > 0 ? 'warning' : 'pass') : 'critical',
			detail: inputs.dfm.summary,
			count: c,
		});
	}

	if (inputs.cross) {
		const c = inputs.cross.bySeverity.critical;
		checks.push({
			id: 'CROSS-VERIFY',
			title: 'Schematic ↔ PCB consistent',
			severity: c === 0 ? 'pass' : 'critical',
			detail: c === 0 ? 'No designator/MPN/footprint mismatches.' : inputs.cross.summary,
			count: c,
		});
	}

	if (inputs.datasheetCoverage) {
		const without = inputs.datasheetCoverage.withoutDatasheet;
		checks.push({
			id: 'DATASHEET-COVERAGE',
			title: 'Datasheets cached for all unique parts',
			severity: without === 0 ? 'pass' : 'warning',
			detail: `${inputs.datasheetCoverage.withDatasheet} cached, ${without} missing.`,
			count: without,
		});
	}

	const criticalCount = checks.filter((c) => c.severity === 'critical').length;
	const warningCount = checks.filter((c) => c.severity === 'warning').length;
	const status = criticalCount ? 'fail' : coverage.some(item => item.status === 'error') ? 'error'
		: checks.some(check => check.severity === 'inconclusive') ? 'inconclusive' : 'pass';
	const pass = status === 'pass';

	return {
		pass, status, coverage,
		criticalCount,
		warningCount,
		checks,
		summary: `Engineering evidence: ${status.toUpperCase()} — ${criticalCount} critical, ${warningCount} warning. Automated checks are not manufacturing approval.`,
	};
}

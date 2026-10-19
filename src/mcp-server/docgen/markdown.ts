// kidoc-style markdown report generators. Each takes structured analyzer
// outputs and produces a publication-ready markdown document. Section types:
// design_review, emc_report, manufacturing_pkg, schematic_review, hdd
// (Hardware Design Description).

import type { BomReport } from '../analyzers/bom';
import type { EmcReport } from '../analyzers/emc';
import type { ThermalReport } from '../analyzers/thermal';
import type { DfmReport } from '../analyzers/dfm';
import type { PcbEmcReport } from '../analyzers/pcb-emc';
import type { FabReleaseGate } from '../analyzers/fab-release';
import type { FunctionalReport } from '../analyzers/functional';

function fmtTable(headers: string[], rows: any[][]): string {
	const escape = (s: any) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
	const out = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
	for (const r of rows) out.push(`| ${r.map(escape).join(' | ')} |`);
	return out.join('\n');
}

export function renderDesignReview(opts: {
	projectName?: string;
	bom: BomReport;
	emc?: EmcReport;
	functional?: FunctionalReport;
	thermal?: ThermalReport;
	pcbEmc?: PcbEmcReport;
	dfm?: DfmReport;
	gate?: FabReleaseGate;
}): string {
	const lines: string[] = [];
	lines.push(`# Design Review — ${opts.projectName || '(untitled)'}`);
	lines.push(`Generated ${new Date().toISOString()}`);
	lines.push('');

	if (opts.gate) {
		lines.push(`## Release readiness: ${opts.gate.pass ? '✓ PASS' : '✗ HOLD'}`);
		lines.push('');
		lines.push(opts.gate.summary);
		lines.push('');
		lines.push(fmtTable(['Check', 'Severity', 'Detail'], opts.gate.checks.map((c) => [c.title, c.severity, c.detail])));
		lines.push('');
	}

	lines.push('## BOM summary');
	lines.push('');
	lines.push(`- **${opts.bom.rowCount} rows / ${opts.bom.componentCount} components** · ${opts.bom.dnpCount} DNP`);
	const gs = opts.bom.gapsSummary;
	lines.push(`- Gaps: MPN=${gs.mpn}, manufacturer=${gs.manufacturer}, value=${gs.value}, footprint=${gs.footprint}, distributor=${gs.distributor}`);
	lines.push(`- Distributor breakdown: ${Object.entries(opts.bom.distributorBreakdown).map(([k, v]) => `${k}:${v}`).join(', ')}`);
	lines.push('');

	if (opts.emc) {
		lines.push('## EMC pre-compliance (schematic)');
		lines.push('');
		lines.push(opts.emc.summary);
		lines.push('');
		const top = opts.emc.findings.slice(0, 30);
		if (top.length) {
			lines.push(fmtTable(['Rule', 'Severity', 'Finding', 'Designators'], top.map((f) => [f.ruleId, f.severity, f.title, (f.designators ?? []).join(', ')])));
			lines.push('');
		}
	}

	if (opts.functional) {
		lines.push('## Functional review (intent check)');
		lines.push('');
		lines.push(opts.functional.summary);
		lines.push('');
		const top = opts.functional.findings.slice(0, 30);
		if (top.length) {
			lines.push(fmtTable(['Rule', 'Severity', 'Confidence', 'Finding', 'Designators'],
				top.map((f) => [f.ruleId, f.severity, f.confidence, f.title, (f.designators ?? []).join(', ')])));
			lines.push('');
		}
	}

	if (opts.pcbEmc) {
		lines.push('## EMC pre-compliance (PCB)');
		lines.push('');
		lines.push(opts.pcbEmc.summary);
		lines.push('');
		const top = opts.pcbEmc.findings.slice(0, 20);
		if (top.length) {
			lines.push(fmtTable(['Rule', 'Severity', 'Finding'], top.map((f) => [f.ruleId, f.severity, f.title])));
			lines.push('');
		}
	}

	if (opts.thermal) {
		lines.push('## Thermal');
		lines.push('');
		lines.push(opts.thermal.summary);
		lines.push('');
		lines.push(fmtTable(['Designator', 'Class', 'Estimated W', 'Method'], opts.thermal.hottest.map((e) => [e.designator, e.deviceClass, (e.powerWatts ?? 0).toFixed(3), e.method])));
		lines.push('');
	}

	if (opts.dfm) {
		lines.push(`## DFM (${opts.dfm.tier.toUpperCase()})`);
		lines.push('');
		lines.push(opts.dfm.summary);
		lines.push('');
		if (opts.dfm.pricingHints?.extendedPartCount) {
			lines.push(`- Extended parts (JLCPCB): ${opts.dfm.pricingHints.extendedPartCount} · est. setup fee $${opts.dfm.pricingHints.estimatedSetupFeeUsd ?? '?'}`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

export function renderEmcReport(opts: { projectName?: string; emc?: EmcReport; pcbEmc?: PcbEmcReport }): string {
	const lines: string[] = [];
	lines.push(`# EMC Pre-Compliance Report — ${opts.projectName || '(untitled)'}`);
	lines.push(`Generated ${new Date().toISOString()}`);
	lines.push('');

	const all = [...(opts.emc?.findings ?? []), ...(opts.pcbEmc?.findings ?? [])];
	const byCat = new Map<string, typeof all>();
	for (const f of all) {
		if (!byCat.has(f.category)) byCat.set(f.category, []);
		byCat.get(f.category)!.push(f);
	}
	for (const [cat, fs] of byCat) {
		lines.push(`## ${cat}`);
		lines.push('');
		lines.push(fmtTable(['Rule', 'Severity', 'Finding', 'Designators', 'Suggestion'],
			fs.map((f) => [f.ruleId, f.severity, f.title, (f.designators ?? []).join(', '), f.suggestion ?? ''])));
		lines.push('');
	}
	return lines.join('\n');
}

export function renderManufacturingPkg(opts: {
	projectName?: string;
	bom: BomReport;
	dfm?: DfmReport;
	tier?: string;
}): string {
	const lines: string[] = [];
	lines.push(`# Manufacturing Package — ${opts.projectName || '(untitled)'}`);
	lines.push(`Tier: ${opts.tier ?? opts.dfm?.tier ?? 'JLCPCB'} · Generated ${new Date().toISOString()}`);
	lines.push('');
	lines.push('## BOM');
	lines.push('');
	lines.push(fmtTable(
		['Designators', 'Qty', 'MPN', 'Manufacturer', 'Value', 'Footprint', 'Distributor', 'ID', 'DNP'],
		opts.bom.rows.map((r) => [r.designators.join(', '), r.qty, r.mpn, r.manufacturer, r.value, r.footprint, r.distributor, r.distributorId, r.dnp ? 'DNP' : '']),
	));
	lines.push('');
	if (opts.dfm) {
		lines.push('## DFM notes');
		lines.push('');
		lines.push(opts.dfm.summary);
		lines.push('');
	}
	return lines.join('\n');
}

export function renderHdd(opts: { projectName?: string; bom: BomReport; emc?: EmcReport; thermal?: ThermalReport }): string {
	const lines: string[] = [];
	lines.push(`# Hardware Design Description — ${opts.projectName || '(untitled)'}`);
	lines.push(`Generated ${new Date().toISOString()}`);
	lines.push('');
	lines.push('## 1. Overview');
	lines.push('');
	lines.push(`This document captures the high-level hardware design for ${opts.projectName || 'this project'}. It is generated automatically from the design database. Section 2 lists all BOM items; Section 3 surfaces design-review findings (EMC/thermal); Section 4 enumerates external interfaces (TBD).`);
	lines.push('');
	lines.push('## 2. BOM');
	lines.push('');
	lines.push(`${opts.bom.rowCount} unique BOM rows / ${opts.bom.componentCount} component instances.`);
	lines.push('');
	lines.push(fmtTable(['Refs', 'Qty', 'Description'], opts.bom.rows.map((r) => [r.designators.join(', '), r.qty, [r.mpn, r.value, r.footprint].filter(Boolean).join(' · ')])));
	lines.push('');
	if (opts.emc) {
		lines.push('## 3. Design-review findings');
		lines.push('');
		lines.push(`EMC: ${opts.emc.summary}`);
		lines.push('');
	}
	if (opts.thermal) {
		lines.push('### Thermal');
		lines.push('');
		lines.push(opts.thermal.summary);
		lines.push('');
	}
	return lines.join('\n');
}

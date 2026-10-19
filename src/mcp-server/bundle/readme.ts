// Generate the bundle README.md — the LLM verifier's entry point.
//
// Goal: a "smart agent without tool calls" can read this file and follow
// links into the rest of the bundle to verify the design. Every file in
// the bundle is referenced from here with a one-line description of what
// it contains and why the verifier might want it.

import type { BomReport } from '../analyzers/bom';

export interface BundleManifestEntry {
	path: string;
	bytes: number;
	contentType: 'json' | 'markdown' | 'csv' | 'pdf' | 'gerber' | 'step' | 'text' | 'binary';
	description: string;
}

export interface ReadmeContext {
	projectName: string;
	generatedAt: string;
	mcpVersion: string;
	schSnapshotStats: {
		componentCount: number;
		netCount: number;
		pageCount: number;
	};
	bomReport: BomReport;
	pcbExportsIncluded: string[];
	datasheetCount: number;
	datasheetMissingForMpn: string[];
	manifest: BundleManifestEntry[];
	notes: string[];
	emcSummary?: string;
	thermalSummary?: string;
	pcbSnapshotStats?: { componentCount: number; netCount: number; padCount: number; viaCount: number; trackCount: number; pourCount: number };
	pcbEmcSummary?: string;
	crossSummary?: string;
	dfmSummary?: string;
	spiceSummary?: string;
	fabGate?: {
		pass: boolean;
		criticalCount: number;
		warningCount: number;
		summary: string;
		checks: Array<{ id: string; title: string; severity: string; detail: string }>;
	};
}

export function renderReadme(ctx: ReadmeContext): string {
	const lines: string[] = [];

	lines.push(`# Verification Bundle — ${ctx.projectName || '(untitled project)'}`);
	lines.push('');
	lines.push(`Generated **${ctx.generatedAt}** by easyeda-agent-mcp-server v${ctx.mcpVersion}.`);
	lines.push('');
	lines.push('You are a verifying agent reading this bundle. **You do not have tool calls.** Everything you need to audit this design is in this archive. This README is the entry point — follow the links below into specific files.');
	lines.push('');

	// ---- Release verdict ----
	if (ctx.fabGate) {
		lines.push(`## Release verdict: ${ctx.fabGate.pass ? '✓ PASS' : '✗ HOLD'}`);
		lines.push('');
		lines.push(ctx.fabGate.summary);
		lines.push('');
		lines.push('| Check | Severity | Detail |');
		lines.push('|---|---|---|');
		for (const c of ctx.fabGate.checks) {
			const det = c.detail.replace(/\|/g, '\\|');
			lines.push(`| ${c.title} | ${c.severity} | ${det} |`);
		}
		lines.push('');
		lines.push('Full machine-readable gate at [`analysis/fab-release-gate.json`](analysis/fab-release-gate.json).');
		lines.push('');
	}

	// ---- Snapshot ----
	lines.push('## What this bundle contains');
	lines.push('');
	lines.push(`- **Schematic snapshot** — ${ctx.schSnapshotStats.componentCount} components, ${ctx.schSnapshotStats.netCount} nets across ${ctx.schSnapshotStats.pageCount} schematic pages. Raw JSON in [\`project/schematic-snapshot.json\`](project/schematic-snapshot.json).`);
	lines.push(`- **BOM** — ${ctx.bomReport.rowCount} rows / ${ctx.bomReport.componentCount} components. Structured: [\`project/bom.json\`](project/bom.json). CSV: [\`project/bom.csv\`](project/bom.csv). Markdown summary: [\`project/bom.md\`](project/bom.md).`);
	lines.push(`- **PCB exports** — ${ctx.pcbExportsIncluded.length ? ctx.pcbExportsIncluded.join(', ') : '(none included — schematic-only project)'}. See [\`pcb/\`](pcb/).`);
	lines.push(`- **Datasheets** — ${ctx.datasheetCount} PDFs in [\`datasheets/\`](datasheets/), indexed by [\`datasheets/index.md\`](datasheets/index.md).`);
	if (ctx.pcbSnapshotStats) {
		const p = ctx.pcbSnapshotStats;
		lines.push(`- **PCB snapshot** — ${p.componentCount} components, ${p.netCount} nets, ${p.padCount} pads, ${p.viaCount} vias, ${p.trackCount} tracks, ${p.pourCount} pours. Raw JSON in [\`pcb/pcb-snapshot.json\`](pcb/pcb-snapshot.json).`);
	}
	if (ctx.emcSummary) {
		lines.push(`- **EMC (schematic-side)** — ${ctx.emcSummary} → [\`analysis/emc.json\`](analysis/emc.json)`);
	}
	if (ctx.pcbEmcSummary) {
		lines.push(`- **EMC (PCB-side)** — ${ctx.pcbEmcSummary} → [\`analysis/pcb-emc.json\`](analysis/pcb-emc.json)`);
	}
	if (ctx.thermalSummary) {
		lines.push(`- **Thermal** — ${ctx.thermalSummary} → [\`analysis/thermal.json\`](analysis/thermal.json)`);
	}
	if (ctx.crossSummary) {
		lines.push(`- **Cross-verify (sch ↔ PCB)** — ${ctx.crossSummary} → [\`analysis/cross-verify.json\`](analysis/cross-verify.json)`);
	}
	if (ctx.dfmSummary) {
		lines.push(`- **DFM** — ${ctx.dfmSummary} → [\`analysis/dfm.json\`](analysis/dfm.json)`);
	}
	if (ctx.spiceSummary) {
		lines.push(`- **SPICE testbenches** — ${ctx.spiceSummary} → [\`analysis/spice-testbenches.json\`](analysis/spice-testbenches.json) and individual \`.cir\` files in [\`spice/\`](spice/)`);
	}
	lines.push('');

	// ---- Verification checklist ----
	lines.push('## Recommended verification checklist');
	lines.push('');
	lines.push('Start here. Each step references the file you should open.');
	lines.push('');
	lines.push('1. **Sanity-check the BOM gaps.** Open [`project/bom.md`](project/bom.md). The "Gaps" column flags missing MPN / footprint / value / distributor. Anything in `gapsSummary` > 0 in [`project/bom.json`](project/bom.json) is a defect.');
	lines.push('2. **Verify the power tree.** From [`project/schematic-snapshot.json`](project/schematic-snapshot.json), find every net flagged `isPower:true`. Trace upstream to a regulator (deviceClass `regulator_ldo`/`regulator_buck`/`regulator_boost`). For each regulator, find its feedback divider on the FB pin and confirm Vout = Vref·(R1+R2)/R2.');
	lines.push('3. **Check decoupling coverage.** For every IC in the snapshot, count caps adjacent on its power pin\'s net. Flag anything with cap_count < ic_pin_count_on_rail.');
	lines.push('4. **ESD / protection audit.** For every connector (deviceClass `connector`/`header`/`usb_connector`), every signal pin should have a TVS diode (deviceClass `tvs`) on its net. Missing TVS = exposure.');
	lines.push('5. **Read the relevant datasheets.** [`datasheets/index.md`](datasheets/index.md) maps MPN → PDF filename. Cross-reference each regulator/IC/sensor against its datasheet for absolute-max ratings, recommended layout, decoupling guidance.');
	lines.push('6. **Inspect PCB layout.** Open [`pcb/pcb.pdf`](pcb/pcb.pdf) for visual review and [`pcb/netlist.txt`](pcb/netlist.txt) for connectivity. The pick-and-place file [`pcb/pick-and-place.csv`](pcb/pick-and-place.csv) gives every component\'s position and rotation.');
	lines.push('7. **Reconcile schematic BOM with manufacturing BOM.** Compare [`project/bom.csv`](project/bom.csv) (from schematic) with [`pcb/bom.csv`](pcb/bom.csv) (from PCB). Any mismatch is a sync bug.');
	lines.push('');

	// ---- BOM summary ----
	lines.push('## BOM summary');
	lines.push('');
	lines.push(`Total rows: **${ctx.bomReport.rowCount}** · Components: **${ctx.bomReport.componentCount}** · DNP qty: **${ctx.bomReport.dnpCount}**`);
	lines.push('');
	const gs = ctx.bomReport.gapsSummary;
	lines.push('**Gaps:**');
	lines.push(`- Missing MPN: ${gs.mpn}`);
	lines.push(`- Missing manufacturer: ${gs.manufacturer}`);
	lines.push(`- Missing value: ${gs.value}`);
	lines.push(`- Missing footprint: ${gs.footprint}`);
	lines.push(`- Unknown distributor: ${gs.distributor}`);
	lines.push('');
	lines.push('**Distributor breakdown:**');
	for (const [dist, count] of Object.entries(ctx.bomReport.distributorBreakdown).sort((a, b) => b[1] - a[1])) {
		lines.push(`- ${dist}: ${count} rows`);
	}
	lines.push('');

	// ---- Datasheets ----
	if (ctx.datasheetMissingForMpn.length) {
		lines.push('## Datasheets — coverage gaps');
		lines.push('');
		lines.push('The following BOM rows have no datasheet in this bundle. The verifier should flag any of these that look like ICs (not passives).');
		lines.push('');
		for (const mpn of ctx.datasheetMissingForMpn.slice(0, 30)) lines.push(`- ${mpn}`);
		if (ctx.datasheetMissingForMpn.length > 30) lines.push(`- … and ${ctx.datasheetMissingForMpn.length - 30} more`);
		lines.push('');
	}

	// ---- File manifest ----
	lines.push('## Full file manifest');
	lines.push('');
	lines.push('Every file in this archive, with its size and content type. Also available machine-readable in [`manifest.json`](manifest.json).');
	lines.push('');
	lines.push('| Path | Type | Size (bytes) | Description |');
	lines.push('|---|---|---:|---|');
	for (const entry of ctx.manifest) {
		const desc = entry.description.replace(/\|/g, '\\|');
		lines.push(`| \`${entry.path}\` | ${entry.contentType} | ${entry.bytes.toLocaleString()} | ${desc} |`);
	}
	lines.push('');

	// ---- Notes ----
	if (ctx.notes.length) {
		lines.push('## Build notes');
		lines.push('');
		for (const note of ctx.notes) lines.push(`- ${note}`);
		lines.push('');
	}

	lines.push('---');
	lines.push('');
	lines.push('Bundle format v1. Source: [easyeda-agent-mcp-server](https://github.com/berkaykosebay/easyeda-agent-mcp-server). Issues / format suggestions welcome.');
	lines.push('');
	return lines.join('\n');
}

export function renderBomMarkdown(report: BomReport): string {
	const lines: string[] = [];
	lines.push(`# BOM — ${report.project || '(untitled)'}`);
	lines.push('');
	lines.push(`${report.rowCount} rows / ${report.componentCount} components / ${report.dnpCount} DNP qty.`);
	lines.push('');
	lines.push('| Designators | Qty | MPN | Manufacturer | Value | Footprint | Class | Distributor | ID | DNP | Gaps |');
	lines.push('|---|---:|---|---|---|---|---|---|---|---|---|');
	for (const r of report.rows) {
		const d = r.designators.join(', ').replace(/\|/g, '\\|');
		const mpn = (r.mpn || '').replace(/\|/g, '\\|');
		const mfg = (r.manufacturer || '').replace(/\|/g, '\\|');
		const v = (r.value || '').replace(/\|/g, '\\|');
		const fp = (r.footprint || '').replace(/\|/g, '\\|');
		lines.push(`| ${d} | ${r.qty} | ${mpn} | ${mfg} | ${v} | ${fp} | ${r.deviceClass} | ${r.distributor} | ${r.distributorId} | ${r.dnp ? 'DNP' : ''} | ${r.gaps.join(';')} |`);
	}
	lines.push('');
	return lines.join('\n');
}

export function renderDatasheetIndexMarkdown(entries: Array<{ mpn: string; lcscCode?: string; filename: string; bytes: number; sha256: string; url: string }>): string {
	const lines: string[] = [];
	lines.push('# Datasheets index');
	lines.push('');
	lines.push(`${entries.length} datasheet PDFs included. Verify the SHA-256 if provenance matters.`);
	lines.push('');
	lines.push('| MPN | LCSC | File | Size (bytes) | SHA-256 (first 16) | Source URL |');
	lines.push('|---|---|---|---:|---|---|');
	for (const e of entries.sort((a, b) => a.mpn.localeCompare(b.mpn))) {
		lines.push(`| ${e.mpn} | ${e.lcscCode || ''} | [\`${e.filename}\`](${e.filename}) | ${e.bytes.toLocaleString()} | \`${e.sha256.slice(0, 16)}…\` | ${e.url || ''} |`);
	}
	lines.push('');
	return lines.join('\n');
}

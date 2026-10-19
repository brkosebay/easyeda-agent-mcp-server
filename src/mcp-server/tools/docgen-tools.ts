// Document-generation tools (kidoc-style). Produce design review, EMC report,
// manufacturing package, and HDD as markdown. Each runs the relevant
// analyzers, formats the output, and optionally writes to disk.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { promises as fs } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { WebSocketBridge } from '../bridge';
import { withInstanceParam } from './query-params';
import { buildBom, type DesignSnapshotMinimal } from '../analyzers/bom';
import { analyzeEmc, type EmcSnapshot } from '../analyzers/emc';
import { analyzeThermal, type ThermalSnapshot } from '../analyzers/thermal';
import { analyzeDfm, getTier } from '../analyzers/dfm';
import { analyzePcbEmc, type PcbSnapMinimal } from '../analyzers/pcb-emc';
import { analyzeFunctionalReport, type FunctionalSnapshot } from '../analyzers/functional';
import { evaluateFabRelease } from '../analyzers/fab-release';
import { renderDesignReview, renderEmcReport, renderManufacturingPkg, renderHdd } from '../docgen/markdown';

async function writeOutput(text: string, outputPath?: string): Promise<{ outputPath: string | null; bytes: number; preview: string }> {
	const preview = text.split('\n').slice(0, 30).join('\n');
	if (outputPath) {
		await mkdir(dirname(outputPath), { recursive: true });
		await fs.writeFile(outputPath, text);
		return { outputPath, bytes: Buffer.byteLength(text), preview };
	}
	return { outputPath: null, bytes: Buffer.byteLength(text), preview };
}

export function registerDocgenTools(server: McpServer, bridge: WebSocketBridge): void {
	const fetchSch = async (rest: any, document: string) =>
		(await bridge.send('sch.extract.design', { ...rest, document, allPages: true, _timeoutMs: 120_000 })) as DesignSnapshotMinimal & EmcSnapshot & ThermalSnapshot;

	const fetchPcb = async (rest: any, document: string) => {
		try { return await bridge.send('pcb.extract.design', { ...rest, document, includeAllPads: true, _timeoutMs: 180_000 }); }
		catch { return null; }
	};

	server.tool(
		'docgen_design_review',
		'Generate a markdown Design Review document combining BOM, EMC, thermal, DFM, and (if pcbDocument provided) PCB-EMC + release gate. The output is publication-ready markdown.',
		withInstanceParam({
			schDocument: z.string(),
			pcbDocument: z.string().optional(),
			tier: z.enum(['jlcpcb', 'pcbway']).default('jlcpcb'),
			outputPath: z.string().optional(),
		}),
		async ({ schDocument, pcbDocument, tier, outputPath, ...rest }) => {
			const sch = await fetchSch(rest, schDocument);
			const pcb = pcbDocument ? await fetchPcb(rest, pcbDocument) : null;
			const bom = buildBom(sch);
			const emc = analyzeEmc(sch);
			const thermal = analyzeThermal(sch);
			const dfm = await analyzeDfm(sch, pcb as any, getTier(tier));
			const pcbEmc = pcb ? analyzePcbEmc(pcb as PcbSnapMinimal) : undefined;
			const functional = analyzeFunctionalReport(sch as unknown as FunctionalSnapshot);
			const gate = evaluateFabRelease({ bom, emc, thermal, dfm, pcbEmc, functional });
			const md = renderDesignReview({ projectName: bom.project, bom, emc, thermal, pcbEmc, dfm, gate, functional });
			const r = await writeOutput(md, outputPath);
			return { content: [{ type: 'text', text: JSON.stringify(r) }] };
		},
	);

	server.tool(
		'docgen_emc_report',
		'Generate a markdown EMC report — every finding grouped by category, with rule IDs, suggestions, and designators.',
		withInstanceParam({
			schDocument: z.string(),
			pcbDocument: z.string().optional(),
			outputPath: z.string().optional(),
		}),
		async ({ schDocument, pcbDocument, outputPath, ...rest }) => {
			const sch = await fetchSch(rest, schDocument);
			const pcb = pcbDocument ? await fetchPcb(rest, pcbDocument) : null;
			const emc = analyzeEmc(sch);
			const pcbEmc = pcb ? analyzePcbEmc(pcb as PcbSnapMinimal) : undefined;
			const md = renderEmcReport({ projectName: sch.project?.name, emc, pcbEmc });
			const r = await writeOutput(md, outputPath);
			return { content: [{ type: 'text', text: JSON.stringify(r) }] };
		},
	);

	server.tool(
		'docgen_manufacturing_pkg',
		'Generate a markdown manufacturing package: full BOM table, DFM tier-specific notes, ready to share with the fabricator.',
		withInstanceParam({
			schDocument: z.string(),
			pcbDocument: z.string().optional(),
			tier: z.enum(['jlcpcb', 'pcbway']).default('jlcpcb'),
			outputPath: z.string().optional(),
		}),
		async ({ schDocument, pcbDocument, tier, outputPath, ...rest }) => {
			const sch = await fetchSch(rest, schDocument);
			const pcb = pcbDocument ? await fetchPcb(rest, pcbDocument) : null;
			const bom = buildBom(sch);
			const dfm = await analyzeDfm(sch, pcb as any, getTier(tier));
			const md = renderManufacturingPkg({ projectName: bom.project, bom, dfm, tier });
			const r = await writeOutput(md, outputPath);
			return { content: [{ type: 'text', text: JSON.stringify(r) }] };
		},
	);

	server.tool(
		'docgen_hdd',
		'Generate a markdown Hardware Design Description (HDD) — overview, BOM table, design-review findings (EMC, thermal). Suitable as the engineering package handed to a reviewer.',
		withInstanceParam({
			schDocument: z.string(),
			outputPath: z.string().optional(),
		}),
		async ({ schDocument, outputPath, ...rest }) => {
			const sch = await fetchSch(rest, schDocument);
			const bom = buildBom(sch);
			const emc = analyzeEmc(sch);
			const thermal = analyzeThermal(sch);
			const md = renderHdd({ projectName: sch.project?.name, bom, emc, thermal });
			const r = await writeOutput(md, outputPath);
			return { content: [{ type: 'text', text: JSON.stringify(r) }] };
		},
	);
}

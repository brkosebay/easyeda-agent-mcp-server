// Fab-release-gate tool — runs every analyzer and produces a single
// pass/fail with a punch list.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withInstanceParam } from './query-params';
import { buildBom, type DesignSnapshotMinimal } from '../analyzers/bom';
import { analyzeEmc, type EmcSnapshot } from '../analyzers/emc';
import { analyzeThermal, type ThermalSnapshot } from '../analyzers/thermal';
import { analyzeDfm, getTier } from '../analyzers/dfm';
import { analyzePcbEmc, type PcbSnapMinimal } from '../analyzers/pcb-emc';
import { crossVerify, type SchSnap, type PcbSnap } from '../analyzers/cross';
import { analyzeFunctionalReport, type FunctionalSnapshot } from '../analyzers/functional';
import { evaluateFabRelease, type GateInputs } from '../analyzers/fab-release';
import { listCachedDatasheets } from '../datasheet/cache';

export function registerFabReleaseTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'fab_release_gate',
		'One-shot release readiness check. Runs BOM audit, EMC (sch + pcb), thermal, DFM (JLCPCB or PCBWay), cross-verify, and datasheet coverage. Returns evidence status (pass/fail/inconclusive/error), coverage and findings; not manufacturing approval. Pass schDocument and (optionally) pcbDocument.',
		withInstanceParam({
			schDocument: z.string().describe('Schematic document UUID'),
			pcbDocument: z.string().optional().describe('PCB document UUID — enables PCB-EMC + DFM-geometry + cross-verify'),
			tier: z.enum(['jlcpcb', 'pcbway']).default('jlcpcb'),
		}),
		async ({ schDocument, pcbDocument, tier, ...rest }) => {
			const sch = (await bridge.send('sch.extract.design', { ...rest, document: schDocument, allPages: true, _timeoutMs: 120_000 })) as DesignSnapshotMinimal & EmcSnapshot & ThermalSnapshot & SchSnap;
			let pcb: any = null;
			const evidenceErrors: GateInputs['evidenceErrors'] = {};
			if (pcbDocument) {
				try { pcb = await bridge.send('pcb.extract.design', { ...rest, document: pcbDocument, includeAllPads: true, _timeoutMs: 180_000 }); }
				catch (error) {
					const detail = `PCB extraction failed: ${error instanceof Error ? error.message : String(error)}`;
					evidenceErrors.pcbEmc = detail; evidenceErrors.cross = detail; evidenceErrors.dfm = detail;
				}
			}

			const bom = buildBom(sch);
			const emc = analyzeEmc(sch as EmcSnapshot);
			const thermal = analyzeThermal(sch as ThermalSnapshot);
			const dfm = await analyzeDfm(sch, pcb, getTier(tier));
			const pcbEmc = pcb ? analyzePcbEmc(pcb as PcbSnapMinimal) : undefined;
			const cross = pcb ? crossVerify(sch as SchSnap, pcb as PcbSnap) : undefined;
			const functional = analyzeFunctionalReport(sch as unknown as FunctionalSnapshot);

			// Datasheet coverage
			const cached = await listCachedDatasheets();
			const cachedKeys = new Set(cached.map((c) => (c.lcscCode || c.mpn || '').toUpperCase()));
			let withDs = 0, withoutDs = 0;
			for (const row of bom.rows) {
				if (!row.mpn && !row.distributorId) continue;
				const k1 = row.mpn?.toUpperCase() ?? '';
				const k2 = row.distributorId?.toUpperCase() ?? '';
				if ([...cachedKeys].some((c) => c === k1 || c === k2)) withDs += 1;
				else withoutDs += 1;
			}

			const gate = evaluateFabRelease({
				bom, emc, thermal, dfm, evidenceErrors,
				pcbEmc, cross, functional,
				datasheetCoverage: { withDatasheet: withDs, withoutDatasheet: withoutDs },
			});

			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						gate,
						bom: { rowCount: bom.rowCount, gapsSummary: bom.gapsSummary, dnpCount: bom.dnpCount },
						emc: { findingsCount: emc.findings.length, bySeverity: emc.bySeverity, summary: emc.summary },
						thermal: { totalWatts: thermal.totalEstimatedWatts, hottest: thermal.hottest.slice(0, 3).map((e) => ({ designator: e.designator, watts: e.powerWatts })) },
						dfm: { tier: dfm.tier, summary: dfm.summary, extendedPartCount: dfm.pricingHints?.extendedPartCount },
						pcbEmc: pcbEmc?.summary ?? null,
						cross: cross?.summary ?? null,
						functional: { bySeverity: functional.bySeverity, summary: functional.summary },
						datasheetCoverage: { cached: withDs, missing: withoutDs },
					}),
				}],
			};
		},
	);
}

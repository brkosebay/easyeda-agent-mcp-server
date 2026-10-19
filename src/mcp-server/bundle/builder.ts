// Verification bundle builder — packages a project's design data + datasheets
// + manufacturing exports into a single ZIP that an external "verifier LLM"
// (no tool calls) can read and audit.
//
// Format v1 layout:
//
//   verification-bundle-{project}-{ts}/
//     README.md                  ← LLM entry point
//     manifest.json              ← machine-readable index
//     project/
//       metadata.json            ← project name, document UUIDs, generated-at
//       schematic-snapshot.json  ← from sch.extract.design (raw)
//       bom.json                 ← buildBom() output
//       bom.csv                  ← merge-aware tracking sheet
//       bom.md                   ← human-readable BOM table
//     pcb/
//       netlist.txt              ← from pcb_export netlist
//       bom.csv                  ← from pcb_export bom (manufacturing BOM)
//       pick-and-place.csv       ← from pcb_export pick_and_place
//       gerber.zip               ← from pcb_export gerber (already a ZIP)
//       pcb.pdf                  ← from pcb_export pdf
//       3d.step                  ← from pcb_export 3d (optional, large)
//     datasheets/
//       {NORM-MPN}.pdf           ← copied from ~/.easyeda-mcp/datasheets/
//       index.json
//       index.md

import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { basename, join, resolve } from 'path';
import JSZip from 'jszip';
import type { WebSocketBridge } from '../bridge';
import { buildBom, bomToCsv, type DesignSnapshotMinimal } from '../analyzers/bom';
import { listCachedDatasheets, fetchAndCacheDatasheet, getCachedDatasheet } from '../datasheet/cache';
import { resolveLcsc } from '../sourcing/lcsc';
import { analyzeEmc, type EmcSnapshot } from '../analyzers/emc';
import { analyzeThermal, type ThermalSnapshot } from '../analyzers/thermal';
import { analyzePcbEmc, type PcbSnapMinimal } from '../analyzers/pcb-emc';
import { crossVerify, type SchSnap, type PcbSnap } from '../analyzers/cross';
import { analyzeDfm, getTier, type DfmTier } from '../analyzers/dfm';
import { evaluateFabRelease } from '../analyzers/fab-release';
import { generateSpiceTestbenches } from '../analyzers/spice-testbench';
import {
	renderReadme,
	renderBomMarkdown,
	renderDatasheetIndexMarkdown,
	type BundleManifestEntry,
	type ReadmeContext,
} from './readme';

const MCP_VERSION = '1.0.0';

export interface BuildBundleOptions {
	/** Absolute path to write the .zip. Required. */
	outputPath: string;
	/** Schematic document UUID (required for sch snapshot, BOM, EMC, thermal). */
	documentUuid?: string;
	/** PCB document UUID (required for PCB exports). If omitted, the bundle
	 *  auto-discovers the PCB tab from the same instance. */
	pcbDocumentUuid?: string;
	/** Instance ID when multiple EasyEDA windows are open. */
	instanceId?: string;
	/** Include all schematic pages in the snapshot. */
	allPages?: boolean;
	/** Which PCB export formats to include. Default: all useful ones. */
	pcbFormats?: Array<'gerber' | 'pdf' | 'netlist' | 'bom' | 'pick_and_place' | '3d'>;
	/** Auto-fetch datasheets for every BOM row that resolves on LCSC. */
	autoFetchDatasheets?: boolean;
	/** Cap on auto-fetch attempts. */
	maxDatasheetFetches?: number;
	/** Manufacturing tier for DFM rules. */
	tier?: 'jlcpcb' | 'pcbway';
}

export interface BuildBundleResult {
	zipPath: string;
	bytes: number;
	manifest: BundleManifestEntry[];
	notes: string[];
	bundleRootName: string;
}

interface PcbExportResult {
	fileName: string;
	data: string;       // base64
	size: number;
}

const DEFAULT_PCB_FORMATS: NonNullable<BuildBundleOptions['pcbFormats']> = ['gerber', 'pdf', 'netlist', 'bom', 'pick_and_place'];

function bridgeKwargs(opts: BuildBundleOptions, override: Record<string, unknown> = {}): Record<string, unknown> {
	const out: Record<string, unknown> = { ...override };
	// Only fall back to the schematic doc when the caller didn't specify a
	// document. Without this, calls to pcb.* methods that pass a PCB doc UUID
	// in `override` would be silently overwritten with the schematic UUID,
	// triggering the "currently active tab is not a PCB" guard.
	if (!('document' in out) && opts.documentUuid) out.document = opts.documentUuid;
	if (!('instance_id' in out) && opts.instanceId) out.instance_id = opts.instanceId;
	return out;
}

async function safeBridgeSend<T>(bridge: WebSocketBridge, method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
	try {
		const result = await bridge.send(method, { ...params, _timeoutMs: timeoutMs });
		return { ok: true, result: result as T };
	} catch (err: any) {
		return { ok: false, error: err?.message ?? String(err) };
	}
}

function normFilename(s: string): string {
	return s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'UNKNOWN';
}

export async function buildVerificationBundle(
	bridge: WebSocketBridge,
	opts: BuildBundleOptions,
): Promise<BuildBundleResult> {
	if (!opts.outputPath) throw new Error('buildVerificationBundle: outputPath is required');
	const zip = new JSZip();
	const notes: string[] = [];
	const manifest: BundleManifestEntry[] = [];

	const pcbFormats = opts.pcbFormats?.length ? opts.pcbFormats : DEFAULT_PCB_FORMATS;
	const allPages = opts.allPages ?? true;

	// 1. Schematic snapshot (the foundation everything else builds on)
	const snapResp = await safeBridgeSend<DesignSnapshotMinimal & { project?: any; page?: any }>(
		bridge,
		'sch.extract.design',
		bridgeKwargs(opts, { allPages }),
		120_000,
	);
	let snapshot: DesignSnapshotMinimal & { project?: any; page?: any } | null = null;
	if (snapResp.ok) {
		snapshot = snapResp.result;
		const json = JSON.stringify(snapshot, null, 2);
		zip.file('project/schematic-snapshot.json', json);
		manifest.push({
			path: 'project/schematic-snapshot.json',
			bytes: Buffer.byteLength(json),
			contentType: 'json',
			description: 'Normalized schematic — every component (designator, MPN, value, footprint, deviceClass, pins→net), every net (members + power/ground tagging), pin index, stats. The verifier should treat this as the source of truth for connectivity and components.',
		});
	} else {
		notes.push(`schematic snapshot failed: ${snapResp.error}`);
	}

	// 2. BOM (built from snapshot — pure)
	let bomReport = snapshot ? buildBom(snapshot) : null;
	if (bomReport) {
		const bomJson = JSON.stringify(bomReport, null, 2);
		zip.file('project/bom.json', bomJson);
		manifest.push({
			path: 'project/bom.json',
			bytes: Buffer.byteLength(bomJson),
			contentType: 'json',
			description: 'BOM rows grouped by normalized MPN, with qty, distributor classification, DNP flags, and per-row gap audit (missing MPN/manufacturer/value/footprint/distributor).',
		});

		const csv = bomToCsv(bomReport, { includeColumns: ['lcsc'] });
		zip.file('project/bom.csv', csv);
		manifest.push({
			path: 'project/bom.csv',
			bytes: Buffer.byteLength(csv),
			contentType: 'csv',
			description: 'Tracking-sheet CSV. Same rows as bom.json. Importable into spreadsheets; merge-aware for repeat exports.',
		});

		const md = renderBomMarkdown(bomReport);
		zip.file('project/bom.md', md);
		manifest.push({
			path: 'project/bom.md',
			bytes: Buffer.byteLength(md),
			contentType: 'markdown',
			description: 'Human/LLM-readable BOM table. Use this for fast review; use bom.json for programmatic checks.',
		});
	} else {
		notes.push('BOM not generated (no schematic snapshot)');
	}

	// 2b. Run every available analyzer (EMC, thermal, SPICE testbenches).
	let emcSummary = '';
	let thermalSummary = '';
	let emcReport: ReturnType<typeof analyzeEmc> | null = null;
	let thermalReport: ReturnType<typeof analyzeThermal> | null = null;
	let spiceReport: ReturnType<typeof generateSpiceTestbenches> | null = null;
	if (snapshot) {
		try {
			emcReport = analyzeEmc(snapshot as unknown as EmcSnapshot);
			const emcJson = JSON.stringify(emcReport, null, 2);
			zip.file('analysis/emc.json', emcJson);
			manifest.push({ path: 'analysis/emc.json', bytes: Buffer.byteLength(emcJson), contentType: 'json',
				description: `EMC pre-compliance — ${emcReport.findings.length} findings (${emcReport.bySeverity.critical}C/${emcReport.bySeverity.warning}W/${emcReport.bySeverity.info}I).` });
			emcSummary = emcReport.summary;
		} catch (err: any) { notes.push(`EMC analysis failed: ${err?.message ?? err}`); }
		try {
			thermalReport = analyzeThermal(snapshot as unknown as ThermalSnapshot);
			const thJson = JSON.stringify(thermalReport, null, 2);
			zip.file('analysis/thermal.json', thJson);
			manifest.push({ path: 'analysis/thermal.json', bytes: Buffer.byteLength(thJson), contentType: 'json',
				description: thermalReport.summary });
			thermalSummary = thermalReport.summary;
		} catch (err: any) { notes.push(`Thermal failed: ${err?.message ?? err}`); }
		try {
			spiceReport = generateSpiceTestbenches(snapshot as any);
			const spiceJson = JSON.stringify(spiceReport, null, 2);
			zip.file('analysis/spice-testbenches.json', spiceJson);
			manifest.push({ path: 'analysis/spice-testbenches.json', bytes: Buffer.byteLength(spiceJson), contentType: 'json',
				description: `${spiceReport.testbenches.length} SPICE testbenches auto-generated for detected subcircuits.` });
			for (const tb of spiceReport.testbenches) {
				const cir = `* ${tb.description}\n${tb.netlist}\n`;
				zip.file(`spice/${tb.name}.cir`, cir);
				manifest.push({ path: `spice/${tb.name}.cir`, bytes: Buffer.byteLength(cir), contentType: 'text',
					description: `${tb.subcircuit}: ${tb.description}` });
			}
		} catch (err: any) { notes.push(`SPICE gen failed: ${err?.message ?? err}`); }
	}

	// 3. PCB exports (if a document UUID is available — gerber etc. need a PCB)
	const pcbExportsIncluded: string[] = [];

	// 2c. PCB-side analysis: extract a PCB snapshot and run cross-verify,
	// PCB-EMC, DFM, and the combined fab-release-gate. All gated on the
	// existence of a PCB document.
	let pcbSnapshot: any = null;
	let crossReport: ReturnType<typeof crossVerify> | null = null;
	let pcbEmcReport: ReturnType<typeof analyzePcbEmc> | null = null;
	let dfmReport: Awaited<ReturnType<typeof analyzeDfm>> | null = null;
	let fabGate: ReturnType<typeof evaluateFabRelease> | null = null;

	// Resolve a PCB document UUID for the manufacture exports. Priority:
	// 1) explicit pcbDocumentUuid argument
	// 2) auto-discover via list_instances (find a tab whose title contains "PCB"/"board")
	// 3) fall back to documentUuid (same as before)
	let pcbDoc = opts.pcbDocumentUuid || '';
	if (!pcbDoc) {
		try {
			const instances = await safeBridgeSend<any[]>(bridge, 'instance.list', bridgeKwargs(opts), 8_000);
			if (!instances.ok) {
				// silent fall-through, we have other fallbacks
			}
		} catch { /* ignore */ }
		// Use the bridge's existing accessor when available
		try {
			const inst = (bridge as any).getConnectedInstances?.()?.[0];
			const pcbTab = (inst?.documents ?? []).find((d: any) => /pcb|board|layout/i.test(d?.title ?? ''));
			if (pcbTab?.uuid && /^[0-9a-f]{6,}/i.test(pcbTab.uuid)) pcbDoc = pcbTab.uuid;
		} catch { /* ignore */ }
		if (pcbDoc) notes.push(`PCB exports auto-discovered: using ${pcbDoc.slice(0, 12)}…`);
	}
	if (!pcbDoc && opts.documentUuid) pcbDoc = opts.documentUuid;

	if (pcbDoc) {
		// Extract PCB snapshot — required for PCB-side analyzers
		const pcbSnapResp = await safeBridgeSend<any>(bridge, 'pcb.extract.design',
			bridgeKwargs(opts, { document: pcbDoc, includeAllPads: true }), 180_000);
		if (pcbSnapResp.ok) {
			pcbSnapshot = pcbSnapResp.result;
			const json = JSON.stringify(pcbSnapshot, null, 2);
			zip.file('pcb/pcb-snapshot.json', json);
			manifest.push({ path: 'pcb/pcb-snapshot.json', bytes: Buffer.byteLength(json), contentType: 'json',
				description: `PCB snapshot: ${pcbSnapshot.componentCount} components, ${pcbSnapshot.netCount} nets, ${pcbSnapshot.padCount} pads, ${pcbSnapshot.stats?.viaCount ?? 0} vias, ${pcbSnapshot.stats?.trackCount ?? 0} tracks, ${pcbSnapshot.stats?.pourCount ?? 0} pours.` });

			// Cross-analysis
			if (snapshot) {
				try {
					crossReport = crossVerify(snapshot as SchSnap, pcbSnapshot as PcbSnap);
					const j = JSON.stringify(crossReport, null, 2);
					zip.file('analysis/cross-verify.json', j);
					manifest.push({ path: 'analysis/cross-verify.json', bytes: Buffer.byteLength(j), contentType: 'json',
						description: `Schematic ↔ PCB consistency: ${crossReport.summary}` });
				} catch (err: any) { notes.push(`Cross-verify failed: ${err?.message ?? err}`); }
			}

			// PCB-EMC
			try {
				pcbEmcReport = analyzePcbEmc(pcbSnapshot as PcbSnapMinimal);
				const j = JSON.stringify(pcbEmcReport, null, 2);
				zip.file('analysis/pcb-emc.json', j);
				manifest.push({ path: 'analysis/pcb-emc.json', bytes: Buffer.byteLength(j), contentType: 'json',
					description: `PCB-side EMC — ${pcbEmcReport.summary}` });
			} catch (err: any) { notes.push(`PCB-EMC failed: ${err?.message ?? err}`); }
		} else {
			notes.push(`pcb.extract.design failed: ${pcbSnapResp.error}`);
		}

		// pcb.manufacture.* handlers — same map as manufacture-tools.ts EXPORT_HANDLER_MAP
		const formatToHandler: Record<string, { method: string; outName: string; ct: BundleManifestEntry['contentType']; desc: string }> = {
			netlist: { method: 'pcb.manufacture.getNetlistFile', outName: 'pcb/netlist.txt', ct: 'text', desc: 'Plain-text netlist exported from the PCB. Use to verify connectivity matches the schematic.' },
			bom: { method: 'pcb.manufacture.getBomFile', outName: 'pcb/bom.csv', ct: 'csv', desc: 'Manufacturing BOM as exported by EasyEDA. Compare with project/bom.csv — mismatches indicate sch↔PCB sync bugs.' },
			pick_and_place: { method: 'pcb.manufacture.getPickAndPlaceFile', outName: 'pcb/pick-and-place.csv', ct: 'csv', desc: 'Component positions/rotations for assembly. Verifier can spot-check against schematic-snapshot for placement plausibility.' },
			gerber: { method: 'pcb.manufacture.getGerberFile', outName: 'pcb/gerber.zip', ct: 'binary', desc: 'Manufacturing Gerber set (multi-file ZIP). Needed only if the verifier needs to inspect copper layers.' },
			pdf: { method: 'pcb.manufacture.getPdfFile', outName: 'pcb/pcb.pdf', ct: 'pdf', desc: 'Visual PDF rendering of the PCB. Easiest format for an LLM with vision to spot layout issues.' },
			'3d': { method: 'pcb.manufacture.get3DFile', outName: 'pcb/3d.step', ct: 'step', desc: '3D mechanical model. Heavy — only request when mechanical fit matters.' },
		};

		for (const fmt of pcbFormats) {
			const def = formatToHandler[fmt];
			if (!def) continue;
			const params: Record<string, unknown> = {};
			// CSV preference for tabular formats
			if (fmt === 'bom' || fmt === 'pick_and_place') params.fileType = 'csv';
			if (fmt === '3d') params.fileType = 'step';
			// Override document with the resolved PCB doc UUID
			const pcbParams = { ...params, document: pcbDoc };
			if (opts.instanceId) (pcbParams as any).instance_id = opts.instanceId;
			const resp = await safeBridgeSend<PcbExportResult>(
				bridge,
				def.method,
				pcbParams,
				120_000,
			);
			if (resp.ok && resp.result?.data) {
				const buf = Buffer.from(resp.result.data, 'base64');
				zip.file(def.outName, buf);
				manifest.push({
					path: def.outName,
					bytes: buf.length,
					contentType: def.ct,
					description: def.desc,
				});
				pcbExportsIncluded.push(fmt);
			} else if (!resp.ok) {
				notes.push(`pcb export "${fmt}" failed: ${resp.error}`);
			}
		}
	} else {
		notes.push('No PCB document UUID provided — skipping all pcb/ exports.');
	}

	// 4. Datasheets — copy cached PDFs into the bundle
	const datasheetIndex: Array<{ mpn: string; lcscCode?: string; filename: string; bytes: number; sha256: string; url: string }> = [];
	const missingFor: string[] = [];
	const seenFilenames = new Set<string>();

	const candidateMpns = new Map<string, { mpn: string; lcscCode?: string }>();
	if (bomReport) {
		for (const row of bomReport.rows) {
			if (!row.mpn) continue;
			const lcsc = /^c\d+$/i.test(row.distributorId) ? row.distributorId : undefined;
			const key = lcsc?.toUpperCase() || row.mpn.toUpperCase();
			if (!candidateMpns.has(key)) candidateMpns.set(key, { mpn: row.mpn, lcscCode: lcsc });
		}
	}

	// Auto-fetch defaults to TRUE for the verification bundle — a self-
	// contained bundle should include every datasheet a verifier needs.
	const autoFetch = opts.autoFetchDatasheets ?? true;
	const fetchCap = opts.maxDatasheetFetches ?? 200;
	let fetchAttempts = 0;

	for (const [, cand] of candidateMpns) {
		let cached = await getCachedDatasheet(cand.lcscCode || cand.mpn);
		if (!cached && autoFetch && fetchAttempts < fetchCap) {
			fetchAttempts += 1;
			try {
				const part = await resolveLcsc(cand.lcscCode || cand.mpn, { enrich: false });
				if (part?.datasheetUrl) {
					cached = await fetchAndCacheDatasheet({
						mpn: part.mpn || cand.mpn,
						lcscCode: part.lcscCode || cand.lcscCode,
						url: part.datasheetUrl,
					});
				}
			} catch (err: any) {
				notes.push(`datasheet auto-fetch failed for ${cand.mpn}: ${err?.message ?? err}`);
			}
		}

		if (!cached) {
			missingFor.push(cand.mpn);
			continue;
		}

		try {
			const buf = await fs.readFile(cached.pdfPath);
			let filename = `${normFilename(cand.mpn)}.pdf`;
			let i = 1;
			while (seenFilenames.has(filename)) { filename = `${normFilename(cand.mpn)}_${++i}.pdf`; }
			seenFilenames.add(filename);
			zip.file(`datasheets/${filename}`, buf);
			manifest.push({
				path: `datasheets/${filename}`,
				bytes: buf.length,
				contentType: 'pdf',
				description: `Datasheet for ${cand.mpn}${cand.lcscCode ? ` (${cand.lcscCode})` : ''}.`,
			});
			datasheetIndex.push({
				mpn: cached.mpn || cand.mpn,
				lcscCode: cached.lcscCode,
				filename,
				bytes: buf.length,
				sha256: cached.sha256,
				url: cached.url,
			});
		} catch (err: any) {
			notes.push(`datasheet read failed for ${cand.mpn}: ${err?.message ?? err}`);
		}
	}

	// Datasheet indices
	const dsIndexJson = JSON.stringify(datasheetIndex, null, 2);
	zip.file('datasheets/index.json', dsIndexJson);
	manifest.push({
		path: 'datasheets/index.json',
		bytes: Buffer.byteLength(dsIndexJson),
		contentType: 'json',
		description: 'Machine-readable datasheet index — MPN → filename → SHA-256 → source URL.',
	});
	const dsIndexMd = renderDatasheetIndexMarkdown(datasheetIndex);
	zip.file('datasheets/index.md', dsIndexMd);
	manifest.push({
		path: 'datasheets/index.md',
		bytes: Buffer.byteLength(dsIndexMd),
		contentType: 'markdown',
		description: 'Human-readable datasheet index. Use this to find which PDF covers which MPN.',
	});

	// 4b. DFM + Fab-release-gate (run after datasheets so coverage stat is fresh)
	const tier: DfmTier = getTier(opts.tier ?? 'jlcpcb');
	if (snapshot && bomReport) {
		try {
			dfmReport = await analyzeDfm(snapshot as any, pcbSnapshot, tier);
			const j = JSON.stringify(dfmReport, null, 2);
			zip.file('analysis/dfm.json', j);
			manifest.push({ path: 'analysis/dfm.json', bytes: Buffer.byteLength(j), contentType: 'json',
				description: `DFM (${tier.name}) — ${dfmReport.summary}` });
		} catch (err: any) { notes.push(`DFM failed: ${err?.message ?? err}`); }

		try {
			const cachedKeys = new Set(datasheetIndex.map((e) => (e.lcscCode || e.mpn || '').toUpperCase()));
			let withDs = 0, withoutDs = 0;
			for (const row of bomReport.rows) {
				if (!row.mpn && !row.distributorId) continue;
				const k1 = (row.mpn ?? '').toUpperCase();
				const k2 = (row.distributorId ?? '').toUpperCase();
				if (cachedKeys.has(k1) || cachedKeys.has(k2)) withDs++;
				else withoutDs++;
			}
			fabGate = evaluateFabRelease({
				bom: bomReport,
				emc: emcReport ?? undefined,
				thermal: thermalReport ?? undefined,
				pcbEmc: pcbEmcReport ?? undefined,
				dfm: dfmReport ?? undefined,
				cross: crossReport ?? undefined,
				datasheetCoverage: { withDatasheet: withDs, withoutDatasheet: withoutDs },
			});
			const j = JSON.stringify(fabGate, null, 2);
			zip.file('analysis/fab-release-gate.json', j);
			manifest.push({ path: 'analysis/fab-release-gate.json', bytes: Buffer.byteLength(j), contentType: 'json',
				description: `Combined release-readiness verdict: ${fabGate.summary}` });
		} catch (err: any) { notes.push(`Fab-release-gate failed: ${err?.message ?? err}`); }
	}

	// 5. Project metadata
	const projectName = (snapshot as any)?.project?.name || (snapshot as any)?.page?.name || 'unknown';
	const generatedAt = new Date().toISOString();
	const metadata = {
		projectName,
		generatedAt,
		mcpVersion: MCP_VERSION,
		bundleFormatVersion: 1,
		documentUuid: opts.documentUuid,
		instanceId: opts.instanceId,
		schSnapshot: snapshot ? {
			componentCount: Object.keys(snapshot.components || {}).length,
			netCount: Object.keys((snapshot as any).nets || {}).length,
		} : null,
		pcbExportsIncluded,
		datasheetCount: datasheetIndex.length,
		emcSummary,
		thermalSummary,
		notes,
	};
	const metadataJson = JSON.stringify(metadata, null, 2);
	zip.file('project/metadata.json', metadataJson);
	manifest.push({
		path: 'project/metadata.json',
		bytes: Buffer.byteLength(metadataJson),
		contentType: 'json',
		description: 'Bundle metadata: project name, generation timestamp, what was/wasn\'t included, build notes.',
	});

	// 6. README.md (entry point — must come last so manifest is complete)
	const readmeCtx: ReadmeContext = {
		projectName,
		generatedAt,
		mcpVersion: MCP_VERSION,
		schSnapshotStats: {
			componentCount: snapshot ? Object.keys(snapshot.components || {}).length : 0,
			netCount: snapshot ? Object.keys((snapshot as any).nets || {}).length : 0,
			pageCount: snapshot ? Number((snapshot as any).pageCount ?? 1) : 0,
		},
		bomReport: bomReport ?? buildBom({ components: {} }),
		pcbExportsIncluded,
		datasheetCount: datasheetIndex.length,
		datasheetMissingForMpn: missingFor,
		manifest,
		notes,
		emcSummary,
		thermalSummary,
		pcbSnapshotStats: pcbSnapshot ? {
			componentCount: pcbSnapshot.componentCount ?? 0,
			netCount: pcbSnapshot.netCount ?? 0,
			padCount: pcbSnapshot.padCount ?? 0,
			viaCount: pcbSnapshot.stats?.viaCount ?? 0,
			trackCount: pcbSnapshot.stats?.trackCount ?? 0,
			pourCount: pcbSnapshot.stats?.pourCount ?? 0,
		} : undefined,
		pcbEmcSummary: pcbEmcReport?.summary,
		crossSummary: crossReport?.summary,
		dfmSummary: dfmReport?.summary,
		spiceSummary: spiceReport?.summary,
		fabGate: fabGate ? {
			pass: fabGate.pass,
			criticalCount: fabGate.criticalCount,
			warningCount: fabGate.warningCount,
			summary: fabGate.summary,
			checks: fabGate.checks.map((c) => ({ id: c.id, title: c.title, severity: c.severity, detail: c.detail })),
		} : undefined,
	};
	const readme = renderReadme(readmeCtx);
	zip.file('README.md', readme);
	manifest.push({
		path: 'README.md',
		bytes: Buffer.byteLength(readme),
		contentType: 'markdown',
		description: 'Entry point. Read this first.',
	});

	// Manifest goes last too (so it can list itself accurately enough)
	const manifestJson = JSON.stringify({ files: manifest, generatedAt, projectName }, null, 2);
	zip.file('manifest.json', manifestJson);

	// 7. Write the ZIP
	const buf = await zip.generateAsync({
		type: 'nodebuffer',
		compression: 'DEFLATE',
		compressionOptions: { level: 6 },
	});
	const outputPath = resolve(opts.outputPath);
	await fs.writeFile(outputPath, buf);

	return {
		zipPath: outputPath,
		bytes: buf.length,
		manifest,
		notes,
		bundleRootName: basename(outputPath, '.zip'),
	};
}

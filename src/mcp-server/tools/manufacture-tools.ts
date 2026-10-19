import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { spawn } from 'child_process';
import { mkdtemp, writeFile, readFile, access, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, isAbsolute, join, resolve } from 'path';
import type { WebSocketBridge } from '../bridge';
import { exportsDir } from '../exports-dir';
import { resolveFastrouteBinary, runFastrouteOnDsn, type FastrouteRunOptions } from '../autoroute/fastroute';
import { calibrateDsnFrame, dsnBoundaryPoints, dsnPlacements, dsnWiringVias } from '../autoroute/pour-planes';
import { deleteNetCopper, drcSnapshot, incompleteNets, newViolations, refreshNetConnectivity, restoreNetCopper, snapshotNetCopper, summarizeViolations, type CopperSnapshot, type DrcSnapshot } from '../autoroute/board-copper';
import { parseSexpr, stripViaPins, writeSexpr } from '../autoroute/specctra';
import { runtimeRootCandidates, uniqueStrings } from '../autoroute/runtime-paths';
import { withDocumentParam } from './query-params';

const EXPORT_HANDLER_MAP: Record<string, string> = {
	dsn: 'pcb.manufacture.getDsnFile',
	autoroute_json: 'pcb.manufacture.getAutoRouteJsonFile',
	autolayout_json: 'pcb.manufacture.getAutoLayoutJsonFile',
	gerber: 'pcb.manufacture.getGerberFile',
	bom: 'pcb.manufacture.getBomFile',
	pick_and_place: 'pcb.manufacture.getPickAndPlaceFile',
	'3d': 'pcb.manufacture.get3DFile',
	pdf: 'pcb.manufacture.getPdfFile',
	netlist: 'pcb.manufacture.getNetlistFile',
	dxf: 'pcb.manufacture.getDxfFile',
	altium: 'pcb.manufacture.getAltiumDesignerFile',
	pads: 'pcb.manufacture.getPadsFile',
};

const IMPORT_HANDLER_MAP: Record<string, string> = {
	autoroute_json: 'pcb.manufacture.importAutoRouteJson',
	autolayout_json: 'pcb.manufacture.importAutoLayoutJson',
	autoroute_ses: 'pcb.manufacture.importAutoRouteSes',
};

export function registerManufactureTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'pcb_export',
		`Export the PCB design in various formats. Saves the file under ~/.easyeda-mcp/exports/ (or outputDir) and returns { path, fileName, size }; inline:true returns the Base64 data instead (large).
Formats: dsn (for FreeRouting), gerber (manufacturing), bom (bill of materials), pick_and_place (assembly),
3d (STEP/OBJ), pdf, netlist, dxf, altium, pads, autoroute_json, autolayout_json.
Use fileType for sub-formats: "xlsx"/"csv" (bom, pick_and_place), "step"/"obj" (3d).`,
		withDocumentParam({
			format: z
				.enum([
					'dsn', 'autoroute_json', 'autolayout_json', 'gerber', 'bom',
					'pick_and_place', '3d', 'pdf', 'netlist', 'dxf', 'altium', 'pads',
				])
				.describe('Export format'),
			fileName: z.string().optional().describe('Output file name'),
			layers: z.array(z.object({ layerId: z.number().int().positive(), isMirror: z.boolean().default(false) })).optional().describe('Explicit Gerber layers; include all active copper layers for multilayer boards.'),
			objects: z.array(z.enum(['Pad', 'Via', 'Track', 'Text', 'Image', 'Dimension', 'BoardOutline', 'BoardCutout', 'CopperFilled', 'SolidRegion', 'FPCStiffener', 'Line', 'PlaneZone', 'ComponentProperty', 'ComponentSilkscreen', 'TearDrop'])).optional().describe('Explicit Gerber object categories when specifying layers.'),
			timeoutMs: z.number().int().positive().optional().describe('Bounded native export generation timeout in milliseconds.'),
			fileType: z
				.string()
				.optional()
				.describe('Sub-format (e.g. "xlsx"/"csv" for bom, "step"/"obj" for 3d)'),
			outputDir: z.string().optional().describe('Directory to save into (default ~/.easyeda-mcp/exports)'),
			inline: z.boolean().optional().default(false).describe('Return Base64 data inline instead of saving a file'),
		}),
		async ({ format, outputDir, inline, ...rest }) => {
			const result: any = await bridge.send(EXPORT_HANDLER_MAP[format], rest);
			if (inline || typeof result?.data !== 'string') {
				return { content: [{ type: 'text', text: JSON.stringify(result) }] };
			}
			// A Gerber zip or STEP file is useless to read inline (~80 KB of
			// Base64 on average); hand back a path instead.
			// Only the default folder is swept (7 days / 200 files); a caller's
			// outputDir is never pruned.
			const dir = outputDir ? resolve(outputDir) : await exportsDir();
			await mkdir(dir, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			// Without a fileName EasyEDA names the file the string "undefined".
			const rawName = String(result.fileName ?? '');
			const name = basename(rawName && rawName !== 'undefined' && rawName !== 'null' ? rawName : `${format}-export${format === 'dsn' ? '.dsn' : ''}`);
			const path = join(dir, `${stamp}-${name}`);
			const bytes = Buffer.from(result.data, 'base64');
			await writeFile(path, bytes);
			const { data, ...meta } = result;
			return { content: [{ type: 'text', text: JSON.stringify({ ...meta, path, size: bytes.length }) }] };
		},
	);

	server.tool(
		'pcb_autoroute',
		`Autoroute the PCB with an external router: fastroute (Rust FreeRouting port, used by default when installed; honors the board's diff pairs, equal-length groups, track widths, clearances and board-edge clearance) or FreeRouting (java jar). EasyEDA has no autorouter API. Pipeline: DSN export → layer-constraint patch → router → SES validation/completion analysis → return .ses path.

Routers (router:"auto" picks fastroute if found, else FreeRouting):
- fastroute: binary from FASTROUTE_BIN, vendor/fastroute/fastroute or PATH; install with \`bash scripts/install-fastroute.sh\`. With rules:"easyeda" (default) the DSN's net classes are rebuilt from the board's Track / Safe Spacing / Differential Pair rules, EasyEDA diff pairs become --pairs (gap = pair spacing rule, skew = pair length tolerance), equal-length groups become --tune (tolerance: lengthToleranceMm, EasyEDA stores none), pair nets keep full width at pins, and the Safe Spacing Board Outline value becomes the copper-to-edge clearance. diffPairs / lengthGroups override the board's lists ([] disables). The board is routed in real microns (EasyEDA's DSN is in 10-mil units) and the SES is scaled back, so pcb_import_file works unchanged. maxTimeSeconds is a soft stop that keeps the best result; on the hard timeoutSeconds the run is stopped and its best checkpoint is still returned. Result carries rules (what was applied and from which rule), report (unrouted connections by net, new clearance violations) and warnings.
- freerouting: Java 11+ and vendor/freerouting.jar (or FREEROUTING_JAR). Uses the DSN as exported; ignores the fastroute-only options.

fastroute + rules:"easyeda" also passes every copper pour as a plane (pours:"planes"): pads a pour already joins are not routed, and a solid trace-free inner pour becomes a plane layer no signal crosses. Reroute: reroute:"none" (default) keeps the existing copper and routes only what is missing; "signals" lets every net without a pour (not in keepNets, no locked copper) be ripped up and rerouted; "best" keeps fastroute's version only for the nets that come out better (fewer unrouted connections, else length + viaCostMm per via lower by minGainPct), verified by routing again with every other net fixed. Both return comparison (per-net before/after) and replaceNets; with importMode:"attempt" (or pcb_import_file replaceNets) those nets' unlocked copper is deleted first, then the result is imported, re-poured and DRC-checked. Try a reroute on a copy of the board first.

Layer constraints (for typical Signal / GND / PWR / Signal stackups, where L2/L3 are planes that should not be routed on):
- excludeLayers: layers the router must not place ANY signal track on. The DSN layer type is rewritten to "power" so the router treats it as a plane.
- powerOnlyLayers: same effect today (DSN has no per-net layer cost knob the router honors reliably). Listed separately so callers can express intent; the rewrite is identical.
Layers accept names ("Inner1", "Inner2", "TopLayer", "BottomLayer") or numeric IDs (1, 2, 15, 16).

Existing copper is exported as fixed wiring, so hand-route critical nets first and let the router finish the rest. By default this does NOT import into EasyEDA. It returns after the router exits, with routingCompletion/manualRouteCandidates and a manualImport command. Pass importMode:"attempt" only when you explicitly want the tool to spend extra time importing the SES and running refresh/DRC.`,
		withDocumentParam({
			router: z.enum(['auto', 'fastroute', 'freerouting']).optional().default('auto').describe('auto: fastroute if installed, else FreeRouting'),
			passes: z.number().int().positive().optional().default(100).describe('Max autorouter passes'),
			timeoutSeconds: z.number().int().positive().optional().default(600).describe('Hard process timeout (s). FreeRouting fails on it; fastroute is stopped and its best checkpoint returned.'),
			maxTimeSeconds: z.number().int().positive().optional().describe('fastroute: soft stop (--max-time) that keeps the best result. Default timeoutSeconds - 30.'),
			threads: z.number().int().positive().optional().describe('Worker threads. Default: FreeRouting 1 (deterministic); fastroute all cores (deterministic for a given count).'),
			rules: z.enum(['easyeda', 'dsn']).optional().default('easyeda').describe('fastroute: easyeda rebuilds net classes and pair/length/edge constraints from the board rules; dsn routes the exported DSN as is'),
			diffPairs: z.array(z.object({
				positiveNet: z.string(),
				negativeNet: z.string(),
				name: z.string().optional(),
				gapMm: z.number().positive().optional().describe('Copper gap; default: the pair\'s Differential Pair rule spacing'),
				skewMm: z.number().nonnegative().optional().describe('Allowed P/N length difference; default: the rule\'s length tolerance'),
			})).optional().describe('fastroute: replaces the board\'s differential pairs ([] = route no pairs as pairs)'),
			lengthGroups: z.array(z.object({
				name: z.string(),
				nets: z.array(z.string()).min(2),
				toleranceMm: z.number().nonnegative().optional(),
				targetMm: z.number().positive().optional().describe('Fixed target length; default: the longest net of the group'),
			})).optional().describe('fastroute: replaces the board\'s equal-length groups ([] = no length matching)'),
			lengthToleranceMm: z.number().nonnegative().optional().default(0.5).describe('fastroute: tolerance for equal-length groups without one (EasyEDA stores none)'),
			layerHeightsMm: z.array(z.number().nonnegative()).optional().describe('fastroute: copper layer heights from the top in mm, physical order (top, inner1.., bottom), so vias count in length matching. Default: not counted, as in EasyEDA\'s DRC.'),
			countViaLengths: z.boolean().optional().default(false).describe('fastroute: count via lengths in pair/group length matching with the JLC 4L preset (or evenly spaced) stackup for boardThicknessMm. Off by default because EasyEDA\'s DRC measures track length only.'),
			boardThicknessMm: z.number().positive().optional().default(1.6).describe('fastroute: board thickness for the layer-height preset (countViaLengths)'),
			keepWidthAtPinsNets: z.array(z.string()).optional().describe('fastroute: nets that keep their full width at pins (controlled impedance). Default: every routed diff-pair net.'),
			clearanceMarginUm: z.number().nonnegative().optional().default(5).describe('fastroute: added to every rule clearance so copper does not sit exactly on the DRC limit'),
			multiStart: z.number().int().positive().optional().describe('fastroute: rerun with N-1 shuffled orders in parallel if connections stay unrouted (fastroute default 4)'),
			diagnose: z.boolean().optional().default(false).describe('fastroute: classify each unrouted connection as congestion or blocked (slower)'),
			live: z.boolean().optional().default(false).describe('fastroute: open a live routing view in the browser (http://127.0.0.1:7878)'),
			extraArgs: z.array(z.string().regex(/^--[a-z]/, 'only --options')).optional().describe('fastroute: extra options, e.g. ["--router.scoring.via_costs=80"]'),
			pours: z.enum(['inner', 'planes', 'ignore']).optional().default('inner').describe('fastroute + rules:"easyeda": inner = a solid, trace-free, single-net inner pour becomes a plane layer no signal crosses, and every pad of its net gets a via to it; other pours are not passed, so every other connection is routed. planes = also pass outer/partial pours as conduction areas (pads they touch count as joined; risky: other nets route across them and the re-pour can leave those pads isolated). ignore = no pours.'),
			reroute: z.enum(['none', 'signals', 'best']).optional().default('none').describe('fastroute: none = existing copper stays, only missing connections are routed; signals = every net without a pour may be ripped up and rerouted; best = reroute only the nets that come out better than the current routing (verified with all other nets fixed). In signals/best the result carries comparison (per-net before/after) and replaceNets, and importMode:"attempt" deletes those nets\' unlocked copper before importing.'),
			keepNets: z.array(z.string()).optional().describe('fastroute reroute: nets never rerouted (pour nets and nets with locked copper never are)'),
			viaCostMm: z.number().nonnegative().optional().default(1).describe('fastroute reroute:"best": one via counts as this much trace length'),
			minGainPct: z.number().nonnegative().optional().default(3).describe('fastroute reroute:"best": a complete net must improve by this much (%) to be replaced'),
			maxBestPasses: z.number().int().positive().optional().default(3).describe('fastroute reroute:"best": verification passes'),
			importMode: z.enum(['attempt', 'skip']).optional().default('skip').describe('skip returns the SES path immediately after FreeRouting; attempt imports the SES into EasyEDA and then refreshes/DRCs'),
			importStrategy: z.enum(['direct', 'easyeda']).optional().default('direct').describe('When importMode=attempt: direct creates Line/Via primitives from SES; easyeda calls EasyEDA SES importer.'),
			importTimeoutSeconds: z.number().int().positive().optional().default(45).describe('EasyEDA SES import timeout (s); keep short so agents recover quickly'),
			failOnImportError: z.boolean().optional().default(false).describe('If true, SES import failure throws. Default false returns sesFile for manual import/retry.'),
			repourAfterImport: z.boolean().optional().default(true).describe('When importMode=attempt: re-pour with EasyEDA\'s engine before the DRC check (and before the reference DRC taken ahead of routing)'),
			rollbackOnNewViolations: z.boolean().optional().default(true).describe('When importMode=attempt replaces nets (reroute signals/best): EasyEDA\'s DRC is compared with the one taken before routing; the replaced nets a new violation names are put back as they were, and if violations remain, every replaced net is'),
			includeSesData: z.boolean().optional().default(false).describe('Include Base64 SES data in the response. Defaults false because SES files can be large.'),
			excludeLayers: z.array(z.union([z.string(), z.number()])).optional().describe('Layers FreeRouting must not route on (rewritten to DSN type "power")'),
			powerOnlyLayers: z.array(z.union([z.string(), z.number()])).optional().describe('Layers reserved for power planes (rewritten to DSN type "power")'),
		}),
		async ({
			router, passes, timeoutSeconds, maxTimeSeconds, threads, rules, diffPairs, lengthGroups, lengthToleranceMm, layerHeightsMm,
			countViaLengths, boardThicknessMm, keepWidthAtPinsNets, clearanceMarginUm, multiStart, diagnose, live, extraArgs,
			pours, reroute, keepNets, viaCostMm, minGainPct, maxBestPasses,
			importMode, importStrategy, importTimeoutSeconds, failOnImportError, repourAfterImport, rollbackOnNewViolations, includeSesData, excludeLayers, powerOnlyLayers, ...rest
		}) => {
			const result = await runAutoroute(
				bridge,
				{
					router: router ?? 'auto',
					passes: passes ?? 100,
					timeoutSeconds: timeoutSeconds ?? 600,
					threads,
					importMode: importMode ?? 'skip',
					importStrategy: importStrategy ?? 'direct',
					importTimeoutSeconds: importTimeoutSeconds ?? 45,
					failOnImportError: failOnImportError ?? false,
					repourAfterImport: repourAfterImport ?? true,
					rollbackOnNewViolations: rollbackOnNewViolations ?? true,
					includeSesData: includeSesData ?? false,
					excludeLayers: excludeLayers ?? [],
					powerOnlyLayers: powerOnlyLayers ?? [],
					fastroute: {
						rules: rules ?? 'easyeda',
						diffPairs,
						lengthGroups,
						lengthToleranceMm: lengthToleranceMm ?? 0.5,
						layerHeightsMm,
						countViaLengths: countViaLengths ?? false,
						boardThicknessMm: boardThicknessMm ?? 1.6,
						keepWidthAtPinsNets,
						clearanceMarginUm: clearanceMarginUm ?? 5,
						maxTimeSeconds,
						multiStart,
						diagnose: diagnose ?? false,
						live: live ?? false,
						extraArgs: extraArgs ?? [],
						pours: pours ?? 'inner',
						reroute: reroute ?? 'none',
						keepNets,
						viaCostMm: viaCostMm ?? 1,
						minGainPct: minGainPct ?? 3,
						maxBestPasses: maxBestPasses ?? 3,
					},
				},
				rest,
			);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_import',
		`Import routing or layout result files into the PCB (Base64-encoded).
Formats: autoroute_json (JSON autoroute), autolayout_json (JSON autolayout), autoroute_ses (FreeRouting SES).`,
		withDocumentParam({
			format: z
				.enum(['autoroute_json', 'autolayout_json', 'autoroute_ses'])
				.describe('Import format'),
			data: z.string().describe('Base64-encoded file content'),
			fileName: z.string().optional().describe('File name'),
			strategy: z.enum(['direct', 'easyeda']).optional().default('direct').describe('For autoroute_ses: direct creates tracks/vias from SES and avoids EasyEDA SES importer hangs; easyeda calls EasyEDA importAutoRouteSesFile. Other formats always use EasyEDA.'),
			dryRun: z.boolean().optional().default(false).describe('For autoroute_ses direct strategy: parse and summarize without creating tracks/vias.'),
			chunkSize: z.number().int().positive().optional().default(75).describe('For autoroute_ses direct strategy: operations per extension call. Smaller chunks return faster on dense boards.'),
			coordinateMode: z.enum(['canvas_to_data', 'scale_only']).optional().default('canvas_to_data').describe('Direct SES coordinate transform. Default canvas_to_data measures the DSN frame\'s offset to the board from the SES\'s fixed vias (EasyEDA\'s DSN starts at the board outline\'s lower-left corner), falling back to EasyEDA\'s canvas-to-data conversion when none match. scale_only skips both and uses yAxis.'),
			coordinateScaleToMil: z.number().positive().optional().default(10).describe('DSN numeric unit to canvas mil scale. EasyEDA DSN uses 10 mil units even when SES says resolution mil 1000. Formula: canvasMil = sesValue / sesResolution * coordinateScaleToMil.'),
			coordinateProbeDistanceMil: z.number().positive().optional().default(1000).describe('For coordinateMode=canvas_to_data: probe distance used to derive EasyEDA canvas-to-data affine transform.'),
			yAxis: z.enum(['invert', 'same']).optional().default('invert').describe('Only for coordinateMode=scale_only: invert converts DSN/SES Y-up coordinates into EasyEDA signed Y-down coordinates.'),
			widthScaleToMil: z.number().positive().optional().describe('Trace width DSN-unit to mil scale; defaults to coordinateScaleToMil. Formula: mil = sesWidth / sesResolution * widthScaleToMil.'),
			viaDiameterMil: z.number().positive().optional().describe('Direct strategy via pad diameter override. Defaults to SES padstack diameter or 24 mil.'),
			viaHoleDiameterMil: z.number().positive().optional().describe('Direct strategy via drill override. Defaults to half diameter or 12 mil.'),
			dedupe: z.boolean().optional().default(true).describe('Direct strategy: dedupe exact same tracks/vias before committing.'),
			includeFixedWiring: z.boolean().optional().default(false).describe('Direct strategy: also recreate SES wiring marked (type protect), i.e. copper the board already had when the DSN was exported. Default false avoids duplicating existing tracks/vias.'),
			replaceNets: z.array(z.string()).optional().describe('Direct strategy: delete these nets\' unlocked tracks/arcs/vias before importing (pass the replaceNets of a pcb_autoroute reroute result). Ignored with dryRun.'),
			timeoutSeconds: z.number().int().positive().optional().default(45).describe('Import timeout (s). Keep short; retry from file if EasyEDA is busy.'),
		}),
		async ({ format, timeoutSeconds, strategy, dryRun, chunkSize, coordinateMode, coordinateScaleToMil, coordinateProbeDistanceMil, yAxis, widthScaleToMil, viaDiameterMil, viaHoleDiameterMil, dedupe, includeFixedWiring, replaceNets, ...rest }) => {
			if (format === 'autoroute_ses' && strategy !== 'easyeda') {
				const data = String((rest as any).data ?? '');
				const ses = Buffer.from(data, 'base64').toString('utf8');
				const { removedBeforeImport, result } = await replaceAndImportSes(bridge, ses, replaceNets, {
					...rest,
					dryRun: dryRun ?? false,
					chunkSize: chunkSize ?? 75,
					coordinateMode: coordinateMode ?? 'canvas_to_data',
					coordinateScaleToMil: coordinateScaleToMil ?? 10,
					coordinateProbeDistanceMil: coordinateProbeDistanceMil ?? 1000,
					yAxis: yAxis ?? 'invert',
					widthScaleToMil: widthScaleToMil ?? coordinateScaleToMil ?? 10,
					viaDiameterMil,
					viaHoleDiameterMil,
					dedupe: dedupe ?? true,
					includeFixedWiring: includeFixedWiring ?? false,
					timeoutSeconds: timeoutSeconds ?? 45,
				});
				return { content: [{ type: 'text', text: JSON.stringify(removedBeforeImport ? { removedBeforeImport, ...result } : result) }] };
			}
			const timeoutMs = (timeoutSeconds ?? 45) * 1000;
			const result = await bridge.send(IMPORT_HANDLER_MAP[format], {
				...rest,
				timeoutMs,
				_timeoutMs: timeoutMs + 5000,
			});
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_import_file',
		`Import a local routing/layout result file into the PCB. This is the recovery path for pcb_autoroute when FreeRouting produced a .ses file but EasyEDA's auto-import timed out or failed.
Formats: autoroute_json, autolayout_json, autoroute_ses.`,
		withDocumentParam({
			format: z
				.enum(['autoroute_json', 'autolayout_json', 'autoroute_ses'])
				.describe('Import format'),
			path: z.string().describe('Absolute or workspace-relative local file path to import'),
			fileName: z.string().optional().describe('File name to present to EasyEDA; defaults to basename(path)'),
			strategy: z.enum(['direct', 'easyeda']).optional().default('direct').describe('For autoroute_ses: direct creates tracks/vias from SES and avoids EasyEDA SES importer hangs; easyeda calls EasyEDA importAutoRouteSesFile. Other formats always use EasyEDA.'),
			dryRun: z.boolean().optional().default(false).describe('For autoroute_ses direct strategy: parse and summarize without creating tracks/vias.'),
			chunkSize: z.number().int().positive().optional().default(75).describe('For autoroute_ses direct strategy: operations per extension call. Smaller chunks return faster on dense boards.'),
			coordinateMode: z.enum(['canvas_to_data', 'scale_only']).optional().default('canvas_to_data').describe('Direct SES coordinate transform. Default canvas_to_data measures the DSN frame\'s offset to the board from the SES\'s fixed vias (EasyEDA\'s DSN starts at the board outline\'s lower-left corner), falling back to EasyEDA\'s canvas-to-data conversion when none match. scale_only skips both and uses yAxis.'),
			coordinateScaleToMil: z.number().positive().optional().default(10).describe('DSN numeric unit to canvas mil scale. EasyEDA DSN uses 10 mil units even when SES says resolution mil 1000. Formula: canvasMil = sesValue / sesResolution * coordinateScaleToMil.'),
			coordinateProbeDistanceMil: z.number().positive().optional().default(1000).describe('For coordinateMode=canvas_to_data: probe distance used to derive EasyEDA canvas-to-data affine transform.'),
			yAxis: z.enum(['invert', 'same']).optional().default('invert').describe('Only for coordinateMode=scale_only: invert converts DSN/SES Y-up coordinates into EasyEDA signed Y-down coordinates.'),
			widthScaleToMil: z.number().positive().optional().describe('Trace width DSN-unit to mil scale; defaults to coordinateScaleToMil. Formula: mil = sesWidth / sesResolution * widthScaleToMil.'),
			viaDiameterMil: z.number().positive().optional().describe('Direct strategy via pad diameter override. Defaults to SES padstack diameter or 24 mil.'),
			viaHoleDiameterMil: z.number().positive().optional().describe('Direct strategy via drill override. Defaults to half diameter or 12 mil.'),
			dedupe: z.boolean().optional().default(true).describe('Direct strategy: dedupe exact same tracks/vias before committing.'),
			includeFixedWiring: z.boolean().optional().default(false).describe('Direct strategy: also recreate SES wiring marked (type protect), i.e. copper the board already had when the DSN was exported. Default false avoids duplicating existing tracks/vias.'),
			replaceNets: z.array(z.string()).optional().describe('Direct strategy: delete these nets\' unlocked tracks/arcs/vias before importing (pass the replaceNets of a pcb_autoroute reroute result). Ignored with dryRun.'),
			timeoutSeconds: z.number().int().positive().optional().default(45).describe('Import timeout (s).'),
		}),
		async ({ format, path: filePath, fileName, strategy, dryRun, chunkSize, coordinateMode, coordinateScaleToMil, coordinateProbeDistanceMil, yAxis, widthScaleToMil, viaDiameterMil, viaHoleDiameterMil, dedupe, includeFixedWiring, replaceNets, timeoutSeconds, ...rest }) => {
			const { path: absPath, searchedPaths } = await resolveLocalFilePath(filePath);
			const bytes = await readFile(absPath);
			if (format === 'autoroute_ses' && strategy !== 'easyeda') {
				const { removedBeforeImport, result } = await replaceAndImportSes(bridge, bytes.toString('utf8'), replaceNets, {
					...rest,
					fileName: fileName ?? basename(absPath),
					dryRun: dryRun ?? false,
					chunkSize: chunkSize ?? 75,
					coordinateMode: coordinateMode ?? 'canvas_to_data',
					coordinateScaleToMil: coordinateScaleToMil ?? 10,
					coordinateProbeDistanceMil: coordinateProbeDistanceMil ?? 1000,
					yAxis: yAxis ?? 'invert',
					widthScaleToMil: widthScaleToMil ?? coordinateScaleToMil ?? 10,
					viaDiameterMil,
					viaHoleDiameterMil,
					dedupe: dedupe ?? true,
					includeFixedWiring: includeFixedWiring ?? false,
					timeoutSeconds: timeoutSeconds ?? 45,
				});
				return {
					content: [{
						type: 'text',
						text: JSON.stringify({
							path: absPath,
							size: bytes.length,
							searchedPaths,
							...(removedBeforeImport ? { removedBeforeImport } : {}),
							importResult: result,
						}),
					}],
				};
			}
			const timeoutMs = (timeoutSeconds ?? 45) * 1000;
			const result = await bridge.send(IMPORT_HANDLER_MAP[format], {
				...rest,
				fileName: fileName ?? basename(absPath),
				data: bytes.toString('base64'),
				timeoutMs,
				_timeoutMs: timeoutMs + 5000,
			});
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						path: absPath,
						size: bytes.length,
						searchedPaths,
						importResult: result,
					}),
				}],
			};
		},
	);
}

interface AutorouteOptions {
	router: 'auto' | 'fastroute' | 'freerouting';
	passes: number;
	timeoutSeconds: number;
	/** Unset: FreeRouting 1, fastroute all cores. */
	threads?: number;
	importMode: 'attempt' | 'skip';
	importStrategy: 'direct' | 'easyeda';
	importTimeoutSeconds: number;
	failOnImportError: boolean;
	includeSesData: boolean;
	excludeLayers: Array<string | number>;
	powerOnlyLayers: Array<string | number>;
	fastroute: Omit<FastrouteRunOptions, 'passes' | 'timeoutSeconds' | 'threads'>;
	/** After importing: re-pour (EasyEDA's engine) before the DRC summary. */
	repourAfterImport: boolean;
	/** After importing replaced nets: put back the nets (or all of them) behind new DRC violations. */
	rollbackOnNewViolations: boolean;
}

// EasyEDA DSN export uses these names for the standard copper layers in PCB
// "(layer <name> ...)" blocks. Inner copper layers come out as Inner1..Inner30.
// We accept friendly aliases here so callers can pass numeric IDs the rest of
// the MCP layer normalizes to ("1" → TopLayer, "15" → Inner1, etc.). Also
// emits common variants ("InnerLayer1") so the matcher can tolerate naming
// differences between EasyEDA versions.
function dsnLayerNames(input: string | number): string[] {
	if (typeof input === 'number' || /^\d+$/.test(String(input))) {
		const id = Number(input);
		// Always include the literal numeric form first — some EasyEDA
		// versions emit DSN layer definitions as `(layer 1 ...)` rather than
		// `(layer TopLayer ...)`. Without this, numeric `excludeLayers: [15]`
		// would generate ["Inner1","InnerLayer1"] and silently miss a DSN
		// that names the layer "15".
		const out: string[] = [String(id)];
		if (id === 1) out.push('TopLayer', 'Top');
		else if (id === 2) out.push('BottomLayer', 'Bottom');
		else if (id >= 15 && id <= 44) {
			const n = id - 14;
			out.push(`Inner${n}`, `InnerLayer${n}`);
		}
		return out;
	}
	const raw = String(input).trim();
	const compact = raw.replace(/[\s_-]+/g, '').toLowerCase();
	if (compact === 'top' || compact === 'toplayer') return ['TopLayer', 'Top'];
	if (compact === 'bottom' || compact === 'bottomlayer') return ['BottomLayer', 'Bottom'];
	const inner = compact.match(/^inner(layer)?(\d+)$/);
	if (inner) return [`Inner${inner[2]}`, `InnerLayer${inner[2]}`];
	// Fall back to the raw name as written — covers custom-named layers.
	return [raw];
}

// Normalize a layer name for fuzzy comparison. Collapses whitespace/dashes/
// underscores, lowercases, and strips a trailing "layer" so "Inner1",
// "InnerLayer1", "inner_1", and "INNER LAYER 1" all compare equal.
function normalizeLayerName(s: string): string {
	return String(s).trim().toLowerCase().replace(/[\s_-]+/g, '').replace(/layer$/, '');
}

// Find the next "(layer<whitespace>" — i.e. an actual layer block, not a
// "(layer_rule" or similar prefix collision.
function findLayerOpen(dsn: string, from: number): number {
	let p = from;
	while (true) {
		const idx = dsn.indexOf('(layer', p);
		if (idx === -1) return -1;
		const next = dsn[idx + '(layer'.length];
		if (next && /\s/.test(next)) return idx;
		p = idx + 1;
	}
}

/**
 * Rewrite the type of a layer DEFINITION to `power` for the requested names.
 * EasyEDA writes layer definitions across multiple lines, e.g.:
 *
 *   (layer Inner1
 *     (type signal)
 *     (property
 *       (index 2)
 *     )
 *   )
 *
 * The earlier single-line regex (`/\(layer\s+([^\s()]+)\s+\(type\s+signal\)/`)
 * happened to match on `\s+` matching newlines, but only when no other
 * attributes appeared between `Inner1` and `(type signal)`. As soon as
 * EasyEDA emits anything else first (an `(index ...)`, a `(direction ...)`),
 * the regex misses the block and the constraint silently no-ops. The
 * autorouter then routes on layers the agent thought were excluded — which
 * is exactly the bug the user hit on layer 15.
 *
 * This implementation walks the DSN with paren counting:
 *   1. find each `(layer NAME ...)` block by paren depth
 *   2. only treat it as a definition if it contains `(type <kw>)` somewhere
 *      inside (otherwise it's a reference inside a via/track/boundary)
 *   3. for matching definitions, replace `(type <anything>)` → `(type power)`
 *
 * Returns the patched DSN, names actually matched, and the full list of
 * layer definitions the parser saw — so the agent can spot a name mismatch
 * (e.g. user passed `Inner1` but DSN says `InnerLayer1`) without blind retry.
 */
export function patchDsnLayerTypes(
	dsn: string,
	layersToForcePower: string[],
): { dsn: string; matched: string[]; layersFound: string[] } {
	const wantedNorm = new Set(layersToForcePower.map(normalizeLayerName).filter(Boolean));
	const matched = new Set<string>();
	const layersFound: string[] = [];
	if (wantedNorm.size === 0) return { dsn, matched: [], layersFound };

	let result = '';
	let i = 0;
	const len = dsn.length;

	while (i < len) {
		const idx = findLayerOpen(dsn, i);
		if (idx === -1) { result += dsn.slice(i); break; }
		result += dsn.slice(i, idx);

		// Parse `(layer<ws>NAME` and walk to the matching close paren.
		let nameStart = idx + '(layer'.length;
		while (nameStart < len && /\s/.test(dsn[nameStart])) nameStart++;
		let nameEnd = nameStart;
		while (nameEnd < len && !/[\s()]/.test(dsn[nameEnd])) nameEnd++;
		const name = dsn.slice(nameStart, nameEnd);

		let depth = 1;
		let j = idx + 1;
		while (j < len && depth > 0) {
			const c = dsn[j];
			if (c === '(') depth++;
			else if (c === ')') depth--;
			j++;
		}
		let block = dsn.slice(idx, j);

		// Treat as a layer DEFINITION only when the block carries a (type X)
		// declaration. Layer references (inside vias, tracks, boundaries) do
		// not — and we must not rewrite those.
		const typeMatch = block.match(/\(type\s+\w+\s*\)/i);
		if (typeMatch) {
			layersFound.push(name);
			if (wantedNorm.has(normalizeLayerName(name))) {
				const before = block;
				block = block.replace(/\(type\s+\w+\s*\)/i, '(type power)');
				if (before !== block) matched.add(name);
			}
		}
		result += block;
		i = j;
	}
	return { dsn: result, matched: Array.from(matched), layersFound };
}

async function resolveFreeroutingJarPath(): Promise<{ jarPath: string; searchedJarPaths: string[] }> {
	const envPath = process.env.FREEROUTING_JAR?.trim();
	if (envPath) {
		const resolved = resolve(envPath);
		return { jarPath: resolved, searchedJarPaths: [resolved] };
	}

	const candidates = uniqueStrings(runtimeRootCandidates().map((root) => resolve(root, 'vendor/freerouting.jar')));
	for (const candidate of candidates) {
		try {
			await access(candidate);
			return { jarPath: candidate, searchedJarPaths: candidates };
		} catch {
			// Try next candidate.
		}
	}
	return { jarPath: candidates[0], searchedJarPaths: candidates };
}

async function resolveLocalFilePath(inputPath: string): Promise<{ path: string; searchedPaths: string[] }> {
	const candidates = isAbsolute(inputPath)
		? [resolve(inputPath)]
		: uniqueStrings(runtimeRootCandidates().map((root) => resolve(root, inputPath)));

	for (const candidate of candidates) {
		try {
			await access(candidate);
			return { path: candidate, searchedPaths: candidates };
		} catch {
			// Try next candidate.
		}
	}

	throw new Error(`Import file not found. Input: ${inputPath}\nSearched:\n${candidates.map((p) => `- ${p}`).join('\n')}`);
}

type PickedRouter = { kind: 'fastroute'; bin: string } | { kind: 'freerouting'; jarPath: string };

/** Resolve the router before exporting anything, so a missing install fails fast. */
async function pickRouter(choice: AutorouteOptions['router']): Promise<PickedRouter> {
	let fastrouteSearched: string[] = [];
	if (choice !== 'freerouting') {
		const fastroute = await resolveFastrouteBinary();
		if (fastroute.path) return { kind: 'fastroute', bin: fastroute.path };
		fastrouteSearched = fastroute.searched;
		if (choice === 'fastroute') throw new Error(fastrouteNotFoundMessage(fastrouteSearched));
	}
	const { jarPath, searchedJarPaths } = await resolveFreeroutingJarPath();
	try {
		await access(jarPath);
		return { kind: 'freerouting', jarPath };
	} catch {
		throw new Error(
			(choice === 'auto' ? `${fastrouteNotFoundMessage(fastrouteSearched)}\n\n` : '') +
			`FreeRouting jar not found. Searched:\n${searchedJarPaths.map((p) => `- ${p}`).join('\n')}\n` +
			`Download a release from ` +
			`https://github.com/freerouting/freerouting/releases and either drop it at ` +
			`vendor/freerouting.jar or set FREEROUTING_JAR to its absolute path.`,
		);
	}
}

function fastrouteNotFoundMessage(searched: string[]): string {
	const shown = searched.slice(0, 8).map((p) => `- ${p}`).join('\n');
	return `fastroute binary not found. Searched:\n${shown}${searched.length > 8 ? `\n- ... ${searched.length - 8} more (PATH)` : ''}\n` +
		'Install it with `bash scripts/install-fastroute.sh` (downloads the release for this platform into vendor/fastroute/), ' +
		'or set FASTROUTE_BIN to its absolute path. Releases: https://github.com/parisxmas/fastroute/releases.';
}

/** FreeRouting headless: exactly the pre-fastroute behaviour. */
async function runFreerouting(
	jarPath: string,
	dsnFile: string,
	sesFile: string,
	opts: AutorouteOptions,
): Promise<{ sesRaw: string; javaResult: JavaResult }> {
	const javaBin = process.env.JAVA_BIN || 'java';
	// Minimal flag set — `-de`/`-do`/`-mp` are stable across FreeRouting 1.x
	// and 2.x. Earlier versions of this tool passed `-us global` which isn't a
	// documented flag and could be ignored or misinterpreted depending on
	// FreeRouting version.
	const args = [
		'-jar', jarPath,
		'-de', dsnFile,
		'-do', sesFile,
		'-mp', String(opts.passes),
		'-mt', String(opts.threads ?? 1),
	];
	const javaResult = await runJava(javaBin, args, opts.timeoutSeconds * 1000);

	// Validate FreeRouting actually produced output before importing.
	if (javaResult.code !== 0) {
		throw new Error(
			`FreeRouting exited with code ${javaResult.code}. ` +
			`Common causes: jar built for newer Java than installed; insufficient memory; ` +
			`unrecognized DSN structure.\n` +
			`stderr tail:\n${javaResult.stderrTail || '(empty)'}\n` +
			`stdout tail:\n${javaResult.stdoutTail || '(empty)'}\n` +
			`DSN file kept at: ${dsnFile}`,
		);
	}

	let sesBytes: Buffer;
	try {
		sesBytes = await readFile(sesFile);
	} catch {
		throw new Error(
			`FreeRouting exited cleanly but produced no SES file at ${sesFile}. ` +
			`This usually means the design has unconstrained nets or class definitions FreeRouting can't parse.\n` +
			`stdout tail:\n${javaResult.stdoutTail || '(empty)'}`,
		);
	}
	if (sesBytes.length === 0) {
		throw new Error(`FreeRouting wrote an empty SES file. The router likely failed silently. DSN kept at: ${dsnFile}`);
	}
	return { sesRaw: sesBytes.toString('utf8'), javaResult };
}


async function runAutoroute(
	bridge: WebSocketBridge,
	opts: AutorouteOptions,
	routingParams: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const router = await pickRouter(opts.router);

	// Bridge timeout for DSN/SES round-trips on non-trivial boards. Big designs
	// take 30-60s to serialize; the default 45s would 50/50 cut it.
	const bridgeTimeoutMs = 5 * 60_000;

	// 0. EasyEDA's DRC as it is now: the reference an import is checked against,
	// and (reroute:"best") which nets EasyEDA already counts as connected.
	// Re-poured first when the import re-pours, so both sides compare alike.
	let drcBefore: DrcSnapshot | undefined;
	let snapshot: CopperSnapshot | undefined;
	let importedOps: DirectSesOperation[] = [];
	const rerouting = router.kind === 'fastroute' && opts.fastroute.reroute !== 'none';
	if (opts.importMode === 'attempt' || rerouting) {
		if (opts.importMode === 'attempt' && opts.repourAfterImport) await repourAll(bridge, routingParams);
		drcBefore = await drcSnapshot(bridge, routingParams, bridgeTimeoutMs);
	}

	// 1. Export DSN from EasyEDA.
	const dsnResult = (await bridge.send('pcb.manufacture.getDsnFile', {
		...routingParams,
		fileName: 'autoroute',
		_timeoutMs: bridgeTimeoutMs,
	})) as { fileName: string; data: string; size: number };

	if (!dsnResult?.data) throw new Error('DSN export returned no data — is a PCB document open?');

	const dir = await mkdtemp(join(tmpdir(), 'easyeda-autoroute-'));
	// Force distinct .dsn/.ses paths. EasyEDA sometimes returns fileName
	// without an extension ("autoroute"); a naive `dsnFile.replace(/\.dsn$/i, '.ses')`
	// then leaves dsnFile === sesFile, which makes FreeRouting silently
	// write its output back over the input. Always strip any trailing .dsn
	// from the base name and append the canonical extension explicitly.
	const baseName = (dsnResult.fileName || 'autoroute').replace(/\.dsn$/i, '');
	const dsnFile = join(dir, `${baseName}.dsn`);
	const sesFile = join(dir, `${baseName}.ses`);

	// Apply layer constraints (block / power-only) by rewriting the DSN's
	// (type signal) → (type power) for the requested layers. Both lists are
	// merged because FreeRouting only distinguishes signal vs power; "block"
	// and "power-only" are the same instruction to the router.
	const dsnRaw = Buffer.from(dsnResult.data, 'base64').toString('utf8');
	const constrainedLayers = [...opts.excludeLayers, ...opts.powerOnlyLayers]
		.flatMap(dsnLayerNames);
	const { dsn: dsnPatched, matched: matchedLayers, layersFound } = patchDsnLayerTypes(dsnRaw, constrainedLayers);
	const requested = constrainedLayers;
	const unmatched = requested.filter((name) => !matchedLayers.includes(name));
	await writeFile(dsnFile, dsnPatched);

	// Hard-fail when we asked to constrain a layer but didn't actually
	// patch it. Silently autorouting onto inner planes wastes a round trip
	// and produces a SES the user will (rightly) refuse to import.
	const userRequestedAny = (opts.excludeLayers.length + opts.powerOnlyLayers.length) > 0;
	if (userRequestedAny && matchedLayers.length === 0) {
		throw new Error(
			`Layer constraint patch matched ZERO layer definitions in the DSN. ` +
			`Requested names: ${requested.join(', ') || '(none)'}\n` +
			`Layer definitions found in DSN: ${layersFound.join(', ') || '(none — DSN may not contain (type ...) declarations this version)'}\n` +
			`Likely cause: name mismatch between excludeLayers/powerOnlyLayers and what EasyEDA emits. ` +
			`Re-run with one of the names listed above (e.g. pass excludeLayers=["${layersFound[0] ?? 'Inner1'}", ...]).`,
		);
	}

	// 2. Route. Both routers leave a SES in EasyEDA's DSN units at sesFile.
	let sesRaw: string;
	let routerLog: JavaResult;
	let routerResult: Record<string, unknown>;
	let replaceNets: string[] = [];
	let routedDsn = dsnPatched;
	let viaPinsRemoved: number | undefined;
	if (router.kind === 'fastroute') {
		const tree = parseSexpr(dsnPatched);
		viaPinsRemoved = stripViaPins(tree);
		if (viaPinsRemoved) routedDsn = writeSexpr(tree);
		const run = await runFastrouteOnDsn(bridge, routingParams, router.bin, routedDsn, dir, baseName, {
			...opts.fastroute,
			...(drcBefore && !drcBefore.error ? { easyedaIncompleteNets: Array.from(incompleteNets(drcBefore)) } : {}),
			passes: opts.passes,
			timeoutSeconds: opts.timeoutSeconds,
			threads: opts.threads,
		});
		sesRaw = run.ses;
		routerLog = { code: run.processResult.code, stdoutTail: run.processResult.stdoutTail, stderrTail: run.processResult.stderrTail };
		routerResult = run.details;
		replaceNets = run.replaceNets;
	} else {
		const freerouting = await runFreerouting(router.jarPath, dsnFile, sesFile, opts);
		sesRaw = freerouting.sesRaw;
		routerLog = freerouting.javaResult;
		routerResult = {
			router: 'freerouting',
			javaExitCode: freerouting.javaResult.code,
			freeroutingJar: router.jarPath,
			stdoutTail: freerouting.javaResult.stdoutTail,
			stderrTail: freerouting.javaResult.stderrTail,
		};
	}

	const importFileName = dsnResult.fileName?.replace(/\.dsn$/i, '.ses') || 'autoroute.ses';
	const routingCompletion = safeAnalyzeRoutingCompletion(routedDsn, sesRaw, routerLog);
	const commonResult: Record<string, unknown> = {
		...routerResult,
		...(viaPinsRemoved != null ? { viaPinsRemoved } : {}),
		dsnSize: dsnResult.size,
		sesSize: Buffer.byteLength(sesRaw),
		passes: opts.passes,
		dsnFile,
		sesFile,
		layerConstraints: {
			requested,
			matched: matchedLayers,
			unmatched,
			layersFoundInDsn: layersFound,
		},
		routingCompletion,
		manualImport: {
			tool: 'pcb_import_file',
			format: 'autoroute_ses',
			path: sesFile,
			strategy: 'direct',
			coordinateMode: 'canvas_to_data',
			timeoutSeconds: opts.importTimeoutSeconds,
			...(replaceNets.length ? { replaceNets } : {}),
		},
	};

	if (opts.includeSesData) {
		commonResult.sesData = Buffer.from(sesRaw).toString('base64');
	}

	// 4. Import the SES result. FreeRouting output is valuable even when
	// EasyEDA's importer stalls, so import failure is captured in the return
	// payload by default instead of throwing away the .ses path.
	let importResult: Record<string, unknown> = {
		attempted: false,
		imported: false,
		skipped: opts.importMode === 'skip',
	};
	if (opts.importMode === 'attempt') {
		const importTimeoutMs = opts.importTimeoutSeconds * 1000;
		try {
			if (replaceNets.length && opts.importStrategy !== 'direct') {
				throw new Error('reroute results replace existing copper, which only importStrategy:"direct" supports');
			}
			// Measured on the DSN before any copper is deleted, so every exported via can match.
			const frame = opts.importStrategy === 'direct' ? await measureBoardOffset(bridge, routingParams, { dsn: dsnPatched }) : undefined;
			if (opts.importStrategy === 'direct' && !frame?.offset) {
				throw new Error(`could not measure the DSN-to-board offset (${frame?.warnings.join('; ') || 'no via, component or outline matched'}); nothing was deleted or imported`);
			}
			// A copy of the copper about to be replaced, so nets that make the board
			// worse can be put back. No copy, no delete.
			if (replaceNets.length) {
				snapshot = await snapshotNetCopper(bridge, routingParams, replaceNets);
				if (snapshot.errors.length) {
					throw new Error(`could not read the copper of the nets to replace, so it could not be put back if needed (${snapshot.errors.slice(0, 3).join('; ')}); nothing was deleted or imported`);
				}
			}
			const removed = replaceNets.length ? await deleteNetCopper(bridge, routingParams, replaceNets) : undefined;
			if (removed) importResult = { ...importResult, removedBeforeImport: removed };
			const directOptions: DirectSesImportOptions = {
				...routingParams,
				fileName: importFileName,
				dryRun: false,
				timeoutSeconds: opts.importTimeoutSeconds,
				chunkSize: 75,
				coordinateMode: 'canvas_to_data',
				...(frame?.offset ? { boardOffsetMil: frame.offset } : {}),
				...(frame?.warnings.length ? { calibrationWarnings: frame.warnings } : {}),
				coordinateScaleToMil: 10,
				coordinateProbeDistanceMil: 1000,
				yAxis: 'invert',
				widthScaleToMil: 10,
				dedupe: true,
			};
			if (opts.importStrategy === 'direct') importedOps = sesRoutesToOperations(sesRaw, directOptions).operations;
			const response = opts.importStrategy === 'direct'
				? await importSesRoutesDirect(bridge, sesRaw, directOptions)
				: await bridge.send('pcb.manufacture.importAutoRouteSes', {
					...routingParams,
					fileName: importFileName,
					data: Buffer.from(sesRaw).toString('base64'),
					timeoutMs: importTimeoutMs,
					_timeoutMs: importTimeoutMs + 5000,
				});
			const imported = importSucceeded(response);
			importResult = {
				...importResult,
				attempted: true,
				strategy: opts.importStrategy,
				imported,
				response,
			};
			if (!imported && opts.failOnImportError) {
				throw new Error(`EasyEDA SES import did not confirm success. Response: ${JSON.stringify(response)}`);
			}
		} catch (err: any) {
			const message = err instanceof Error ? err.message : String(err);
			if (opts.failOnImportError) {
				throw new Error(`${message}\nRouter SES output kept at: ${sesFile}\nRetry with pcb_import_file({ format: "autoroute_ses", path: "${sesFile}" }).`);
			}
			importResult = {
				...importResult,
				attempted: true,
				imported: false,
				error: message,
			};
		}
	}

	if (!importResult.imported) {
		return {
			status: opts.importMode === 'skip' ? 'ses_ready_import_skipped' : 'ses_ready_import_failed',
			...commonResult,
			importResult,
		};
	}

	// 5. Force the canvas to redraw, re-pour (new copper changes what the pours
	// can reach), then compare EasyEDA's DRC with the one taken before routing.
	await bridge.send('pcb.document.refresh', { ...routingParams, zoom: false }).catch(() => {/* non-fatal */});
	const repourNow = () => (opts.repourAfterImport ? repourAll(bridge, routingParams) : Promise.resolve(undefined));
	const repour = await repourNow();
	let drcAfter = await drcSnapshot(bridge, routingParams, bridgeTimeoutMs);

	const verification: Record<string, unknown> = {
		drcBefore: drcBefore ? (drcBefore.error ? { error: drcBefore.error } : { total: drcBefore.total }) : 'not taken',
	};
	let status = 'imported';
	if (drcAfter.error || !drcBefore || drcBefore.error) {
		verification.drcAfter = drcAfter.error ? { error: drcAfter.error } : { total: drcAfter.total, ...summarizeViolations(drcAfter.violations) };
		verification.note = 'No DRC comparison: run pcb_drc_violations_detailed before trusting the result.';
	} else {
		let added = newViolations(drcBefore, drcAfter);
		verification.newViolations = summarizeViolations(added);
		if (added.length && snapshot && opts.rollbackOnNewViolations) {
			// Put back the replaced nets behind each new violation: the ones it
			// names, else the ones whose new copper runs next to it (a pour cut
			// into islands names only the pour net). Up to three rounds, then
			// every replaced net.
			const kept = new Set(replaceNets);
			const steps: Array<Record<string, unknown>> = [];
			for (let round = 1; round <= 3 && added.length && !drcAfter.error && kept.size; round++) {
				const culprits = new Set<string>();
				for (const v of added) {
					const named = v.nets.filter((n) => kept.has(n));
					const near = named.length ? [] : netsNear(importedOps, v.location, 150).filter((n) => kept.has(n));
					for (const n of [...named, ...near]) culprits.add(n);
				}
				if (!culprits.size || culprits.size === kept.size) break;
				const nets = Array.from(culprits);
				const r = await restoreNetCopper(bridge, routingParams, snapshot, nets);
				for (const n of nets) kept.delete(n);
				await repourNow();
				drcAfter = await drcSnapshot(bridge, routingParams, bridgeTimeoutMs);
				if (!drcAfter.error) added = newViolations(drcBefore, drcAfter);
				steps.push({ restored: nets, tracks: r.tracks, arcs: r.arcs, vias: r.vias, ...(r.errors.length ? { errors: r.errors.slice(0, 10) } : {}), newViolationsLeft: drcAfter.error ? `DRC failed: ${drcAfter.error}` : added.length });
			}
			if (added.length || drcAfter.error) {
				const rest = Array.from(kept);
				const r = await restoreNetCopper(bridge, routingParams, snapshot, rest);
				kept.clear();
				await repourNow();
				drcAfter = await drcSnapshot(bridge, routingParams, bridgeTimeoutMs);
				if (!drcAfter.error) added = newViolations(drcBefore, drcAfter);
				steps.push({ restored: `all ${rest.length} remaining replaced nets`, tracks: r.tracks, arcs: r.arcs, vias: r.vias, ...(r.errors.length ? { errors: r.errors.slice(0, 10) } : {}), newViolationsLeft: drcAfter.error ? `DRC failed: ${drcAfter.error}` : added.length });
			}
			status = kept.size ? 'imported_partially_rolled_back' : 'rolled_back';
			verification.rollback = { steps, keptNets: Array.from(kept), restoredNets: replaceNets.filter((n) => !kept.has(n)) };
		} else if (added.length) {
			status = 'imported_with_new_violations';
		}
		verification.drcAfter = { total: drcAfter.total, newViolationsLeft: drcAfter.error ? 'unknown' : added.length };
		verification.passed = !drcAfter.error && added.length === 0;
	}

	return {
		status,
		...commonResult,
		importResult,
		...(repour ? { repour } : {}),
		verification,
	};
}

/** Nets with an imported track or via within `radius` mil of `at`. */
function netsNear(ops: DirectSesOperation[], at: { x: number; y: number } | undefined, radius: number): string[] {
	if (!at) return [];
	const out = new Set<string>();
	for (const op of ops) {
		const d = op.type === 'create_via'
			? Math.hypot(op.x - at.x, op.y - at.y)
			: pointSegmentDistance(at, { x: op.startX, y: op.startY }, { x: op.endX, y: op.endY }) - op.lineWidth / 2;
		if (d <= radius) out.add(op.net);
	}
	return Array.from(out);
}

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x, dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

async function repourAll(bridge: WebSocketBridge, routingParams: Record<string, unknown>): Promise<unknown> {
	return bridge.send('pcb.pour.repourAll', { ...routingParams, totalTimeoutMs: 120_000, _timeoutMs: 135_000 })
		.then((r: any) => ({ status: r?.status, summary: r?.summary ?? r?.counts }))
		.catch((err: any) => ({ error: err instanceof Error ? err.message : String(err), note: 'Re-pour with pcb_repour_all before trusting DRC.' }));
}

/**
 * pcb_import_* direct path: resolve the coordinate transform while the board
 * still has all its vias, then delete `replaceNets`' copper, then import.
 */
async function replaceAndImportSes(
	bridge: WebSocketBridge,
	ses: string,
	replaceNets: string[] | undefined,
	options: DirectSesImportOptions,
): Promise<{ removedBeforeImport?: Awaited<ReturnType<typeof deleteNetCopper>>; result: Record<string, unknown> }> {
	const resolved = await resolveDirectSesImportOptions(bridge, ses, options);
	if (!replaceNets?.length || options.dryRun) return { result: await importSesRoutesDirect(bridge, ses, resolved) };
	if (!resolved.boardOffsetMil && resolved.coordinateMode === 'canvas_to_data') {
		throw new Error('replaceNets: no SES via matched a board via, so the DSN-to-board offset could not be measured; nothing was deleted. Import without replaceNets and check with DRC, or pass coordinateMode:"scale_only" if you know the frame.');
	}
	const removedBeforeImport = await deleteNetCopper(bridge, pickRoutingParams(options), replaceNets);
	return { removedBeforeImport, result: await importSesRoutesDirect(bridge, ses, resolved) };
}

function importSucceeded(response: unknown): boolean {
	if (response === true) return true;
	if (!response || typeof response !== 'object') return false;
	return (response as { imported?: unknown }).imported === true;
}

interface DirectSesImportOptions extends Record<string, unknown> {
	dryRun?: boolean;
	chunkSize?: number;
	coordinateMode?: 'canvas_to_data' | 'scale_only';
	coordinateScaleToMil?: number;
	coordinateProbeDistanceMil?: number;
	coordinateTransform?: DirectSesCoordinateTransform;
	/**
	 * DSN frame -> board, in mil: boardMil = sesValue / sesResolution * coordinateScaleToMil + offset.
	 * EasyEDA's DSN starts at the board outline's lower-left corner, not the canvas origin.
	 */
	boardOffsetMil?: BoardOffset;
	calibrationWarnings?: string[];
	yAxis?: 'invert' | 'same';
	widthScaleToMil?: number;
	viaDiameterMil?: number;
	viaHoleDiameterMil?: number;
	dedupe?: boolean;
	/** Also recreate SES wiring marked (type protect|fix), i.e. copper the DSN already had. */
	includeFixedWiring?: boolean;
	timeoutSeconds?: number;
}

interface DirectSesCoordinateTransform {
	mode: 'canvas_to_data';
	probeDistanceMil: number;
	origin: Point;
	xProbe: Point;
	yProbe: Point;
}

interface BoardOffset {
	x: number;
	y: number;
	method: 'vias' | 'components' | 'board-outline';
	support: number;
}

/**
 * Measure the DSN frame's offset to the board from vias present on both sides
 * (all DSN vias, or an SES's fixed vias), falling back to the outline when a
 * DSN is given. Call it before deleting copper: it matches against the board.
 */
async function measureBoardOffset(
	bridge: WebSocketBridge,
	routingParams: Record<string, unknown>,
	source: { dsn: string } | { ses: string },
): Promise<{ offset?: BoardOffset; warnings: string[] }> {
	const send = (method: string, params: Record<string, unknown> = {}) =>
		bridge.send(method, { ...routingParams, ...params, _timeoutMs: 20_000 });
	let vias: Array<Point & { net: string }>;
	let parts: Array<Point & { ref: string }>;
	let boundary: Point[] = [];
	if ('dsn' in source) {
		const root = parseSexpr(source.dsn);
		vias = dsnWiringVias(root);
		parts = dsnPlacements(root);
		boundary = dsnBoundaryPoints(root);
	} else {
		const res = getSesResolutionScale(source.ses);
		vias = parseSesRouteNets(source.ses).flatMap((n) =>
			n.viaPoints.filter((v) => v.fixed).map((v) => ({ x: v.x / res, y: v.y / res, net: n.name })));
		parts = dsnPlacements(parseSexpr(source.ses)).map((p) => ({ ...p, x: p.x / res, y: p.y / res }));
	}
	const { calibration, warnings } = await calibrateDsnFrame(send, vias, boundary, parts);
	if (!calibration) return { warnings };
	// The calibration is in 10-mil DSN units.
	return { offset: { x: round3(calibration.offsetX * 10), y: round3(calibration.offsetY * 10), method: calibration.method, support: calibration.support }, warnings };
}

type DirectSesOperation =
	| {
		type: 'create_track';
		net: string;
		layer: string | number;
		startX: number;
		startY: number;
		endX: number;
		endY: number;
		lineWidth: number;
	}
	| {
		type: 'create_via';
		net: string;
		x: number;
		y: number;
		diameter: number;
		holeDiameter: number;
		viaType: 'Through';
	};

async function importSesRoutesDirect(
	bridge: WebSocketBridge,
	ses: string,
	options: DirectSesImportOptions,
): Promise<Record<string, unknown>> {
	const resolvedOptions = await resolveDirectSesImportOptions(bridge, ses, options);
	const plan = sesRoutesToOperations(ses, resolvedOptions);
	const dryRun = options.dryRun === true;
	const chunkSize = Math.max(1, Math.floor(Number(options.chunkSize ?? 75)));

	const baseResult: Record<string, unknown> = {
		strategy: 'direct',
		dryRun,
		imported: dryRun ? false : plan.operations.length === 0,
		...plan.summary,
		measurement: plan.measurement,
		sampleOperations: plan.operations.slice(0, 10),
	};
	if (dryRun || plan.operations.length === 0) return baseResult;

	const chunks = chunkArray(plan.operations, chunkSize);
	const timeoutMs = Math.max(1, Math.floor(Number(options.timeoutSeconds ?? 45))) * 1000;
	const routingParams = pickRoutingParams(options);
	let createdTracks = 0;
	let createdVias = 0;
	let errorCount = 0;
	const errors: Array<Record<string, unknown>> = [];
	const chunkResults: Array<Record<string, unknown>> = [];

	for (let i = 0; i < chunks.length; i++) {
		const response = await bridge.send('pcb.manufacture.commitSesRoutesDirect', {
			...routingParams,
			operations: chunks[i],
			dryRun: false,
			onError: 'continue',
			maxResultIds: 25,
			perOperationTimeoutMs: 1500,
			_timeoutMs: timeoutMs,
		}) as any;
		createdTracks += Number(response?.createdTracks ?? 0);
		createdVias += Number(response?.createdVias ?? 0);
		errorCount += Number(response?.errorCount ?? 0);
		if (Array.isArray(response?.errors)) errors.push(...response.errors);
		chunkResults.push({
			index: i,
			operationCount: chunks[i].length,
			createdTracks: response?.createdTracks ?? 0,
			createdVias: response?.createdVias ?? 0,
			errorCount: response?.errorCount ?? 0,
		});
	}

	const importedNets = Array.from(new Set(plan.operations.filter((op) => op.type === 'create_track').map((op) => op.net)));
	const connectivityRefresh = await refreshNetConnectivity(bridge, routingParams, importedNets);

	return {
		...baseResult,
		dryRun: false,
		chunkSize,
		chunkCount: chunks.length,
		createdTracks,
		createdVias,
		errorCount,
		imported: errorCount === 0,
		errors: errors.slice(0, 50),
		errorsTruncated: errors.length > 50,
		chunkResults,
		connectivityRefresh,
	};
}

async function resolveDirectSesImportOptions(
	bridge: WebSocketBridge,
	ses: string,
	options: DirectSesImportOptions,
): Promise<DirectSesImportOptions> {
	const coordinateMode = options.coordinateMode ?? 'canvas_to_data';
	if (coordinateMode !== 'canvas_to_data' || options.coordinateTransform || options.boardOffsetMil) {
		return { ...options, coordinateMode };
	}

	const routingParams = pickRoutingParams(options);
	const measured = await measureBoardOffset(bridge, routingParams, { ses });
	if (measured.offset) {
		return { ...options, coordinateMode, boardOffsetMil: measured.offset, calibrationWarnings: [...(options.calibrationWarnings ?? []), ...measured.warnings] };
	}

	const probeDistanceMil = Math.max(1, Number(options.coordinateProbeDistanceMil ?? 1000));
	const timeoutMs = Math.min(
		Math.max(1, Math.floor(Number(options.timeoutSeconds ?? 45))) * 1000,
		5000,
	);
	try {
		const origin = await bridge.send('pcb.document.convertCanvasToData', { ...routingParams, x: 0, y: 0, _timeoutMs: timeoutMs });
		const xProbe = await bridge.send('pcb.document.convertCanvasToData', { ...routingParams, x: probeDistanceMil, y: 0, _timeoutMs: timeoutMs });
		const yProbe = await bridge.send('pcb.document.convertCanvasToData', { ...routingParams, x: 0, y: probeDistanceMil, _timeoutMs: timeoutMs });
		return {
			...options,
			coordinateMode,
			coordinateProbeDistanceMil: probeDistanceMil,
			calibrationWarnings: [
				...(options.calibrationWarnings ?? []),
				...measured.warnings,
				'no SES via matched a board via, so the DSN-to-board offset could not be measured; fell back to EasyEDA\'s canvas-to-data transform, which is wrong when the board outline does not start at the canvas origin. Check the result with DRC.',
			],
			coordinateTransform: {
				mode: 'canvas_to_data',
				probeDistanceMil,
				origin: extractPoint(origin, 'convertCanvasToData(0,0)'),
				xProbe: extractPoint(xProbe, `convertCanvasToData(${probeDistanceMil},0)`),
				yProbe: extractPoint(yProbe, `convertCanvasToData(0,${probeDistanceMil})`),
			},
		};
	} catch (err: any) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Could not derive EasyEDA canvas-to-data coordinate transform for direct SES import: ${message}. ` +
			`Retry after the extension reconnects, or pass coordinateMode:"scale_only" with the correct yAxis if you intentionally want raw scaled coordinates.`,
		);
	}
}

export function sesRoutesToOperations(
	ses: string,
	options: DirectSesImportOptions = {},
): {
	operations: DirectSesOperation[];
	summary: Record<string, unknown>;
	measurement: Record<string, unknown>;
} {
	const sesResolution = getSesResolutionScale(ses);
	const requestedCoordinateMode = options.coordinateMode ?? (options.coordinateTransform || options.boardOffsetMil ? 'canvas_to_data' : 'scale_only');
	const boardOffset = options.boardOffsetMil;
	const coordinateMode = boardOffset ? 'board_calibrated' : options.coordinateTransform ? 'canvas_to_data' : 'scale_only';
	const coordinateScaleToMil = Number(options.coordinateScaleToMil ?? 10);
	const yAxis = options.yAxis === 'same' ? 'same' : 'invert';
	const widthScaleToMil = Number(options.widthScaleToMil ?? coordinateScaleToMil);
	const coordinateTransform = options.coordinateTransform;
	const viaPadstackDiameters = parseSesViaPadstackDiameters(ses);
	const nets = parseSesRouteNets(ses);
	const operations: DirectSesOperation[] = [];
	let skippedSinglePointWires = 0;
	let skippedZeroLengthSegments = 0;
	let trackOperationCount = 0;
	let viaOperationCount = 0;

	const toCanvasMil = (v: number): number => round3((v / sesResolution) * coordinateScaleToMil);
	const transformCanvasToData = (x: number, y: number): Point => {
		if (boardOffset) return { x: round3(x + boardOffset.x), y: round3(y + boardOffset.y) };
		if (coordinateMode === 'canvas_to_data' && coordinateTransform) {
			const px = (x / coordinateTransform.probeDistanceMil);
			const py = (y / coordinateTransform.probeDistanceMil);
			return {
				x: round3(
					coordinateTransform.origin.x
					+ (coordinateTransform.xProbe.x - coordinateTransform.origin.x) * px
					+ (coordinateTransform.yProbe.x - coordinateTransform.origin.x) * py,
				),
				y: round3(
					coordinateTransform.origin.y
					+ (coordinateTransform.xProbe.y - coordinateTransform.origin.y) * px
					+ (coordinateTransform.yProbe.y - coordinateTransform.origin.y) * py,
				),
			};
		}
		return { x: round3(x), y: yAxis === 'invert' ? -round3(y) : round3(y) };
	};
	const toCoordMil = (v: number): number => toCanvasMil(v);
	const toDataPoint = (p: Point): Point => transformCanvasToData(toCanvasMil(p.x), toCanvasMil(p.y));
	const toWidthMil = (v: number): number => round3((v / sesResolution) * widthScaleToMil);

	const includeFixed = options.includeFixedWiring === true;
	let skippedFixedWires = 0;
	let skippedFixedVias = 0;
	for (const net of nets) {
		for (const path of net.paths) {
			if (path.fixed && !includeFixed) {
				skippedFixedWires += 1;
				continue;
			}
			if (path.points.length < 2) {
				skippedSinglePointWires += 1;
				continue;
			}
			const lineWidth = Math.max(0.1, toWidthMil(path.width));
			for (let i = 1; i < path.points.length; i++) {
				const a = path.points[i - 1];
				const b = path.points[i];
				const start = toDataPoint(a);
				const end = toDataPoint(b);
				const startX = start.x;
				const startY = start.y;
				const endX = end.x;
				const endY = end.y;
				if (Math.abs(startX - endX) < 0.001 && Math.abs(startY - endY) < 0.001) {
					skippedZeroLengthSegments += 1;
					continue;
				}
				operations.push({
					type: 'create_track',
					net: net.name,
					layer: path.layer,
					startX,
					startY,
					endX,
					endY,
					lineWidth,
				});
				trackOperationCount += 1;
			}
		}

		for (const via of net.viaPoints) {
			if (via.fixed && !includeFixed) {
				skippedFixedVias += 1;
				continue;
			}
			const rawDiameter = viaPadstackDiameters.get(via.padstack);
			const diameter = round3(Number(options.viaDiameterMil ?? (rawDiameter != null ? toCoordMil(rawDiameter) : 24)));
			const holeDiameter = round3(Number(options.viaHoleDiameterMil ?? Math.max(4, diameter / 2)));
			const point = toDataPoint(via);
			operations.push({
				type: 'create_via',
				net: net.name,
				x: point.x,
				y: point.y,
				diameter,
				holeDiameter,
				viaType: 'Through',
			});
			viaOperationCount += 1;
		}
	}

	const beforeDedupeCount = operations.length;
	const finalOperations = options.dedupe === false ? operations : dedupeDirectOperations(operations);

	const firstPoint = nets.flatMap((net) => net.paths).flatMap((path) => path.points)[0];
	const firstPath = nets.flatMap((net) => net.paths)[0];
	const firstVia = nets.flatMap((net) => net.viaPoints)[0];
	return {
		operations: finalOperations,
		summary: {
			routeNetCount: nets.length,
			operationCount: finalOperations.length,
			trackOperationCount: finalOperations.filter((op) => op.type === 'create_track').length,
			viaOperationCount: finalOperations.filter((op) => op.type === 'create_via').length,
			rawTrackOperationCount: trackOperationCount,
			rawViaOperationCount: viaOperationCount,
			dedupedOperationCount: beforeDedupeCount - finalOperations.length,
			skippedSinglePointWires,
			skippedZeroLengthSegments,
			skippedFixedWires,
			skippedFixedVias,
		},
		measurement: {
			sesResolution,
			requestedCoordinateMode,
			coordinateMode,
			coordinateScaleToMil,
			yAxis: coordinateMode === 'scale_only' ? yAxis : undefined,
			widthScaleToMil,
			coordinateTransform,
			...(boardOffset ? { boardOffsetMil: boardOffset } : {}),
			...(options.calibrationWarnings?.length ? { calibrationWarnings: options.calibrationWarnings } : {}),
			canvasFormula: 'canvasMil = sesCoordinate / sesResolution * coordinateScaleToMil',
			coordinateFormulaX: coordinateMode === 'board_calibrated'
				? 'mcpXMil = canvasXMil + boardOffsetMil.x'
				: coordinateMode === 'canvas_to_data'
				? 'mcpXMil = EasyEDA.convertCanvasOriginToDataOrigin(canvasXMil, canvasYMil).x'
				: 'mcpXMil = sesX / sesResolution * coordinateScaleToMil',
			coordinateFormulaY: coordinateMode === 'board_calibrated'
				? 'mcpYMil = canvasYMil + boardOffsetMil.y'
				: coordinateMode === 'canvas_to_data'
				? 'mcpYMil = EasyEDA.convertCanvasOriginToDataOrigin(canvasXMil, canvasYMil).y'
				: yAxis === 'invert'
				? 'mcpYMil = -sesY / sesResolution * coordinateScaleToMil'
				: 'mcpYMil = sesY / sesResolution * coordinateScaleToMil',
			coordinateFormula: coordinateMode === 'board_calibrated'
				? 'SES/DSN coordinates are scaled to mil, then shifted by the DSN frame offset measured on this board (boardOffsetMil).'
				: coordinateMode === 'canvas_to_data'
				? 'SES/DSN coordinates are first scaled to canvas mil, then converted to EasyEDA data coordinates using an affine transform derived from convertCanvasOriginToDataOrigin.'
				: yAxis === 'invert'
				? 'x is scaled normally; y is scaled and negated to convert SES/DSN Y-up to EasyEDA signed Y-down'
				: 'x and y are scaled without sign changes',
			widthFormula: 'mcpMil = sesWidth / sesResolution * widthScaleToMil',
			reason: coordinateMode === 'board_calibrated'
				? `EasyEDA's DSN frame starts at the board outline's lower-left corner, not at the canvas origin, so the offset is measured (${boardOffset!.method}, ${boardOffset!.support} matches) instead of assumed.`
				: coordinateMode === 'canvas_to_data'
				? 'No DSN-to-board offset could be measured, so SES coordinates were treated as canvas-origin coordinates and converted with convertCanvasOriginToDataOrigin. This is wrong when the board outline does not start at the canvas origin.'
				: yAxis === 'invert'
				? 'Raw scale_only mode was requested. EasyEDA DSN coordinates are exported in 10 mil numeric units; FreeRouting SES stores those numbers multiplied by SES resolution. Y is flipped because yAxis:"invert" was selected.'
				: 'Y inversion was explicitly disabled by yAxis:"same". Use this only for SES sources already using EasyEDA signed-Y coordinates.',
			sampleCoordinate: firstPoint ? {
				sesX: firstPoint.x,
				sesY: firstPoint.y,
				canvasXMil: toCanvasMil(firstPoint.x),
				canvasYMil: toCanvasMil(firstPoint.y),
				mcpXMil: toDataPoint(firstPoint).x,
				mcpYMil: toDataPoint(firstPoint).y,
			} : null,
			sampleWidth: firstPath ? {
				sesWidth: firstPath.width,
				mcpWidthMil: toWidthMil(firstPath.width),
			} : null,
			sampleViaDiameter: firstVia ? {
				padstack: firstVia.padstack,
				sesDiameter: viaPadstackDiameters.get(firstVia.padstack) ?? null,
				mcpDiameterMil: viaPadstackDiameters.get(firstVia.padstack) != null
					? toCoordMil(viaPadstackDiameters.get(firstVia.padstack)!)
					: Number(options.viaDiameterMil ?? 24),
			} : null,
		},
	};
}

function parseSesViaPadstackDiameters(ses: string): Map<string, number> {
	const out = new Map<string, number>();
	let cursor = 0;
	while (true) {
		const start = findSexprOpen(ses, 'padstack', cursor);
		if (start < 0) break;
		const block = readBalancedBlock(ses, start);
		if (!block) break;
		cursor = block.end;
		const name = readHeadArg(block.block, 'padstack');
		if (!name) continue;
		let maxDiameter = out.get(name) ?? 0;
		let circleCursor = 0;
		while (true) {
			const circleStart = findSexprOpen(block.block, 'circle', circleCursor);
			if (circleStart < 0) break;
			const circleBlock = readBalancedBlock(block.block, circleStart);
			if (!circleBlock) break;
			circleCursor = circleBlock.end;
			const args = readHeadArgs(circleBlock.block, 'circle', 2);
			const diameter = Number(args[1]);
			if (Number.isFinite(diameter) && diameter > maxDiameter) maxDiameter = diameter;
		}
		if (maxDiameter > 0) out.set(name, maxDiameter);
	}
	return out;
}

function dedupeDirectOperations(ops: DirectSesOperation[]): DirectSesOperation[] {
	const seen = new Set<string>();
	const out: DirectSesOperation[] = [];
	for (const op of ops) {
		let key: string;
		if (op.type === 'create_track') {
			const a = `${op.startX},${op.startY}`;
			const b = `${op.endX},${op.endY}`;
			const [p1, p2] = a <= b ? [a, b] : [b, a];
			key = `track|${op.net}|${op.layer}|${p1}|${p2}|${op.lineWidth}`;
		} else {
			key = `via|${op.net}|${op.x},${op.y}|${op.diameter}|${op.holeDiameter}`;
		}
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(op);
	}
	return out;
}

function chunkArray<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

function pickRoutingParams(options: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (options.document != null) out.document = options.document;
	if (options.instance_id != null) out.instance_id = options.instance_id;
	return out;
}

function extractPoint(value: unknown, label: string): Point {
	const candidates = [
		value,
		(value as any)?.data,
		(value as any)?.result,
		(value as any)?.point,
		(value as any)?.coordinate,
		(value as any)?.coordinates,
	];
	for (const candidate of candidates) {
		const x = Number((candidate as any)?.x ?? (candidate as any)?.X);
		const y = Number((candidate as any)?.y ?? (candidate as any)?.Y);
		if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
	}
	throw new Error(`${label} did not return a point with finite x/y: ${JSON.stringify(value)}`);
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

function safeAnalyzeRoutingCompletion(dsn: string, ses: string, javaResult: JavaResult): Record<string, unknown> {
	try {
		return analyzeRoutingCompletion(dsn, ses, javaResult);
	} catch (err: any) {
		return {
			status: 'unknown',
			complete: false,
			error: err instanceof Error ? err.message : String(err),
			note: 'FreeRouting produced a SES file, but routing-completion analysis failed. Use sesFile/manualImport, then run pcb_connectivity_status after import.',
		};
	}
}

interface DsnNetInfo {
	name: string;
	pins: string[];
	pinLocations: PinLocation[];
}

interface SesNetInfo {
	name: string;
	wires: number;
	vias: number;
	paths: SesPath[];
	viaPoints: SesVia[];
}

interface SesPath {
	layer: string | number;
	width: number;
	points: Point[];
	/** (type protect|fix): wiring the DSN already contained. */
	fixed?: boolean;
}

interface SesVia extends Point {
	padstack: string;
	fixed?: boolean;
}

interface Point {
	x: number;
	y: number;
}

interface PinLocation extends Point {
	ref: string;
}

interface NetRouteCompletion {
	net: DsnNetInfo;
	status: 'complete' | 'partial' | 'no_ses_route' | 'unknown_pin_locations';
	routePrimitiveCount: number;
	connectedPinCount: number;
	unconnectedPins: string[];
	unresolvedPins: string[];
}

interface FreeroutingLogSummary {
	lastUnconnectedCount: number | null;
	unconnectedCountSamples: number[];
}

export function analyzeRoutingCompletion(dsn: string, ses: string, javaResult: JavaResult): Record<string, unknown> {
	const dsnNets = parseDsnNets(dsn);
	const requiredNets = dsnNets.filter((net) => net.pins.length > 1);
	const sesRouteNets = parseSesRouteNets(ses);
	const routeByNet = new Map(sesRouteNets.map((net) => [net.name, net]));
	const sesScale = getSesResolutionScale(ses);

	const netCompletions = requiredNets.map((net) => analyzeNetRouteCompletion(net, routeByNet.get(net.name), sesScale));
	const completeNets = netCompletions.filter((net) => net.status === 'complete');
	const partialNets = netCompletions.filter((net) => net.status === 'partial');
	const noSesRoute = netCompletions.filter((net) => net.status === 'no_ses_route');
	const unknownNets = netCompletions.filter((net) => net.status === 'unknown_pin_locations');
	const incompleteNets = [...partialNets, ...noSesRoute];
	const likelyPlaneOrPourNets = incompleteNets.filter((net) => isLikelyPlaneOrPourNet(net.net.name));
	const manualRouteCandidates = incompleteNets.filter((net) => !isLikelyPlaneOrPourNet(net.net.name));
	const logSummary = parseFreeroutingLogSummary(`${javaResult.stdoutTail}\n${javaResult.stderrTail}`);

	let status: 'complete' | 'partial' | 'unknown';
	if (requiredNets.length === 0 || sesRouteNets.length === 0) status = 'unknown';
	else if (incompleteNets.length > 0 || ((logSummary.lastUnconnectedCount ?? 0) > 0)) status = 'partial';
	else if (unknownNets.length > 0) status = 'unknown';
	else status = 'complete';

	const wireCount = sesRouteNets.reduce((sum, net) => sum + net.wires, 0);
	const viaCount = sesRouteNets.reduce((sum, net) => sum + net.vias, 0);

	return {
		status,
		complete: status === 'complete',
		source: 'dsn_pin_graph_vs_ses_route_graph',
		sesResolutionScale: sesScale,
		requiredNetCount: requiredNets.length,
		fullyRoutedNetCount: completeNets.length,
		netsWithSesRoutesCount: requiredNets.length - noSesRoute.length,
		partialNetCount: partialNets.length,
		noSesRouteNetCount: noSesRoute.length,
		unknownPinLocationNetCount: unknownNets.length,
		manualRouteCandidateCount: manualRouteCandidates.length,
		likelyPlaneOrPourNetCount: likelyPlaneOrPourNets.length,
		manualRouteCandidates: manualRouteCandidates.map(summarizeNetCompletion),
		likelyPlaneOrPourNets: likelyPlaneOrPourNets.map(summarizeNetCompletion),
		unroutedNets: incompleteNets.map(summarizeNetCompletion),
		unknownPinLocationNets: unknownNets.map(summarizeNetCompletion),
		sesRouteStats: {
			netCount: sesRouteNets.length,
			wireCount,
			viaCount,
		},
		logSummary,
		note: 'Partial autoroute is usable. Nets listed in manualRouteCandidates are not fully connected by the FreeRouting SES route graph and should be checked/routed manually. likelyPlaneOrPourNets may be intentionally handled by pours or planes.',
	};
}

function summarizeNetCompletion(completion: NetRouteCompletion): Record<string, unknown> {
	const MAX_PINS = 16;
	const net = completion.net;
	return {
		net: net.name,
		status: completion.status,
		pinCount: net.pins.length,
		pins: net.pins.slice(0, MAX_PINS),
		pinsTruncated: net.pins.length > MAX_PINS,
		routePrimitiveCount: completion.routePrimitiveCount,
		connectedPinCount: completion.connectedPinCount,
		unconnectedPins: completion.unconnectedPins.slice(0, MAX_PINS),
		unconnectedPinsTruncated: completion.unconnectedPins.length > MAX_PINS,
		unresolvedPins: completion.unresolvedPins.slice(0, MAX_PINS),
		unresolvedPinsTruncated: completion.unresolvedPins.length > MAX_PINS,
	};
}

function parseDsnNets(dsn: string): DsnNetInfo[] {
	const pinLocationsByRef = parseDsnPinLocations(dsn);
	const networkStart = findSexprOpen(dsn, 'network', 0);
	if (networkStart < 0) return [];
	const network = readBalancedBlock(dsn, networkStart)?.block;
	if (!network) return [];

	const nets: DsnNetInfo[] = [];
	let cursor = 0;
	while (true) {
		const netStart = findSexprOpen(network, 'net', cursor);
		if (netStart < 0) break;
		const netBlock = readBalancedBlock(network, netStart);
		if (!netBlock) break;
		cursor = netBlock.end;

		const name = readHeadArg(netBlock.block, 'net');
		if (!name) continue;
		const pinsStart = findSexprOpen(netBlock.block, 'pins', 0);
		const pinsBlock = pinsStart >= 0 ? readBalancedBlock(netBlock.block, pinsStart)?.block : undefined;
		const pins = pinsBlock ? readHeadArgs(pinsBlock, 'pins') : [];
		const pinLocations = pins
			.map((ref) => {
				const point = pinLocationsByRef.get(ref) ?? pinLocationsByRef.get(ref.toLowerCase());
				return point ? { ref, ...point } : undefined;
			})
			.filter((pin): pin is PinLocation => !!pin);
		nets.push({ name, pins, pinLocations });
	}
	return nets;
}

function parseSesRouteNets(ses: string): SesNetInfo[] {
	const networkStart = findSexprOpen(ses, 'network_out', 0);
	if (networkStart < 0) return [];
	const network = readBalancedBlock(ses, networkStart)?.block;
	if (!network) return [];

	const nets: SesNetInfo[] = [];
	let cursor = 0;
	while (true) {
		const netStart = findSexprOpen(network, 'net', cursor);
		if (netStart < 0) break;
		const netBlock = readBalancedBlock(network, netStart);
		if (!netBlock) break;
		cursor = netBlock.end;

		const name = readHeadArg(netBlock.block, 'net');
		if (!name) continue;
		const paths = parseSesPaths(netBlock.block);
		const viaPoints = parseSesVias(netBlock.block);
		nets.push({
			name,
			wires: countSexpr(netBlock.block, 'wire'),
			vias: countSexpr(netBlock.block, 'via'),
			paths,
			viaPoints,
		});
	}
	return nets;
}

function parseDsnPinLocations(dsn: string): Map<string, Point> {
	const images = parseDsnImages(dsn);
	const placements = parseDsnPlacements(dsn);
	const pins = new Map<string, Point>();

	for (const [componentName, placement] of placements.entries()) {
		const imagePins = images.get(placement.imageName) ?? images.get(placement.imageName.toLowerCase());
		if (!imagePins) continue;
		for (const [pinName, localPoint] of imagePins.entries()) {
			const point = transformDsnPoint(localPoint, placement);
			const ref = `${componentName}-${pinName}`;
			pins.set(ref, point);
			pins.set(ref.toLowerCase(), point);
		}
	}
	return pins;
}

function parseDsnImages(dsn: string): Map<string, Map<string, Point>> {
	const images = new Map<string, Map<string, Point>>();
	let cursor = 0;
	while (true) {
		const imageStart = findSexprOpen(dsn, 'image', cursor);
		if (imageStart < 0) break;
		const imageBlock = readBalancedBlock(dsn, imageStart);
		if (!imageBlock) break;
		cursor = imageBlock.end;

		const imageName = readHeadArg(imageBlock.block, 'image');
		if (!imageName) continue;
		const pinMap = new Map<string, Point>();
		let pinCursor = 0;
		while (true) {
			const pinStart = findSexprOpen(imageBlock.block, 'pin', pinCursor);
			if (pinStart < 0) break;
			const pinBlock = readBalancedBlock(imageBlock.block, pinStart);
			if (!pinBlock) break;
			pinCursor = pinBlock.end;

			const args = readHeadArgs(pinBlock.block, 'pin', 4);
			if (args.length < 4) continue;
			const pinName = args[1];
			const x = Number(args[2]);
			const y = Number(args[3]);
			if (!pinName || !Number.isFinite(x) || !Number.isFinite(y)) continue;
			pinMap.set(pinName, { x, y });
			pinMap.set(pinName.toLowerCase(), { x, y });
		}
		images.set(imageName, pinMap);
		images.set(imageName.toLowerCase(), pinMap);
	}
	return images;
}

function parseDsnPlacements(dsn: string): Map<string, { imageName: string; x: number; y: number; side: string; rotation: number }> {
	const placements = new Map<string, { imageName: string; x: number; y: number; side: string; rotation: number }>();
	const placementStart = findSexprOpen(dsn, 'placement', 0);
	if (placementStart < 0) return placements;
	const placementBlock = readBalancedBlock(dsn, placementStart)?.block;
	if (!placementBlock) return placements;

	let cursor = 0;
	while (true) {
		const componentStart = findSexprOpen(placementBlock, 'component', cursor);
		if (componentStart < 0) break;
		const componentBlock = readBalancedBlock(placementBlock, componentStart);
		if (!componentBlock) break;
		cursor = componentBlock.end;

		const imageName = readHeadArg(componentBlock.block, 'component');
		if (!imageName) continue;
		let placeCursor = 0;
		while (true) {
			const placeStart = findSexprOpen(componentBlock.block, 'place', placeCursor);
			if (placeStart < 0) break;
			const placeBlock = readBalancedBlock(componentBlock.block, placeStart);
			if (!placeBlock) break;
			placeCursor = placeBlock.end;

			const args = readHeadArgs(placeBlock.block, 'place', 5);
			if (args.length < 5) continue;
			const componentName = args[0];
			const x = Number(args[1]);
			const y = Number(args[2]);
			const side = args[3] || 'front';
			const rotation = Number(args[4]);
			if (!componentName || !Number.isFinite(x) || !Number.isFinite(y)) continue;
			const placement = {
				imageName,
				x,
				y,
				side,
				rotation: Number.isFinite(rotation) ? rotation : 0,
			};
			placements.set(componentName, placement);
			placements.set(componentName.toLowerCase(), placement);
		}
	}
	return placements;
}

function transformDsnPoint(
	point: Point,
	placement: { x: number; y: number; side: string; rotation: number },
): Point {
	const mirroredX = placement.side.toLowerCase() === 'back' ? -point.x : point.x;
	const angle = (placement.rotation * Math.PI) / 180;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return {
		x: placement.x + mirroredX * cos - point.y * sin,
		y: placement.y + mirroredX * sin + point.y * cos,
	};
}

// Wiring the DSN already had (EasyEDA exports existing copper as protected)
// comes back in the SES unchanged; it is on the board already.
const FIXED_WIRING_RE = /\(type\s+(?:protect|fix)\s*\)/i;

function parseSesPaths(netBlock: string): SesPath[] {
	const paths: SesPath[] = [];
	let cursor = 0;
	while (true) {
		const pathStart = findSexprOpen(netBlock, 'path', cursor);
		if (pathStart < 0) break;
		const pathBlock = readBalancedBlock(netBlock, pathStart);
		if (!pathBlock) break;
		cursor = pathBlock.end;
		const fixed = FIXED_WIRING_RE.test(enclosingWireTail(netBlock, pathBlock.end));

		const args = readHeadArgs(pathBlock.block, 'path');
		const layerToken = args[0] ?? '1';
		const width = Number(args[1]);
		const points: Point[] = [];
		for (let i = 2; i + 1 < args.length; i += 2) {
			const x = Number(args[i]);
			const y = Number(args[i + 1]);
			if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x: Math.round(x), y: Math.round(y) });
		}
		if (points.length > 0) {
			paths.push({
				layer: /^\d+$/.test(layerToken) ? Number(layerToken) : layerToken,
				width: Number.isFinite(width) && width > 0 ? width : 1000,
				points,
				...(fixed ? { fixed } : {}),
			});
		}
	}
	return paths;
}

/** The rest of the `(wire ...)` that contains the shape ending at `shapeEnd` (where its `(type ...)` lives). */
function enclosingWireTail(text: string, shapeEnd: number): string {
	let depth = 0;
	for (let i = shapeEnd; i < text.length; i++) {
		const c = text[i];
		if (c === '(') depth++;
		else if (c === ')') {
			if (depth === 0) return text.slice(shapeEnd, i);
			depth--;
		}
	}
	return text.slice(shapeEnd);
}

function parseSesVias(netBlock: string): SesVia[] {
	const vias: SesVia[] = [];
	let cursor = 0;
	while (true) {
		const viaStart = findSexprOpen(netBlock, 'via', cursor);
		if (viaStart < 0) break;
		const viaBlock = readBalancedBlock(netBlock, viaStart);
		if (!viaBlock) break;
		cursor = viaBlock.end;

		const args = readHeadArgs(viaBlock.block, 'via', 3);
		if (args.length < 3) continue;
		const padstack = args[0] || 'via0';
		const x = Number(args[1]);
		const y = Number(args[2]);
		const fixed = FIXED_WIRING_RE.test(viaBlock.block);
		if (Number.isFinite(x) && Number.isFinite(y)) vias.push({ padstack, x: Math.round(x), y: Math.round(y), ...(fixed ? { fixed } : {}) });
	}
	return vias;
}

function analyzeNetRouteCompletion(net: DsnNetInfo, route: SesNetInfo | undefined, scale: number): NetRouteCompletion {
	const routePrimitiveCount = route ? route.wires + route.vias : 0;
	if (!route || routePrimitiveCount === 0) {
		return {
			net,
			status: 'no_ses_route',
			routePrimitiveCount: 0,
			connectedPinCount: 0,
			unconnectedPins: net.pins,
			unresolvedPins: net.pins.filter((pin) => !net.pinLocations.some((loc) => loc.ref === pin)),
		};
	}

	if (net.pinLocations.length === 0) {
		return {
			net,
			status: 'unknown_pin_locations',
			routePrimitiveCount,
			connectedPinCount: 0,
			unconnectedPins: [],
			unresolvedPins: net.pins,
		};
	}

	const dsu = new DisjointSet();
	const nodeKeys = new Set<string>();
	const addPoint = (point: Point): string => {
		const key = pointKey(point);
		nodeKeys.add(key);
		dsu.add(key);
		return key;
	};

	for (const path of route.paths) {
		let prev: string | null = null;
		for (const point of path.points) {
			const key = addPoint(point);
			if (prev) dsu.union(prev, key);
			prev = key;
		}
	}
	for (const point of route.viaPoints) addPoint(point);

	const nodeList = Array.from(nodeKeys).map((key) => ({ key, point: pointFromKey(key) }));
	const tolerance = Math.max(250, scale * 0.25);
	const pinRoots: Array<{ ref: string; root: string }> = [];
	const unconnectedPins: string[] = [];
	const unresolvedPins: string[] = [];

	for (const ref of net.pins) {
		const loc = net.pinLocations.find((pin) => pin.ref === ref);
		if (!loc) {
			unresolvedPins.push(ref);
			continue;
		}
		const scaled = { x: Math.round(loc.x * scale), y: Math.round(loc.y * scale) };
		const node = findNearbyNode(scaled, nodeList, tolerance);
		if (!node) {
			unconnectedPins.push(ref);
			continue;
		}
		pinRoots.push({ ref, root: dsu.find(node.key) });
	}

	if (pinRoots.length === 0) {
		return {
			net,
			status: unresolvedPins.length > 0 ? 'unknown_pin_locations' : 'partial',
			routePrimitiveCount,
			connectedPinCount: 0,
			unconnectedPins: [...unconnectedPins, ...net.pins.filter((pin) => !unconnectedPins.includes(pin) && !unresolvedPins.includes(pin))],
			unresolvedPins,
		};
	}

	const rootCounts = new Map<string, number>();
	for (const pin of pinRoots) rootCounts.set(pin.root, (rootCounts.get(pin.root) ?? 0) + 1);
	const largestRoot = Array.from(rootCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
	const splitPins = largestRoot ? pinRoots.filter((pin) => pin.root !== largestRoot).map((pin) => pin.ref) : [];
	const allUnconnected = [...unconnectedPins, ...splitPins];
	const status = allUnconnected.length === 0 && unresolvedPins.length === 0 && rootCounts.size === 1
		? 'complete'
		: 'partial';

	return {
		net,
		status,
		routePrimitiveCount,
		connectedPinCount: status === 'complete' ? net.pins.length : Math.max(0, net.pins.length - allUnconnected.length - unresolvedPins.length),
		unconnectedPins: allUnconnected,
		unresolvedPins,
	};
}

function getSesResolutionScale(ses: string): number {
	const m = ses.match(/\(resolution\s+mil\s+(\d+(?:\.\d+)?)\)/i);
	const scale = m ? Number(m[1]) : 1000;
	return Number.isFinite(scale) && scale > 0 ? scale : 1000;
}

function parseFreeroutingLogSummary(log: string): FreeroutingLogSummary {
	const counts: number[] = [];
	const patterns = [
		/(?:incomplete|unconnected|unrouted|not\s+routed|remaining)\s+(?:connections?|routes?|traces?|nets?)?\D{0,40}(\d+)/gi,
		/(\d+)\s+(?:incomplete|unconnected|unrouted|not\s+routed|remaining)\s+(?:connections?|routes?|traces?|nets?)/gi,
	];
	for (const pattern of patterns) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(log)) !== null) {
			const n = Number(match[1]);
			if (Number.isFinite(n) && n >= 0) counts.push(n);
		}
	}
	return {
		lastUnconnectedCount: counts.length ? counts[counts.length - 1] : null,
		unconnectedCountSamples: counts.slice(-8),
	};
}

function isLikelyPlaneOrPourNet(net: string): boolean {
	const n = net.trim().toUpperCase();
	return n.includes('GND')
		|| n.startsWith('+')
		|| n.startsWith('-')
		|| /^(VCC|VDD|VSS|VBAT|VBUS|VBUSB|VIN|VOUT|PWR|POWER|AVDD|DVDD|PVDD|AGND|DGND|PGND)\b/.test(n);
}

function findSexprOpen(text: string, keyword: string, from: number): number {
	let cursor = from;
	const needle = `(${keyword}`;
	while (true) {
		const idx = text.indexOf(needle, cursor);
		if (idx < 0) return -1;
		const next = text[idx + needle.length];
		if (next === undefined || /\s|\)/.test(next)) return idx;
		cursor = idx + 1;
	}
}

function readBalancedBlock(text: string, start: number): { block: string; end: number } | null {
	if (text[start] !== '(') return null;
	let depth = 0;
	let quote: string | null = null;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === '\\') {
				i += 1;
			} else if (c === quote) {
				quote = null;
			}
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
		} else if (c === '(') {
			depth += 1;
		} else if (c === ')') {
			depth -= 1;
			if (depth === 0) return { block: text.slice(start, i + 1), end: i + 1 };
		}
	}
	return null;
}

function readHeadArg(block: string, head: string): string | null {
	const args = readHeadArgs(block, head, 1);
	return args[0] ?? null;
}

function readHeadArgs(block: string, head: string, limit = Number.POSITIVE_INFINITY): string[] {
	let cursor = 1 + head.length;
	const args: string[] = [];
	while (cursor < block.length - 1 && args.length < limit) {
		const atom = readAtom(block, cursor);
		if (!atom) break;
		args.push(atom.value);
		cursor = atom.end;
	}
	return args;
}

function readAtom(text: string, from: number): { value: string; end: number } | null {
	let cursor = from;
	while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
	if (cursor >= text.length || text[cursor] === ')' || text[cursor] === '(') return null;

	const quote = text[cursor];
	if (quote === '"' || quote === "'") {
		let out = '';
		cursor += 1;
		while (cursor < text.length) {
			const c = text[cursor];
			if (c === '\\' && cursor + 1 < text.length) {
				out += text[cursor + 1];
				cursor += 2;
			} else if (c === quote) {
				return { value: out, end: cursor + 1 };
			} else {
				out += c;
				cursor += 1;
			}
		}
		return { value: out, end: cursor };
	}

	const start = cursor;
	while (cursor < text.length && !/[\s()]/.test(text[cursor])) cursor += 1;
	return { value: text.slice(start, cursor), end: cursor };
}

function countSexpr(text: string, keyword: string): number {
	let count = 0;
	let cursor = 0;
	while (true) {
		const idx = findSexprOpen(text, keyword, cursor);
		if (idx < 0) return count;
		count += 1;
		cursor = idx + 1;
	}
}

function pointKey(point: Point): string {
	return `${Math.round(point.x)},${Math.round(point.y)}`;
}

function pointFromKey(key: string): Point {
	const [x, y] = key.split(',').map(Number);
	return { x, y };
}

function findNearbyNode(point: Point, nodes: Array<{ key: string; point: Point }>, tolerance: number): { key: string; point: Point } | null {
	const exact = pointKey(point);
	const exactNode = nodes.find((node) => node.key === exact);
	if (exactNode) return exactNode;

	const maxDist2 = tolerance * tolerance;
	let best: { key: string; point: Point; dist2: number } | null = null;
	for (const node of nodes) {
		const dx = node.point.x - point.x;
		const dy = node.point.y - point.y;
		const dist2 = dx * dx + dy * dy;
		if (dist2 <= maxDist2 && (!best || dist2 < best.dist2)) {
			best = { ...node, dist2 };
		}
	}
	return best ? { key: best.key, point: best.point } : null;
}

class DisjointSet {
	private parent = new Map<string, string>();

	add(key: string): void {
		if (!this.parent.has(key)) this.parent.set(key, key);
	}

	find(key: string): string {
		const parent = this.parent.get(key);
		if (!parent) {
			this.parent.set(key, key);
			return key;
		}
		if (parent === key) return key;
		const root = this.find(parent);
		this.parent.set(key, root);
		return root;
	}

	union(a: string, b: string): void {
		const rootA = this.find(a);
		const rootB = this.find(b);
		if (rootA !== rootB) this.parent.set(rootB, rootA);
	}
}

interface JavaResult {
	code: number;
	stdoutTail: string;
	stderrTail: string;
}

function runJava(javaBin: string, args: string[], timeoutMs: number): Promise<JavaResult> {
	return new Promise((resolveProm, rejectProm) => {
		const proc = spawn(javaBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		const TAIL = 4000;

		const killer = setTimeout(() => {
			try { proc.kill('SIGKILL'); } catch {/* */}
			rejectProm(new Error(`FreeRouting timed out after ${timeoutMs}ms — increase timeoutSeconds.`));
		}, timeoutMs);

		proc.stdout.on('data', (d) => {
			stdout += d.toString();
			if (stdout.length > TAIL * 2) stdout = stdout.slice(-TAIL);
		});
		proc.stderr.on('data', (d) => {
			stderr += d.toString();
			if (stderr.length > TAIL * 2) stderr = stderr.slice(-TAIL);
		});
		proc.on('error', (err) => {
			clearTimeout(killer);
			rejectProm(new Error(`Failed to spawn Java (${javaBin}): ${err.message}. Is Java installed and on PATH?`));
		});
		proc.on('close', (code) => {
			clearTimeout(killer);
			resolveProm({
				code: code ?? -1,
				stdoutTail: stdout.slice(-TAIL),
				stderrTail: stderr.slice(-TAIL),
			});
		});
	});
}

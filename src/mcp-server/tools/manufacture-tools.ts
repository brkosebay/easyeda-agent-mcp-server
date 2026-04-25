import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { spawn } from 'child_process';
import { mkdtemp, writeFile, readFile, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { WebSocketBridge } from '../bridge';
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
		`Export the PCB design in various formats. Returns { fileName, data (Base64), size }.
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
			fileType: z
				.string()
				.optional()
				.describe('Sub-format (e.g. "xlsx"/"csv" for bom, "step"/"obj" for 3d)'),
		}),
		async ({ format, ...rest }) => {
			const result = await bridge.send(EXPORT_HANDLER_MAP[format], rest);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_autoroute',
		`EasyEDA has no built-in autorouter API; this tool runs external FreeRouting. Pipeline: DSN export → java -jar freerouting.jar → SES import → canvas refresh → DRC summary. Requires Java 11+ and a FreeRouting jar at vendor/freerouting.jar (or FREEROUTING_JAR env). Download the latest jar from https://github.com/freerouting/freerouting/releases. Returns sizes, paths, and a DRC summary so you can verify the routing immediately.`,
		withDocumentParam({
			passes: z.number().int().positive().optional().default(100).describe('Max optimization passes'),
			timeoutSeconds: z.number().int().positive().optional().default(600).describe('Java process timeout (s)'),
		}),
		async ({ passes, timeoutSeconds, ...rest }) => {
			const result = await runAutoroute(bridge, { passes: passes ?? 100, timeoutSeconds: timeoutSeconds ?? 600 }, rest);
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
		}),
		async ({ format, ...rest }) => {
			const result = await bridge.send(IMPORT_HANDLER_MAP[format], rest);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);
}

interface AutorouteOptions {
	passes: number;
	timeoutSeconds: number;
}

async function runAutoroute(
	bridge: WebSocketBridge,
	opts: AutorouteOptions,
	routingParams: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const javaBin = process.env.JAVA_BIN || 'java';
	const jarPath = process.env.FREEROUTING_JAR || resolve(process.cwd(), 'vendor/freerouting.jar');

	try {
		await access(jarPath);
	} catch {
		throw new Error(
			`FreeRouting jar not found at ${jarPath}. Download a release from ` +
			`https://github.com/freerouting/freerouting/releases and either drop it at ` +
			`vendor/freerouting.jar or set FREEROUTING_JAR to its absolute path.`,
		);
	}

	// Bridge timeout for DSN/SES round-trips on non-trivial boards. Big designs
	// take 30-60s to serialize; the default 45s would 50/50 cut it.
	const bridgeTimeoutMs = 5 * 60_000;

	// 1. Export DSN from EasyEDA.
	const dsnResult = (await bridge.send('pcb.manufacture.getDsnFile', {
		...routingParams,
		fileName: 'autoroute',
		_timeoutMs: bridgeTimeoutMs,
	})) as { fileName: string; data: string; size: number };

	if (!dsnResult?.data) throw new Error('DSN export returned no data — is a PCB document open?');

	const dir = await mkdtemp(join(tmpdir(), 'easyeda-autoroute-'));
	const dsnFile = join(dir, dsnResult.fileName || 'autoroute.dsn');
	const sesFile = dsnFile.replace(/\.dsn$/i, '.ses');
	await writeFile(dsnFile, Buffer.from(dsnResult.data, 'base64'));

	// 2. Run FreeRouting headless. Minimal flag set — `-de`/`-do`/`-mp` are
	// stable across FreeRouting 1.x and 2.x. Earlier versions of this tool
	// passed `-us global` which isn't a documented flag and could be ignored
	// or misinterpreted depending on FreeRouting version.
	const args = [
		'-jar', jarPath,
		'-de', dsnFile,
		'-do', sesFile,
		'-mp', String(opts.passes),
	];
	const javaResult = await runJava(javaBin, args, opts.timeoutSeconds * 1000);

	// 3. Validate FreeRouting actually produced output before importing.
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

	// 4. Import the SES result.
	await bridge.send('pcb.manufacture.importAutoRouteSes', {
		...routingParams,
		fileName: dsnResult.fileName?.replace(/\.dsn$/i, '.ses') || 'autoroute.ses',
		data: sesBytes.toString('base64'),
		_timeoutMs: bridgeTimeoutMs,
	});

	// 5. Force the canvas to redraw, then run DRC for a quick sanity report.
	await bridge.send('pcb.document.refresh', { ...routingParams, zoom: false }).catch(() => {/* non-fatal */});

	let drcSummary: any = null;
	try {
		drcSummary = await bridge.send('pcb.drc.summarize', {
			...routingParams,
			groupBy: 'category',
			top: 10,
			_timeoutMs: bridgeTimeoutMs,
		});
	} catch {
		/* DRC is best-effort */
	}

	return {
		dsnSize: dsnResult.size,
		sesSize: sesBytes.length,
		javaExitCode: javaResult.code,
		passes: opts.passes,
		stdoutTail: javaResult.stdoutTail,
		stderrTail: javaResult.stderrTail,
		dsnFile,
		sesFile,
		drcSummary,
	};
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

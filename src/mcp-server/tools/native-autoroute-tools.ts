// EasyEDA's own PCB autorouter / autolayout (EasyEDA Pro 3.2.150+), driven
// fire-and-verify by src/extension/handlers/native-autoroute.ts. An optional
// fallback behind the model-planned routing path (pcb_route_path), never a
// replacement: the result is measured, not trusted.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam, withInstanceParam } from './query-params';

const SYNC_DEFAULT_TOTAL_MS = 100_000;
const SYNC_MAX_TOTAL_MS = 280_000;
const CALL_MARGIN_MS = 20_000;
// Probe, baselines and the before-connectivity run inside the call even in
// background mode.
const BACKGROUND_CALL_MS = 90_000;

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

function callTimeout(params: { background?: boolean; totalTimeoutMs?: number; _timeoutMs?: number }): number {
	if (params._timeoutMs) return params._timeoutMs;
	if (params.background) return BACKGROUND_CALL_MS;
	return Math.min(params.totalTimeoutMs ?? SYNC_DEFAULT_TOTAL_MS, SYNC_MAX_TOTAL_MS) + CALL_MARGIN_MS;
}

const jobArgs = {
	background: z.boolean().optional().describe('Return a jobId right after dispatch; poll pcb_native_auto_job_status. Recommended: the router can run for minutes.'),
	totalTimeoutMs: z.number().int().min(10_000).max(1_800_000).optional().describe('Observation window. Default: 100 s synchronous (max 280 s), 600 s background (max 1800 s).'),
	quietMs: z.number().int().min(2_000).max(300_000).optional().describe('Board changed, then unchanged this long with the promise unsettled ⇒ status "quiet" (default 20000)'),
	pollMs: z.number().int().min(250).max(10_000).optional().describe('Board poll interval (default 1000 route / 1500 layout)'),
	drc: z.boolean().optional().describe('Run DRC once after the job (default true)'),
	pauseRatline: z.boolean().optional().describe('Stop the ratsnest calculation during the run and restore it after (default false; experimental A/B)'),
};

const safety = 'Beta EasyEDA API, untested beyond this harness: run it on a SCRATCH COPY of the board, never on a board you care about. Saves nothing; undo with editor_undo or close without saving.';

export function registerNativeAutorouteTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'pcb_native_autoroute',
		`Run EasyEDA's own autorouter (eda.pcb_Document.autoRouting, EasyEDA Pro 3.2.150+, beta) on the active PCB and measure what it did. Fallback only: plan routes yourself with pcb_route_path first.
Fire-and-verify: the call is dispatched and never awaited. Completion comes from polling the board's line/via/arc ids: status completed (promise settled with a report, or after copper changed) | quiet (copper changed then stopped changing; promise still pending or only an ack) | no-change | deadline | sdk-unresponsive | failed | document-changed | unsupported (pre-3.2.150 host). Before/after: copper counts, per-net connectivity from the real copper graph (routedNets, newlyConnected, regressed, stillOpen), DRC summary, plus the promise's raw settled value and settle time.
nets omitted = every unrouted net. ripUpExisting:true deletes ALL existing tracks and vias first. ${safety}`,
		withDocumentParam({
			nets: z.array(z.string()).optional().describe('Nets to route (default: all unrouted nets)'),
			ignoreNets: z.array(z.string()).optional().describe('Nets the router must not touch (e.g. GND left for a pour)'),
			layers: z.array(z.union([z.string(), z.number()])).optional().describe('Copper layers the router may use (default: all enabled signal/plane layers)'),
			corner: z.enum(['45', '90']).optional().describe('Corner style (default 45)'),
			optimization: z.enum(['completion', 'faster']).optional().describe('Prioritize completion rate (default) or speed'),
			ripUpExisting: z.boolean().optional().describe('Remove ALL existing tracks/vias before routing (default false = keep and route around them)'),
			verify: z.boolean().optional().describe('Connectivity analysis before and after (default true)'),
			...jobArgs,
		}),
		async (params) => text(await bridge.send('pcb.native.autoroute', { ...params, _timeoutMs: callTimeout(params) })),
	);

	server.tool(
		'pcb_native_autolayout',
		`Run EasyEDA's own auto-placement (eda.pcb_Document.autoLayout, EasyEDA Pro 3.2.150+, alpha) on the active PCB. It rearranges the WHOLE board: every unlocked component may move. Fire-and-verify like pcb_native_autoroute; completion from polling component positions; reports moved/total with a sample, the promise's raw value, DRC after. ${safety}`,
		withDocumentParam({ ...jobArgs }),
		async (params) => text(await bridge.send('pcb.native.autolayout', { ...params, _timeoutMs: callTimeout(params) })),
	);

	server.tool(
		'pcb_native_auto_job_status',
		'Status of a pcb_native_autoroute / pcb_native_autolayout job (jobId optional → last job), from the extension\'s in-memory record: answers without the operation queue, even while EasyEDA is busy. The promise fields keep updating after the job ends (settledAfterJobFinished:true = it settled late). refresh:true adds one 4 s board read and reports changes since observation ended.',
		withInstanceParam({
			jobId: z.string().optional(),
			refresh: z.boolean().optional().describe('Re-read the board once (bounded) and report changes since the job finished'),
		}),
		async (params) => text(await bridge.send('pcb.native.autoJobStatus', { ...params, _timeoutMs: 15_000 })),
	);
}

// Verification bundle tool — wraps src/mcp-server/bundle/builder.ts as an MCP tool.
//
// Output: a single .zip with schematic snapshot, BOM (json/csv/md), PCB exports
// (gerber/pdf/netlist/bom/pnp), cached datasheets, and a top-level README.md
// designed as the LLM verifier's entry point. See bundle/readme.ts for format.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';
import { buildVerificationBundle } from '../bundle/builder';

const DEFAULT_BUNDLE_DIR = join(homedir(), '.easyeda-mcp', 'bundles');

function defaultBundleName(): string {
	const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	return `verification-bundle-${ts}.zip`;
}

export function registerBundleTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'project_export_verification_bundle',
		'Export the current project as a single ZIP designed for an external "verifier LLM" that has no tool calls. Includes: schematic snapshot (raw JSON), BOM in three formats (json/csv/md), PCB manufacturing exports (gerber, pdf, netlist, bom, pick_and_place, optional 3d), all cached datasheets indexed by MPN, and a top-level README.md that orients the verifier with a recommended audit checklist. Optionally fetches missing datasheets from LCSC during bundling.',
		withDocumentParam({
			outputPath: z.string().optional().describe('Absolute path for the output .zip. Defaults to ~/.easyeda-mcp/bundles/verification-bundle-{ISO}.zip'),
			pcbDocument: z.string().optional().describe('PCB document UUID. If omitted, the bundle auto-discovers the PCB tab in the same EasyEDA instance.'),
			pcbFormats: z
				.array(z.enum(['gerber', 'pdf', 'netlist', 'bom', 'pick_and_place', '3d']))
				.optional()
				.describe('Which PCB exports to include. Default: gerber, pdf, netlist, bom, pick_and_place. Add "3d" for STEP — adds tens of MB.'),
			autoFetchDatasheets: z.boolean().optional().default(false).describe('Auto-fetch missing datasheets via LCSC during bundling. Bounded by maxDatasheetFetches.'),
			maxDatasheetFetches: z.number().int().min(0).max(200).optional().default(25),
			allPages: z.boolean().optional().default(true).describe('Include all schematic pages in the snapshot'),
		}),
		async ({ outputPath, pcbDocument, pcbFormats, autoFetchDatasheets, maxDatasheetFetches, allPages, ...rest }) => {
			let outPath = outputPath;
			if (!outPath) {
				if (!existsSync(DEFAULT_BUNDLE_DIR)) {
					await mkdir(DEFAULT_BUNDLE_DIR, { recursive: true });
				}
				outPath = join(DEFAULT_BUNDLE_DIR, defaultBundleName());
			}
			outPath = resolve(outPath);

			// withDocumentParam injects `document` and `instance_id` into the
			// destructured args. The builder takes them as documentUuid / instanceId.
			const documentUuid = (rest as any).document as string | undefined;
			const instanceId = (rest as any).instance_id as string | undefined;

			const result = await buildVerificationBundle(bridge, {
				outputPath: outPath,
				documentUuid,
				pcbDocumentUuid: pcbDocument,
				instanceId,
				pcbFormats,
				autoFetchDatasheets,
				maxDatasheetFetches,
				allPages,
			});

			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						zipPath: result.zipPath,
						bytes: result.bytes,
						bundleRootName: result.bundleRootName,
						fileCount: result.manifest.length,
						notes: result.notes,
						manifestPreview: result.manifest
							.slice(0, 25)
							.map((m) => ({ path: m.path, bytes: m.bytes, contentType: m.contentType })),
						readmePath: 'README.md (inside the zip — read this first if you\'re the verifier LLM)',
					}),
				}],
			};
		},
	);
}

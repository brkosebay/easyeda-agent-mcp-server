import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withInstanceParam } from './query-params';

export function registerLibTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'lib_search_device',
		'Search the component library for devices by keyword. Returns a list of matching components with their UUIDs, names, descriptions, and package info.',
		withInstanceParam({
			key: z.string().describe('Search keyword (e.g. "2.2k resistor", "STM32F103", "0805 capacitor")'),
			libraryUuid: z.string().optional().describe('Library UUID to search in (omit to search all libraries)'),
			itemsOfPage: z.number().optional().describe('Number of results per page (default varies)'),
			page: z.number().optional().describe('Page number (0-based)'),
		}),
		async (params) => {
			const result = await bridge.send('lib.device.search', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'lib_get_device',
		'Get detailed information about a specific device by its UUID, including symbol, footprint, and all properties',
		withInstanceParam({
			deviceUuid: z.string().describe('The device UUID'),
			libraryUuid: z.string().optional().describe('Library UUID (omit to search all libraries)'),
		}),
		async ({ deviceUuid, libraryUuid, instance_id }) => {
			const result = await bridge.send('lib.device.get', { deviceUuid, libraryUuid, instance_id });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'lib_get_device_by_lcsc',
		'Get device(s) by LCSC C-number(s). Useful for finding specific components like "C17414" for a 2.2k resistor.',
		withInstanceParam({
			lcscIds: z
				.union([z.string(), z.array(z.string())])
				.describe('Single LCSC ID (e.g. "C17414") or array of LCSC IDs'),
			libraryUuid: z.string().optional().describe('Library UUID (omit to search all libraries)'),
		}),
		async ({ lcscIds, libraryUuid, instance_id }) => {
			const result = await bridge.send('lib.device.getByLcscIds', { lcscIds, libraryUuid, instance_id });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'lib_get_system_library_uuid',
		'Get the UUID of the system (built-in) component library',
		withInstanceParam({}),
		async ({ instance_id }) => {
			const result = await bridge.send('lib.getSystemLibraryUuid', { instance_id });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'lib_get_all_libraries',
		'Get a list of all available component libraries with their UUIDs and names',
		withInstanceParam({}),
		async ({ instance_id }) => {
			const result = await bridge.send('lib.getAllLibraries', { instance_id });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);
}

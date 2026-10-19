import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

async function main() {
	const defaultPath = '/Users/test/.easyeda-mcp/token';
	const token = 'ab'.repeat(32);
	const config = new Map<string, string>();
	let contents = token;
	let saveSucceeds = true;
	let reconnects = 0;
	let opened: unknown[] = [];
	const host: any = {
		sys_Storage: {
			getExtensionUserConfig: (key: string) => config.get(key),
			setExtensionUserConfig: async (key: string, value: string) => {
				if (saveSucceeds) config.set(key, value);
				return saveSucceeds;
			},
		},
		sys_FileSystem: { readFileFromFileSystem: async () => new Blob([contents]) },
		// Reproduce the installed host: input dialog does nothing; iframe works
		// but returns undefined rather than the documented boolean.
		sys_Dialog: { showInputDialog: () => { throw new Error('Unsupported input dialog was called'); } },
		sys_IFrame: { openIFrame: async (...args: unknown[]) => { opened = args; } },
	};
	const result = await build({ entryPoints: ['src/extension/native-settings.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', define: { __NATIVE_DAEMON_TOKEN_PATH__: JSON.stringify(defaultPath) } });
	const module = { exports: {} as any };
	runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, eda: host, Blob, TextEncoder, setTimeout, clearTimeout, btoa });
	await module.exports.openNativeBridgeSettings(() => { reconnects++; });
	assert.equal(opened[0], 'pages/native-settings.html');
	const bridge = host.__easyedaNativeBridgeSettings;
	assert.equal(bridge.getPath(), defaultPath);
	await bridge.savePath('  /custom/token  ');
	assert.equal(bridge.getPath(), '/custom/token');
	assert.equal(reconnects, 1);
	await assert.rejects(bridge.savePath(''), /absolute path/);
	await assert.rejects(bridge.savePath('~/.easyeda-mcp/token'), /not absolute/);
	contents = 'invalid';
	await assert.rejects(bridge.savePath('/bad/token'), /64-hex/);
	contents = token;
	saveSucceeds = false;
	await assert.rejects(bridge.savePath('/unsaved/token'), /could not be saved/);
	assert.equal(config.get('nativeDaemonCredentialPath'), '/custom/token');
	assert.equal(reconnects, 1, 'Invalid files or failed storage must not reconnect');
	saveSucceeds = true;
	// Exercise the actual packaged form against the injected shared eda object.
	const elements: any = { path: {}, status: {}, save: {}, settings: {} };
	let submit: any;
	const document = {
		getElementById: (id: string) => elements[id],
		addEventListener: (_: string, callback: () => void) => callback(),
	};
	elements.settings.addEventListener = (_: string, callback: unknown) => { submit = callback; };
	const script = readFileSync('pages/native-settings.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1];
	runInNewContext(script, { document, window: { eda: host }, Error });
	assert.equal(elements.path.value, '/custom/token');
	elements.path.value = '/form/token';
	await submit({ preventDefault() {} });
	assert.equal(config.get('nativeDaemonCredentialPath'), '/form/token');
	assert.match(elements.status.textContent, /Saved/);
	contents = 'invalid';
	await submit({ preventDefault() {} });
	assert.match(elements.status.textContent, /64-hex/);
	assert.equal(elements.save.disabled, false);
	console.log('Native bridge settings: default, override, validation, storage failure and packaged form passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

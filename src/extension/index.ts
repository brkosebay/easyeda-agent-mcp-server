import * as extensionConfig from '../../extension.json';
import { connectToMcpServers, disconnectFromAllMcpServers, getConnectedPortCount, getConnectedServers, getInstanceId, startLiveMode, stopLiveMode, isLiveModeActive } from './ws-client';

const AUTO_CONNECT_KEY = 'autoConnect';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {
	try {
		const autoConnect = eda.sys_Storage.getExtensionUserConfig(AUTO_CONNECT_KEY);
		if (autoConnect) {
			startLiveMode(extensionConfig.uuid);
			connectToMcpServers(extensionConfig.uuid);
		}
	} catch {
		// Storage API unavailable or failed — skip auto-connect
	}
}

export function connectClaude(): void {
	const wasLive = isLiveModeActive();

	if (!wasLive) {
		startLiveMode(extensionConfig.uuid);
		eda.sys_Storage.setExtensionUserConfig(AUTO_CONNECT_KEY, true).catch(() => {});
		eda.sys_Message.showToastMessage(
			'Live mode enabled — scanning for Claude agents...',
			ESYS_ToastMessageType.SUCCESS,
			5,
		);
	} else {
		const alreadyConnected = getConnectedPortCount();
		eda.sys_Message.showToastMessage(
			alreadyConnected > 0
				? `Rescanning... (${alreadyConnected} already connected)`
				: 'Rescanning for Claude agents...',
			ESYS_ToastMessageType.INFO,
			3,
		);
	}

	try {
		connectToMcpServers(extensionConfig.uuid);
	} catch (err: any) {
		eda.sys_Dialog.showInformationMessage(
			`Failed to connect: ${err instanceof Error ? err.message : String(err)}\n\nMake sure Claude Code is running with the easyeda-agent MCP server configured.`,
			'Connection Error',
		);
	}
}

export function disconnectClaude(): void {
	const count = getConnectedPortCount();
	const wasLive = isLiveModeActive();
	stopLiveMode();
	eda.sys_Storage.deleteExtensionUserConfig(AUTO_CONNECT_KEY).catch(() => {});
	disconnectFromAllMcpServers(extensionConfig.uuid);

	if (count === 0 && !wasLive) {
		eda.sys_Message.showToastMessage('Not connected to any Claude MCP Servers', ESYS_ToastMessageType.WARNING, 3);
		return;
	}
	eda.sys_Message.showToastMessage(
		`Live mode disabled — disconnected from ${count} server${count === 1 ? '' : 's'}`,
		ESYS_ToastMessageType.INFO,
		3,
	);
}

export async function about(): Promise<void> {
	// Get current theme so the dialog can match
	let theme = 'light';
	try {
		theme = await eda.sys_System.getCurrentTheme();
	} catch {
		// Default to light if API unavailable
	}

	// Set data on globalThis for the iframe to read
	(globalThis as any).__claude_about_data__ = {
		instanceId: getInstanceId(),
		version: extensionConfig.version,
		connectedPorts: getConnectedPortCount(),
		connectedServers: getConnectedServers(),
		theme,
	};

	// Taller iframe so the connected-agents list has room to breathe.
	eda.sys_IFrame.openIFrame('pages/about.html', 420, 520, 'claude-about', {
		title: 'About EasyEDA Agent',
		grayscaleMask: true,
	});
}

import { openNativeBridgeSettings } from './native-settings';
import * as extensionConfig from '../../extension.json';
import { connectToMcpServers, disconnectFromAllMcpServers, getConnectedPortCount, getConnectedServers, getInstanceId, startLiveMode, stopLiveMode, isLiveModeActive, reconnectAll } from './ws-client';

const AUTO_CONNECT_KEY = 'autoConnect';

function autoConnectIfEnabled(): void {
	try {
		const autoConnect = eda.sys_Storage.getExtensionUserConfig(AUTO_CONNECT_KEY);
		if (autoConnect && !isLiveModeActive()) {
			startLiveMode(extensionConfig.uuid);
			connectToMcpServers(extensionConfig.uuid);
		}
	} catch {
		// Storage API unavailable or failed — skip auto-connect
	}
}

// EasyEDA calls activate() at startup and when the extension is (re-)enabled
// in the Extension Manager — but only while an EasyEDA account is logged in;
// otherwise nothing runs until the first Claude menu action.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {
	try {
		if (wasLiveAtLoad && eda.sys_Storage.getExtensionUserConfig(AUTO_CONNECT_KEY)) {
			// Re-enabled while live state survived on globalThis: the old
			// sockets may still be bound to a stuck queue. Take over with fresh
			// connections so the daemon sees a new extension connection.
			reconnectAll(extensionConfig.uuid, { resetQueue: true });
			return;
		}
	} catch {
		// Storage API unavailable — fall through to the normal path
	}
	autoConnectIfEnabled();
}

// Live state lives on globalThis and survives disable/re-enable; remember
// whether it predates this evaluation so activate() can tell a re-enable
// (take over the old sockets) from a fresh start.
const wasLiveAtLoad = isLiveModeActive();

// Whenever the host evaluates this bundle (startup activation, or the first
// menu action after an EasyEDA restart) resume live mode if the user had it
// on. Guarded so repeated menu evaluations do not restart timers.
autoConnectIfEnabled();

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
		// Already live: the user is clicking Connect because something looks
		// wrong (stale socket, wedged queue). Do a hard reconnect — fresh
		// sockets the daemon can't mistake for the old ones, and release any
		// request queue held by a hung EasyEDA call.
		const { closed } = reconnectAll(extensionConfig.uuid, { resetQueue: true });
		eda.sys_Message.showToastMessage(
			closed > 0
				? `Resetting bridge — reconnecting ${closed} connection${closed === 1 ? '' : 's'}...`
				: 'Rescanning for Claude agents...',
			ESYS_ToastMessageType.INFO,
			3,
		);
		return;
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

function showError(title: string, err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	try { eda.sys_Log.add(`EasyEDA Agent: ${title}: ${message}`, ESYS_LogType.ERROR); } catch {/* */}
	try {
		eda.sys_Dialog.showInformationMessage(message, title);
	} catch {
		try { eda.sys_Message.showToastMessage(`${title}: ${message}`, ESYS_ToastMessageType.ERROR, 8); } catch {/* */}
	}
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), ms);
		Promise.resolve(promise).then(
			(value) => { clearTimeout(timer); resolve(value); },
			() => { clearTimeout(timer); resolve(undefined); },
		);
	});
}

export async function about(): Promise<void> {
	try {
		// Bounded: a theme RPC that never answers must not swallow the click.
		const theme = (await within(eda.sys_Window.getCurrentTheme(), 1_500)) ?? 'light';

		// Set data on globalThis for the iframe to read
		(globalThis as any).__claude_about_data__ = {
			instanceId: getInstanceId(),
			version: extensionConfig.version,
			connectedPorts: getConnectedPortCount(),
			connectedServers: getConnectedServers(),
			theme,
		};

		// Taller iframe so the connected-agents list has room to breathe.
		await eda.sys_IFrame.openIFrame('pages/about.html', 420, 520, 'claude-about', {
			title: 'About EasyEDA Agent',
			grayscaleMask: true,
		});
	} catch (err) {
		showError('About EasyEDA Agent', err);
	}
}

/** Desktop bootstrap: only a local configuration action may choose the credential file. */
export async function configureNativeDaemon(): Promise<void> {
	try {
		await openNativeBridgeSettings(() => {
			eda.sys_Message.showToastMessage('Protected bridge configured — reconnecting...', ESYS_ToastMessageType.SUCCESS, 4);
			reconnectAll(extensionConfig.uuid, { resetQueue: false });
			void eda.sys_Storage.setExtensionUserConfig(AUTO_CONNECT_KEY, true).catch(() => {});
		});
	} catch (err) {
		showError('Configure protected bridge', err);
	}
}

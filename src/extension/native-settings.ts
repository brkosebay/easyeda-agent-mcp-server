import { getNativeTokenPath, NATIVE_TOKEN_PATH_KEY, readNativeToken } from './native-peer';

function bounded<T>(operation: Promise<T>, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), 10_000);
		operation.then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error) => { clearTimeout(timer); reject(error); },
		);
	});
}

/** The host injects this same eda object into packaged iframes. Only expose
 * path configuration: the validated credential never leaves this module.
 * EasyEDA 2.2.47 has no UI handler for the beta showInputDialog API.
 */
export async function openNativeBridgeSettings(onSaved: () => void): Promise<void> {
	(eda as any).__easyedaNativeBridgeSettings = {
		getPath: getNativeTokenPath,
		async savePath(input: string): Promise<void> {
			const path = input.trim();
			if (!path) throw new Error('Enter the absolute path to the daemon token file.');
			await bounded(readNativeToken(path), 'Reading the token file timed out. Check External Interactions in Extension Manager.');
			const saved = await bounded(eda.sys_Storage.setExtensionUserConfig(NATIVE_TOKEN_PATH_KEY, path), 'Saving the credential path timed out.');
			if (!saved) throw new Error('Native credential path could not be saved.');
			onSaved();
		},
	};
	const opened = await bounded(eda.sys_IFrame.openIFrame('pages/native-settings.html', 540, 300, 'native-bridge-settings', {
		title: 'Configure protected bridge',
		grayscaleMask: true,
	}), 'Opening bridge settings timed out. Try disabling and re-enabling the extension.');
	// Some 2.2.x hosts successfully open the window but return undefined.
	if (opened === false) throw new Error('Could not open the bridge settings window.');
}

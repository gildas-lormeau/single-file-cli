/*
 * Copyright 2010-2024 Gildas Lormeau
 * contact : gildas.lormeau <at> gmail.com
 * 
 * This file is part of SingleFile.
 *
 *   The code in this file is free software: you can redistribute it and/or 
 *   modify it under the terms of the GNU Affero General Public License 
 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
 *   of the License, or (at your option) any later version.
 * 
 *   The code in this file is distributed in the hope that it will be useful, 
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of 
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero 
 *   General Public License for more details.
 *
 *   As additional permission under GNU AGPL version 3 section 7, you may 
 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU 
 *   AGPL normally required by section 4, provided you include this license 
 *   notice and a URL through which recipients can access the Corresponding 
 *   Source.
 */

/* global setTimeout, clearTimeout */

import { CDP } from "npm:simple-cdp";
import { launchBrowser, closeBrowser } from "./chromium-browser.js";
import { getScriptSource } from "./single-file-script.js";

const LOAD_TIMEOUT_ERROR = "ERR_LOAD_TIMEOUT";
const NETWORK_IDLE_STATE = "networkIdle";
const NETWORK_STATES = ["networkAlmostIdle", "load", "DOMContentLoaded"];

export { initialize, getPageData, closeBrowser };

async function initialize(options) {
	await launchBrowser(getBrowserOptions(options));
}

async function getPageData(options) {
	let targetInfo;
	try {
		const targetInfo = await CDP.createTarget({ url: "about:blank" });
		const cdp = new CDP(targetInfo);
		await cdp.Page.enable();
		if (options.browserStartMinimized) {
			const { windowId, bounds } = await cdp.Browser.getWindowForTarget({ targetId: targetInfo.targetId });
			if (bounds.windowState !== "minimized") {
				await cdp.Browser.setWindowBounds({ windowId, bounds: { windowState: "minimized" } });
			}
		}
		if (options.browserIgnoreHTTPSErrors !== undefined && options.browserIgnoreHTTPSErrors) {
			await cdp.Security.enable();
			await cdp.Security.setIgnoreCertificateErrors({ ignore: true });
		}
		if (options.browserByPassCSP === undefined || options.browserByPassCSP) {
			await cdp.Page.setBypassCSP({ enabled: true });
		}
		if (options.browserMobileEmulation) {
			await cdp.Emulation.setDeviceMetricsOverride({ mobile: true });
		}
		if (options.httpProxyServer && options.httpProxyUsername) {
			await cdp.Fetch.enable({ handleAuthRequests: true });
			cdp.Fetch.addEventListener("authRequired", async ({ params }) => {
				await cdp.Fetch.continueWithAuth({
					requestId: params.requestId,
					authChallengeResponse: {
						response: "ProvideCredentials",
						username: options.httpProxyUsername,
						password: options.httpProxyPassword
					}
				});
			});
			cdp.Fetch.addEventListener("requestPaused", async ({ params }) => {
				await cdp.Fetch.continueRequest({ requestId: params.requestId });
			});
		}
		if (options.httpHeaders) {
			await cdp.Network.setExtraHTTPHeaders({ headers: options.httpHeaders });
		}
		if (options.emulateMediaFeatures) {
			for (const mediaFeature of options.emulateMediaFeatures) {
				await cdp.Emulation.setEmulatedMedia({
					media: mediaFeature.name,
					features: mediaFeature.value.split(",").map(feature => feature.trim())
				});
			}
		}
		if (options.browserCookies && options.browserCookies.length) {
			await cdp.Network.setCookies({ cookies: options.browserCookies });
		}
		let debuggerReady;
		if (options.browserDebug) {
			await cdp.Debugger.enable();
			debuggerReady = new Promise(resolve => {
				cdp.Debugger.addEventListener("scriptParsed", onScriptParsed);

				async function onScriptParsed() {
					cdp.Debugger.removeEventListener("scriptParsed", onScriptParsed);
					cdp.Debugger.addEventListener("resumed", onResumed);
					await cdp.Debugger.pause();
				}

				async function onResumed() {
					cdp.Debugger.removeEventListener("resumed", onResumed);
					resolve();
				}
			});
		}
		await cdp.Page.addScriptToEvaluateOnNewDocument({
			source: await getScriptSource(options),
			runImmediately: true
		});
		await cdp.Page.setLifecycleEventsEnabled({ enabled: true });
		const pageNavigated = cdp.Page.navigate({ url: options.url });
		const topFrameId = (await cdp.Page.getFrameTree()).frameTree.frame.id;
		const pageReady = new Promise(resolve => {
			let contentLoaded;
			cdp.Page.addEventListener("lifecycleEvent", ({ params }) => {
				const { name, frameId } = params;
				if (name === "DOMContentLoaded" && frameId === topFrameId) {
					contentLoaded = true;
				}
				if (contentLoaded && name === (options.browserWaitUntil || NETWORK_IDLE_STATE)) {
					if (options.browserWaitDelay) {
						setTimeout(() => resolve, options.browserWaitDelay);
					} else {
						resolve();
					}
				}
			});
		});
		let timeoutReady, timeoutId, resolveTimeoutReady;
		if (options.browserLoadMaxTime) {
			timeoutReady = new Promise((resolve, reject) => {
				resolveTimeoutReady = resolve;
				timeoutId = setTimeout(() => {
					const error = new Error("Load timeout");
					error.code = LOAD_TIMEOUT_ERROR;
					reject(error);
				}, options.browserLoadMaxTime);
			});
		}
		await Promise.race([Promise.all([pageNavigated, pageReady, debuggerReady]), timeoutReady]);
		if (timeoutId) {
			clearTimeout(timeoutId);
			resolveTimeoutReady();
		}
		const { result } = await cdp.Runtime.evaluate({
			expression: `singlefile.getPageData(${JSON.stringify(options)})`,
			awaitPromise: true,
			returnByValue: true,
			executionContextName: "singlefile"
		});
		const { value } = result;
		if (options.compressContent) {
			value.content = new Uint8Array(value.content);
		}
		return value;
	} catch (error) {
		if (error.code === LOAD_TIMEOUT_ERROR && options.browserWaitUntilFallback && options.browserWaitUntil) {
			const browserWaitUntil = NETWORK_STATES[(NETWORK_STATES.indexOf(options.browserWaitUntil) + 1)];
			if (browserWaitUntil) {
				options.browserWaitUntil = browserWaitUntil;
				return await getPageData(options);
			}
		}
		throw error;
	} finally {
		if (targetInfo && !options.browserDebug) {
			await CDP.closeTarget(targetInfo.targetId);
		}
	}
}

function getBrowserOptions(options) {
	const browserOptions = {};
	browserOptions.args = options.browserArgs ? JSON.parse(options.browserArgs) : [];
	browserOptions.headless = options.browserHeadless && !options.browserDebug;
	browserOptions.executablePath = options.browserExecutablePath;
	browserOptions.browserDebug = options.browserDebug;
	browserOptions.browserDisableWebSecurity = options.browserDisableWebSecurity === undefined || options.browserDisableWebSecurity;
	browserOptions.browserWidth = options.browserWidth;
	browserOptions.browserHeight = options.browserHeight;
	browserOptions.userAgent = options.userAgent;
	browserOptions.httpProxyServer = options.httpProxyServer;
	return browserOptions;
}
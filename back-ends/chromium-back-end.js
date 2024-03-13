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

import { CDP } from "jsr:@simple-cdp/simple-cdp@^1.7.16";
import { launchBrowser, closeBrowser } from "./chromium-browser.js";
import { getScriptSource, getHookScriptSource } from "./single-file-script.js";

const LOAD_TIMEOUT_ERROR = "ERR_LOAD_TIMEOUT";
const NETWORK_IDLE_STATE = "networkIdle";
const NETWORK_STATES = ["networkAlmostIdle", "load", "DOMContentLoaded"];
const MINIMIZED_WINDOW_STATE = "minimized";
const SINGLE_FILE_WORLD_NAME = "singlefile";
const EMPTY_PAGE_URL = "about:blank";

export { initialize, getPageData, closeBrowser };

async function initialize(options) {
	await launchBrowser(getBrowserOptions(options));
}

async function getPageData(options) {
	let targetInfo;
	try {
		const targetInfo = await CDP.createTarget({ url: EMPTY_PAGE_URL });
		const cdp = new CDP(targetInfo);
		if (options.browserStartMinimized) {
			const { windowId, bounds } = await cdp.Browser.getWindowForTarget({ targetId: targetInfo.targetId });
			if (bounds.windowState !== MINIMIZED_WINDOW_STATE) {
				await cdp.Browser.setWindowBounds({ windowId, bounds: { windowState: MINIMIZED_WINDOW_STATE } });
			}
		}
		if (options.browserIgnoreHTTPSErrors !== undefined && options.browserIgnoreHTTPSErrors) {
			await cdp.Security.setIgnoreCertificateErrors({ ignore: true });
		}
		if (options.browserByPassCSP === undefined || options.browserByPassCSP) {
			await cdp.Page.setBypassCSP({ enabled: true });
		}
		if (options.browserMobileEmulation) {
			await cdp.Emulation.setDeviceMetricsOverride({ mobile: true });
		}
		if (options.httpProxyServer && options.httpProxyUsername) {
			const REQUEST_PAUSED_EVENT = "requestPaused";
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
			cdp.Fetch.addEventListener(REQUEST_PAUSED_EVENT, onRequestPaused);

			// eslint-disable-next-line no-inner-declarations
			async function onRequestPaused({ params }) {
				cdp.Fetch.removeEventListener(REQUEST_PAUSED_EVENT, onRequestPaused);
				await cdp.Fetch.continueRequest({ requestId: params.requestId });
			}
		}
		if (options.httpHeaders && options.httpHeaders.length) {
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
				const SCRIPT_PARSED_EVENT = "scriptParsed";
				const RESUMED_EVENT = "resumed";
				cdp.Debugger.addEventListener(SCRIPT_PARSED_EVENT, onScriptParsed);

				async function onScriptParsed() {
					cdp.Debugger.removeEventListener(SCRIPT_PARSED_EVENT, onScriptParsed);
					cdp.Debugger.addEventListener(RESUMED_EVENT, onResumed);
					await cdp.Debugger.pause();
				}

				async function onResumed() {
					cdp.Debugger.removeEventListener(RESUMED_EVENT, onResumed);
					await cdp.Debugger.disable();
					resolve();
				}
			});
		}
		await cdp.Page.addScriptToEvaluateOnNewDocument({
			source: await getHookScriptSource(),
			runImmediately: true
		});
		await cdp.Page.addScriptToEvaluateOnNewDocument({
			source: await getScriptSource(options),
			runImmediately: true,
			worldName: SINGLE_FILE_WORLD_NAME
		});
		await cdp.Runtime.enable();
		let topFrameId;
		const executionContextIdPromise = new Promise(resolve => {
			const CONTEXT_CREATED_EVENT = "executionContextCreated";
			cdp.Runtime.addEventListener(CONTEXT_CREATED_EVENT, executionContextCreated);

			async function executionContextCreated({ params }) {
				const { context } = params;
				if (context.auxData && context.auxData.isDefault && topFrameId === undefined) {
					topFrameId = context.auxData.frameId;
				} else if (context.name === SINGLE_FILE_WORLD_NAME && context.auxData && context.auxData.frameId === topFrameId) {
					cdp.Runtime.removeEventListener(CONTEXT_CREATED_EVENT, executionContextCreated);
					await cdp.Runtime.disable();
					resolve(context.id);
				}
			}
		});
		await cdp.Page.enable();
		await cdp.Page.setLifecycleEventsEnabled({ enabled: true });
		const pageNavigated = cdp.Page.navigate({ url: options.url });
		const pageReady = new Promise(resolve => {
			const LIFE_CYCLE_EVENT = "lifecycleEvent";
			let contentLoaded;
			cdp.Page.addEventListener(LIFE_CYCLE_EVENT, onLifecycleEvent);

			async function onLifecycleEvent({ params }) {
				const { name, frameId } = params;
				if (name === "DOMContentLoaded" && frameId === topFrameId) {
					contentLoaded = true;
				}
				if (contentLoaded && name === (options.browserWaitUntil || NETWORK_IDLE_STATE)) {
					if (options.browserWaitDelay) {
						setTimeout(() => resolve, options.browserWaitDelay);
					} else {
						cdp.Page.removeEventListener(LIFE_CYCLE_EVENT, onLifecycleEvent);
						await cdp.Page.setLifecycleEventsEnabled({ enabled: false });
						await cdp.Page.disable();
						resolve();
					}
				}
			}
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
		const contextId = await executionContextIdPromise;
		const { result } = await cdp.Runtime.evaluate({
			expression: `singlefile.getPageData(${JSON.stringify(options)})`,
			awaitPromise: true,
			returnByValue: true,
			contextId
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
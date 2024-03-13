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
		const { Browser, Security, Page, Emulation, Fetch, Network, Runtime, Debugger } = new CDP(targetInfo);
		if (options.browserStartMinimized) {
			const { windowId, bounds } = await Browser.getWindowForTarget({ targetId: targetInfo.targetId });
			if (bounds.windowState !== MINIMIZED_WINDOW_STATE) {
				await Browser.setWindowBounds({ windowId, bounds: { windowState: MINIMIZED_WINDOW_STATE } });
			}
		}
		if (options.browserIgnoreHTTPSErrors !== undefined && options.browserIgnoreHTTPSErrors) {
			await Security.setIgnoreCertificateErrors({ ignore: true });
		}
		if (options.browserByPassCSP === undefined || options.browserByPassCSP) {
			await Page.setBypassCSP({ enabled: true });
		}
		if (options.browserMobileEmulation) {
			await Emulation.setDeviceMetricsOverride({ mobile: true });
		}
		if (options.httpProxyServer && options.httpProxyUsername) {
			await Fetch.enable({ handleAuthRequests: true });
			Fetch.addEventListener("authRequired", async ({ params }) => {
				await Fetch.continueWithAuth({
					requestId: params.requestId,
					authChallengeResponse: {
						response: "ProvideCredentials",
						username: options.httpProxyUsername,
						password: options.httpProxyPassword
					}
				});
			});
			Fetch.addEventListener("requestPaused", ({ params }) => Fetch.continueRequest({ requestId: params.requestId }));
		}
		if (options.httpHeaders && options.httpHeaders.length) {
			await Network.setExtraHTTPHeaders({ headers: options.httpHeaders });
		}
		if (options.emulateMediaFeatures) {
			for (const mediaFeature of options.emulateMediaFeatures) {
				await Emulation.setEmulatedMedia({
					media: mediaFeature.name,
					features: mediaFeature.value.split(",").map(feature => feature.trim())
				});
			}
		}
		if (options.browserCookies && options.browserCookies.length) {
			await Network.setCookies({ cookies: options.browserCookies });
		}
		let debuggerReady;
		if (options.browserDebug) {
			await Debugger.enable();
			debuggerReady = new Promise(resolve => {
				const SCRIPT_PARSED_EVENT = "scriptParsed";
				const RESUMED_EVENT = "resumed";
				Debugger.addEventListener(SCRIPT_PARSED_EVENT, onScriptParsed);

				async function onScriptParsed() {
					Debugger.removeEventListener(SCRIPT_PARSED_EVENT, onScriptParsed);
					Debugger.addEventListener(RESUMED_EVENT, onResumed);
					await Debugger.pause();
				}

				async function onResumed() {
					Debugger.removeEventListener(RESUMED_EVENT, onResumed);
					await Debugger.disable();
					resolve();
				}
			});
		}
		await Page.addScriptToEvaluateOnNewDocument({
			source: await getHookScriptSource(),
			runImmediately: true
		});
		await Page.addScriptToEvaluateOnNewDocument({
			source: await getScriptSource(options),
			runImmediately: true,
			worldName: SINGLE_FILE_WORLD_NAME
		});
		await Runtime.enable();
		let topFrameId;
		const executionContextIdPromise = new Promise(resolve => {
			const CONTEXT_CREATED_EVENT = "executionContextCreated";
			Runtime.addEventListener(CONTEXT_CREATED_EVENT, executionContextCreated);

			async function executionContextCreated({ params }) {
				const { context } = params;
				if (context.auxData && context.auxData.isDefault && topFrameId === undefined) {
					topFrameId = context.auxData.frameId;
				} else if (context.name === SINGLE_FILE_WORLD_NAME && context.auxData && context.auxData.frameId === topFrameId) {
					Runtime.removeEventListener(CONTEXT_CREATED_EVENT, executionContextCreated);
					await Runtime.disable();
					resolve(context.id);
				}
			}
		});
		await Page.enable();
		await Page.setLifecycleEventsEnabled({ enabled: true });
		const pageNavigated = Page.navigate({ url: options.url });
		const pageReady = new Promise(resolve => {
			const LIFE_CYCLE_EVENT = "lifecycleEvent";
			let contentLoaded;
			Page.addEventListener(LIFE_CYCLE_EVENT, onLifecycleEvent);

			async function onLifecycleEvent({ params }) {
				const { name, frameId } = params;
				if (topFrameId === undefined && frameId !== undefined) {
					topFrameId = frameId;
				}
				if (name === "DOMContentLoaded" && topFrameId !== undefined && frameId === topFrameId) {
					contentLoaded = true;
				}
				if (contentLoaded && name === (options.browserWaitUntil || NETWORK_IDLE_STATE) && frameId === topFrameId) {
					if (options.browserWaitDelay) {
						setTimeout(() => resolve, options.browserWaitDelay);
					} else {
						Page.removeEventListener(LIFE_CYCLE_EVENT, onLifecycleEvent);
						await Page.setLifecycleEventsEnabled({ enabled: false });
						await Page.disable();
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
		const { result } = await Runtime.evaluate({
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
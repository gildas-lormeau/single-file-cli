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

import { launchBrowser, closeBrowser } from "./browser.js";
import { getScriptSource, getHookScriptSource } from "./single-file-script.js";
import { CDP } from "simple-cdp";

const LOAD_TIMEOUT_ERROR = "ERR_LOAD_TIMEOUT";
const INTERACTIVE_TIME_STATE = "InteractiveTime";
const NETWORK_STATES = ["InteractiveTime", "networkIdle", "networkAlmostIdle", "load", "DOMContentLoaded"];
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
		const targetInfo = await CDP.createTarget(EMPTY_PAGE_URL);
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
			Fetch.addEventListener("authRequired", ({ params }) => Fetch.continueWithAuth({
				requestId: params.requestId,
				authChallengeResponse: {
					response: "ProvideCredentials",
					username: options.httpProxyUsername,
					password: options.httpProxyPassword
				}
			}));
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
		await Page.addScriptToEvaluateOnNewDocument({
			source: getHookScriptSource(),
			runImmediately: true
		});
		await Page.addScriptToEvaluateOnNewDocument({
			source: await getScriptSource(options),
			runImmediately: true,
			worldName: SINGLE_FILE_WORLD_NAME
		});
		const [contextId] = await Promise.all([
			navigate({ Page, Runtime }, options),
			options.browserDebug ? waitForDebuggerReady({ Debugger }) : Promise.resolve()
		]);
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

async function navigate({ Page, Runtime }, options) {
	await Runtime.enable();
	await Page.enable();
	try {
		const loadTimeoutAbortController = new AbortController();
		const loadTimeoutAbortSignal = loadTimeoutAbortController.signal;
		const [contextId] = await Promise.race([
			Promise.all([getTopFrameContextId({ Page, Runtime }, options), Page.navigate({ url: options.url })]),
			options.browserLoadMaxTime ? waitForLoadTimeout(loadTimeoutAbortSignal, options.browserLoadMaxTime) : Promise.resolve()
		]);
		if (!loadTimeoutAbortSignal.aborted) {
			loadTimeoutAbortController.abort();
		}
		return contextId;
	} finally {
		await Runtime.disable();
		await Page.disable();
	}
}

function getTopFrameContextId({ Page, Runtime }, options) {
	let frameId, contextId, abortController;
	return new Promise((resolve, reject) => {
		const FRAME_NAVIGATED_EVENT = "frameNavigated";
		const CONTEXT_CREATED_EVENT = "executionContextCreated";
		Page.addEventListener(FRAME_NAVIGATED_EVENT, onFrameNavigated);
		Runtime.addEventListener(CONTEXT_CREATED_EVENT, executionContextCreated);

		async function onFrameNavigated({ params }) {
			const { frame } = params;
			if (!frame.parentId) {
				frameId = frame.id;
				if (abortController) {
					abortController.abort();
				}
				abortController = new AbortController();
				await waitForPageReady({ Page }, frameId, options);
				if (!abortController.signal.aborted) {
					Page.removeEventListener(FRAME_NAVIGATED_EVENT, onFrameNavigated);
					Runtime.removeEventListener(CONTEXT_CREATED_EVENT, executionContextCreated);
					if (contextId === undefined) {
						reject(new Error("Execution context not found"));
					} else {
						resolve(contextId);
					}
				}
				abortController = undefined;
			}
		}

		function executionContextCreated({ params }) {
			const { context } = params;
			const { name, origin, auxData } = context;
			if (frameId !== undefined && origin === "://" && name === SINGLE_FILE_WORLD_NAME && auxData && auxData.frameId === frameId) {
				contextId = context.id;
			}
		}
	});
}

function waitForLoadTimeout(abortSignal, maxDelay) {
	return new Promise((resolve, reject) => {
		const ABORT_EVENT = "abort";
		abortSignal.addEventListener(ABORT_EVENT, onAbort);
		const timeoutId = setTimeout(() => {
			const error = new Error("Load timeout");
			error.code = LOAD_TIMEOUT_ERROR;
			reject(error);
		}, maxDelay);

		function onAbort() {
			abortSignal.removeEventListener(ABORT_EVENT, onAbort);
			clearTimeout(timeoutId);
			resolve();
		}
	});
}

async function waitForPageReady({ Page }, topFrameId, options) {
	await Page.setLifecycleEventsEnabled({ enabled: true });
	await new Promise(resolve => {
		const LIFE_CYCLE_EVENT = "lifecycleEvent";
		Page.addEventListener(LIFE_CYCLE_EVENT, onLifecycleEvent);

		function onLifecycleEvent({ params }) {
			const { name, frameId } = params;
			if (frameId === topFrameId) {
				if ((name === options.browserWaitUntil || name === INTERACTIVE_TIME_STATE)) {
					Page.removeEventListener(LIFE_CYCLE_EVENT, onLifecycleEvent);
					resolve();
				}
			}
		}
	});
	await Page.setLifecycleEventsEnabled({ enabled: false });
	if (options.browserWaitDelay) {
		setTimeout(() => resolve, options.browserWaitDelay);
	}
}

async function waitForDebuggerReady({ Debugger }) {
	await Debugger.enable();
	await Debugger.pause();
	await new Promise(resolve => {
		const RESUMED_EVENT = "resumed";
		Debugger.addEventListener(RESUMED_EVENT, onResumed);

		function onResumed() {
			Debugger.removeEventListener(RESUMED_EVENT, onResumed);
			resolve();
		}
	});
	await Debugger.disable();
}

function getBrowserOptions(options) {
	const browserOptions = {};
	browserOptions.args = options.browserArgs;
	browserOptions.headless = options.browserHeadless && !options.browserDebug;
	browserOptions.executablePath = options.browserExecutablePath;
	browserOptions.debug = options.browserDebug;
	browserOptions.disableWebSecurity = options.browserDisableWebSecurity === undefined || options.browserDisableWebSecurity;
	browserOptions.width = options.browserWidth;
	browserOptions.height = options.browserHeight;
	browserOptions.userAgent = options.userAgent;
	browserOptions.httpProxyServer = options.httpProxyServer;
	return browserOptions;
}
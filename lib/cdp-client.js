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
import { CDP, options } from "simple-cdp";

const LOAD_TIMEOUT_ERROR = "ERR_LOAD_TIMEOUT";
const CAPTURE_TIMEOUT_ERROR = "ERR_CAPTURE_TIMEOUT";
const NETWORK_STATES = ["InteractiveTime", "networkIdle", "networkAlmostIdle", "load", "DOMContentLoaded"];
const MINIMIZED_WINDOW_STATE = "minimized";
const SINGLE_FILE_WORLD_NAME = "singlefile";
const EMPTY_PAGE_URL = "about:blank";
const CAPTURE_SCREENSHOT_FUNCTION_NAME = "captureScreenshot";
const PRINT_TO_PDF_FUNCTION_NAME = "printToPDF";
const SET_SCREENSHOT_FUNCTION_NAME = "setScreenshot";
const SET_PDF_FUNCTION_NAME = "setPDF";
const SET_PAGE_DATA_FUNCTION_NAME = "setPageData";
const REDIRECT_STATUS_CODES = [301, 302, 303, 307, 308];

export { initialize, getPageData, closeBrowser };

async function initialize(singleFileOptions) {
	if (singleFileOptions.browserServer) {
		options.apiUrl = singleFileOptions.browserServer;
	} else {
		options.apiUrl = "http://localhost:" + (await launchBrowser(getBrowserOptions(singleFileOptions)));
	}
}

async function getPageData(options) {
	const debugMessages = [];
	let targetInfo;
	try {
		if (options.debugMessagesFile) {
			debugMessages.push([Date.now(), ["Loading page", EMPTY_PAGE_URL]]);
		}
		targetInfo = await CDP.createTarget(EMPTY_PAGE_URL);
		const consoleMessages = [];
		const { Browser, Security, Page, Emulation, Fetch, Network, Runtime, Debugger, Console } = new CDP(targetInfo);
		if (options.consoleMessagesFile) {
			if (options.debugMessagesFile) {
				debugMessages.push([Date.now(), ["Enabling console messages"]]);
			}
			await Console.enable();
			Console.addEventListener("messageAdded", ({ params }) => {
				const { message } = params;
				consoleMessages.push(message);
			});
		}
		if (options.browserStartMinimized) {
			const { windowId, bounds } = await Browser.getWindowForTarget({ targetId: targetInfo.id });
			if (bounds.windowState !== MINIMIZED_WINDOW_STATE) {
				if (options.debugMessagesFile) {
					debugMessages.push([Date.now(), ["Minimizing window"]]);
				}
				await Browser.setWindowBounds({ windowId, bounds: { windowState: MINIMIZED_WINDOW_STATE } });
			}
		}
		if (options.browserIgnoreHTTPSErrors !== undefined && options.browserIgnoreHTTPSErrors) {
			if (options.debugMessagesFile) {
				debugMessages.push([Date.now(), ["Ignoring HTTPS errors"]]);
			}
			await Security.setIgnoreCertificateErrors({ ignore: true });
		}
		if (options.browserByPassCSP === undefined || options.browserByPassCSP) {
			if (options.debugMessagesFile) {
				debugMessages.push([Date.now(), ["Bypassing CSP"]]);
			}
			await Page.setBypassCSP({ enabled: true });
		}
		if (options.browserMobileEmulation || options.browserDeviceWidth || options.browserDeviceHeight || options.browserDeviceScaleFactor || options.platform || options.acceptLanguage) {
			if (options.browserMobileEmulation || options.browserDeviceWidth || options.browserDeviceHeight || options.browserDeviceScaleFactor) {
				let browserDeviceWidth;
				if (!options.browserDeviceWidth) {
					const { result } = await Runtime.evaluate({ expression: "window.innerWidth" });
					browserDeviceWidth = result.value;
				}
				let browserDeviceHeight;
				if (!options.browserDeviceHeight) {
					const { result } = await Runtime.evaluate({ expression: "window.innerHeight" });
					browserDeviceHeight = result.value;
				}
				let browserDeviceScaleFactor;
				if (!options.browserDeviceScaleFactor) {
					const { result } = await Runtime.evaluate({ expression: "window.devicePixelRatio" });
					browserDeviceScaleFactor = result.value;
				}
				const deviceMetricsOptions = {
					mobile: Boolean(options.browserMobileEmulation),
					width: options.browserDeviceWidth || (options.browserMobileEmulation ? 360 : options.width || browserDeviceWidth),
					height: options.browserDeviceHeight || (options.browserMobileEmulation ? 800 : options.height || browserDeviceHeight),
					deviceScaleFactor: options.browserDeviceScaleFactor || (options.browserMobileEmulation ? 2 : browserDeviceScaleFactor)
				};
				if (options.debugMessagesFile) {
					debugMessages.push([Date.now(), ["Emulating device metrics", JSON.stringify(deviceMetricsOptions)]]);
				}
				await Emulation.setDeviceMetricsOverride(deviceMetricsOptions);
			}
			if (options.browserMobileEmulation || options.platform || options.acceptLanguage) {
				const { userAgent, product } = await Browser.getVersion();
				const agentOptions = {
					userAgent: options.userAgent || (options.browserMobileEmulation ? "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) " + product + " Mobile Safari/537.36" : userAgent)
				};
				if (options.acceptLanguage) {
					agentOptions.acceptLanguage = options.acceptLanguage;
				}
				if (options.platform || options.browserMobileEmulation) {
					agentOptions.platform = options.platform || "Android";
				}
				if (options.debugMessagesFile) {
					debugMessages.push([Date.now(), ["Emulating user agent", JSON.stringify(agentOptions)]]);
				}
				await Emulation.setUserAgentOverride(agentOptions);
			}
		}
		const handleAuthRequests = Boolean(options.httpProxyUsername);
		const patterns = handleAuthRequests ? [{ requestStage: "Request" }, { requestStage: "Response" }] : [{ requestStage: "Response" }];
		await Fetch.enable({ handleAuthRequests, patterns });
		if (handleAuthRequests) {
			Fetch.addEventListener("authRequired", async ({ params }) => {
				if (options.debugMessagesFile) {
					debugMessages.push([Date.now(), ["Authenticating"]]);
				}
				await Fetch.continueWithAuth({
					requestId: params.requestId,
					authChallengeResponse: {
						response: "ProvideCredentials",
						username: options.httpProxyUsername,
						password: options.httpProxyPassword
					}
				});
			});
		}
		let url = options.url;
		let alternativeUrl = new URL(url);
		if (!alternativeUrl.pathname.endsWith("/")) {
			alternativeUrl.pathname = alternativeUrl.pathname + "/";
		}
		alternativeUrl = alternativeUrl.href;
		let httpInfo;
		Fetch.addEventListener("requestPaused", async ({ params }) => {
			const { requestId, request, resourceType, responseHeaders, responseStatusCode, responseStatusText } = params;
			if (resourceType == "Document" && (options.outputJson && !httpInfo && (request.url == url || request.url == alternativeUrl) && responseStatusCode !== undefined)) {
				if (REDIRECT_STATUS_CODES.includes(responseStatusCode)) {
					const redirect = responseHeaders.find(header => header.name.toLowerCase() == "location").value;
					if (redirect) {
						url = new URL(redirect, url).href;
					}
					if (options.debugMessagesFile) {
						debugMessages.push([Date.now(), ["Redirecting", url]]);
					}
				} else {
					httpInfo = {
						request: {
							url: request.url,
							method: request.method,
							headers: request.headers,
							referrerPolicy: request.referrerPolicy
						},
						resourceType,
						response: {
							status: responseStatusCode,
							statusText: responseStatusText,
							headers: responseHeaders
						}
					};
				}
			} else if (options.blockedURLPatterns && options.blockedURLPatterns.length) {
				const blockedURL = options.blockedURLPatterns.find(blockedURL => new RegExp(blockedURL).test(request.url));
				if (blockedURL) {
					try {
						if (options.debugMessagesFile) {
							debugMessages.push([Date.now(), ["Blocking request", request.url]]);
						}
						await Fetch.failRequest({ requestId, errorReason: "Aborted" });
					} catch {
						// ignored
					}
				}
			}
			try {
				await Fetch.continueRequest({ requestId });
			} catch {
				// ignored
			}
		});
		if (options.httpHeaders && options.httpHeaders.length) {
			if (options.debugMessagesFile) {
				debugMessages.push([Date.now(), ["Setting HTTP headers", JSON.stringify(options.httpHeaders)]]);
			}
			await Network.setExtraHTTPHeaders({ headers: options.httpHeaders });
		}
		if (options.emulateMediaFeatures) {
			for (const mediaFeature of options.emulateMediaFeatures) {
				if (options.debugMessagesFile) {
					debugMessages.push([Date.now(), ["Emulating media feature", mediaFeature.name, mediaFeature.value]]);
				}
				await Emulation.setEmulatedMedia({
					media: mediaFeature.name,
					features: mediaFeature.value.split(",").map(feature => feature.trim())
				});
			}
		}
		if (options.browserCookies && options.browserCookies.length) {
			if (options.debugMessagesFile) {
				debugMessages.push([Date.now(), ["Setting cookies", JSON.stringify(options.browserCookies)]]);
			}
			await Network.setCookies({ cookies: options.browserCookies });
		}
		await Browser.setDownloadBehavior({ behavior: "deny" });
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
			loadPage({ Page, Runtime }, options, debugMessages),
			options.browserDebug ? waitForDebuggerReady({ Debugger }) : Promise.resolve()
		]);
		await Runtime.addBinding({ name: SET_PAGE_DATA_FUNCTION_NAME, executionContextId: contextId });
		if (options.embedScreenshot && options.compressContent) {
			await Runtime.addBinding({ name: CAPTURE_SCREENSHOT_FUNCTION_NAME, executionContextId: contextId });
			Runtime.addEventListener("bindingCalled", async ({ params }) => {
				if (params.name === CAPTURE_SCREENSHOT_FUNCTION_NAME) {
					if (options.debugMessagesFile) {
						debugMessages.push([Date.now(), ["Capturing screenshot"]]);
					}
					try {
						let screenshotOptions = { captureBeyondViewport: true };
						if (options.embedScreenshotOptions) {
							try {
								screenshotOptions = JSON.parse(options.embedScreenshotOptions);
							} catch {
								// ignored
							}
						}
						screenshotOptions.format = "png";
						const { data } = await Page.captureScreenshot(screenshotOptions);
						await Runtime.evaluate({ expression: `globalThis.${SET_SCREENSHOT_FUNCTION_NAME}(${JSON.stringify(data)})`, contextId });
					} catch {
						await Runtime.evaluate({ expression: `globalThis.${SET_SCREENSHOT_FUNCTION_NAME}(${JSON.stringify("")})`, contextId });
					}
				}
			});
		}
		if (options.embedPdf) {
			await Runtime.addBinding({ name: PRINT_TO_PDF_FUNCTION_NAME, executionContextId: contextId });
			Runtime.addEventListener("bindingCalled", async ({ params }) => {
				if (params.name === PRINT_TO_PDF_FUNCTION_NAME) {
					if (options.debugMessagesFile) {
						debugMessages.push([Date.now(), ["Printing to PDF", options.embedPdfOptions || ""]]);
					}
					let pdfOptions = {};
					if (options.embedPdfOptions) {
						try {
							pdfOptions = JSON.parse(options.embedPdfOptions);
						} catch {
							// ignored
						}
					}
					try {
						const { data } = await Page.printToPDF(pdfOptions);
						await Runtime.evaluate({ expression: `globalThis.${SET_PDF_FUNCTION_NAME}(${JSON.stringify(data)})`, contextId });
					} catch {
						await Runtime.evaluate({ expression: `globalThis.${SET_PDF_FUNCTION_NAME}(${JSON.stringify("")})`, contextId });
					}
				}
			});
		}
		const pageDataPromise = new Promise(resolve => {
			let pageDataResponse = "";
			Runtime.addEventListener("bindingCalled", ({ params }) => {
				if (params.name === SET_PAGE_DATA_FUNCTION_NAME) {
					const { payload } = params;
					if (payload.length) {
						pageDataResponse += payload;
					} else {
						if (options.debugMessagesFile) {
							debugMessages.push([Date.now(), ["Setting page data"]]);
						}
						const result = JSON.parse(pageDataResponse);
						if (result.content instanceof Array) {
							result.content = new Uint8Array(result.content);
						}
						resolve(result);
					}
				}
			});
		});
		if (options.browserWaitDelay) {
			if (options.debugMessagesFile) {
				debugMessages.push([Date.now(), [`Waiting ${options.browserWaitDelay} ms`]]);
			}
			await new Promise(resolve => setTimeout(resolve, options.browserWaitDelay));
		}
		const captureTimeoutAbortController = new AbortController();
		const captureTimeoutAbortSignal = captureTimeoutAbortController.signal;
		try {
			if (options.debugMessagesFile) {
				debugMessages.push([Date.now(), ["Capturing page"]]);
			}
			const { result } = await Promise.race([
				Runtime.evaluate({
					expression: `(${getPageDataScriptSource.toString()})(${JSON.stringify(options)},${JSON.stringify([SET_SCREENSHOT_FUNCTION_NAME, SET_PDF_FUNCTION_NAME, SET_PAGE_DATA_FUNCTION_NAME, CAPTURE_SCREENSHOT_FUNCTION_NAME, PRINT_TO_PDF_FUNCTION_NAME])})`,
					awaitPromise: true,
					returnByValue: true,
					contextId
				}),
				waitForTimeout(captureTimeoutAbortSignal, options.browserCaptureMaxTime, "Capture timeout", CAPTURE_TIMEOUT_ERROR)
			]);
			const { subtype, description } = result;
			if (subtype === "error") {
				throw new Error(description);
			}
		} finally {
			if (!captureTimeoutAbortSignal.aborted) {
				captureTimeoutAbortController.abort();
			}
			await Runtime.disable();
			await Page.disable();
		}
		const pageData = await pageDataPromise;
		if (options.consoleMessagesFile) {
			await Console.disable();
			pageData.consoleMessages = consoleMessages;
		}
		if (options.debugMessagesFile) {
			pageData.debugMessages = debugMessages;
			debugMessages.push([Date.now(), ["Returning page data"]]);
		}
		Object.assign(pageData, httpInfo);
		return pageData;
	} catch (error) {
		if (error.code === LOAD_TIMEOUT_ERROR && options.browserWaitUntilFallback && options.browserWaitUntil) {
			const browserWaitUntil = NETWORK_STATES[(NETWORK_STATES.indexOf(options.browserWaitUntil) + 1)];
			if (browserWaitUntil) {
				if (options.debugMessagesFile) {
					debugMessages.push([Date.now(), ["Retrying with waitUntil", browserWaitUntil]]);
				}
				options.browserWaitUntil = browserWaitUntil;
				await closeTarget();
				return await getPageData(options);
			}
		}
		if (options.consoleMessagesFile) {
			error.consoleMessages = consoleMessages;
		}
		if (options.debugMessagesFile) {
			error.debugMessages = debugMessages;
		}
		throw error;
	} finally {
		if (options.debugMessagesFile) {
			debugMessages.push([Date.now(), ["Closing page"]]);
		}
		await closeTarget();
		if (options.debugMessagesFile) {
			debugMessages.push([Date.now(), ["Finishing"]]);
		}
	}

	async function closeTarget() {
		if (targetInfo && !options.browserDebug) {
			await CDP.closeTarget(targetInfo.id);
			targetInfo = null;
		}
	}
}

function getPageDataScriptSource(options, [SET_SCREENSHOT_FUNCTION_NAME, SET_PDF_FUNCTION_NAME, SET_PAGE_DATA_FUNCTION_NAME, CAPTURE_SCREENSHOT_FUNCTION_NAME, PRINT_TO_PDF_FUNCTION_NAME]) {
	if ((options.embedScreenshot || options.embedPdf) && options.compressContent) {
		let screenshot, pdf;
		if (options.embedScreenshot) {
			screenshot = new Promise(resolve => globalThis[SET_SCREENSHOT_FUNCTION_NAME] = async data =>
				resolve(Array.from(new Uint8Array(await (await fetch("data:image/png;base64," + data)).arrayBuffer()))));
		}
		if (options.embedPdf) {
			pdf = new Promise(resolve => globalThis[SET_PDF_FUNCTION_NAME] = async data =>
				resolve(Array.from(new Uint8Array(await (await fetch("data:application/pdf;base64," + data)).arrayBuffer()))));
		}
		let pendingCapture;
		options.onprogress = async event => {
			if (event.type == event.RESOURCES_INITIALIZING && window == top && !pendingCapture) {
				pendingCapture = true;
				if (globalThis[CAPTURE_SCREENSHOT_FUNCTION_NAME]) {
					globalThis[CAPTURE_SCREENSHOT_FUNCTION_NAME]("");
					options.embeddedImage = await screenshot;
				}
				if (globalThis[PRINT_TO_PDF_FUNCTION_NAME]) {
					globalThis[PRINT_TO_PDF_FUNCTION_NAME]("");
					options.embeddedPdf = await pdf;
				}
			}
		};
	}
	const MAX_CONTENT_SIZE = 32 * 1024 * 1024;
	return singlefile.getPageData(options).then(data => {
		if (data.content instanceof Uint8Array) {
			data.content = Array.from(data.content);
		}
		data = JSON.stringify(data);
		let indexData = 0;
		do {
			globalThis[SET_PAGE_DATA_FUNCTION_NAME](data.slice(indexData, indexData + MAX_CONTENT_SIZE));
			indexData += MAX_CONTENT_SIZE;
		} while (indexData < data.length);
		globalThis[SET_PAGE_DATA_FUNCTION_NAME]("");
	});
}

async function loadPage({ Page, Runtime }, options, debugMessages) {
	await Runtime.enable();
	await Page.enable();
	const loadTimeoutAbortController = new AbortController();
	const loadTimeoutAbortSignal = loadTimeoutAbortController.signal;
	try {
		if (options.debugMessagesFile) {
			debugMessages.push([Date.now(), ["Loading page", options.url]]);
		}
		const [contextId] = await Promise.race([
			Promise.all([getTopFrameContextId({ Page, Runtime }, options, debugMessages), Page.navigate({ url: options.url })]),
			waitForTimeout(loadTimeoutAbortSignal, options.browserLoadMaxTime, "Load timeout", LOAD_TIMEOUT_ERROR)
		]);
		return contextId;
	} finally {
		if (!loadTimeoutAbortSignal.aborted) {
			loadTimeoutAbortController.abort();
		}
		await Runtime.disable();
		await Page.disable();
	}
}

async function getTopFrameContextId({ Page, Runtime }, options, debugMessages) {
	const CONTEXT_CREATED_EVENT = "executionContextCreated";
	const contextIds = [];
	let topFrameId;
	try {
		Runtime.addEventListener(CONTEXT_CREATED_EVENT, onExecutionContextCreated);
		await waitForPageReady({ Page }, options);
		if (options.debugMessagesFile) {
			debugMessages.push([Date.now(), ["Getting execution context"]]);
		}
		const contextId = await getContextId();
		if (contextId === undefined) {
			throw new Error("Execution context not found");
		} else {
			return contextId;
		}
	} finally {
		Runtime.removeEventListener(CONTEXT_CREATED_EVENT, onExecutionContextCreated);
	}

	function onExecutionContextCreated({ params }) {
		const { context } = params;
		const { name, auxData = {} } = context;
		if (name === SINGLE_FILE_WORLD_NAME && topFrameId !== undefined && auxData.frameId === topFrameId) {
			contextIds.unshift(context.id);
		}
	}

	async function waitForPageReady({ Page }, options) {
		let resolveCallbackTimeout;
		await Page.setLifecycleEventsEnabled({ enabled: true });
		try {
			await new Promise((resolve, reject) => {
				const LIFE_CYCLE_EVENT = "lifecycleEvent";
				const FRAME_NAVIGATED_EVENT = "frameNavigated";
				Page.addEventListener(LIFE_CYCLE_EVENT, onLifecycleEvent);
				Page.addEventListener(FRAME_NAVIGATED_EVENT, onFrameNavigated);

				function onLifecycleEvent({ params }) {
					const { frameId, name } = params;
					if (frameId === topFrameId) {
						if (options.debugMessagesFile) {
							debugMessages.push([Date.now(), ["Detecting lifecycle event", name]]);
						}
						if (name === options.browserWaitUntil || (resolveCallbackTimeout && NETWORK_STATES.indexOf(name) < NETWORK_STATES.indexOf(options.browserWaitUntil))) {
							clearTimeout(resolveCallbackTimeout);
							if (options.debugMessagesFile) {
								debugMessages.push([Date.now(), [`Waiting ${options.browserWaitUntilDelay} ms`]]);
							}
							setTimeout(() => {
								if (options.debugMessagesFile) {
									debugMessages.push([Date.now(), ["Detecting page ready"]]);
								}
								removeListeners();
								resolve();
							}, options.browserWaitUntilDelay);
						}
					}
				}

				function onFrameNavigated({ params }) {
					const { frame } = params;
					if (!frame.parentId) {
						if (frame.unreachableUrl) {
							clearTimeout(resolveCallbackTimeout);
							removeListeners();
							reject(new Error("Unreachable URL: " + frame.unreachableUrl));
						} else {
							if (options.debugMessagesFile) {
								debugMessages.push([Date.now(), ["Detecting top frame ID"]]);
							}
							topFrameId = frame.id;
						}
					}
				}

				function removeListeners() {
					Page.removeEventListener(LIFE_CYCLE_EVENT, onLifecycleEvent);
					Page.removeEventListener(FRAME_NAVIGATED_EVENT, onFrameNavigated);
				}
			});
		} finally {
			await Page.setLifecycleEventsEnabled({ enabled: false });
		}
	}

	async function getContextId() {
		let contextId;
		if (contextIds.length) {
			let contextIdIndex = 0;
			do {
				if (await testExecutionContext(contextIds[contextIdIndex])) {
					contextId = contextIds[contextIdIndex];
				}
				contextIdIndex++;
			} while (contextId === undefined && contextIdIndex < contextIds.length);
		}
		return contextId;
	}

	async function testExecutionContext(contextId) {
		try {
			const { result } = await Runtime.evaluate({
				expression: "singlefile !== undefined",
				contextId
			});
			return result.value === true;
		} catch {
			// ignored
		}
		return false;
	}
}

function waitForTimeout(abortSignal, maxDelay, errorMessage, errorCode) {
	return new Promise((resolve, reject) => {
		const ABORT_EVENT = "abort";
		abortSignal.addEventListener(ABORT_EVENT, onAbort);
		const timeoutId = setTimeout(() => {
			abortSignal.removeEventListener(ABORT_EVENT, onAbort);
			const error = new Error(errorMessage);
			error.code = errorCode;
			reject(error);
		}, maxDelay);

		function onAbort() {
			abortSignal.removeEventListener(ABORT_EVENT, onAbort);
			clearTimeout(timeoutId);
			resolve();
		}
	});
}

async function waitForDebuggerReady({ Debugger }) {
	await Debugger.enable();
	try {
		await Debugger.pause();
		await new Promise(resolve => {
			const RESUMED_EVENT = "resumed";
			Debugger.addEventListener(RESUMED_EVENT, onResumed);

			function onResumed() {
				Debugger.removeEventListener(RESUMED_EVENT, onResumed);
				resolve();
			}
		});
	} finally {
		await Debugger.disable();
	}
}

function getBrowserOptions(options) {
	const browserOptions = {};
	browserOptions.args = options.browserArgs;
	browserOptions.headless = options.browserHeadless;
	browserOptions.executablePath = options.browserExecutablePath;
	browserOptions.debug = options.browserDebug;
	browserOptions.disableWebSecurity = options.browserDisableWebSecurity === undefined || options.browserDisableWebSecurity;
	browserOptions.width = options.browserWidth;
	browserOptions.height = options.browserHeight;
	browserOptions.userAgent = options.userAgent;
	browserOptions.httpProxyServer = options.httpProxyServer;
	return browserOptions;
}

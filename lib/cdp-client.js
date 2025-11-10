/*
 * Copyright 2010-2025 Gildas Lormeau
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

/* global setTimeout, clearTimeout, URL, AbortController */

import { launchBrowser, closeBrowser } from "./browser.js";
import {
	FETCH_FUNCTION_NAME,
	RESOLVE_FETCH_FUNCTION_NAME,
	REJECT_FETCH_FUNCTION_NAME,
	getScriptSource,
	getHookScriptSource,
	getPageDataScriptSource
} from "./single-file-script.js";
import {
	fetch,
	waitForTimeout,
	arrayBufferToBase64,
	getAlternativeUrl
} from "./cdp-client-util.js";
import {
	CDP,
	options
} from "simple-cdp";

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
		const browserOptions = {};
		browserOptions.args = options.browserArgs;
		browserOptions.headless = options.browserHeadless;
		browserOptions.executablePath = options.browserExecutablePath;
		browserOptions.debug = options.browserDebug;
		browserOptions.disableWebSecurity = options.browserDisableWebSecurity;
		browserOptions.width = options.browserWidth;
		browserOptions.height = options.browserHeight;
		browserOptions.userAgent = options.userAgent;
		browserOptions.httpProxyServer = options.httpProxyServer;
		options.apiUrl = "http://localhost:" + (await launchBrowser(browserOptions));
	}
}

async function getPageData(options) {
	const debugMessages = [];
	const consoleMessages = [];
	let targetInfo;
	try {
		if (options.debugMessagesFile) {
			debugMessages.push([Date.now(), ["Loading page", EMPTY_PAGE_URL]]);
		}
		targetInfo = await CDP.createTarget(EMPTY_PAGE_URL);
		const {
			Browser,
			Console,
			Debugger,
			Emulation,
			Fetch,
			Network,
			Page,
			Runtime,
			Security
		} = new CDP(targetInfo);
		const httpInfo = {};
		await setupConsoleLogging({ Console }, { options, consoleMessages, debugMessages });
		await setupBrowserWindow({ Browser }, targetInfo.id, { options, debugMessages });
		await setupSecurity({ Security }, { options, debugMessages });
		await setupDeviceEmulation({ Browser, Emulation, Runtime }, { options, debugMessages });
		await setupNetworkInterception({ Browser, Emulation, Fetch, Network }, { options, debugMessages, httpInfo });
		await setupScriptInjection({ Page }, { options });
		const contextId = await getContextId({ Debugger, Page, Runtime }, { options, debugMessages });
		const pageDataPromise = setupPageDataCapture({ Runtime }, contextId, { options, debugMessages });
		await setupBindings({ Page, Runtime }, contextId, { options, debugMessages });
		await waitDelay(options.browserWaitDelay, { options, debugMessages });
		await capturePageData({ Runtime }, contextId, { options, debugMessages });
		await disableCdpDomains({ Console, Network, Page, Runtime }, { options });
		return await finalizePageData(pageDataPromise, { options, consoleMessages, debugMessages, httpInfo });
	} catch (error) {
		if (shouldRetryWithFallback(error)) {
			return await retryWithFallback();
		}
		attachDebugInfo(error, { options, consoleMessages, debugMessages });
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

	function shouldRetryWithFallback(error) {
		return error.code === LOAD_TIMEOUT_ERROR &&
			options.browserWaitUntilFallback &&
			options.browserWaitUntil &&
			NETWORK_STATES.indexOf(options.browserWaitUntil) < NETWORK_STATES.length - 1;
	}

	async function retryWithFallback() {
		const browserWaitUntil = NETWORK_STATES[(NETWORK_STATES.indexOf(options.browserWaitUntil) + 1)];
		if (options.debugMessagesFile) {
			debugMessages.push([Date.now(), ["Retrying with waitUntil", browserWaitUntil]]);
		}
		options.browserWaitUntil = browserWaitUntil;
		await closeTarget();
		return await getPageData(options);
	}

	async function closeTarget() {
		if (targetInfo && !options.browserDebug) {
			await CDP.closeTarget(targetInfo.id);
			targetInfo = null;
		}
	}
}

async function setupConsoleLogging({ Console }, { options, consoleMessages, debugMessages }) {
	if (options.consoleMessagesFile) {
		if (options.debugMessagesFile) {
			debugMessages.push([Date.now(), ["Enabling console messages"]]);
		}
		await Console.enable();
		Console.addEventListener("messageAdded", ({ params }) => {
			consoleMessages.push(params.message);
		});
	}
}

async function setupBrowserWindow({ Browser }, targetId, { options, debugMessages }) {
	if (options.browserStartMinimized) {
		const { windowId, bounds } = await Browser.getWindowForTarget({ targetId });
		if (bounds.windowState !== MINIMIZED_WINDOW_STATE) {
			if (options.debugMessagesFile) {
				debugMessages.push([Date.now(), ["Minimizing window"]]);
			}
			await Browser.setWindowBounds({ windowId, bounds: { windowState: MINIMIZED_WINDOW_STATE } });
		}
	}
}

async function setupSecurity({ Security }, { options, debugMessages }) {
	if (options.browserIgnoreHTTPSErrors !== undefined && options.browserIgnoreHTTPSErrors) {
		if (options.debugMessagesFile) {
			debugMessages.push([Date.now(), ["Ignoring HTTPS errors"]]);
		}
		await Security.setIgnoreCertificateErrors({ ignore: true });
	}
}

async function setupDeviceEmulation({ Browser, Emulation, Runtime }, { options, debugMessages }) {
	const needsDeviceMetrics = options.browserMobileEmulation || options.browserDeviceWidth ||
		options.browserDeviceHeight || options.browserDeviceScaleFactor;
	const needsUserAgent = options.browserMobileEmulation || options.platform || options.acceptLanguage;
	if (needsDeviceMetrics) {
		await setupDeviceMetrics({ Emulation, Runtime }, { options, debugMessages });
	}
	if (needsUserAgent) {
		await setupUserAgent({ Browser, Emulation }, { options, debugMessages });
	}
}

async function setupDeviceMetrics({ Emulation, Runtime }, { options, debugMessages }) {
	const browserDeviceWidth = options.browserDeviceWidth ||
		(await Runtime.evaluate({ expression: "window.innerWidth" })).result.value;
	const browserDeviceHeight = options.browserDeviceHeight ||
		(await Runtime.evaluate({ expression: "window.innerHeight" })).result.value;
	const browserDeviceScaleFactor = options.browserDeviceScaleFactor ||
		(await Runtime.evaluate({ expression: "window.devicePixelRatio" })).result.value;
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

async function setupUserAgent({ Browser, Emulation }, { options, debugMessages }) {
	const { userAgent, product } = await Browser.getVersion();
	const defaultMobileUA = `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) ${product} Mobile Safari/537.36`;
	const agentOptions = {
		userAgent: options.userAgent || (options.browserMobileEmulation ? defaultMobileUA : userAgent)
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

async function setupNetworkInterception({ Browser, Emulation, Fetch, Network }, { options, debugMessages, httpInfo }) {
	const handleAuthRequests = Boolean(options.httpProxyUsername);
	const patterns = handleAuthRequests ?
		[{ requestStage: "Request" }, { requestStage: "Response" }] :
		[{ requestStage: "Response" }];
	await Fetch.enable({ handleAuthRequests, patterns });
	if (handleAuthRequests) {
		setupProxyAuth({ Fetch }, { options, debugMessages });
	}
	setupRequestInterception({ Fetch }, { options, debugMessages, httpInfo });
	if (options.httpHeaders) {
		await setupHttpHeaders({ Network }, { options, debugMessages });
	}
	if (options.emulateMediaFeatures) {
		await setupMediaFeatures({ Emulation }, { options, debugMessages });
	}
	if (options.browserCookies && options.browserCookies.length) {
		await setupCookies({ Network }, { options, debugMessages });
	}
	await Browser.setDownloadBehavior({ behavior: "deny" });
}

function setupProxyAuth({ Fetch }, { options, debugMessages }) {
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

function setupRequestInterception({ Fetch }, { options, debugMessages, httpInfo }) {
	const urlState = { url: options.url, alternativeUrl: getAlternativeUrl(options.url) };
	Fetch.addEventListener("requestPaused", async ({ params }) => {
		const { requestId, request } = params;
		captureHttpInfo(params, urlState, { options, debugMessages, httpInfo });
		if (shouldBlockRequest(request.url)) {
			try {
				await Fetch.failRequest({ requestId, errorReason: "Aborted" });
				return;
			} catch {
				// ignored
			}
		}
		try {
			await Fetch.continueRequest({ requestId });
		} catch {
			// ignored
		}
	});

	function shouldBlockRequest(requestUrl) {
		if (!options.blockedURLPatterns || !options.blockedURLPatterns.length) {
			return false;
		}
		const blockedURL = options.blockedURLPatterns.find(pattern =>
			new RegExp(pattern).test(requestUrl)
		);
		if (blockedURL) {
			if (options.debugMessagesFile) {
				debugMessages.push([Date.now(), ["Blocking request", requestUrl]]);
			}
			return true;
		}
		return false;
	}
}

function captureHttpInfo(params, urlState, { options, debugMessages, httpInfo }) {
	const { request, resourceType, responseHeaders, responseStatusCode, responseStatusText } = params;
	const shouldCapture = resourceType === "Document" &&
		options.outputJson &&
		!httpInfo.request &&
		responseStatusCode !== undefined &&
		(request.url === urlState.url || request.url === urlState.alternativeUrl);
	if (shouldCapture) {
		if (REDIRECT_STATUS_CODES.includes(responseStatusCode)) {
			const redirect = responseHeaders.find(header => header.name.toLowerCase() === "location")?.value;
			if (redirect) {
				urlState.url = new URL(redirect, urlState.url).href;
			}
			if (options.debugMessagesFile) {
				debugMessages.push([Date.now(), ["Redirecting", urlState.url]]);
			}
		} else {
			Object.assign(httpInfo, {
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
			});
		}
	}
}

async function setupHttpHeaders({ Network }, { options, debugMessages }) {
	if (options.debugMessagesFile) {
		debugMessages.push([Date.now(), ["Setting HTTP headers", JSON.stringify(options.httpHeaders)]]);
	}
	await Network.enable();
	await Network.setExtraHTTPHeaders({ headers: options.httpHeaders });
}

async function setupMediaFeatures({ Emulation }, { options, debugMessages }) {
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

async function setupCookies({ Network }, { options, debugMessages }) {
	if (options.debugMessagesFile) {
		debugMessages.push([Date.now(), ["Setting cookies", JSON.stringify(options.browserCookies)]]);
	}
	await Network.setCookies({ cookies: options.browserCookies });
}

async function setupScriptInjection({ Page }, { options }) {
	await Page.addScriptToEvaluateOnNewDocument({
		source: getHookScriptSource(),
		runImmediately: true
	});
	await Page.addScriptToEvaluateOnNewDocument({
		source: await getScriptSource(options),
		runImmediately: true,
		worldName: SINGLE_FILE_WORLD_NAME
	});
}

async function getContextId({ Debugger, Page, Runtime }, { options, debugMessages }) {
	const [contextId] = await Promise.all([
		loadPage({ Page, Runtime }, { options, debugMessages }),
		options.browserDebug ? waitForDebuggerReady() : Promise.resolve()
	]);
	return contextId;

	async function waitForDebuggerReady() {
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
	}
}

async function loadPage({ Page, Runtime }, { options, debugMessages }) {
	await Runtime.enable();
	await Page.enable();
	const loadTimeoutAbortController = new AbortController();
	const loadTimeoutAbortSignal = loadTimeoutAbortController.signal;
	try {
		if (options.debugMessagesFile) {
			debugMessages.push([Date.now(), ["Loading page", options.url]]);
		}
		const [contextId] = await Promise.race([
			Promise.all([getTopFrameContextId({ Page, Runtime }, { options, debugMessages }), Page.navigate({ url: options.url })]),
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

async function getTopFrameContextId({ Page, Runtime }, { options, debugMessages }) {
	await Page.setLifecycleEventsEnabled({ enabled: true });
	const state = { topFrameId: undefined, contextIds: [] };
	const removeContextListener = setupContextCreatedListener({ Runtime }, state);
	try {
		await waitForPageReadyState({ Page }, state, { options, debugMessages });
		const contextId = await findValidSingleFileContext({ Runtime }, state.contextIds, { options, debugMessages });
		return contextId;
	} finally {
		removeContextListener();
		await Page.setLifecycleEventsEnabled({ enabled: false });
	}
}

function setupContextCreatedListener({ Runtime }, state) {
	const onContextCreated = ({ params }) => {
		const { context } = params;
		if (context.name === SINGLE_FILE_WORLD_NAME && context.auxData?.frameId === state.topFrameId) {
			state.contextIds.push(context.id);
		}
	};
	Runtime.addEventListener("executionContextCreated", onContextCreated);
	return () => Runtime.removeEventListener("executionContextCreated", onContextCreated);
}

async function waitForPageReadyState({ Page }, state, { options, debugMessages }) {
	await new Promise((resolve, reject) => {
		const timeoutState = { timeoutId: undefined };
		const cleanup = () => {
			Page.removeEventListener("lifecycleEvent", onLifecycleEvent);
			Page.removeEventListener("frameNavigated", onFrameNavigated);
		};
		const onLifecycleEvent = createLifecycleEventHandler(state, timeoutState, resolve, cleanup, { options, debugMessages });
		const onFrameNavigated = createFrameNavigatedHandler(state, timeoutState, reject, cleanup, { options, debugMessages });
		Page.addEventListener("lifecycleEvent", onLifecycleEvent);
		Page.addEventListener("frameNavigated", onFrameNavigated);
	});
}

function createLifecycleEventHandler(state, timeoutState, resolve, cleanup, { options, debugMessages }) {
	return ({ params }) => {
		const { frameId, name } = params;
		if (frameId === state.topFrameId) {
			if (options.debugMessagesFile) {
				debugMessages.push([Date.now(), ["Detecting lifecycle event", name]]);
			}
			const shouldResolve = name === options.browserWaitUntil ||
				(timeoutState.timeoutId && NETWORK_STATES.indexOf(name) < NETWORK_STATES.indexOf(options.browserWaitUntil));
			if (shouldResolve) {
				clearTimeout(timeoutState.timeoutId);
				if (options.debugMessagesFile) {
					debugMessages.push([Date.now(), [`Waiting ${options.browserWaitUntilDelay} ms`]]);
				}
				setTimeout(() => {
					if (options.debugMessagesFile) {
						debugMessages.push([Date.now(), ["Detecting page ready"]]);
					}
					cleanup();
					resolve();
				}, options.browserWaitUntilDelay);
			}
		}
	};
}

function createFrameNavigatedHandler(state, timeoutState, reject, cleanup, { options, debugMessages }) {
	return ({ params }) => {
		const { frame } = params;
		if (!frame.parentId) {
			if (frame.unreachableUrl) {
				clearTimeout(timeoutState.timeoutId);
				cleanup();
				reject(new Error("Unreachable URL: " + frame.unreachableUrl));
			} else {
				if (options.debugMessagesFile) {
					debugMessages.push([Date.now(), ["Detecting top frame ID"]]);
				}
				state.topFrameId = frame.id;
			}
		}
	};
}

async function findValidSingleFileContext({ Runtime }, contextIds, { options, debugMessages }) {
	if (options.debugMessagesFile) {
		debugMessages.push([Date.now(), ["Getting execution context"]]);
	}
	if (!contextIds.length) {
		throw new Error("Execution context not found for SingleFile world");
	}
	for (const contextId of contextIds) {
		try {
			const { result } = await Runtime.evaluate({
				expression: "typeof singlefile !== 'undefined'",
				contextId
			});
			if (result.value === true) {
				return contextId;
			}
		} catch {
			// ignored
		}
	}
	throw new Error("No valid SingleFile execution context found");
}

function setupPageDataCapture({ Runtime }, contextId, { options, debugMessages }) {
	return new Promise(resolve => {
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
}

async function setupBindings({ Page, Runtime }, contextId, { options, debugMessages }) {
	await Runtime.addBinding({ name: SET_PAGE_DATA_FUNCTION_NAME, executionContextId: contextId });
	if (options.embedScreenshot && options.compressContent) {
		await setupScreenshotCapture({ Page, Runtime }, contextId, { options, debugMessages });
	}
	if (options.embedPdf) {
		await setupPdfCapture({ Page, Runtime }, contextId, { options, debugMessages });
	}
	await Runtime.addBinding({ name: FETCH_FUNCTION_NAME, executionContextId: contextId });
	Runtime.addEventListener("bindingCalled", async ({ params }) => {
		if (params.name === FETCH_FUNCTION_NAME) {
			await handleFetchRequest({ Runtime }, params, contextId, { options, debugMessages });
		}
	});
}

async function setupScreenshotCapture({ Page, Runtime }, contextId, { options, debugMessages }) {
	await Runtime.addBinding({ name: CAPTURE_SCREENSHOT_FUNCTION_NAME, executionContextId: contextId });
	Runtime.addEventListener("bindingCalled", async ({ params }) => {
		if (params.name === CAPTURE_SCREENSHOT_FUNCTION_NAME) {
			if (options.debugMessagesFile) {
				debugMessages.push([Date.now(), ["Capturing screenshot"]]);
			}
			try {
				const screenshotOptions = parseScreenshotOptions(options.embedScreenshotOptions);
				const { data } = await Page.captureScreenshot(screenshotOptions);
				await callBrowserFunction({ Runtime }, contextId, SET_SCREENSHOT_FUNCTION_NAME, [data]);
			} catch {
				await callBrowserFunction({ Runtime }, contextId, SET_SCREENSHOT_FUNCTION_NAME, [""]);
			}
		}
	});

	function parseScreenshotOptions(optionsString) {
		let screenshotOptions = { captureBeyondViewport: true };
		if (optionsString) {
			try {
				screenshotOptions = JSON.parse(optionsString);
			} catch {
				// ignored
			}
		}
		screenshotOptions.format = "png";
		return screenshotOptions;
	}
}

async function setupPdfCapture({ Page, Runtime }, contextId, { options, debugMessages }) {
	await Runtime.addBinding({ name: PRINT_TO_PDF_FUNCTION_NAME, executionContextId: contextId });
	Runtime.addEventListener("bindingCalled", async ({ params }) => {
		if (params.name !== PRINT_TO_PDF_FUNCTION_NAME) {
			if (options.debugMessagesFile) {
				debugMessages.push([Date.now(), ["Printing to PDF", options.embedPdfOptions || ""]]);
			}
			const pdfOptions = parsePdfOptions(options.embedPdfOptions);
			try {
				const { data } = await Page.printToPDF(pdfOptions);
				await callBrowserFunction({ Runtime }, contextId, SET_PDF_FUNCTION_NAME, [data]);
			} catch {
				await callBrowserFunction({ Runtime }, contextId, SET_PDF_FUNCTION_NAME, [""]);
			}
		}
	});

	function parsePdfOptions(optionsString) {
		let pdfOptions = {};
		if (optionsString) {
			try {
				pdfOptions = JSON.parse(optionsString);
			} catch {
				// ignored
			}
		}
		return pdfOptions;
	}
}

async function handleFetchRequest({ Runtime }, params, contextId, { options, debugMessages }) {
	const { payload } = params;
	const { requestId, url, options: fetchOptions } = JSON.parse(payload);
	if (options.debugMessagesFile) {
		debugMessages.push([Date.now(), ["Fetching URL", url]]);
	}
	try {
		const response = await fetch(url, fetchOptions);
		const arrayBuffer = await response.arrayBuffer();
		const base64Data = arrayBufferToBase64(arrayBuffer);
		const result = {
			status: response.status,
			headers: Object.fromEntries(response.headers.entries()),
			data: base64Data
		};
		await callBrowserFunction({ Runtime }, contextId, RESOLVE_FETCH_FUNCTION_NAME, [requestId, result]);
	} catch (error) {
		const errorResult = {
			error: error.message,
			code: error.code
		};
		await callBrowserFunction({ Runtime }, contextId, REJECT_FETCH_FUNCTION_NAME, [requestId, errorResult]);
	}
}

async function callBrowserFunction({ Runtime }, contextId, functionName, args) {
	const serializedArgs = args.map(arg => JSON.stringify(arg)).join(", ");
	await Runtime.evaluate({
		expression: `globalThis.${functionName}(${serializedArgs})`,
		contextId
	});
}

async function waitDelay(delay, { options, debugMessages }) {
	if (options.browserWaitDelay) {
		if (options.debugMessagesFile) {
			debugMessages.push([Date.now(), [`Waiting ${delay} ms`]]);
		}
		await new Promise(resolve => setTimeout(resolve, delay));
	}
}

async function capturePageData({ Runtime }, contextId, { options, debugMessages }) {
	const captureTimeoutAbortController = new AbortController();
	const captureTimeoutAbortSignal = captureTimeoutAbortController.signal;
	try {
		if (options.debugMessagesFile) {
			debugMessages.push([Date.now(), ["Capturing page"]]);
		}
		const captureScript = `(${getPageDataScriptSource.toString()})(${JSON.stringify(options)},${JSON.stringify([
			SET_SCREENSHOT_FUNCTION_NAME,
			SET_PDF_FUNCTION_NAME,
			SET_PAGE_DATA_FUNCTION_NAME,
			CAPTURE_SCREENSHOT_FUNCTION_NAME,
			PRINT_TO_PDF_FUNCTION_NAME
		])})`;
		const { result } = await Promise.race([
			Runtime.evaluate({
				expression: captureScript,
				awaitPromise: true,
				returnByValue: true,
				contextId
			}),
			waitForTimeout(captureTimeoutAbortSignal, options.browserCaptureMaxTime, "Capture timeout", CAPTURE_TIMEOUT_ERROR)
		]);
		if (result.subtype === "error") {
			throw new Error(result.description);
		}
	} finally {
		if (!captureTimeoutAbortSignal.aborted) {
			captureTimeoutAbortController.abort();
		}
	}
}

async function disableCdpDomains({ Console, Network, Page, Runtime }, { options }) {
	await Runtime.disable();
	await Page.disable();
	if (options.httpHeaders) {
		await Network.disable();
	}
	if (options.consoleMessagesFile) {
		await Console.disable();
	}
}

async function finalizePageData(pageDataPromise, { options, consoleMessages, debugMessages, httpInfo }) {
	const pageData = await pageDataPromise;
	if (options.consoleMessagesFile) {
		pageData.consoleMessages = consoleMessages;
	}
	if (options.debugMessagesFile) {
		pageData.debugMessages = debugMessages;
		debugMessages.push([Date.now(), ["Returning page data"]]);
	}
	Object.assign(pageData, httpInfo);
	return pageData;
}

function attachDebugInfo(error, { options, consoleMessages, debugMessages }) {
	if (options.consoleMessagesFile) {
		error.consoleMessages = consoleMessages;
	}
	if (options.debugMessagesFile) {
		error.debugMessages = debugMessages;
	}
}

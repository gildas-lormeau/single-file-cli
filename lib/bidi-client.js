/*
 * Copyright 2010-2026 Gildas Lormeau
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

/* global setTimeout, clearTimeout, URL, AbortController, TextDecoder, window, btoa, ReadableStream, WritableStream */

import {
	launchFirefox,
	closeFirefox,
	hasFirefoxExited,
	getFirefoxOptions
} from "./firefox.js";
import { connect } from "./bidi.js";
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
import { webStreamsPonyfill } from "./single-file-bundle.js";

const LOAD_TIMEOUT_ERROR = "ERR_LOAD_TIMEOUT";
const CAPTURE_TIMEOUT_ERROR = "ERR_CAPTURE_TIMEOUT";
const NETWORK_STATES = ["InteractiveTime", "networkIdle", "networkAlmostIdle", "load", "DOMContentLoaded"];
const NETWORK_IDLE_STATE = "networkIdle";
const NETWORK_ALMOST_IDLE_STATE = "networkAlmostIdle";
const LOAD_STATE = "load";
const DOM_CONTENT_LOADED_STATE = "DOMContentLoaded";
const INTERACTIVE_TIME_STATE = "InteractiveTime";
const MOBILE_VIEWPORT_WIDTH = 360;
const MOBILE_VIEWPORT_HEIGHT = 800;
const MOBILE_DEVICE_SCALE_FACTOR = 2;
const NETWORK_IDLE_DELAY = 500;
const NETWORK_ALMOST_IDLE_MAX_REQUESTS = 2;
const SINGLE_FILE_SANDBOX_NAME = "singlefile";
const CAPTURE_SCREENSHOT_FUNCTION_NAME = "captureScreenshot";
const PRINT_TO_PDF_FUNCTION_NAME = "printToPDF";
const SET_SCREENSHOT_FUNCTION_NAME = "setScreenshot";
const SET_PDF_FUNCTION_NAME = "setPDF";
const SET_PAGE_DATA_FUNCTION_NAME = "setPageData";
const SINGLE_FILE_GLOBAL_DECLARATION = /var singlefile\s*=\s*/;
const SINGLE_FILE_GLOBAL_ASSIGNMENT = "globalThis.singlefile=window.singlefile=";
const SERVER_CONNECT_TIMEOUT = 30000;
const SESSION_TIMEOUT = 120000;
const SERVER_SESSION_PATH = "/session";
const WEB_SOCKET_PROTOCOLS = { "http:": "ws:", "https:": "wss:" };
const BROWSER_EXITED_MAX_DELAY = 2000;
const USER_AGENT_HEADER_NAME = "user-agent";
const INCHES_TO_CENTIMETERS = 2.54;
const CONSOLE_LOG_TYPE = "console";
const CONSOLE_API_SOURCE = "console-api";
const JAVASCRIPT_SOURCE = "javascript";
const WARNING_LEVEL = "warning";
const WARN_LEVEL = "warn";
const SESSION_EVENTS = [
	"browsingContext.contextCreated",
	"browsingContext.contextDestroyed",
	"browsingContext.navigationStarted",
	"browsingContext.navigationFailed",
	"browsingContext.domContentLoaded",
	"browsingContext.load",
	"network.beforeRequestSent",
	"network.responseStarted",
	"network.responseCompleted",
	"network.fetchError",
	"network.authRequired",
	"script.message"
];
const CONSOLE_EVENT = "log.entryAdded";
const PROXY_AUTHENTICATION_REQUIRED_STATUS = 407;
const NO_TIMEOUT = { timeout: 0 };

let session, browserInfo = {};

export {
	initialize,
	getPageData,
	closeBrowser
};

async function initialize(singleFileOptions) {
	let server;
	if (singleFileOptions.browserServer) {
		server = { url: getServerUrl(singleFileOptions.browserServer), timeout: SERVER_CONNECT_TIMEOUT };
	} else {
		server = await launchFirefox(getFirefoxOptions(singleFileOptions));
	}
	try {
		session = await connect(server.url, { timeout: server.timeout, isClosed: hasFirefoxExited });
		const { capabilities } = await session.send("session.new", {
			capabilities: {
				alwaysMatch: {
					acceptInsecureCerts: Boolean(singleFileOptions.browserIgnoreHTTPSErrors)
				}
			}
		}, { timeout: SESSION_TIMEOUT });
		browserInfo = { userAgent: capabilities.userAgent, browserName: capabilities.browserName, browserVersion: capabilities.browserVersion };
	} catch (error) {
		await closeBrowser();
		throw error;
	}
}

function getServerUrl(browserServer) {
	const url = new URL(browserServer);
	if (WEB_SOCKET_PROTOCOLS[url.protocol]) {
		url.protocol = WEB_SOCKET_PROTOCOLS[url.protocol];
		if (url.pathname == "/") {
			url.pathname = SERVER_SESSION_PATH;
		}
	}
	return url.href;
}

async function closeBrowser() {
	if (session) {
		try {
			await Promise.race([
				session.send("session.end"),
				new Promise(resolve => setTimeout(resolve, BROWSER_EXITED_MAX_DELAY))
			]);
		} catch {
			// ignored
		}
		session.close();
		session = undefined;
	}
	await closeFirefox();
}

async function getPageData(options) {
	const blockedURLPatterns = (options.blockedURLPatterns || []).map(pattern => new RegExp(pattern));
	const pageContext = {
		options,
		consoleMessages: [],
		debugMessages: [],
		httpInfo: {},
		browserInfo,
		blockedURLPatterns,
		fetchAbortController: new AbortController(),
		listeners: [],
		preloadScripts: [],
		subscriptions: [],
		intercepts: []
	};
	let context;
	try {
		logData(["Creating tab"], pageContext);
		({ context } = await session.send("browsingContext.create", { type: "tab" }));
		pageContext.context = context;
		pageContext.contexts = new Set([context]);
		await setupSubscriptions(pageContext);
		setupContextTracking(pageContext);
		setupConsoleLogging(pageContext);
		await setupDeviceEmulation(pageContext);
		await setupNetwork(pageContext);
		await setupScriptInjection(pageContext);
		const pageDataPromise = setupPageDataCapture(pageContext);
		setupFetchRequests(pageContext);
		await loadPage(pageContext);
		await checkSingleFileContext(pageContext);
		await capturePageData(pageContext);
		return await finalizePageData(pageDataPromise, pageContext);
	} catch (error) {
		attachDebugInfo(error, pageContext);
		throw error;
	} finally {
		logData(["Closing tab"], pageContext);
		pageContext.fetchAbortController.abort();
		await cleanup(pageContext);
		logData(["Finishing"], pageContext);
	}
}

async function setupSubscriptions({ options, context, subscriptions }) {
	const events = options.consoleMessagesFile ? SESSION_EVENTS.concat(CONSOLE_EVENT) : SESSION_EVENTS;
	const result = await session.send("session.subscribe", { events, contexts: [context] });
	if (result && result.subscription) {
		subscriptions.push(result.subscription);
	}
}

function setupContextTracking(pageContext) {
	const { contexts } = pageContext;
	listen(pageContext, "browsingContext.contextCreated", params => {
		if (params.parent && contexts.has(params.parent)) {
			contexts.add(params.context);
		}
	});
	listen(pageContext, "browsingContext.contextDestroyed", params => {
		if (params.context !== pageContext.context) {
			contexts.delete(params.context);
		}
	});
}

function isOwnContext(pageContext, params) {
	return params.context !== null && params.context !== undefined && pageContext.contexts.has(params.context);
}

function setupConsoleLogging(pageContext) {
	const { options, context, consoleMessages } = pageContext;
	if (options.consoleMessagesFile) {
		logData(["Enabling console messages"], pageContext);
		listen(pageContext, CONSOLE_EVENT, params => {
			if (params.source && params.source.context === context) {
				const callFrame = params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0];
				consoleMessages.push({
					source: params.type === CONSOLE_LOG_TYPE ? CONSOLE_API_SOURCE : JAVASCRIPT_SOURCE,
					level: params.level === WARN_LEVEL ? WARNING_LEVEL : params.level,
					text: params.text,
					url: callFrame && callFrame.url,
					line: callFrame && callFrame.lineNumber,
					column: callFrame && callFrame.columnNumber,
					timestamp: params.timestamp
				});
			}
		});
	}
}

async function setupDeviceEmulation(pageContext) {
	const { options, context } = pageContext;
	const viewportOptions = { context };
	const width = options.browserDeviceWidth || (options.browserMobileEmulation ? MOBILE_VIEWPORT_WIDTH : options.browserWidth);
	const height = options.browserDeviceHeight || (options.browserMobileEmulation ? MOBILE_VIEWPORT_HEIGHT : options.browserHeight);
	if (width && height) {
		viewportOptions.viewport = { width, height };
	}
	const devicePixelRatio = options.browserDeviceScaleFactor || (options.browserMobileEmulation ? MOBILE_DEVICE_SCALE_FACTOR : undefined);
	if (devicePixelRatio) {
		viewportOptions.devicePixelRatio = devicePixelRatio;
	}
	if (viewportOptions.viewport || viewportOptions.devicePixelRatio) {
		logData(["Emulating viewport", JSON.stringify(viewportOptions)], pageContext);
		await session.send("browsingContext.setViewport", viewportOptions);
	}
}

async function setupNetwork(pageContext) {
	const { options, context, blockedURLPatterns, intercepts } = pageContext;
	const hasBlockedURLPatterns = blockedURLPatterns.length > 0;
	const hasHttpHeaders = Boolean(options.httpHeaders) && Object.keys(options.httpHeaders).length > 0;
	const handleAuthRequests = Boolean(options.httpProxyUsername);
	const phases = [];
	if (hasBlockedURLPatterns || hasHttpHeaders) {
		phases.push("beforeRequestSent");
	}
	if (handleAuthRequests) {
		phases.push("authRequired");
	}
	if (phases.length) {
		const { intercept } = await session.send("network.addIntercept", { phases, contexts: [context] });
		intercepts.push(intercept);
	}
	if (handleAuthRequests) {
		listen(pageContext, "network.authRequired", ignoringErrors(async params => {
			if (!params.isBlocked || !isOwnContext(pageContext, params)) {
				return;
			}
			const requestId = params.request.request;
			if (params.response.status === PROXY_AUTHENTICATION_REQUIRED_STATUS) {
				logData(["Authenticating"], pageContext);
				await session.send("network.continueWithAuth", {
					request: requestId,
					action: "provideCredentials",
					credentials: { type: "password", username: options.httpProxyUsername, password: options.httpProxyPassword }
				});
			} else {
				await session.send("network.continueWithAuth", { request: requestId, action: "default" });
			}
		}, pageContext));
	}
	if (hasBlockedURLPatterns || hasHttpHeaders) {
		listen(pageContext, "network.beforeRequestSent", ignoringErrors(async params => {
			if (!params.isBlocked || !isOwnContext(pageContext, params)) {
				return;
			}
			const requestId = params.request.request;
			if (blockedURLPatterns.some(pattern => pattern.test(params.request.url))) {
				logData(["Blocking request", params.request.url], pageContext);
				await session.send("network.failRequest", { request: requestId });
			} else if (hasHttpHeaders) {
				await session.send("network.continueRequest", { request: requestId, headers: getMergedHeaders(params.request.headers, options.httpHeaders) });
			} else {
				await session.send("network.continueRequest", { request: requestId });
			}
		}, pageContext));
	}
	if (options.outputJson) {
		setupHttpInfoCapture(pageContext);
	}
	if (options.browserCookies && options.browserCookies.length) {
		await setupCookies(pageContext);
	}
}

function getMergedHeaders(requestHeaders, extraHeaders) {
	const headers = new Map();
	requestHeaders.forEach(header => headers.set(header.name.toLowerCase(), header));
	Object.entries(extraHeaders).forEach(([name, value]) => headers.set(name.toLowerCase(), { name, value: { type: "string", value } }));
	return Array.from(headers.values());
}

function setupHttpInfoCapture(pageContext) {
	const REDIRECT_STATUS_CODES = [301, 302, 303, 307, 308];
	const DOCUMENT_RESOURCE_TYPE = "Document";
	const { options, context, httpInfo } = pageContext;
	const urlState = { url: options.url, alternativeUrl: getAlternativeUrl(options.url) };
	listen(pageContext, "network.responseStarted", params => {
		const { request, response, navigation } = params;
		const shouldCapture = params.context === context && navigation && !httpInfo.request &&
			(request.url === urlState.url || request.url === urlState.alternativeUrl);
		if (shouldCapture) {
			if (REDIRECT_STATUS_CODES.includes(response.status)) {
				const redirect = getHeaderValue(response.headers, "location");
				if (redirect) {
					urlState.url = new URL(redirect, urlState.url).href;
				}
				logData(["Redirecting", urlState.url], pageContext);
			} else {
				Object.assign(httpInfo, {
					request: {
						url: request.url,
						method: request.method,
						headers: getHeadersObject(request.headers)
					},
					resourceType: DOCUMENT_RESOURCE_TYPE,
					response: {
						status: response.status,
						statusText: response.statusText,
						headers: response.headers.map(header => ({ name: header.name, value: header.value.value }))
					}
				});
			}
		}
	});
}

function getHeaderValue(headers, name) {
	const header = headers.find(header => header.name.toLowerCase() === name);
	return header && header.value.value;
}

function getHeadersObject(headers) {
	return Object.fromEntries(headers.map(header => [header.name, header.value.value]));
}

async function setupCookies(pageContext) {
	const { options } = pageContext;
	logData(["Setting cookies", JSON.stringify(options.browserCookies)], pageContext);
	for (const cookie of options.browserCookies) {
		const domain = cookie.domain || (cookie.url && new URL(cookie.url).hostname);
		const cookieParams = {
			name: cookie.name,
			value: { type: "string", value: cookie.value },
			domain
		};
		if (cookie.path) {
			cookieParams.path = cookie.path;
		}
		if (cookie.secure !== undefined) {
			cookieParams.secure = cookie.secure;
		}
		if (cookie.httpOnly !== undefined) {
			cookieParams.httpOnly = cookie.httpOnly;
		}
		if (cookie.sameSite) {
			cookieParams.sameSite = cookie.sameSite.toLowerCase();
		}
		if (cookie.expires) {
			cookieParams.expiry = Math.round(cookie.expires);
		}
		await session.send("storage.setCookie", { cookie: cookieParams });
	}
}

async function setupScriptInjection(pageContext) {
	const { options, context, preloadScripts } = pageContext;
	const scriptSource = (await getScriptSource(options)).replace(SINGLE_FILE_GLOBAL_DECLARATION, SINGLE_FILE_GLOBAL_ASSIGNMENT);
	const hookScript = await session.send("script.addPreloadScript", {
		functionDeclaration: "() => {" + getHookScriptSource() + "}",
		contexts: [context]
	});
	preloadScripts.push(hookScript.script);
	const channelNames = [SET_PAGE_DATA_FUNCTION_NAME, FETCH_FUNCTION_NAME];
	if (options.embedScreenshot && options.compressContent) {
		channelNames.push(CAPTURE_SCREENSHOT_FUNCTION_NAME);
	}
	if (options.embedPdf && options.compressContent) {
		channelNames.push(PRINT_TO_PDF_FUNCTION_NAME);
	}
	const parameters = channelNames.map((name, index) => "channel" + index);
	const sandboxPrelude = webStreamsPonyfill + ";(" + installSandboxGlobals.toString() + ")();" +
		channelNames.map((name, index) => "globalThis[" + JSON.stringify(name) + "]=channel" + index + ";").join("");
	const singleFileScript = await session.send("script.addPreloadScript", {
		functionDeclaration: "(" + parameters.join(",") + ") => {" + sandboxPrelude + scriptSource + "}",
		arguments: channelNames.map(name => ({ type: "channel", value: { channel: name } })),
		sandbox: SINGLE_FILE_SANDBOX_NAME,
		contexts: [context]
	});
	preloadScripts.push(singleFileScript.script);
}

function getSingleFileTarget(context) {
	return { context, sandbox: SINGLE_FILE_SANDBOX_NAME };
}

function installSandboxGlobals() {
	const BYTE_PRESERVING_ENCODING = "x-user-defined";
	const BYTE_MASK = 0xff;
	const CHUNK_SIZE = 8192;
	const DEFAULT_BLOB_TYPE = "application/octet-stream";
	const READY_STATE_EMPTY = 0;
	const READY_STATE_LOADING = 1;
	const READY_STATE_DONE = 2;
	const RealBlob = globalThis.Blob;
	const RealFileReader = globalThis.FileReader;
	const RealURL = globalThis.URL;
	const RealCompressionStream = globalThis.CompressionStream;
	const RealDecompressionStream = globalThis.DecompressionStream;
	const realCrypto = globalThis.crypto;
	const nativeFetch = window.fetch.bind(window);
	const byteDecoder = new TextDecoder(BYTE_PRESERVING_ENCODING);

	function encodeUTF8(text) {
		const bytes = [];
		for (let index = 0; index < text.length; index++) {
			let codePoint = text.codePointAt(index);
			if (codePoint > 0xffff) {
				index++;
			}
			if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
				codePoint = 0xfffd;
			}
			if (codePoint < 0x80) {
				bytes.push(codePoint);
			} else if (codePoint < 0x800) {
				bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
			} else if (codePoint < 0x10000) {
				bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
			} else {
				bytes.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
			}
		}
		return new Uint8Array(bytes);
	}

	function binaryStringToBytes(text) {
		const bytes = new Uint8Array(text.length);
		for (let index = 0; index < text.length; index++) {
			bytes[index] = text.charCodeAt(index) & BYTE_MASK;
		}
		return bytes;
	}

	function bytesToBinaryString(bytes) {
		let text = "";
		for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
			text += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK_SIZE));
		}
		return text;
	}

	function isRealBlob(value) {
		return value instanceof RealBlob;
	}

	function isSandboxBlob(value) {
		return value !== null && typeof value == "object" && Object.getPrototypeOf(value) === SandboxBlob.prototype;
	}

	function readRealBlob(blob, method) {
		return new Promise((resolve, reject) => {
			const reader = new RealFileReader();
			reader.onload = () => resolve(reader.result);
			reader.onerror = () => reject(reader.error);
			reader[method](blob);
		});
	}

	function toBytes(part) {
		if (typeof part == "string") {
			return encodeUTF8(part);
		}
		if (ArrayBuffer.isView(part)) {
			return new Uint8Array(part.buffer, part.byteOffset, part.byteLength).slice();
		}
		if (part instanceof ArrayBuffer) {
			return new Uint8Array(part).slice();
		}
		return encodeUTF8(String(part));
	}

	class SandboxBlob {
		#parts;
		#size;
		#type;
		#bytes;
		#range;

		constructor(parts = [], options = {}) {
			this.#type = String(options.type || "").toLowerCase();
			this.#parts = Array.from(parts).map(part => isSandboxBlob(part) || isRealBlob(part) ? part : toBytes(part));
			this.#size = this.#parts.reduce((size, part) => size + (part instanceof Uint8Array ? part.length : part.size), 0);
		}

		static [Symbol.hasInstance](value) {
			return isSandboxBlob(value) || isRealBlob(value);
		}

		get size() {
			return this.#size;
		}

		get type() {
			return this.#type;
		}

		get [Symbol.toStringTag]() {
			return "Blob";
		}

		slice(start = 0, end = this.#size, type = "") {
			const size = this.#size;
			start = start < 0 ? Math.max(size + start, 0) : Math.min(start, size);
			end = end < 0 ? Math.max(size + end, 0) : Math.min(end, size);
			const blob = new SandboxBlob([], { type });
			blob.#range = { source: this, start, end: Math.max(end, start) };
			blob.#size = Math.max(end - start, 0);
			return blob;
		}

		bytesSync() {
			if (!this.#bytes) {
				if (this.#range) {
					this.#bytes = this.#range.source.bytesSync().subarray(this.#range.start, this.#range.end).slice();
				} else {
					if (this.#parts.some(part => !(part instanceof Uint8Array) && !isSandboxBlob(part))) {
						throw new Error("The blob content is not available synchronously");
					}
					this.#bytes = concatenate(this.#parts.map(part => part instanceof Uint8Array ? part : part.bytesSync()), this.#size);
				}
			}
			return this.#bytes;
		}

		async bytes() {
			if (!this.#bytes) {
				if (this.#range) {
					this.#bytes = (await this.#range.source.bytes()).subarray(this.#range.start, this.#range.end).slice();
				} else {
					const chunks = [];
					for (const part of this.#parts) {
						if (part instanceof Uint8Array) {
							chunks.push(part);
						} else if (isSandboxBlob(part)) {
							chunks.push(await part.bytes());
						} else {
							chunks.push(binaryStringToBytes(await readRealBlob(part, "readAsBinaryString")));
						}
					}
					this.#bytes = concatenate(chunks, this.#size);
				}
			}
			return this.#bytes;
		}

		async arrayBuffer() {
			return (await this.bytes()).buffer;
		}

		async text() {
			return new TextDecoder().decode(await this.bytes());
		}

		stream() {
			const blob = this;
			return new ReadableStream({
				async start(controller) {
					controller.enqueue(await blob.bytes());
					controller.close();
				}
			});
		}

		toRealBlob() {
			return new RealBlob([this.bytesSync()], { type: this.#type });
		}
	}

	function concatenate(chunks, size) {
		const bytes = new Uint8Array(size);
		let offset = 0;
		chunks.forEach(chunk => {
			bytes.set(chunk, offset);
			offset += chunk.length;
		});
		return bytes;
	}

	class SandboxFileReader {
		#listeners = new Map();

		constructor() {
			this.result = null;
			this.error = null;
			this.readyState = READY_STATE_EMPTY;
		}

		addEventListener(type, listener) {
			if (!this.#listeners.has(type)) {
				this.#listeners.set(type, new Set());
			}
			this.#listeners.get(type).add(listener);
		}

		removeEventListener(type, listener) {
			const listeners = this.#listeners.get(type);
			if (listeners) {
				listeners.delete(listener);
			}
		}

		dispatch(type) {
			const event = { type, target: this };
			const handler = this["on" + type];
			if (typeof handler == "function") {
				handler.call(this, event);
			}
			const listeners = this.#listeners.get(type);
			if (listeners) {
				Array.from(listeners).forEach(listener => listener.call(this, event));
			}
		}

		abort() {
		}

		readAsDataURL(blob) {
			this.#read(blob, "readAsDataURL", bytes => "data:" + (blob.type || DEFAULT_BLOB_TYPE) + ";base64," + btoa(bytesToBinaryString(bytes)));
		}

		readAsBinaryString(blob) {
			this.#read(blob, "readAsBinaryString", bytes => bytesToBinaryString(bytes));
		}

		readAsText(blob, encoding) {
			this.#read(blob, "readAsText", bytes => new TextDecoder(encoding || "utf-8").decode(bytes));
		}

		readAsArrayBuffer(blob) {
			this.#read(blob, "readAsArrayBuffer", bytes => bytes.slice().buffer);
		}

		#read(blob, method, convert) {
			this.readyState = READY_STATE_LOADING;
			const resultPromise = isRealBlob(blob) ?
				(method == "readAsArrayBuffer" ?
					readRealBlob(blob, "readAsBinaryString").then(text => binaryStringToBytes(text).buffer) :
					readRealBlob(blob, method)) :
				blob.bytes().then(convert);
			resultPromise.then(result => {
				this.result = result;
				this.readyState = READY_STATE_DONE;
				this.dispatch("load");
				this.dispatch("loadend");
			}, error => {
				this.error = error;
				this.readyState = READY_STATE_DONE;
				this.dispatch("error");
				this.dispatch("loadend");
			});
		}
	}
	SandboxFileReader.EMPTY = READY_STATE_EMPTY;
	SandboxFileReader.LOADING = READY_STATE_LOADING;
	SandboxFileReader.DONE = READY_STATE_DONE;

	class SandboxURL extends RealURL {
		static createObjectURL(object) {
			return RealURL.createObjectURL(isSandboxBlob(object) ? object.toRealBlob() : object);
		}

		static revokeObjectURL(url) {
			return RealURL.revokeObjectURL(url);
		}
	}

	class SandboxTextEncoder {
		get encoding() {
			return "utf-8";
		}

		encode(text = "") {
			return encodeUTF8(String(text));
		}

		encodeInto(text, destination) {
			text = String(text);
			let read = 0, written = 0;
			for (const character of text) {
				const bytes = encodeUTF8(character);
				if (written + bytes.length > destination.length) {
					break;
				}
				destination.set(bytes, written);
				written += bytes.length;
				read += character.length;
			}
			return { read, written };
		}
	}

	function createCodecStreamClass(RealCodecStream) {
		return class SandboxCodecStream {
			constructor(format) {
				const codecStream = new RealCodecStream(format);
				const nativeWriter = codecStream.writable.getWriter();
				this.writable = new WritableStream({
					write: chunk => nativeWriter.write(chunk),
					close: () => nativeWriter.close(),
					abort: reason => nativeWriter.abort(reason)
				});
				this.readable = new ReadableStream({
					async start(controller) {
						try {
							const nativeReader = codecStream.readable.getReader();
							for (;;) {
								const { value, done } = await nativeReader.read();
								if (done) {
									break;
								}
								controller.enqueue(binaryStringToBytes(await readRealBlob(new RealBlob([value]), "readAsBinaryString")));
							}
							controller.close();
						} catch (error) {
							controller.error(error);
						}
					}
				});
			}
		};
	}

	async function sandboxFetch(url, options) {
		const response = await nativeFetch(url, options);
		const text = byteDecoder.decode(await response.arrayBuffer());
		return {
			status: response.status,
			statusText: response.statusText,
			ok: response.ok,
			url: response.url,
			headers: response.headers,
			arrayBuffer: () => Promise.resolve(binaryStringToBytes(text).buffer),
			text: () => Promise.resolve(new TextDecoder().decode(binaryStringToBytes(text)))
		};
	}

	globalThis.fetch = sandboxFetch;
	globalThis.Blob = SandboxBlob;
	globalThis.FileReader = SandboxFileReader;
	globalThis.URL = SandboxURL;
	globalThis.TextEncoder = SandboxTextEncoder;
	Object.defineProperty(globalThis, "crypto", {
		value: {
			getRandomValues: array => realCrypto.getRandomValues(array),
			randomUUID: () => realCrypto.randomUUID(),
			subtle: undefined
		},
		configurable: true,
		writable: true
	});
	const streams = globalThis.WebStreamsPolyfill;
	globalThis.ReadableStream = streams.ReadableStream;
	globalThis.WritableStream = streams.WritableStream;
	globalThis.TransformStream = streams.TransformStream;
	globalThis.ByteLengthQueuingStrategy = streams.ByteLengthQueuingStrategy;
	globalThis.CountQueuingStrategy = streams.CountQueuingStrategy;
	globalThis.CompressionStream = createCodecStreamClass(RealCompressionStream);
	globalThis.DecompressionStream = createCodecStreamClass(RealDecompressionStream);
}

function setupPageDataCapture(pageContext) {
	const { context } = pageContext;
	return new Promise((resolve, reject) => {
		let pageDataResponse = "";
		listen(pageContext, "script.message", params => {
			if (params.channel === SET_PAGE_DATA_FUNCTION_NAME && params.source.context === context) {
				const payload = params.data.value;
				if (payload.length) {
					pageDataResponse += payload;
				} else {
					logData(["Setting page data"], pageContext);
					try {
						const result = JSON.parse(pageDataResponse);
						if (result.content instanceof Array) {
							result.content = new Uint8Array(result.content);
						}
						resolve(result);
					} catch (error) {
						reject(error);
					}
				}
			}
		});
	});
}

function setupFetchRequests(pageContext) {
	const { options } = pageContext;
	listen(pageContext, "script.message", ignoringErrors(async params => {
		if (params.channel === FETCH_FUNCTION_NAME) {
			await handleFetchRequest(params, pageContext);
		} else if (params.channel === CAPTURE_SCREENSHOT_FUNCTION_NAME) {
			await handleScreenshotRequest(params, pageContext);
		} else if (params.channel === PRINT_TO_PDF_FUNCTION_NAME) {
			await handlePdfRequest(params, pageContext);
		}
	}, { options, debugMessages: pageContext.debugMessages }));
}

async function handleFetchRequest(params, pageContext) {
	const BLOCKED_URL_ERROR_MESSAGE = "Blocked URL";
	const { options, browserInfo, blockedURLPatterns, fetchAbortController } = pageContext;
	const { realm } = params.source;
	const { requestId, url, options: fetchOptions } = JSON.parse(params.data.value);
	logData(["Fetching URL", url], pageContext);
	try {
		if (blockedURLPatterns.some(pattern => pattern.test(url))) {
			logData(["Blocking request", url], pageContext);
			throw new Error(BLOCKED_URL_ERROR_MESSAGE);
		}
		const headers = Object.assign({}, fetchOptions.headers, options.httpHeaders);
		if (browserInfo.userAgent && !Object.keys(headers).some(name => name.toLowerCase() == USER_AGENT_HEADER_NAME)) {
			headers[USER_AGENT_HEADER_NAME] = browserInfo.userAgent;
		}
		const response = await fetch(url, Object.assign({}, fetchOptions, { headers, signal: fetchAbortController.signal }));
		const arrayBuffer = await response.arrayBuffer();
		const result = {
			status: response.status,
			headers: Object.fromEntries(response.headers.entries()),
			data: arrayBufferToBase64(arrayBuffer)
		};
		await callBrowserFunction(realm, RESOLVE_FETCH_FUNCTION_NAME, [requestId, result]);
	} catch (error) {
		await callBrowserFunction(realm, REJECT_FETCH_FUNCTION_NAME, [requestId, { error: error.message, code: error.code }]);
	}
}

async function handleScreenshotRequest(params, pageContext) {
	const { options, context } = pageContext;
	const { realm } = params.source;
	logData(["Capturing screenshot"], pageContext);
	try {
		const screenshotOptions = { context, origin: "document", format: { type: "image/png" } };
		try {
			const cdpOptions = options.embedScreenshotOptions ? JSON.parse(options.embedScreenshotOptions) : {};
			if (cdpOptions.clip) {
				screenshotOptions.clip = Object.assign({ type: "box" }, cdpOptions.clip);
			}
			if (cdpOptions.captureBeyondViewport === false) {
				screenshotOptions.origin = "viewport";
			}
		} catch {
			// ignored
		}
		const { data } = await session.send("browsingContext.captureScreenshot", screenshotOptions, NO_TIMEOUT);
		await callBrowserFunction(realm, SET_SCREENSHOT_FUNCTION_NAME, [data]);
	} catch {
		await callBrowserFunction(realm, SET_SCREENSHOT_FUNCTION_NAME, [""]);
	}
}

async function handlePdfRequest(params, pageContext) {
	const { options, context } = pageContext;
	const { realm } = params.source;
	logData(["Printing to PDF", options.embedPdfOptions || ""], pageContext);
	try {
		const { data } = await session.send("browsingContext.print", getPrintOptions(context, options.embedPdfOptions), NO_TIMEOUT);
		await callBrowserFunction(realm, SET_PDF_FUNCTION_NAME, [data]);
	} catch {
		await callBrowserFunction(realm, SET_PDF_FUNCTION_NAME, [""]);
	}
}

function getPrintOptions(context, optionsString) {
	const printOptions = { context, background: true };
	let cdpOptions = {};
	if (optionsString) {
		try {
			cdpOptions = JSON.parse(optionsString);
		} catch {
			// ignored
		}
	}
	if (cdpOptions.printBackground !== undefined) {
		printOptions.background = cdpOptions.printBackground;
	}
	if (cdpOptions.landscape) {
		printOptions.orientation = "landscape";
	}
	if (cdpOptions.scale) {
		printOptions.scale = cdpOptions.scale;
	}
	if (cdpOptions.pageRanges) {
		printOptions.pageRanges = String(cdpOptions.pageRanges).split(",").map(range => range.trim());
	}
	if (cdpOptions.paperWidth || cdpOptions.paperHeight) {
		printOptions.page = {};
		if (cdpOptions.paperWidth) {
			printOptions.page.width = cdpOptions.paperWidth * INCHES_TO_CENTIMETERS;
		}
		if (cdpOptions.paperHeight) {
			printOptions.page.height = cdpOptions.paperHeight * INCHES_TO_CENTIMETERS;
		}
	}
	const margins = [["marginTop", "top"], ["marginBottom", "bottom"], ["marginLeft", "left"], ["marginRight", "right"]]
		.filter(([cdpName]) => cdpOptions[cdpName] !== undefined);
	if (margins.length) {
		printOptions.margin = Object.fromEntries(margins.map(([cdpName, name]) => [name, cdpOptions[cdpName] * INCHES_TO_CENTIMETERS]));
	}
	return printOptions;
}

async function callBrowserFunction(realm, functionName, args) {
	await session.send("script.callFunction", {
		functionDeclaration: "(json) => globalThis." + functionName + "(...JSON.parse(json))",
		arguments: [{ type: "string", value: JSON.stringify(args) }],
		target: { realm },
		awaitPromise: false
	});
}

async function loadPage(pageContext) {
	const LOAD_TIMEOUT_ERROR_MESSAGE = "Load timeout";
	const UNREACHABLE_URL_ERROR_MESSAGE = "Unreachable URL";
	const { options, context } = pageContext;
	const waitUntil = options.browserWaitUntil === INTERACTIVE_TIME_STATE ? NETWORK_IDLE_STATE : options.browserWaitUntil;
	const state = { reachedStateIndex: -1, navigation: undefined, pendingRequests: new Set(), loaded: false };
	const loadTimeoutAbortController = new AbortController();
	const loadTimeoutAbortSignal = loadTimeoutAbortController.signal;
	try {
		logData(["Loading page", options.url], pageContext);
		const readyPromise = waitForPageReadyState(state, waitUntil, pageContext);
		const navigatePromise = session.send("browsingContext.navigate", { context, url: options.url, wait: "none" }, NO_TIMEOUT).catch(error => {
			state.settle();
			throw new Error(UNREACHABLE_URL_ERROR_MESSAGE + ": " + options.url + " (" + error.message + ")");
		});
		await Promise.race([
			Promise.all([
				readyPromise,
				navigatePromise
			]),
			waitForTimeout(loadTimeoutAbortSignal, options.browserLoadMaxTime, LOAD_TIMEOUT_ERROR_MESSAGE, LOAD_TIMEOUT_ERROR).catch(async error => {
				if (options.browserWaitUntilFallback && state.reachedStateIndex >= 0) {
					const reachedState = NETWORK_STATES[state.reachedStateIndex];
					logData(["Stopping the page loading, reached state", reachedState], pageContext);
					console.warn(`Warning: ${options.url} did not reach ${options.browserWaitUntil} within ${options.browserLoadMaxTime} ms, captured as it was at ${reachedState}`); // eslint-disable-line no-console
					await session.send("script.evaluate", { expression: "window.stop()", target: { context }, awaitPromise: false });
					state.settle();
					return readyPromise;
				}
				throw error;
			})
		]);
	} finally {
		if (!loadTimeoutAbortSignal.aborted) {
			loadTimeoutAbortController.abort();
		}
	}
}

function waitForPageReadyState(state, waitUntil, pageContext) {
	const UNREACHABLE_URL_ERROR_MESSAGE = "Unreachable URL";
	const { options, context } = pageContext;
	return new Promise((resolve, reject) => {
		const timeoutState = { timeoutId: undefined, idleTimeoutId: undefined };
		const removers = [];
		const cleanup = () => {
			clearTimeout(timeoutState.idleTimeoutId);
			removers.forEach(remover => remover());
		};
		state.settle = () => {
			clearTimeout(timeoutState.timeoutId);
			cleanup();
			resolve();
		};
		removers.push(listen(pageContext, "browsingContext.navigationStarted", params => {
			if (params.context === context) {
				logData(["Detecting navigation", params.url], pageContext);
				clearTimeout(timeoutState.timeoutId);
				clearTimeout(timeoutState.idleTimeoutId);
				timeoutState.timeoutId = undefined;
				state.reachedStateIndex = -1;
				state.loaded = false;
				state.navigation = params.navigation;
				state.pendingRequests.clear();
			}
		}));
		removers.push(listen(pageContext, "browsingContext.navigationFailed", params => {
			if (params.context === context && params.navigation === state.navigation) {
				logData(["Detecting unreachable URL", params.url], pageContext);
				clearTimeout(timeoutState.timeoutId);
				cleanup();
				reject(new Error(UNREACHABLE_URL_ERROR_MESSAGE + ": " + params.url));
			}
		}));
		removers.push(listen(pageContext, "browsingContext.domContentLoaded", params => {
			if (params.context === context && params.navigation === state.navigation) {
				onStateReached(DOM_CONTENT_LOADED_STATE);
			}
		}));
		removers.push(listen(pageContext, "browsingContext.load", params => {
			if (params.context === context && params.navigation === state.navigation) {
				state.loaded = true;
				onStateReached(LOAD_STATE);
				scheduleNetworkIdleCheck();
			}
		}));
		removers.push(listen(pageContext, "network.beforeRequestSent", params => {
			if (isOwnContext(pageContext, params)) {
				state.pendingRequests.add(params.request.request);
				scheduleNetworkIdleCheck();
			}
		}));
		removers.push(listen(pageContext, "network.responseCompleted", params => {
			if (isOwnContext(pageContext, params)) {
				state.pendingRequests.delete(params.request.request);
				scheduleNetworkIdleCheck();
			}
		}));
		removers.push(listen(pageContext, "network.fetchError", params => {
			if (isOwnContext(pageContext, params)) {
				state.pendingRequests.delete(params.request.request);
				scheduleNetworkIdleCheck();
			}
		}));

		function scheduleNetworkIdleCheck() {
			clearTimeout(timeoutState.idleTimeoutId);
			if (state.loaded) {
				timeoutState.idleTimeoutId = setTimeout(() => {
					if (state.pendingRequests.size <= NETWORK_ALMOST_IDLE_MAX_REQUESTS) {
						onStateReached(NETWORK_ALMOST_IDLE_STATE);
					}
					if (state.pendingRequests.size == 0) {
						onStateReached(NETWORK_IDLE_STATE);
					}
				}, NETWORK_IDLE_DELAY);
			}
		}

		function onStateReached(name) {
			logData(["Detecting lifecycle event", name], pageContext);
			const stateIndex = NETWORK_STATES.indexOf(name);
			if (state.reachedStateIndex == -1 || stateIndex < state.reachedStateIndex) {
				state.reachedStateIndex = stateIndex;
			}
			const shouldResolve = name === waitUntil ||
				(timeoutState.timeoutId && stateIndex < NETWORK_STATES.indexOf(waitUntil));
			if (shouldResolve) {
				clearTimeout(timeoutState.timeoutId);
				logData([`Waiting ${options.browserWaitUntilDelay} ms`], pageContext);
				timeoutState.timeoutId = setTimeout(() => {
					logData(["Detecting page ready"], pageContext);
					cleanup();
					resolve();
				}, options.browserWaitUntilDelay);
			}
		}
	});
}

async function checkSingleFileContext(pageContext) {
	const SINGLE_FILE_DETECTION_TEST = "typeof singlefile !== 'undefined'";
	const NO_VALID_CONTEXT_ERROR_MESSAGE = "No valid SingleFile execution context found";
	const { context } = pageContext;
	logData(["Getting execution context"], pageContext);
	const { result } = await session.send("script.evaluate", {
		expression: SINGLE_FILE_DETECTION_TEST,
		target: getSingleFileTarget(context),
		awaitPromise: false
	});
	if (!result || result.value !== true) {
		throw new Error(NO_VALID_CONTEXT_ERROR_MESSAGE);
	}
}

async function capturePageData(pageContext) {
	const CAPTURE_TIMEOUT_ERROR_MESSAGE = "Capture timeout";
	const EXCEPTION_TYPE = "exception";
	const { options, context } = pageContext;
	const captureTimeoutAbortController = new AbortController();
	const captureTimeoutAbortSignal = captureTimeoutAbortController.signal;
	if (options.browserWaitDelay) {
		logData([`Waiting ${options.browserWaitDelay} ms`], pageContext);
		await new Promise(resolve => setTimeout(resolve, options.browserWaitDelay));
	}
	try {
		logData(["Capturing page"], pageContext);
		const captureScript = `(${getPageDataScriptSource.toString()})(${JSON.stringify(options)},${JSON.stringify([
			SET_SCREENSHOT_FUNCTION_NAME,
			SET_PDF_FUNCTION_NAME,
			SET_PAGE_DATA_FUNCTION_NAME,
			CAPTURE_SCREENSHOT_FUNCTION_NAME,
			PRINT_TO_PDF_FUNCTION_NAME
		])})`;
		const result = await Promise.race([
			session.send("script.evaluate", {
				expression: captureScript,
				target: getSingleFileTarget(context),
				awaitPromise: true,
				resultOwnership: "none"
			}, NO_TIMEOUT),
			waitForTimeout(captureTimeoutAbortSignal, options.browserCaptureMaxTime, CAPTURE_TIMEOUT_ERROR_MESSAGE, CAPTURE_TIMEOUT_ERROR)
		]);
		if (result.type === EXCEPTION_TYPE) {
			const { exceptionDetails } = result;
			logData(["Capture exception", JSON.stringify(exceptionDetails)], pageContext);
			throw new Error(exceptionDetails.text || (exceptionDetails.exception && exceptionDetails.exception.value) || "Capture failed");
		}
	} finally {
		if (!captureTimeoutAbortSignal.aborted) {
			captureTimeoutAbortController.abort();
		}
	}
}

async function finalizePageData(pageDataPromise, pageContext) {
	const { options, consoleMessages, debugMessages, httpInfo } = pageContext;
	const pageData = await pageDataPromise;
	logData(["Returning page data"], pageContext);
	if (options.consoleMessagesFile) {
		pageData.consoleMessages = consoleMessages;
	}
	if (options.debugMessagesFile) {
		pageData.debugMessages = debugMessages;
	}
	Object.assign(pageData, httpInfo);
	if (options.browserWaitEndDelay) {
		logData([`Waiting ${options.browserWaitEndDelay} ms after processing`], pageContext);
		await new Promise(resolve => setTimeout(resolve, options.browserWaitEndDelay));
	}
	return pageData;
}

async function cleanup(pageContext) {
	const { options, context, listeners, preloadScripts, subscriptions, intercepts } = pageContext;
	listeners.forEach(([eventName, listener]) => session.removeEventListener(eventName, listener));
	for (const intercept of intercepts) {
		await session.send("network.removeIntercept", { intercept }).catch(() => { });
	}
	for (const script of preloadScripts) {
		await session.send("script.removePreloadScript", { script }).catch(() => { });
	}
	if (subscriptions.length) {
		await session.send("session.unsubscribe", { subscriptions }).catch(() => { });
	}
	if (context && !options.browserDebug) {
		await session.send("browsingContext.close", { context }).catch(() => { });
	}
}

function listen(pageContext, eventName, listener) {
	session.addEventListener(eventName, listener);
	pageContext.listeners.push([eventName, listener]);
	return () => session.removeEventListener(eventName, listener);
}

function attachDebugInfo(error, { options, consoleMessages, debugMessages }) {
	if (options.consoleMessagesFile) {
		error.consoleMessages = consoleMessages;
	}
	if (options.debugMessagesFile) {
		error.debugMessages = debugMessages;
	}
}

function ignoringErrors(listener, pageContext) {
	return async event => {
		try {
			await listener(event);
		} catch (error) {
			logData(["Ignoring event listener error", error.message], pageContext);
		}
	};
}

function logData(data, { options, debugMessages }) {
	if (options.debugMessagesFile) {
		debugMessages.push([Date.now(), data]);
	}
}

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

/* global window, atob, btoa, fetch, Headers, URL, Blob, CompressionStream, DecompressionStream, Response */

import { script, hookScript, zipScript } from "../lib/single-file-bundle.js";
import { Deno } from "./deno-polyfill.js";

const FETCH_FUNCTION_NAME = "__singleFileFetch";
const RESOLVE_FETCH_FUNCTION_NAME = "__singleFileResolveFetch";
const REJECT_FETCH_FUNCTION_NAME = "__singleFileRejectFetch";
const BROTLI_FUNCTION_NAME = "__singleFileBrotli";
const RESOLVE_BROTLI_FUNCTION_NAME = "__singleFileResolveBrotli";
const SCRIPT_READY_PROPERTY_NAME = "__singleFileScriptReady";
const SCRIPT_ERROR_PROPERTY_NAME = "__singleFileScriptError";

const { readTextFile } = Deno;

export {
	FETCH_FUNCTION_NAME,
	RESOLVE_FETCH_FUNCTION_NAME,
	REJECT_FETCH_FUNCTION_NAME,
	BROTLI_FUNCTION_NAME,
	RESOLVE_BROTLI_FUNCTION_NAME,
	SCRIPT_READY_PROPERTY_NAME,
	SCRIPT_ERROR_PROPERTY_NAME,
	getScriptSource,
	getHookScriptSource,
	getZipScriptSource,
	getPageDataScriptSource,
	getPageOptions,
	isStylesheetReferrerEmpty
};

const PROCESS_OPTION_NAMES = [
	"browserCookies",
	"browserCookiesFile",
	"httpHeaders",
	"httpProxyServer",
	"httpProxyUsername",
	"httpProxyPassword"
];

function getPageOptions(options) {
	const pageOptions = Object.assign({}, options);
	PROCESS_OPTION_NAMES.forEach(name => delete pageOptions[name]);
	return pageOptions;
}

function initSingleFile(constants, isStylesheetReferrerEmpty) {
	const nativeFetch = globalThis.fetch;
	const pendingRequests = new Map();
	const pendingBrotliRequests = new Map();
	let lastRequestId = 0;
	let lastBrotliRequestId = 0;
	const { RESOLVE_FETCH_FUNCTION_NAME, REJECT_FETCH_FUNCTION_NAME, FETCH_FUNCTION_NAME, BROTLI_FUNCTION_NAME, RESOLVE_BROTLI_FUNCTION_NAME } = constants;

	globalThis[RESOLVE_FETCH_FUNCTION_NAME] = (requestId, result) => {
		const pendingRequest = pendingRequests.get(requestId);
		if (pendingRequest) {
			pendingRequests.delete(requestId);
			const bytes = decodeBase64(result.data);
			pendingRequest.resolve({
				status: result.status,
				url: result.url,
				headers: new Headers(result.headers),
				arrayBuffer: () => Promise.resolve(bytes.buffer)
			});
		}
	};
	globalThis[REJECT_FETCH_FUNCTION_NAME] = (requestId, error) => {
		const pendingRequest = pendingRequests.get(requestId);
		if (pendingRequest) {
			pendingRequests.delete(requestId);
			const fetchError = new Error(error.error);
			fetchError.code = error.code;
			pendingRequest.reject(fetchError);
		}
	};
	globalThis[RESOLVE_BROTLI_FUNCTION_NAME] = (requestId, result) => {
		const pendingRequest = pendingBrotliRequests.get(requestId);
		if (pendingRequest) {
			pendingBrotliRequests.delete(requestId);
			if (result.error) {
				pendingRequest.reject(new Error(result.error));
			} else {
				pendingRequest.resolve(decodeBase64(result.data));
			}
		}
	};

	window.singlefile.init({
		brotli: {
			compress: data => brotli("compress", data),
			decompress: data => brotli("decompress", data)
		},
		fetch: async (url, options) => {
			try {
				return await nativeFetch(url, isStylesheetReferrerEmpty(url, options) ? { ...options, referrerPolicy: "no-referrer" } : options);
			} catch {
				const requestId = lastRequestId++;
				return new Promise((resolve, reject) => {
					pendingRequests.set(requestId, { resolve, reject });
					globalThis[FETCH_FUNCTION_NAME](JSON.stringify({
						requestId,
						url,
						options,
						documentUrl: window.location.href,
						metaReferrerPolicy: getMetaReferrerPolicy()
					}));
				});
			}
		}
	});

	async function brotli(mode, data) {
		if (globalThis[BROTLI_FUNCTION_NAME]) {
			const requestId = lastBrotliRequestId++;
			return new Promise((resolve, reject) => {
				pendingBrotliRequests.set(requestId, { resolve, reject });
				globalThis[BROTLI_FUNCTION_NAME](JSON.stringify({ requestId, mode, data: encodeBase64(data) }));
			});
		} else {
			const stream = mode == "compress" ? new CompressionStream("brotli") : new DecompressionStream("brotli");
			return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer());
		}
	}

	function encodeBase64(bytes) {
		const CHUNK_SIZE = 32768;
		let binaryString = "";
		for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
			binaryString += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK_SIZE));
		}
		return btoa(binaryString);
	}

	function decodeBase64(base64) {
		const binaryString = atob(base64);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		return bytes;
	}

	function getMetaReferrerPolicy() {
		return Array.from(window.document.querySelectorAll("meta[name=referrer i]"))
			.map(metaElement => metaElement.getAttribute("content") || "")
			.join(",");
	}
}

function isStylesheetReferrerEmpty(url, { stylesheetURL, stylesheetReferrerPolicy } = {}) {
	const HTTP_PROTOCOLS = ["http:", "https:"];
	const DOWNGRADE_EMPTY_POLICIES = ["no-referrer-when-downgrade", "strict-origin", "strict-origin-when-cross-origin"];
	const REFERRER_POLICIES = ["no-referrer", "no-referrer-when-downgrade", "origin", "origin-when-cross-origin", "same-origin", "strict-origin", "strict-origin-when-cross-origin", "unsafe-url"];
	if (!stylesheetURL) {
		return false;
	}
	let stylesheetLocation, location;
	try {
		stylesheetLocation = new URL(stylesheetURL);
		location = new URL(url, stylesheetURL);
	} catch {
		return false;
	}
	if (!HTTP_PROTOCOLS.includes(stylesheetLocation.protocol) || !HTTP_PROTOCOLS.includes(location.protocol)) {
		return true;
	}
	let policy = "strict-origin-when-cross-origin";
	String(stylesheetReferrerPolicy || "").split(",").forEach(value => {
		value = value.trim().toLowerCase();
		if (REFERRER_POLICIES.includes(value)) {
			policy = value;
		}
	});
	const downgrade = stylesheetLocation.protocol == "https:" && location.protocol != "https:";
	return policy == "no-referrer" ||
		(policy == "same-origin" && location.origin != stylesheetLocation.origin) ||
		(downgrade && DOWNGRADE_EMPTY_POLICIES.includes(policy));
}

async function getScriptSource(options, globalAssignment = "") {
	let source = "";
	source += script;
	source += "\n" + globalAssignment;
	source += "\n" + await readScriptFiles(options && options.browserScripts ? options.browserScripts : []);
	if (options.browserStylesheets && options.browserStylesheets.length) {
		source += "\naddEventListener(\"load\",()=>{const styleElement=document.createElement(\"style\");styleElement.textContent=" + JSON.stringify(await readScriptFiles(options.browserStylesheets)) + ";document.body.appendChild(styleElement);});";
	}
	source += "\n(" + initSingleFile.toString() + ")(" + JSON.stringify({
		FETCH_FUNCTION_NAME,
		RESOLVE_FETCH_FUNCTION_NAME,
		REJECT_FETCH_FUNCTION_NAME,
		BROTLI_FUNCTION_NAME,
		RESOLVE_BROTLI_FUNCTION_NAME
	}) + ", " + isStylesheetReferrerEmpty.toString() + ");";
	return "try{" + source + "\nglobalThis." + SCRIPT_READY_PROPERTY_NAME + "=true;}" +
		"catch(error){globalThis." + SCRIPT_ERROR_PROPERTY_NAME + "=String(error);throw error;}";
}

function getHookScriptSource() {
	return hookScript;
}

function getZipScriptSource() {
	return zipScript;
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
			if (event.type == event.RESOURCES_INITIALIZING && window == window.top && !pendingCapture) {
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
	return window.singlefile.getPageData(options).then(data => {
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


async function readScriptFiles(paths) {
	return (await Promise.all(paths.map(path => readTextFile(path)))).join("\n");
}
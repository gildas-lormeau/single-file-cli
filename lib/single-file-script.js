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

/* global window, atob, fetch, Headers */

import { script, hookScript, zipScript } from "../lib/single-file-bundle.js";
import { Deno } from "./deno-polyfill.js";

const FETCH_FUNCTION_NAME = "__singleFileFetch";
const RESOLVE_FETCH_FUNCTION_NAME = "__singleFileResolveFetch";
const REJECT_FETCH_FUNCTION_NAME = "__singleFileRejectFetch";

const { readTextFile } = Deno;

export {
	FETCH_FUNCTION_NAME,
	RESOLVE_FETCH_FUNCTION_NAME,
	REJECT_FETCH_FUNCTION_NAME,
	getScriptSource,
	getHookScriptSource,
	getZipScriptSource,
	getPageDataScriptSource
};

function initSingleFile(constants) {
	const nativeFetch = globalThis.fetch;
	const pendingRequests = new Map();
	let lastRequestId = 0;
	const { RESOLVE_FETCH_FUNCTION_NAME, REJECT_FETCH_FUNCTION_NAME, FETCH_FUNCTION_NAME } = constants;

	globalThis[RESOLVE_FETCH_FUNCTION_NAME] = (requestId, result) => {
		const pendingRequest = pendingRequests.get(requestId);
		if (pendingRequest) {
			pendingRequests.delete(requestId);
			const binaryString = atob(result.data);
			const bytes = new Uint8Array(binaryString.length);
			for (let i = 0; i < binaryString.length; i++) {
				bytes[i] = binaryString.charCodeAt(i);
			}
			pendingRequest.resolve({
				status: result.status,
				headers: new Headers(result.headers),
				arrayBuffer: () => Promise.resolve(bytes.buffer)
			});
		}
	};
	globalThis[REJECT_FETCH_FUNCTION_NAME] = (requestId, error) => {
		const pendingRequest = pendingRequests.get(requestId);
		if (pendingRequest) {
			pendingRequests.delete(requestId);
			pendingRequest.reject(new Error(error.error));
		}
	};

	window.singlefile.init({
		fetch: async (url, options) => {
			try {
				return await nativeFetch(url, options);
			} catch {
				const requestId = lastRequestId++;
				return new Promise((resolve, reject) => {
					pendingRequests.set(requestId, { resolve, reject });
					globalThis[FETCH_FUNCTION_NAME](JSON.stringify({ requestId, url, options }));
				});
			}
		}
	});
}

async function getScriptSource(options) {
	let source = "";
	source += script;
	source += await readScriptFiles(options && options.browserScripts ? options.browserScripts : []);
	if (options.browserStylesheets && options.browserStylesheets.length) {
		source += "addEventListener(\"load\",()=>{const styleElement=document.createElement(\"style\");styleElement.textContent=" + JSON.stringify(await readScriptFiles(options.browserStylesheets)) + ";document.body.appendChild(styleElement);});";
	}
	source += "(" + initSingleFile.toString() + ")(" + JSON.stringify({
		FETCH_FUNCTION_NAME,
		RESOLVE_FETCH_FUNCTION_NAME,
		REJECT_FETCH_FUNCTION_NAME
	}) + ");";
	return source;
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
	return (await Promise.all(paths.map(path => readTextFile(path)))).join("");
}
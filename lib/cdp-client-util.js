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

/* global setTimeout, clearTimeout, fetch, Headers, btoa */

import { Deno, isDeno } from "./deno-polyfill.js";

const ABORT_EVENT = "abort";

export {
	fetchWithFileSupport as fetch,
	waitForTimeout,
	arrayBufferToBase64
};

async function fetchWithFileSupport(url, fetchOptions = {}) {
	const isFileUrl = url.startsWith("file://");
	if (!isFileUrl) {
		return await fetch(url, fetchOptions);
	}
	if (isDeno) {
		return await fetch(url, fetchOptions);
	}
	const filePath = decodeURIComponent(url.replace(/^file:\/\//, ""));
	const { readFile } = Deno;
	try {
		const fileData = await readFile(filePath);
		return createFileResponse(fileData, 200);
	} catch {
		return createFileResponse(new ArrayBuffer(0), 404);
	}

	function createFileResponse(data, status) {
		const isError = status === 404;
		return {
			status,
			headers: new Headers({
				"content-type": isError ? "text/plain" : "application/octet-stream",
				"content-length": data.length ? data.length.toString() : "0"
			}),
			arrayBuffer: async () => data.buffer || data
		};
	}
}

function waitForTimeout(abortSignal, maxDelay, errorMessage, errorCode) {
	return new Promise((resolve, reject) => {
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

function arrayBufferToBase64(arrayBuffer) {
	return btoa(String.fromCharCode.apply(null, new Uint8Array(arrayBuffer)));
}
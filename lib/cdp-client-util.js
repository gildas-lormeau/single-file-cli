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

/* global setTimeout, clearTimeout, fetch, URL, Headers */

import { Buffer } from "node:buffer";
import { Deno, isDeno, path } from "./deno-polyfill.js";

const ABORT_EVENT = "abort";
const HTTP_PROTOCOLS = ["http:", "https:"];
const HTTPS_PROTOCOL = "https:";
const REFERRER_POLICY_HEADER_NAME = "referrer-policy";
const DEFAULT_REFERRER_POLICY = "strict-origin-when-cross-origin";
const REFERRER_POLICIES = {
	"no-referrer": () => "",
	"no-referrer-when-downgrade": ({ documentUrl, downgrade }) => downgrade ? "" : documentUrl,
	"origin": ({ origin }) => origin,
	"origin-when-cross-origin": ({ documentUrl, origin, crossOrigin }) => crossOrigin ? origin : documentUrl,
	"same-origin": ({ documentUrl, crossOrigin }) => crossOrigin ? "" : documentUrl,
	"strict-origin": ({ origin, downgrade }) => downgrade ? "" : origin,
	"strict-origin-when-cross-origin": ({ documentUrl, origin, crossOrigin, downgrade }) => {
		if (downgrade) {
			return "";
		}
		return crossOrigin ? origin : documentUrl;
	},
	"unsafe-url": ({ documentUrl }) => documentUrl
};

export {
	fetchWithFileSupport as fetch,
	waitForTimeout,
	arrayBufferToBase64,
	getAlternativeUrl,
	getReferer,
	getReferrerPolicy,
	getDocumentReferrerPolicy,
	getDocumentHeaderReferrerPolicy
};

function getReferer(url, documentUrl, referrerPolicy) {
	let documentLocation, location;
	try {
		documentLocation = new URL(documentUrl);
		location = new URL(url, documentUrl);
	} catch {
		return "";
	}
	if (!HTTP_PROTOCOLS.includes(documentLocation.protocol) || !HTTP_PROTOCOLS.includes(location.protocol)) {
		return "";
	}
	documentLocation.hash = "";
	documentLocation.username = "";
	documentLocation.password = "";
	return REFERRER_POLICIES[getReferrerPolicy(referrerPolicy)]({
		documentUrl: documentLocation.href,
		origin: documentLocation.origin + "/",
		crossOrigin: location.origin != documentLocation.origin,
		downgrade: documentLocation.protocol == HTTPS_PROTOCOL && location.protocol != HTTPS_PROTOCOL
	});
}

function getReferrerPolicy(referrerPolicy) {
	let policy = DEFAULT_REFERRER_POLICY;
	String(referrerPolicy || "").split(",").forEach(value => {
		value = value.trim().toLowerCase();
		if (REFERRER_POLICIES[value]) {
			policy = value;
		}
	});
	return policy;
}

function getDocumentReferrerPolicy(documentUrl, documentInfo, metaReferrerPolicy) {
	const policies = [];
	if (documentInfo && documentInfo.referrerPolicy && isSameDocument(documentUrl, documentInfo.url)) {
		policies.push(documentInfo.referrerPolicy);
	}
	if (metaReferrerPolicy) {
		policies.push(metaReferrerPolicy);
	}
	return policies.join(",");
}

function getDocumentHeaderReferrerPolicy(headers) {
	return (headers || [])
		.filter(header => header.name.toLowerCase() == REFERRER_POLICY_HEADER_NAME)
		.map(header => header.value)
		.join(",");
}

function isSameDocument(documentUrl, url) {
	try {
		const documentLocation = new URL(documentUrl);
		const location = new URL(url);
		documentLocation.hash = "";
		location.hash = "";
		return documentLocation.href == location.href;
	} catch {
		return false;
	}
}

async function fetchWithFileSupport(url, fetchOptions = {}) {
	const isFileUrl = url.startsWith("file://");
	if (!isFileUrl) {
		return await fetch(url, fetchOptions);
	}
	if (isDeno) {
		return await fetch(url, fetchOptions);
	}
	const { readFile } = Deno;
	try {
		const fileData = await readFile(await path.fromFileUrl(url));
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
			arrayBuffer: () => data.buffer || data
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

		// the promise must stay pending on abort: the abort fires after the
		// Promise.race around this timeout has settled, and settling here would
		// either make the race winner destructure undefined or raise an
		// unhandled rejection
		function onAbort() {
			abortSignal.removeEventListener(ABORT_EVENT, onAbort);
			clearTimeout(timeoutId);
		}
	});
}

function arrayBufferToBase64(arrayBuffer) {
	return Buffer.from(arrayBuffer).toString("base64");
}

function getAlternativeUrl(url) {
	const alternativeUrl = new URL(url);
	if (!alternativeUrl.pathname.endsWith("/")) {
		alternativeUrl.pathname = alternativeUrl.pathname + "/";
	}
	return alternativeUrl.href;
}
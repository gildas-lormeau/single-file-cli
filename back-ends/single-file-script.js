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

/* global Deno, singlefile, XMLHttpRequest */

import { script, hookScript, zipScript } from "../lib/single-file-bundle.js";

export { getScriptSource, getHookScriptSource, getZipScriptSource };

function initSingleFile() {
	singlefile.init({
		fetch: (url, options) => {
			return new Promise(function (resolve, reject) {
				const xhrRequest = new XMLHttpRequest();
				xhrRequest.withCredentials = true;
				xhrRequest.responseType = "arraybuffer";
				xhrRequest.onerror = event => reject(new Error(event.detail));
				xhrRequest.onabort = () => reject(new Error("aborted"));
				xhrRequest.onreadystatechange = () => {
					if (xhrRequest.readyState == XMLHttpRequest.DONE) {
						resolve({
							arrayBuffer: async () => xhrRequest.response || new ArrayBuffer(),
							headers: { get: headerName => xhrRequest.getResponseHeader(headerName) },
							status: xhrRequest.status
						});
					}
				};
				xhrRequest.open("GET", url, true);
				if (options.headers) {
					for (const entry of Object.entries(options.headers)) {
						xhrRequest.setRequestHeader(entry[0], entry[1]);
					}
				}
				xhrRequest.send();
			});
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
	source += "(" + initSingleFile.toString() + ")();";
	return source;
}

async function getHookScriptSource() {
	return hookScript;
}

async function getZipScriptSource() {
	return zipScript;
}

async function readScriptFiles(paths) {
	return (await Promise.all(paths.map(path => Deno.readTextFile(path)))).join("");
}
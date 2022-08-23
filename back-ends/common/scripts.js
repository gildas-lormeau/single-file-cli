/*
 * Copyright 2010-2020 Gildas Lormeau
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

/* global require, exports, singlefile, XMLHttpRequest */

const fs = require("fs");

const SCRIPTS = [
	"lib/single-file.js",
	"lib/single-file-bootstrap.js",
	"lib/single-file-hooks-frames.js"
];

const basePath = "./../../";

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

exports.get = async options => {
	let scripts = "let _singleFileDefine; if (typeof define !== 'undefined') { _singleFileDefine = define; define = null }";
	scripts += await readScriptFiles(SCRIPTS, basePath);
	scripts += await readScriptFiles(options && options.browserScripts ? options.browserScripts : [], "");
	if (options.browserStylesheets && options.browserStylesheets.length) {
		scripts += "addEventListener(\"load\",()=>{const styleElement=document.createElement(\"style\");styleElement.textContent=" + JSON.stringify(await readScriptFiles(options.browserStylesheets, "")) + ";document.body.appendChild(styleElement);});";
	}
	scripts += "if (_singleFileDefine) { define = _singleFileDefine; _singleFileDefine = null }";
	scripts += "(" + initSingleFile.toString() + ")();";
	return scripts;
};

exports.getInfobarScript = () => {
	return readScriptFile("lib/single-file-infobar.js", basePath);
};

async function readScriptFiles(paths, basePath = "../../../") {
	return (await Promise.all(paths.map(path => readScriptFile(path, basePath)))).join("");
}

function readScriptFile(path, basePath) {
	return new Promise((resolve, reject) =>
		fs.readFile(basePath ? require.resolve(basePath + path) : path, (err, data) => {
			if (err) {
				reject(err);
			} else {
				resolve(data.toString() + "\n");
			}
		})
	);
}
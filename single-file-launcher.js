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

import { initialize, closeBrowser } from "./single-file-cli-api.js";
import { createBrowserProfile, getChromiumOptions } from "./lib/chromium.js";
import { Deno } from "./lib/deno-polyfill.js";
import { getOptions, applySettings, parseUrlsFile } from "./options.js";

const { readTextFile, readFile, exit, addSignalListener, build } = Deno;
const QUIT_BROWSER_HINT = build.os == "darwin" ? " (Cmd+Q)" : "";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d];

try {
	addSignalListener("SIGTERM", closeBrowserAndExit);
} catch {
	// ignored
}
try {
	addSignalListener("SIGINT", closeBrowserAndExit);
} catch {
	// ignored
}

export { run };

async function run() {
	try {
		const options = getOptions();
		let urls;
		if (options.settingsFile) {
			const settings = JSON.parse(await readTextFile(options.settingsFile));
			applySettings(options, settings);
		}
		if (options.createBrowserProfile) {
			await saveBrowserProfile(options);
			exit(0);
		}
		if (options.urlsFile) {
			urls = await getUrlsFile(options.urlsFile);
		} else {
			urls = [options.url];
		}
		if (options.browserCookiesFile) {
			const cookiesContent = await readTextFile(options.browserCookiesFile);
			try {
				options.browserCookies = JSON.parse(cookiesContent);
			} catch {
				options.browserCookies = parseCookies(cookiesContent);
			}
		}
		if (options.embeddedImage) {
			options.embeddedImage = Array.from(await readFile(options.embeddedImage));
			checkSignature(options.embeddedImage, PNG_SIGNATURE, "--embedded-image", "PNG");
		}
		if (options.embeddedPdf) {
			options.embeddedPdf = Array.from(await readFile(options.embeddedPdf));
			checkSignature(options.embeddedPdf, PDF_SIGNATURE, "--embedded-pdf", "PDF");
		}
		options.retrieveLinks = true;
		const singlefile = await initialize(options);
		await singlefile.capture(urls);
		const errorCount = await singlefile.finish();
		if (errorCount) {
			exit(1);
		}
	} catch (error) {
		console.error(error.message || error); // eslint-disable-line no-console
		await closeBrowserAndExit(-1);
	}
}

async function saveBrowserProfile(options) {
	const profileDirectory = options.createBrowserProfile;
	console.error(`Log in to the website in the browser window, then quit the browser${QUIT_BROWSER_HINT} to save the profile.`); // eslint-disable-line no-console
	await createBrowserProfile(Object.assign(getChromiumOptions(options), { profile: profileDirectory, startUrl: options.url }));
	console.error(`Profile saved, use it with --browser-profile ${JSON.stringify(profileDirectory)}.`); // eslint-disable-line no-console
}

function parseCookies(textValue) {
	const httpOnlyRegExp = /^#HttpOnly_(.*)/;
	return textValue.split(/\r\n|\n/)
		.filter(line => line.trim() && (!/^#/.test(line) || httpOnlyRegExp.test(line)))
		.map(line => {
			const httpOnly = httpOnlyRegExp.test(line);
			if (httpOnly) {
				line = line.replace(httpOnlyRegExp, "$1");
			}
			const values = line.split(/\t/);
			if (values.length == 7) {
				return {
					domain: values[0],
					path: values[2],
					secure: values[3] == "TRUE",
					expires: (values[4] && Number(values[4])) || undefined,
					name: values[5],
					value: values[6],
					httpOnly
				};
			}
		})
		.filter(cookieData => cookieData);
}

async function closeBrowserAndExit(code) {
	await closeBrowser();
	exit(code);
}

async function getUrlsFile(urlsFile) {
	return parseUrlsFile(await readTextFile(urlsFile));
}

// the faces are read from the bytes the file starts with: a PDF whose header sits further in
// is dropped by PDF readers, and a file that is not a PNG produces an image nothing can open
function checkSignature(data, signature, optionName, formatName) {
	if (signature.some((byte, index) => data[index] != byte)) {
		throw new Error(optionName + " must be given a " + formatName + " file, and it must start with the " + formatName + " signature");
	}
}

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

import { initialize } from "./single-file-cli-api.js";
import { closeBrowser } from "./lib/browser.js";
import { Deno } from "./lib/deno-polyfill.js";
import options from "./options.js";

const { readTextFile, readFile, exit, addSignalListener } = Deno;

try {
	addSignalListener("SIGTERM", closeBrowserAndExit);
} catch (_error) {
	// ignored
}
try {
	addSignalListener("SIGINT", closeBrowserAndExit);
} catch (_error) {
	// ignored
}

export { run };

async function run() {
	try {
		let urls;
		if (options.settingsFile) {
			const settings = JSON.parse(await Deno.readTextFile(options.settingsFile));
			let profileName = options.settingsProfile || "default";
			if (profileName == "default" || !settings.profiles[profileName]) {
				profileName = "__Default_Settings__";
			}
			Object.assign(options, settings.profiles[profileName]);
			delete options.settingsFile;
		}
		if (options.urlsFile) {
			urls = (await readTextFile(options.urlsFile)).split("\n");
		} else {
			urls = [options.url];
		}
		if (options.browserCookies) {
			const cookies = [];
			for (const cookie of options.browserCookies) {
				const [name, value, domain, path, expires, httpOnly, secure, sameSite, url] = cookie.split(",");
				cookies.push({
					name,
					value,
					url,
					domain,
					path,
					secure: secure === "true",
					httpOnly: httpOnly === "true",
					sameSite,
					expires: isNaN(Number(expires)) ? undefined : Number(expires)
				});
			}
			options.browserCookies = cookies;
		}
		if (options.browserCookiesFile) {
			const cookiesContent = await readTextFile(options.browserCookiesFile);
			try {
				options.browserCookies = JSON.parse(cookiesContent);
			} catch {
				options.browserCookies = parseCookies(cookiesContent);
			}
		}
		if (options.httpHeaders) {
			const headers = {};
			for (const header of options.httpHeaders) {
				const [name, value] = header.split("=");
				headers[name] = value.trim();
			}
			options.httpHeaders = headers;
		}
		if (options.embeddedImage) {
			options.embeddedImage = Array.from(await readFile(options.embeddedImage));
		}
		if (options.embeddedPdf) {
			options.embeddedPdf = Array.from(await readFile(options.embeddedPdf));
		}
		options.retrieveLinks = true;
		const singlefile = await initialize(options);
		await singlefile.capture(urls);
		await singlefile.finish();
	} catch (error) {
		console.error(error.message || error); // eslint-disable-line no-console
		await closeBrowserAndExit(-1);
	}
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

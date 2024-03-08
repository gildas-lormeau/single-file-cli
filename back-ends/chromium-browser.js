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

/* global Deno */

import { BROWSER_PATHS, BROWSER_ARGS } from "./chromium-constants.js";

const PIPED_STD_CONFIG = "piped";

let child, profilePath;
export { launchBrowser, closeBrowser };

async function launchBrowser(options = {}, indexPath = 0) {
	let path = BROWSER_PATHS[Deno.build.os][indexPath];
	const args = Array.from(BROWSER_ARGS);
	profilePath = await Deno.makeTempDir();
	if (options.headless) {
		args.push("--headless");
	} else {
		args.push("--start-maximized");
	}
	if (options.executablePath) {
		path = options.executablePath;
	}
	if (options.browserDebug) {
		args.push("--auto-open-devtools-for-tabs");
	}
	if (options.browserDisableWebSecurity) {
		args.push("--disable-web-security");
	}
	if (options.browserWidth && options.browserHeight) {
		args.push("--window-size=" + options.browserWidth + "," + options.browserHeight);
	}
	if (options.userAgent) {
		args.push("--user-agent=" + options.userAgent);
	}
	if (options.httpProxyServer) {
		args.push("--proxy-server=" + options.httpProxyServer);
	}
	if (options.args) {
		args.push(...options.args);
	}
	args.push(`--user-data-dir=${profilePath}`);
	const command = new Deno.Command(path, { args, stdout: PIPED_STD_CONFIG, stderr: PIPED_STD_CONFIG });
	try {
		child = command.spawn();
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			if (indexPath + 1 < BROWSER_PATHS[Deno.build.os].length) {
				await launchBrowser(options, indexPath + 1);
			} else {
				throw error;
			}
		}
	}
	child.ref();
	return child;
}

async function closeBrowser() {
	if (child !== undefined) {
		child.kill();
		await child.status;
		child = undefined;
	}
	if (profilePath !== undefined) {
		await Deno.remove(profilePath, { recursive: true });
		profilePath = undefined;
	}
}

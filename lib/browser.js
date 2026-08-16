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

/* global fetch, setTimeout */

import { BROWSER_PATHS, BROWSER_ARGS } from "./constants.js";
import { Deno } from "./deno-polyfill.js";

const NULL_STD_CONFIG = "null";
const DEBUG_PORT_MIN = 9222;
const DEBUG_PORT_RANGE = 256;
const READY_TIMEOUT = 30000;
const READY_RETRY_DELAY = 250;

const { build, makeTempDir, Command, errors, remove } = Deno;
let child, profilePath, childExited;
export { launchBrowser, closeBrowser, browserExited };

async function launchBrowser(options = {}, indexPath = 0) {
	const executablePath = options.executablePath || BROWSER_PATHS[build.os][indexPath];
	let args = Array.from(BROWSER_ARGS);
	const debugPort = await getDebugPort();
	args.push("--remote-debugging-port=" + debugPort);
	profilePath = await makeTempDir();
	if (options.headless && !options.debug) {
		args.push("--headless");
	} else {
		args.push("--start-maximized");
	}
	if (options.debug) {
		args.push("--auto-open-devtools-for-tabs");
	}
	if (options.width && options.height) {
		args.push("--window-size=" + options.width + "," + options.height);
	}
	if (options.userAgent) {
		args.push("--user-agent=" + options.userAgent);
	}
	if (options.httpProxyServer) {
		args.push("--proxy-server=" + options.httpProxyServer);
	}
	args.push("--user-data-dir=" + profilePath);
	if (options.singleProcess) {
		args.push("--single-process");
	}
	if (options.args) {
		const argNames = options.args.map(arg => arg.split("=")[0]);
		args = args.filter(arg => !argNames.includes(arg.split("=")[0]));
		args.push(...options.args);
	}
	if (args.includes("--headless=new") ||
		args.includes("--auto-open-devtools-for-tabs") ||
		args.includes("--start-maximized") ||
		!args.includes("--headless")) {
		args.push("--disable-site-isolation-trials");
	}
	const command = new Command(executablePath, { args, stdout: NULL_STD_CONFIG, stderr: NULL_STD_CONFIG });
	try {
		child = await command.spawn();
	} catch (error) {
		await remove(profilePath, { recursive: true }).catch(() => { });
		profilePath = undefined;
		if (error instanceof errors.NotFound) {
			if (!options.executablePath && indexPath + 1 < BROWSER_PATHS[build.os].length) {
				return launchBrowser(options, indexPath + 1);
			}
			throw new Error(options.executablePath ?
				`The browser executable was not found at ${JSON.stringify(executablePath)}` :
				"The browser executable was not found, use --browser-executable-path to set its location");
		}
		throw error;
	}
	child.ref();
	childExited = false;
	child.status.then(() => childExited = true);
	try {
		await waitUntilReady(debugPort);
	} catch (error) {
		await closeBrowser();
		if (options.singleProcess) {
			console.warn("Warning: the browser exited when using --browser-single-process, retrying without it"); // eslint-disable-line no-console
			return launchBrowser(Object.assign({}, options, { singleProcess: false }), indexPath);
		}
		throw error;
	}
	return debugPort;
}

async function waitUntilReady(debugPort) {
	const timeoutTime = Date.now() + READY_TIMEOUT;
	while (!childExited && Date.now() < timeoutTime) {
		try {
			await fetch("http://localhost:" + debugPort + "/json/version");
			return;
		} catch {
			await new Promise(resolve => setTimeout(resolve, READY_RETRY_DELAY));
		}
	}
	throw new Error(childExited ? "The browser exited unexpectedly" : "The browser is not responding");
}

async function browserExited(maxDelay = 0) {
	if (child === undefined) {
		return false;
	}
	if (childExited || !maxDelay) {
		return childExited;
	}
	return Promise.race([
		child.status.then(() => true),
		new Promise(resolve => setTimeout(() => resolve(childExited), maxDelay))
	]);
}

async function getDebugPort(port = getRandomDebugPort(), usedPorts = []) {
	try {
		await fetch("http://localhost:" + port + "/json/version");
	} catch {
		return port;
	}
	if (usedPorts.length < DEBUG_PORT_RANGE) {
		usedPorts.push(port);
		do {
			port = getRandomDebugPort();
		} while (usedPorts.includes(port));
		return getDebugPort(port, usedPorts);
	} else {
		throw new Error("No available debugging port");
	}
}


function getRandomDebugPort() {
	return Math.floor(Math.random() * DEBUG_PORT_RANGE) + DEBUG_PORT_MIN;
}

async function closeBrowser() {
	if (child !== undefined) {
		try {
			child.kill();
		} catch {
			// ignored
		}
		await child.status;
		child = undefined;
	}
	if (profilePath !== undefined) {
		try {
			await remove(profilePath, { recursive: true });
			profilePath = undefined;
		} catch {
			console.log("Warning: failed to remove profile directory: " + profilePath); // eslint-disable-line no-console
		}
	}
}

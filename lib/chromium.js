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

/* global fetch, setTimeout, WebSocket */

import { CHROMIUM_PATHS, CHROMIUM_ARGS } from "./constants.js";
import { spawnBrowser, getDebugPort, copyProfile, pruneProfile, removeProfileLockEntries } from "./browser.js";
import { Deno } from "./deno-polyfill.js";

const READY_TIMEOUT = 30000;
const READY_RETRY_DELAY = 250;
const CLOSE_TIMEOUT = 15000;
const LOCALHOST = "http://localhost:";
const PROFILE_INCOMPATIBLE_ARGS = [
	"--no-startup-window",
	"--bwsi",
	"--deny-permission-prompts"
];

const { build, makeTempDir, mkdir, errors, remove } = Deno;
let child, profilePath, childExited, keepProfilePath, browserDebugPort;
export { launchChromium, createBrowserProfile, getChromiumOptions, closeChromium, chromiumExited };

function getChromiumOptions(options) {
	return {
		args: options.browserArgs,
		headless: options.browserHeadless,
		executablePath: options.browserExecutablePath,
		debug: options.browserDebug,
		singleProcess: options.browserSingleProcess,
		width: options.browserWidth,
		height: options.browserHeight,
		userAgent: options.userAgent,
		httpProxyServer: options.httpProxyServer,
		profile: options.browserProfile
	};
}

async function createBrowserProfile(options = {}) {
	await mkdir(options.profile, { recursive: true });
	await launchChromium(Object.assign({}, options, { headless: false, persistProfile: true }));
	if (child !== undefined) {
		await child.status;
	}
	await closeChromium();
}

async function launchChromium(options = {}, indexPath = 0) {
	const executablePath = options.executablePath || CHROMIUM_PATHS[build.os][indexPath];
	let args = Array.from(CHROMIUM_ARGS);
	const debugPort = await getDebugPort();
	browserDebugPort = debugPort;
	args.push("--remote-debugging-port=" + debugPort);
	keepProfilePath = Boolean(options.persistProfile);
	if (keepProfilePath) {
		profilePath = options.profile;
		args = args.filter(arg => !PROFILE_INCOMPATIBLE_ARGS.includes(arg));
	} else {
		profilePath = await makeTempDir();
		if (options.profile) {
			await copyProfile(options.profile, profilePath);
		}
	}
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
	if (options.startUrl) {
		args.push(options.startUrl);
	}
	try {
		child = await spawnBrowser(executablePath, args, keepProfilePath ? "" : profilePath);
	} catch (error) {
		if (!keepProfilePath) {
			await remove(profilePath, { recursive: true }).catch(() => { });
		}
		profilePath = undefined;
		if (error instanceof errors.NotFound) {
			if (!options.executablePath && indexPath + 1 < CHROMIUM_PATHS[build.os].length) {
				return launchChromium(options, indexPath + 1);
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
		await closeChromium();
		if (options.singleProcess) {
			console.warn("Warning: the browser exited when using --browser-single-process, retrying without it"); // eslint-disable-line no-console
			return launchChromium(Object.assign({}, options, { singleProcess: false }), indexPath);
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

async function chromiumExited(maxDelay = 0) {
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

async function closeChromium() {
	const closedChild = child;
	const closedProfilePath = profilePath;
	child = undefined;
	profilePath = undefined;
	if (closedChild !== undefined) {
		if (keepProfilePath && !childExited) {
			await closeBrowserGracefully(closedChild);
		}
		try {
			closedChild.kill();
		} catch {
			// ignored
		}
		await closedChild.status;
	}
	if (closedProfilePath !== undefined) {
		if (keepProfilePath) {
			await removeProfileLockEntries(closedProfilePath).catch(() => { });
			await pruneProfile(closedProfilePath).catch(() => { });
		} else {
			try {
				await remove(closedProfilePath, { recursive: true });
			} catch {
				console.log("Warning: failed to remove profile directory: " + closedProfilePath); // eslint-disable-line no-console
			}
		}
	}
}

async function closeBrowserGracefully(closedChild) {
	try {
		const response = await fetch(LOCALHOST + browserDebugPort + "/json/version");
		const { webSocketDebuggerUrl } = await response.json();
		const socket = new WebSocket(webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve);
			socket.addEventListener("error", reject);
		});
		socket.send(JSON.stringify({ id: 0, method: "Browser.close" }));
		await Promise.race([
			closedChild.status,
			new Promise(resolve => setTimeout(resolve, CLOSE_TIMEOUT))
		]);
	} catch {
		// ignored
	}
}

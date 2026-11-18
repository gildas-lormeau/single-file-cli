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

/* global fetch, setTimeout, clearTimeout, WebSocket */

import { CHROMIUM_PATHS, CHROMIUM_ARGS } from "./constants.js";
import { getExecutablePaths, findExecutablePath, spawnBrowser, getDebugPort, copyProfile, pruneProfile, removeProfileLockEntries } from "./browser.js";
import { Deno } from "./deno-polyfill.js";

// a first launch on a loaded machine has been measured at more than 30 seconds
const READY_TIMEOUT = 60000;
const READY_RETRY_DELAY = 250;
const CLOSE_TIMEOUT = 15000;
const HTTP_PREFIX = "http://";
// A debugging port is drawn at random and kept when nothing answers on it, so two processes started
// at the same moment can draw the same one. Both browsers then start: the first binds the port on
// the IPv4 loopback address, the second falls back to the IPv6 one, and "localhost" reaches either.
// The browser is therefore addressed by IP, and only once the one answering there has been
// recognized as the browser launched here, from the profile directory in its command line. When the
// port turns out to belong to the browser of another process, the browser is launched again on
// another port. Letting the browser pick its port (--remote-debugging-port=0) would avoid the draw,
// but Chromium then reports navigator.webdriver as true to the pages.
// The command line is not always reported as it was given: on Windows, Chromium rebuilds it and
// quotes the value of a switch that contains a space, a tab, a backslash or a quote, i.e. every
// path. The profile switch is therefore searched in the form Chromium reports (see
// QuoteForCommandLineToArgvWInternal in base/command_line.cc). Searching it as it was given made
// every launch fail on Windows with "No available debugging port" in 2.27.1 and 2.27.2.
const DEBUG_HOSTS = ["127.0.0.1", "[::1]"];
const DEBUG_PORT_ARG_PREFIX = "--remote-debugging-port=";
const PROFILE_ARG_PREFIX = "--user-data-dir=";
const VERSION_PATH = "/json/version";
const COMMAND_LINE_REQUEST = { id: 0, method: "SystemInfo.getInfo" };
const MAX_LAUNCH_ATTEMPTS = 8;
const WINDOWS_QUOTED_VALUE_REGEXP = /[ \t\\"]/;
const WINDOWS_ESCAPED_CHARS_REGEXP = /(\\*)("|$)/g;
const SINGLE_PROCESS_EXECUTABLE_PATH_REGEXP = /[\\/]Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe$/i;
const PROFILE_INCOMPATIBLE_ARGS = [
	"--no-startup-window",
	"--bwsi",
	"--deny-permission-prompts"
];

const { makeTempDir, mkdir, errors, remove, build } = Deno;
let child, profilePath, childExited, childSingleProcess, keepProfilePath, browserDebugUrl;
export { launchChromium, createBrowserProfile, getChromiumOptions, closeChromium, chromiumExited, chromiumSingleProcess, useSingleProcess, getReportedSwitch };

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

async function launchChromium(options = {}, launchAttempt = 1) {
	const executablePath = options.executablePath || await findExecutablePath(getExecutablePaths(CHROMIUM_PATHS));
	if (!executablePath) {
		throw new Error("No Chromium-based browser was found in the default locations, use --browser-executable-path to set its location");
	}
	let args = Array.from(CHROMIUM_ARGS);
	args.push(DEBUG_PORT_ARG_PREFIX + await getDebugPort());
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
	args.push(PROFILE_ARG_PREFIX + profilePath);
	const singleProcess = useSingleProcess(executablePath, options.singleProcess);
	if (singleProcess) {
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
	// read back from the arguments: the ones given by the user replace the ones set above
	const debugPort = getArgValue(args, DEBUG_PORT_ARG_PREFIX);
	const profileArg = getReportedSwitch(PROFILE_ARG_PREFIX, getArgValue(args, PROFILE_ARG_PREFIX));
	try {
		child = await spawnBrowser(executablePath, args, keepProfilePath ? "" : profilePath);
	} catch (error) {
		if (!keepProfilePath) {
			await remove(profilePath, { recursive: true }).catch(() => { });
		}
		profilePath = undefined;
		if (error instanceof errors.NotFound) {
			throw new Error(`The browser executable was not found at ${JSON.stringify(executablePath)}`, { cause: error });
		}
		throw error;
	}
	child.ref();
	childExited = false;
	childSingleProcess = singleProcess;
	child.status.then(() => childExited = true);
	let debugUrl;
	try {
		debugUrl = await waitUntilReady(debugPort, profileArg);
	} catch (error) {
		await closeChromium();
		if (singleProcess) {
			console.warn("Warning: the browser exited when using --browser-single-process, retrying without it"); // eslint-disable-line no-console
			return launchChromium(Object.assign({}, options, { singleProcess: false, executablePath }));
		}
		throw error;
	}
	if (!debugUrl) {
		await closeChromium();
		if (launchAttempt < MAX_LAUNCH_ATTEMPTS) {
			return launchChromium(Object.assign({}, options, { executablePath }), launchAttempt + 1);
		}
		throw new Error("No available debugging port");
	}
	browserDebugUrl = debugUrl;
	return debugUrl;
}

function getArgValue(args, prefix) {
	return args.find(arg => arg.startsWith(prefix)).substring(prefix.length);
}

// Returns a switch as the browser reports it in its command line.
function getReportedSwitch(prefix, value, os = build.os) {
	if (os == "windows" && WINDOWS_QUOTED_VALUE_REGEXP.test(value)) {
		// backslashes are doubled only before a quote and at the end, where the closing quote follows them
		value = "\"" + value.replace(WINDOWS_ESCAPED_CHARS_REGEXP, (_, backslashes, quote) => backslashes + backslashes + (quote ? "\\\"" : "")) + "\"";
	}
	return prefix + value;
}

// Returns the URL the launched browser answers on, or nothing when the port belongs to the browser
// of another process.
async function waitUntilReady(debugPort, profileArg) {
	const timeoutTime = Date.now() + READY_TIMEOUT;
	while (!childExited && Date.now() < timeoutTime) {
		let otherBrowserFound = false;
		for (const host of DEBUG_HOSTS) {
			const debugUrl = HTTP_PREFIX + host + ":" + debugPort;
			try {
				const commandLine = await getBrowserCommandLine(debugUrl, timeoutTime);
				// a browser that does not tell its command line cannot be recognized, it is trusted as before
				if (!commandLine || commandLine.includes(profileArg)) {
					return debugUrl;
				}
				otherBrowserFound = true;
			} catch {
				// ignored
			}
		}
		if (otherBrowserFound) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, READY_RETRY_DELAY));
	}
	throw new Error(childExited ? "The browser exited unexpectedly" : "The browser is not responding");
}

async function getBrowserCommandLine(debugUrl, timeoutTime) {
	const response = await fetch(debugUrl + VERSION_PATH);
	const { webSocketDebuggerUrl } = await response.json();
	const socket = new WebSocket(webSocketDebuggerUrl);
	let timeoutId;
	try {
		return await new Promise((resolve, reject) => {
			timeoutId = setTimeout(() => resolve(), Math.max(timeoutTime - Date.now(), 0));
			socket.addEventListener("open", () => socket.send(JSON.stringify(COMMAND_LINE_REQUEST)));
			socket.addEventListener("message", event => {
				const { id, result } = JSON.parse(event.data);
				if (id === COMMAND_LINE_REQUEST.id) {
					resolve(result && result.commandLine);
				}
			});
			socket.addEventListener("error", reject);
			socket.addEventListener("close", () => reject(new Error("The connection was closed")));
		});
	} finally {
		clearTimeout(timeoutId);
		socket.close();
	}
}

function useSingleProcess(executablePath, singleProcess, os = build.os) {
	if (!singleProcess) {
		return false;
	}
	if (os != "windows") {
		return true;
	}
	return SINGLE_PROCESS_EXECUTABLE_PATH_REGEXP.test(executablePath);
}

function chromiumSingleProcess() {
	return child !== undefined && Boolean(childSingleProcess);
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
		const response = await fetch(browserDebugUrl + VERSION_PATH);
		const { webSocketDebuggerUrl } = await response.json();
		const socket = new WebSocket(webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve);
			socket.addEventListener("error", reject);
		});
		socket.send(JSON.stringify({ id: 0, method: "Browser.close" }));
		let timeoutId;
		await Promise.race([
			closedChild.status,
			new Promise(resolve => timeoutId = setTimeout(resolve, CLOSE_TIMEOUT))
		]);
		clearTimeout(timeoutId);
	} catch {
		// ignored
	}
}

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

import { BROWSER_PATHS, BROWSER_ARGS } from "./constants.js";
import { Deno, path } from "./deno-polyfill.js";

const NULL_STD_CONFIG = "null";
const DEBUG_PORT_MIN = 9222;
const DEBUG_PORT_RANGE = 256;
const READY_TIMEOUT = 30000;
const READY_RETRY_DELAY = 250;
const CLOSE_TIMEOUT = 15000;
const LOCALHOST = "http://localhost:";
const PROFILE_LOCK_ENTRY_PREFIX = "Singleton";
const PROFILE_IGNORED_ENTRY_NAMES = [
	"AutofillAiModelCache",
	"Cache",
	"Code Cache",
	"CacheStorage",
	"Crashpad",
	"DawnCache",
	"DawnGraphiteCache",
	"DawnWebGPUCache",
	"GPUCache",
	"GPUPersistentCache",
	"GraphiteDawnCache",
	"GrShaderCache",
	"ShaderCache",
	"component_crx_cache",
	"extensions_crx_cache",
	"optimization_guide_hint_cache_store",
	"optimization_guide_model_store"
];
const PROFILE_INCOMPATIBLE_ARGS = [
	"--no-startup-window",
	"--bwsi",
	"--deny-permission-prompts"
];

const { build, makeTempDir, readDir, copyFile, mkdir, Command, errors, remove, stat } = Deno;
const WATCHDOG_SHELL = "/bin/sh";
const WATCHDOG_SCRIPT = [
	"trap 'kill -TERM $browser 2>/dev/null' TERM INT",
	"profile=$1",
	"shift",
	"\"$0\" \"$@\" &",
	"browser=$!",
	"parent=$PPID",
	"while kill -0 $parent 2>/dev/null && kill -0 $browser 2>/dev/null; do sleep 0.25; done",
	"if ! kill -0 $parent 2>/dev/null; then",
	"kill -TERM $browser 2>/dev/null",
	"wait $browser 2>/dev/null",
	"if [ -n \"$profile\" ]; then rm -rf \"$profile\"; fi",
	"fi",
	"wait $browser 2>/dev/null"
].join("\n");
const { join } = path;
let child, profilePath, childExited, keepProfilePath, browserDebugPort;
export { launchBrowser, createBrowserProfile, getBrowserOptions, copyProfile, pruneProfile, closeBrowser, browserExited };

function getBrowserOptions(options) {
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
	await launchBrowser(Object.assign({}, options, { headless: false, persistProfile: true }));
	if (child !== undefined) {
		await child.status;
	}
	await closeBrowser();
}

async function launchBrowser(options = {}, indexPath = 0) {
	const executablePath = options.executablePath || BROWSER_PATHS[build.os][indexPath];
	let args = Array.from(BROWSER_ARGS);
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

async function spawnBrowser(executablePath, args, temporaryProfilePath) {
	if (build.os == "windows") {
		return new Command(executablePath, { args, stdout: NULL_STD_CONFIG, stderr: NULL_STD_CONFIG }).spawn();
	}
	try {
		await stat(executablePath);
	} catch {
		throw new errors.NotFound(executablePath);
	}
	return new Command(WATCHDOG_SHELL, { args: ["-c", WATCHDOG_SCRIPT, executablePath, temporaryProfilePath, ...args], stdout: NULL_STD_CONFIG, stderr: NULL_STD_CONFIG }).spawn();
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

async function copyProfile(sourcePath, destinationPath) {
	let entries;
	try {
		entries = await readDir(sourcePath);
	} catch (error) {
		throw error instanceof errors.NotFound ?
			new Error(`The browser profile directory was not found at ${JSON.stringify(sourcePath)}`) :
			error;
	}
	await copyProfileEntries(entries, sourcePath, destinationPath);
}

async function copyProfileEntries(entries, sourcePath, destinationPath) {
	for (const entry of entries) {
		if (entry.isSymlink || entry.name.startsWith(PROFILE_LOCK_ENTRY_PREFIX) || PROFILE_IGNORED_ENTRY_NAMES.includes(entry.name)) {
			continue;
		}
		const entrySourcePath = join(sourcePath, entry.name);
		const entryDestinationPath = join(destinationPath, entry.name);
		if (entry.isDirectory) {
			await mkdir(entryDestinationPath, { recursive: true });
			await copyProfileEntries(await readDir(entrySourcePath), entrySourcePath, entryDestinationPath);
		} else {
			await copyFile(entrySourcePath, entryDestinationPath);
		}
	}
}

// the caches the browser fills during the session are the bulk of the profile and
// none of them is ever copied to the capture profile, so they are dropped rather
// than kept and copied over at every run
async function pruneProfile(profileDirectory) {
	await pruneProfileEntries(await readDir(profileDirectory), profileDirectory);
}

async function pruneProfileEntries(entries, profileDirectory) {
	for (const entry of entries) {
		if (entry.isSymlink) {
			continue;
		}
		const entryPath = join(profileDirectory, entry.name);
		if (PROFILE_IGNORED_ENTRY_NAMES.includes(entry.name)) {
			await remove(entryPath, { recursive: true }).catch(() => { });
		} else if (entry.isDirectory) {
			await pruneProfileEntries(await readDir(entryPath), entryPath);
		}
	}
}

async function removeProfileLockEntries(profileDirectory) {
	const entries = await readDir(profileDirectory);
	for (const entry of entries) {
		if (entry.name.startsWith(PROFILE_LOCK_ENTRY_PREFIX)) {
			await remove(join(profileDirectory, entry.name)).catch(() => { });
		}
	}
}

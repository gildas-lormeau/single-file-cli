/*
 * Copyright 2010-2026 Gildas Lormeau
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

/* global URL, setTimeout */

import { FIREFOX_PATHS } from "./constants.js";
import { copyProfile, spawnBrowser, getDebugPort } from "./browser.js";
import { Deno, path } from "./deno-polyfill.js";

const READY_TIMEOUT = 30000;
const READY_RETRY_DELAY = 250;
const SERVER_FILE_NAME = "WebDriverBiDiServer.json";
const PROFILE_PREFS = {
	"app.update.auto": false,
	"app.update.disabledForTesting": true,
	"browser.aboutwelcome.enabled": false,
	"browser.newtabpage.enabled": false,
	"browser.sessionstore.resume_from_crash": false,
	"browser.shell.checkDefaultBrowser": false,
	"browser.startup.homepage": "about:blank",
	"browser.startup.page": 0,
	"browser.tabs.warnOnClose": false,
	"datareporting.policy.dataSubmissionEnabled": false,
	"dom.disable_beforeunload": true,
	"media.autoplay.default": 0,
	"media.volume_scale": "0.0",
	"toolkit.telemetry.reportingpolicy.firstRun": false
};

const { build, makeTempDir, readTextFile, writeTextFile, errors, remove } = Deno;
const { join } = path;
let child, profilePath, childExited;

export { launchFirefox, closeFirefox, hasFirefoxExited, getFirefoxOptions };

function getFirefoxOptions(options) {
	return {
		args: options.browserArgs,
		headless: options.browserHeadless,
		executablePath: options.browserExecutablePath,
		debug: options.browserDebug,
		width: options.browserWidth,
		height: options.browserHeight,
		userAgent: options.userAgent,
		httpProxyServer: options.httpProxyServer,
		profile: options.browserProfile
	};
}

async function launchFirefox(options = {}, indexPath = 0) {
	const executablePath = options.executablePath || FIREFOX_PATHS[build.os][indexPath];
	const debugPort = await getDebugPort();
	profilePath = await makeTempDir();
	if (options.profile) {
		try {
			await copyProfile(options.profile, profilePath);
		} catch (error) {
			await remove(profilePath, { recursive: true }).catch(() => { });
			profilePath = undefined;
			throw error;
		}
	}
	await writeTextFile(join(profilePath, "user.js"), getProfilePrefs(options));
	let args = [
		"--remote-debugging-port=" + debugPort,
		"--profile", profilePath,
		"--no-remote",
		"--new-instance"
	];
	if (options.headless && !options.debug) {
		args.push("--headless");
	}
	if (options.width && options.height) {
		args.push("--width=" + options.width, "--height=" + options.height);
	}
	if (options.args) {
		const argNames = options.args.map(arg => arg.split("=")[0]);
		args = args.filter(arg => !argNames.includes(arg.split("=")[0]));
		args.push(...options.args);
	}
	try {
		child = await spawnBrowser(executablePath, args, profilePath);
	} catch (error) {
		await remove(profilePath, { recursive: true }).catch(() => { });
		profilePath = undefined;
		if (error instanceof errors.NotFound) {
			if (!options.executablePath && indexPath + 1 < FIREFOX_PATHS[build.os].length) {
				return launchFirefox(options, indexPath + 1);
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
		const { ws_host: host, ws_port: port } = await waitUntilReady(profilePath);
		return { url: "ws://" + host + ":" + port + "/session", timeout: READY_TIMEOUT };
	} catch (error) {
		await closeFirefox();
		throw error;
	}
}

async function waitUntilReady(profilePath) {
	const timeoutTime = Date.now() + READY_TIMEOUT;
	while (!childExited && Date.now() < timeoutTime) {
		try {
			return JSON.parse(await readTextFile(join(profilePath, SERVER_FILE_NAME)));
		} catch {
			await new Promise(resolve => setTimeout(resolve, READY_RETRY_DELAY));
		}
	}
	throw new Error(childExited ? "The browser exited unexpectedly" : "The browser is not responding");
}

function getProfilePrefs(options) {
	const prefs = Object.assign({}, PROFILE_PREFS);
	if (options.userAgent) {
		prefs["general.useragent.override"] = options.userAgent;
	}
	if (options.httpProxyServer) {
		const proxyUrl = new URL(options.httpProxyServer.includes("://") ? options.httpProxyServer : "http://" + options.httpProxyServer);
		prefs["network.proxy.type"] = 1;
		prefs["network.proxy.http"] = proxyUrl.hostname;
		prefs["network.proxy.http_port"] = Number(proxyUrl.port);
		prefs["network.proxy.ssl"] = proxyUrl.hostname;
		prefs["network.proxy.ssl_port"] = Number(proxyUrl.port);
	}
	return Object.entries(prefs)
		.map(([name, value]) => "user_pref(" + JSON.stringify(name) + ", " + JSON.stringify(value) + ");")
		.join("\n") + "\n";
}

function hasFirefoxExited() {
	return Boolean(childExited);
}

async function closeFirefox() {
	const closedChild = child;
	const closedProfilePath = profilePath;
	child = undefined;
	profilePath = undefined;
	if (closedChild !== undefined) {
		try {
			closedChild.kill();
		} catch {
			// ignored
		}
		await closedChild.status;
	}
	if (closedProfilePath !== undefined) {
		try {
			await remove(closedProfilePath, { recursive: true });
		} catch {
			console.log("Warning: failed to remove profile directory: " + closedProfilePath); // eslint-disable-line no-console
		}
	}
}

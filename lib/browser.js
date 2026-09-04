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

/* global fetch */

import { Deno, path } from "./deno-polyfill.js";

const NULL_STD_CONFIG = "null";
const DEBUG_PORT_MIN = 9222;
const DEBUG_PORT_RANGE = 256;
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

const { build, readDir, copyFile, mkdir, Command, errors, remove, stat } = Deno;
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
export { spawnBrowser, getDebugPort, copyProfile, pruneProfile, removeProfileLockEntries };

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

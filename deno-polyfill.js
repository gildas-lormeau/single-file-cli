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

/* global globalThis, URL, Deno, process */

import * as path from "path";

const DENO_RUNTIME_DETECTED = typeof Deno !== "undefined";

const NPM_MODULES = {
	"ws": "ws",
	"simple-cdp": "simple-cdp",
};

const NODE_MODULES = {
	"fs": "node:fs/promises",
	"os": "node:os",
	"child_process": "node:child_process",
	"url": "node:url"
};

export {
	initGlobalThisProperties,
	args,
	readTextFile,
	writeTextFile,
	mkdir,
	makeTempDir,
	stat,
	remove,
	stdout,
	exit,
	build,
	errors,
	Command,
	toFileUrl,
	dirname
};

const args = DENO_RUNTIME_DETECTED ? Deno.args : process.argv.slice(2);

const stdout = {
	write: DENO_RUNTIME_DETECTED ? data => Deno.stdout.write(data) : data => process.stdout.write(data)
};

const build = {
	os: DENO_RUNTIME_DETECTED ? Deno.build.os : process.platform == "win32" ? "windows" : process.platform
};

const errors = {
	NotFound: DENO_RUNTIME_DETECTED ? Deno.errors.NotFound : class NotFound extends Error {
		constructor(message) {
			super(message);
			this.name = "NotFound";
		}
	}
};

async function initGlobalThisProperties() {
	if (!DENO_RUNTIME_DETECTED) {
		const { WebSocket } = await import(getNPMModule("ws"));
		globalThis.WebSocket = WebSocket;
	}
}

async function readTextFile(path) {
	if (DENO_RUNTIME_DETECTED) {
		return Deno.readTextFile(path);
	} else {
		const fsPromise = await import(NODE_MODULES["fs"]);
		return fsPromise.readFile(path, {
			encoding: "utf8"
		});
	}
}

async function writeTextFile(path, data, options = {}) {
	if (DENO_RUNTIME_DETECTED) {
		return Deno.writeTextFile(path, data, options);
	} else {
		const fsPromise = await import(NODE_MODULES["fs"]);
		if (options.append) {
			return fsPromise.appendFile(path, data, options);
		} else {
			return fsPromise.writeFile(path, data, options);
		}
	}
}

async function mkdir(path, options = {}) {
	if (DENO_RUNTIME_DETECTED) {
		return Deno.mkdir(path, options);
	} else {
		const fsPromise = await import(NODE_MODULES["fs"]);
		return fsPromise.mkdir(path, options);
	}
}

async function makeTempDir() {
	if (DENO_RUNTIME_DETECTED) {
		return Deno.makeTempDir();
	} else {
		const fsPromise = await import(NODE_MODULES["fs"]);
		const os = await import(NODE_MODULES["os"]);
		return fsPromise.mkdtemp(path.join(os.tmpdir()));
	}
}

async function stat(path) {
	if (DENO_RUNTIME_DETECTED) {
		return Deno.stat(path);
	} else {
		const fsPromise = await import(NODE_MODULES["fs"]);
		return fsPromise.stat(path);
	}
}

async function remove(path, options = {}) {
	if (DENO_RUNTIME_DETECTED) {
		return Deno.remove(path, options);
	} else {
		const fsPromise = await import(NODE_MODULES["fs"]);
		return fsPromise.rm(path, options);
	}
}

function exit(code) {
	if (DENO_RUNTIME_DETECTED) {
		Deno.exit(code);
	} else {
		process.exit(code);
	}
}

const Command = DENO_RUNTIME_DETECTED ? Deno.Command : class Command {
	constructor(path, options = {}) {
		this.path = path;
		this.options = options;
	}
	async spawn() {
		const childProcess = await import(NODE_MODULES["child_process"]);
		const child = childProcess.spawn(this.path, this.options.args);

		await new Promise((resolve, reject) => {
			child.on("spawn", () => resolve());
			child.on("error", error => {
				if (error.code == "ENOENT") {
					reject(new errors.NotFound(error.message));
				} else {
					reject(error);
				}
			});
		});
		return {
			status: new Promise((resolve, reject) => {
				child.on("exit", code => {
					if (code === 0 || code === 143) {
						resolve();
					} else {
						reject(new Error(`Process exited with code ${code}`));
					}
				});
			}),
			kill() {
				child.kill();
			},
			ref() {
				// Do nothing
			}
		};
	}
};

async function toFileUrl(filePath) {
	if (DENO_RUNTIME_DETECTED) {
		return path.toFileUrl(filePath);
	} else {
		const url = await import(NODE_MODULES["url"]);
		return new URL(url.pathToFileURL(filePath));
	}
}

async function dirname(filePath) {
	if (DENO_RUNTIME_DETECTED) {
		return path.dirname(filePath);
	} else {
		return path.dirname(filePath);
	}
}

function getNPMModule(module) {
	return NPM_MODULES[module];
}
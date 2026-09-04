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

// deno-lint-ignore-file no-node-globals

/* global Deno, process */

import * as path from "path";

const DENO_RUNTIME_DETECTED = typeof Deno !== "undefined";

const NODE_MODULES = {
	"fs": "node:fs/promises",
	"os": "node:os",
	"child_process": "node:child_process",
	"url": "node:url",
	"process": "node:process"
};

const args = DENO_RUNTIME_DETECTED ? Deno.args : process.argv.slice(2);

const env = {
	get: DENO_RUNTIME_DETECTED ? name => Deno.env.get(name) : name => process.env[name]
};

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
	},
	AlreadyExists: DENO_RUNTIME_DETECTED ? Deno.errors.AlreadyExists : class AlreadyExists extends Error {
		constructor(message) {
			super(message);
			this.name = "AlreadyExists";
		}
	}
};

const Command = DENO_RUNTIME_DETECTED ? Deno.Command : class Command {
	constructor(path, options = {}) {
		this.path = path;
		this.options = options;
	}
	async spawn() {
		const childProcess = await import(NODE_MODULES["child_process"]);
		const stdio = [this.options.stdin, this.options.stdout, this.options.stderr]
			.map(config => config == "null" ? "ignore" : config == "piped" ? "pipe" : "inherit");
		const child = childProcess.spawn(this.path, this.options.args, { stdio });

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
			status: new Promise(resolve => {
				child.on("exit", (code, signal) => resolve({ success: code === 0, code, signal }));
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

const DenoAPI = {
	args,
	env,
	readFile,
	readTextFile,
	readDir,
	writeTextFile,
	writeFile,
	copyFile,
	mkdir,
	makeTempDir,
	stat,
	remove,
	stdout,
	exit,
	addSignalListener,
	build,
	errors,
	Command,
	cwd
};

const pathAPI = {
	dirname,
	join,
	toFileUrl,
	fromFileUrl,
	SEPARATOR: DENO_RUNTIME_DETECTED ? path.SEPARATOR : path.sep
};

const isDeno = DENO_RUNTIME_DETECTED;

// the connection to the browser relies on the WebSocket of the runtime. Every version the
// engines field supports has one, so reaching this means either an older runtime than that,
// or Node.js started with --no-experimental-websocket, which still removes the global on
// current versions. The message names neither version, so that it cannot drift away from
// the engines field the way it already did once
if (typeof globalThis.WebSocket !== "function") {
	throw new Error("WebSocket is not available: the runtime is older than this package supports, or it was started with --no-experimental-websocket");
}

export { DenoAPI as Deno, pathAPI as path, isDeno };

async function readFile(path) {
	if (DENO_RUNTIME_DETECTED) {
		return Deno.readFile(path);
	} else {
		const fsPromise = await import(NODE_MODULES["fs"]);
		return new Uint8Array(await fsPromise.readFile(path));
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

async function readDir(path) {
	if (DENO_RUNTIME_DETECTED) {
		const entries = [];
		try {
			for await (const entry of Deno.readDir(path)) {
				entries.push({ name: entry.name, isDirectory: entry.isDirectory, isSymlink: entry.isSymlink });
			}
		} catch (error) {
			throw mapNotFoundError(error);
		}
		return entries;
	} else {
		const fsPromise = await import(NODE_MODULES["fs"]);
		try {
			const entries = await fsPromise.readdir(path, { withFileTypes: true });
			return entries.map(entry => ({ name: entry.name, isDirectory: entry.isDirectory(), isSymlink: entry.isSymbolicLink() }));
		} catch (error) {
			throw mapNotFoundError(error);
		}
	}
}

async function copyFile(sourcePath, destinationPath) {
	if (DENO_RUNTIME_DETECTED) {
		return Deno.copyFile(sourcePath, destinationPath);
	} else {
		const fsPromise = await import(NODE_MODULES["fs"]);
		return fsPromise.copyFile(sourcePath, destinationPath);
	}
}

function mapNotFoundError(error) {
	return error.code == "ENOENT" || error.code == "ENOTDIR" ? new errors.NotFound(error.message) : error;
}

async function writeTextFile(path, data, options = {}) {
	if (DENO_RUNTIME_DETECTED) {
		return Deno.writeTextFile(path, data, options);
	} else {
		const fsPromise = await import(NODE_MODULES["fs"]);
		options.encoding = "utf8";
		if (options.append) {
			return fsPromise.appendFile(path, data, options);
		} else {
			return nodeWriteFile(fsPromise, path, data, options);
		}
	}
}

async function writeFile(path, data, options = {}) {
	if (DENO_RUNTIME_DETECTED) {
		return Deno.writeFile(path, data, options);
	} else {
		const fsPromise = await import(NODE_MODULES["fs"]);
		return nodeWriteFile(fsPromise, path, data, options);
	}
}

async function nodeWriteFile(fsPromise, path, data, options) {
	if (options.createNew) {
		options.flag = "wx";
	}
	try {
		return await fsPromise.writeFile(path, data, options);
	} catch (error) {
		throw error.code == "EEXIST" ? new errors.AlreadyExists(error.message) : error;
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
		return fsPromise.mkdtemp(path.join(os.tmpdir(), "/"));
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
	if (code == "SIGINT") {
		code = 130;
	} else if (code == "SIGTERM") {
		code = 143;
	}
	if (DENO_RUNTIME_DETECTED) {
		Deno.exit(code);
	} else {
		process.exit(code);
	}
}

function addSignalListener(signal, listener) {
	if (DENO_RUNTIME_DETECTED) {
		Deno.addSignalListener(signal, () => listener(signal));
	} else {
		process.once(signal, listener);
	}
}

async function cwd() {
	if (DENO_RUNTIME_DETECTED) {
		return Deno.cwd();
	} else {
		const process = await import(NODE_MODULES["process"]);
		return process.cwd();
	}
}

function dirname(filePath) {
	return path.dirname(filePath);
}

function join(...filePaths) {
	return path.join(...filePaths);
}

async function toFileUrl(filePath) {
	if (DENO_RUNTIME_DETECTED) {
		return path.toFileUrl(filePath);
	} else {
		const url = await import(NODE_MODULES["url"]);
		return url.pathToFileURL(filePath).href;
	}
}

async function fromFileUrl(fileUrl) {
	if (DENO_RUNTIME_DETECTED) {
		return path.fromFileUrl(fileUrl);
	} else {
		const url = await import(NODE_MODULES["url"]);
		return url.fileURLToPath(fileUrl);
	}
}
/* global setInterval, clearInterval */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory } from "../target.js";

const execFileAsync = promisify(execFile);

test("load timeout is reported when the page never loads", { timeout: 120000 }, async () => {
	const server = createServer(() => { });
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const url = "http://localhost:" + server.address().port + "/";
		const { stderr } = await runCli([
			url, join(directory, "out.html"),
			"--browser-load-max-time", "5000",
			"--browser-wait-until-fallback", "false"
		]);
		assert.ok(stderr.includes("Load timeout"), "stderr: " + stderr);
	} finally {
		await rm(directory, { recursive: true });
		server.closeAllConnections();
		server.close();
	}
});

test("a page kept busy by an endless request is captured when the wait times out", { timeout: 120000 }, async () => {
	const server = createServer((request, response) => {
		if (request.url == "/stream") {
			response.writeHead(200, { "content-type": "text/plain" });
			const intervalId = setInterval(() => response.write("tick\n"), 200);
			response.on("close", () => clearInterval(intervalId));
		} else {
			response.writeHead(200, { "content-type": "text/html" });
			response.end("<!doctype html><title>busy</title><p id=marker>captured while a request never ends</p><script>fetch('/stream')</script>");
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const url = "http://localhost:" + server.address().port + "/";
		const output = join(directory, "out.html");
		const { stderr } = await runCli([url, output, "--browser-load-max-time", "3000"]);
		assert.ok(stderr.includes("did not reach networkIdle"), "stderr: " + stderr);
		assert.ok(stderr.includes("captured as it was at"), "stderr: " + stderr);
		assert.ok(!stderr.includes("Load timeout"), "stderr: " + stderr);
		const content = await readFile(output, "utf8");
		assert.ok(content.includes("captured while a request never ends"), "the page content was not captured");
	} finally {
		await rm(directory, { recursive: true });
		server.closeAllConnections();
		server.close();
	}
});

test("a page whose load event never fires is captured at DOMContentLoaded", { timeout: 120000 }, async () => {
	const server = createServer((request, response) => {
		if (request.url.startsWith("/hang")) {
			setTimeout(() => {
				response.writeHead(404);
				response.end();
			}, 10000);
			return;
		}
		response.writeHead(200, { "content-type": "text/html" });
		response.end("<!doctype html><title>hung</title><p id=marker>captured before load</p><img src=/hang1><img src=/hang2><img src=/hang3>");
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const url = "http://localhost:" + server.address().port + "/";
		const output = join(directory, "out.html");
		const { stderr } = await runCli([url, output, "--browser-load-max-time", "3000"]);
		assert.ok(stderr.includes("captured as it was at DOMContentLoaded"), "stderr: " + stderr);
		const content = await readFile(output, "utf8");
		assert.ok(content.includes("captured before load"), "the page content was not captured");
	} finally {
		await rm(directory, { recursive: true });
		server.closeAllConnections();
		server.close();
	}
});

test("the load timeout is reported when the fallback is disabled", { timeout: 120000 }, async () => {
	const server = createServer((request, response) => {
		if (request.url == "/stream") {
			response.writeHead(200, { "content-type": "text/plain" });
			const intervalId = setInterval(() => response.write("tick\n"), 200);
			response.on("close", () => clearInterval(intervalId));
		} else {
			response.writeHead(200, { "content-type": "text/html" });
			response.end("<!doctype html><title>busy</title><script>fetch('/stream')</script>");
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const url = "http://localhost:" + server.address().port + "/";
		const { stderr } = await runCli([url, join(directory, "out.html"), "--browser-load-max-time", "3000", "--browser-wait-until-fallback", "false"]);
		assert.ok(stderr.includes("Load timeout"), "stderr: " + stderr);
	} finally {
		await rm(directory, { recursive: true });
		server.closeAllConnections();
		server.close();
	}
});

test("capture timeout is reported when capturing an endless download", { timeout: 120000 }, async () => {
	const chunk = Buffer.alloc(65536);
	const server = createServer((_, response) => {
		response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=big.bin" });
		const intervalId = setInterval(() => response.write(chunk), 50);
		response.on("close", () => clearInterval(intervalId));
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const url = "http://localhost:" + server.address().port + "/";
		const { stderr } = await runCli([
			url, join(directory, "out.html"),
			"--browser-load-max-time", "5000",
			"--browser-capture-max-time", "10000"
		]);
		assert.ok(stderr.includes("Capture timeout") || stderr.includes("Load timeout"), "stderr: " + stderr);
	} finally {
		await rm(directory, { recursive: true });
		server.closeAllConnections();
		server.close();
	}
});

async function runCli(args) {
	try {
		return await execFileAsync(process.execPath, ["single-file-node.js", ...args], { cwd: cliDirectory, timeout: 90000, killSignal: "SIGKILL" });
	} catch (error) {
		if (error.killed) {
			throw new Error("the process did not exit before the timeout");
		}
		return { stdout: error.stdout, stderr: error.stderr };
	}
}

/* global URL */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory } from "../target.js";

const execFileAsync = promisify(execFile);
const FRAME_MARKER = "OUT_OF_PROCESS_FRAME_CONTENT";

test("blocked URL patterns and extra HTTP headers apply in cross-origin frames", { timeout: 120000 }, async () => {
	const BLOCKED_STYLE = "rgb(123,45,67)";
	const GATED_STYLE = "rgb(89,89,89)";
	const frameServer = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://127.0.0.1");
		if (pathname === "/tracker.css") {
			response.writeHead(200, { "content-type": "text/css" }).end("h2 { color: " + BLOCKED_STYLE + "; }");
		} else if (pathname === "/gated.css") {
			if (request.headers["x-test-header"] === "yes") {
				response.writeHead(200, { "content-type": "text/css" }).end("h3 { color: " + GATED_STYLE + "; }");
			} else {
				response.writeHead(404).end();
			}
		} else {
			response.writeHead(200, { "content-type": "text/html" }).end(
				"<html><head><link rel=\"stylesheet\" href=\"/tracker.css\"><link rel=\"stylesheet\" href=\"/gated.css\"></head>" +
				"<body><h2>blocked</h2><h3>gated</h3></body></html>");
		}
	});
	await new Promise(resolve => frameServer.listen(0, "127.0.0.1", resolve));
	const frameUrl = "http://127.0.0.1:" + frameServer.address().port + "/frame.html";
	const server = createServer((request, response) => {
		response.writeHead(200, { "content-type": "text/html" }).end("<html><body><iframe src=\"" + frameUrl + "\"></iframe></body></html>");
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		const url = "http://localhost:" + server.address().port + "/top.html";
		await execFileAsync(process.execPath, [
			"single-file-node.js", url, outputPath,
			"--blocked-URL-pattern", "tracker",
			"--http-header", "x-test-header=yes"
		], { cwd: cliDirectory });
		const content = await readFile(outputPath, "utf8");
		assert.ok(!content.includes(BLOCKED_STYLE), "a blocked stylesheet leaked into the frame");
		assert.ok(content.includes(GATED_STYLE), "the extra HTTP header was not sent for a frame resource");
	} finally {
		await rm(directory, { recursive: true });
		server.close();
		frameServer.close();
	}
});

test("cross-origin frames are captured in the saved page", { timeout: 120000 }, async () => {
	// localhost and 127.0.0.1 are different sites, so site isolation renders
	// the frame out of process, in a separate CDP target
	const frameServer = createServer((request, response) => {
		response.writeHead(200, { "content-type": "text/html" }).end("<html><body><p>" + FRAME_MARKER + "</p></body></html>");
	});
	await new Promise(resolve => frameServer.listen(0, "127.0.0.1", resolve));
	const frameUrl = "http://127.0.0.1:" + frameServer.address().port + "/frame.html";
	const server = createServer((request, response) => {
		response.writeHead(200, { "content-type": "text/html" }).end("<html><body><iframe src=\"" + frameUrl + "\"></iframe></body></html>");
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		const url = "http://localhost:" + server.address().port + "/top.html";
		await execFileAsync(process.execPath, ["single-file-node.js", url, outputPath], { cwd: cliDirectory });
		const content = await readFile(outputPath, "utf8");
		assert.ok(content.includes(FRAME_MARKER), "the out-of-process frame was saved empty");
	} finally {
		await rm(directory, { recursive: true });
		server.close();
		frameServer.close();
	}
});

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

test("a blocked URL is never requested", { timeout: 120000 }, async () => {
	const BLOCKED_STYLE = "rgb(123,45,67)";
	const KEPT_STYLE = "rgb(89,89,89)";
	const requestedPaths = [];
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		requestedPaths.push(pathname);
		if (pathname === "/tracker.css") {
			response.writeHead(200, { "content-type": "text/css" }).end("h2 { color: " + BLOCKED_STYLE + "; }");
		} else if (pathname === "/kept.css") {
			response.writeHead(200, { "content-type": "text/css" }).end("h3 { color: " + KEPT_STYLE + "; }");
		} else {
			response.writeHead(200, { "content-type": "text/html" }).end(
				"<html><head><link rel=\"stylesheet\" href=\"/tracker.css\"><link rel=\"stylesheet\" href=\"/kept.css\"></head>" +
				"<body><h2>blocked</h2><h3>kept</h3></body></html>");
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		const url = "http://localhost:" + server.address().port + "/top.html";
		await execFileAsync(process.execPath, [
			"single-file-node.js", url, outputPath,
			"--blocked-URL-pattern", "tracker"
		], { cwd: cliDirectory });
		const content = await readFile(outputPath, "utf8");
		// dropping the response is not blocking: the server must never be asked
		// for the resource in the first place
		assert.ok(!requestedPaths.includes("/tracker.css"), "the blocked URL was requested from the server");
		assert.ok(!content.includes(BLOCKED_STYLE), "a blocked stylesheet leaked into the page");
		assert.ok(requestedPaths.includes("/kept.css"), "an unblocked resource was not requested");
		assert.ok(content.includes(KEPT_STYLE), "an unblocked stylesheet was not inlined");
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
});

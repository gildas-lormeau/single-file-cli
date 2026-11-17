/* global setTimeout */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory } from "../target.js";

const execFileAsync = promisify(execFile);

// The first page redirects itself once its network went quiet, inside the
// settle delay of the wait. The second page keeps its body for longer than
// that delay, so a capture decided by the first page's state saves it empty.
test("a page that navigates after its network went quiet is captured once the new page loaded", { timeout: 120000 }, async () => {
	const server = createServer((request, response) => {
		response.writeHead(200, { "content-type": "text/html" });
		if (request.url == "/second") {
			response.write("<!doctype html><title>second</title><p>second page head</p>");
			setTimeout(() => response.end("<p id=late>second page body arrived late</p>"), 4000);
		} else {
			response.end("<!doctype html><title>first</title><p id=first>first page content</p><script>setTimeout(() => location.href = '/second', 800)</script>");
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const url = "http://localhost:" + server.address().port + "/";
		const output = join(directory, "out.html");
		await execFileAsync(process.execPath, ["single-file-node.js", url, output], { cwd: cliDirectory });
		const content = await readFile(output, "utf8");
		assert.ok(content.includes("second page body arrived late"), "the page was captured before the second page loaded");
		assert.ok(!content.includes("first page content"), "the first page was captured");
	} finally {
		await rm(directory, { recursive: true });
		server.closeAllConnections();
		server.close();
	}
});

// The first page replaces itself as soon as its document is parsed, while an image keeps its load
// event pending. That is what the challenge page of reddit.com does. Firefox reports the first
// navigation as failed when the second one interrupts it, after its document was displayed, and
// the tool took that for an unreachable URL: no page of reddit.com could be saved with
// --browser-engine firefox.
test("a page that navigates before its load event is captured once the new page loaded", { timeout: 120000 }, async () => {
	const pendingResponses = [];
	const server = createServer((request, response) => {
		if (request.url == "/pending.png") {
			pendingResponses.push(response);
		} else if (request.url == "/second") {
			response.writeHead(200, { "content-type": "text/html" });
			response.end("<!doctype html><title>second</title><p>second page content</p>");
		} else {
			response.writeHead(200, { "content-type": "text/html" });
			response.end("<!doctype html><title>first</title><p id=first>first page content</p><img src=/pending.png>" +
				"<script>addEventListener('DOMContentLoaded', () => location.replace('/second'))</script>");
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const url = "http://localhost:" + server.address().port + "/";
		const output = join(directory, "out.html");
		await execFileAsync(process.execPath, ["single-file-node.js", url, output], { cwd: cliDirectory });
		const content = await readFile(output, "utf8");
		assert.ok(content.includes("second page content"), "the second page was not captured");
		assert.ok(!content.includes("first page content"), "the first page was captured");
	} finally {
		await rm(directory, { recursive: true });
		pendingResponses.forEach(response => response.destroy());
		server.closeAllConnections();
		server.close();
	}
});

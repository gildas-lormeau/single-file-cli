/* global setTimeout, URL */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import process from "node:process";
import { cliDirectory } from "../target.js";

const execFileAsync = promisify(execFile);
const LOAD_MARKER = "MARKER_ADDED_AFTER_LOAD_EVENT";
const SLOW_RESOURCE_DELAY = 3500;
const PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const TOP_PAGE = `<html><head><title>top</title></head><body>
<img src="/slow.png">
<iframe src="/frame.html"></iframe>
<script>
addEventListener("load", () => {
	const marker = document.createElement("div");
	marker.textContent = "${LOAD_MARKER}";
	document.body.appendChild(marker);
});
</script>
</body></html>`;

test("capture waits for the top frame, not a fast iframe", { timeout: 120000 }, async () => {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		if (pathname === "/top.html") {
			response.writeHead(200, { "content-type": "text/html" }).end(TOP_PAGE);
		} else if (pathname === "/frame.html") {
			response.writeHead(200, { "content-type": "text/html" }).end("<html><body>frame</body></html>");
		} else if (pathname === "/slow.png") {
			setTimeout(() => response.writeHead(200, { "content-type": "image/png" }).end(PIXEL_PNG), SLOW_RESOURCE_DELAY);
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		const url = "http://localhost:" + server.address().port + "/top.html";
		await execFileAsync(process.execPath, [
			"single-file-node.js", url, outputPath,
			"--browser-wait-until", "networkIdle",
			"--browser-wait-until-delay", "1000",
			"--browser-wait-until-fallback", "false"
		], { cwd: cliDirectory });
		const content = await readFile(outputPath, "utf8");
		assert.ok(content.includes(LOAD_MARKER), "page was captured before the top frame finished loading");
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
});

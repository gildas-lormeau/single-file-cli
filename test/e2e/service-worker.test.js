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
import { cliDirectory, firefox } from "../target.js";

const execFileAsync = promisify(execFile);

// the worker fetches a marked URL instead of passing the request through, so a
// request reaching the server proves the service worker is the one that made it
const SERVICE_WORKER = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
	const url = new URL(event.request.url);
	if (url.pathname.endsWith(".css")) {
		url.searchParams.set("via", "sw");
		event.respondWith(fetch(url.href));
	}
});`;

const PAGE = `<html><head></head><body><h2>styled</h2><h3>tracked</h3>
<script>
navigator.serviceWorker.register("/sw.js").then(async () => {
	await navigator.serviceWorker.ready;
	if (!navigator.serviceWorker.controller) {
		await new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
	}
	for (const href of ["/styled.css", "/tracker.css"]) {
		await new Promise(resolve => {
			const link = document.createElement("link");
			link.rel = "stylesheet";
			link.href = href;
			link.onload = link.onerror = resolve;
			document.head.appendChild(link);
		});
	}
});
</script></body></html>`;

test("network options reach the requests made by a service worker", { timeout: 120000, skip: firefox && "Firefox reports the requests of a service worker as intercepted but refuses to continue them" }, async () => {
	const STYLE = "rgb(7,7,7)";
	const requests = [];
	const server = createServer((request, response) => {
		const url = new URL(request.url, "http://localhost");
		requests.push({
			path: url.pathname,
			via: url.searchParams.get("via") || "-",
			header: request.headers["x-test-header"] || "-"
		});
		if (url.pathname === "/sw.js") {
			response.writeHead(200, { "content-type": "text/javascript" }).end(SERVICE_WORKER);
		} else if (url.pathname === "/styled.css") {
			response.writeHead(200, { "content-type": "text/css" }).end("h2 { color: " + STYLE + "; }");
		} else if (url.pathname === "/tracker.css") {
			response.writeHead(200, { "content-type": "text/css" }).end("h3 { color: rgb(9,9,9); }");
		} else {
			response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		const url = "http://localhost:" + server.address().port + "/top.html";
		await execFileAsync(process.execPath, [
			"single-file-node.js", url, outputPath,
			"--http-header", "x-test-header=yes",
			"--blocked-URL-pattern", "tracker",
			"--browser-wait-delay", "3000"
		], { cwd: cliDirectory });
		const content = await readFile(outputPath, "utf8");
		const workerRequest = requests.find(({ path, via }) => path === "/styled.css" && via === "sw");
		assert.ok(workerRequest, "the service worker never served the stylesheet, the test proves nothing");
		assert.equal(workerRequest.header, "yes", "the extra HTTP header was not sent by the service worker");
		assert.ok(!requests.some(({ path }) => path === "/tracker.css"), "the service worker requested a blocked URL");
		assert.ok(content.includes(STYLE), "the stylesheet served by the service worker was not inlined");
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
});

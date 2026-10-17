/* global URL */

// --http-proxy-server reaches the browser at launch, and the browser routes its requests through
// it. A resource the browser could not fetch is fetched again outside the browser, by the runtime,
// and that request got no proxy at all: it left the machine directly, around the proxy the user
// configured. On Deno the request now gets the same proxy through a client; on Node.js, which has
// no per-request proxy without a dependency, it is refused. Both are the same promise seen from the
// resource server: with a proxy configured, no request made outside the browser reaches it directly.
//
// The suite spawns the Node entry point, so this proves the refusal. The resource is served on a
// loopback address without access-control-allow-origin: the browser bypasses the proxy for loopback
// and sends the request itself, refuses the response, and the page falls back to the fetch made
// outside the browser. That fetch sends no sec-fetch-dest, the browser always does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory, fastCaptureArgs } from "../target.js";

const execFileAsync = promisify(execFile);

test("with a proxy configured, the backend fetch does not reach the resource directly", { timeout: 120000 }, async () => {
	const requests = [];
	const resourceServer = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://127.0.0.1");
		requests.push({ headers: request.headers });
		if (pathname === "/cors.css") {
			response.writeHead(200, { "content-type": "text/css" }).end("h2 { color: rgb(11,22,33); }");
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => resourceServer.listen(0, "127.0.0.1", resolve));
	const proxy = createServer((request, response) => response.writeHead(502).end());
	await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
	const styleUrl = "http://127.0.0.1:" + resourceServer.address().port + "/cors.css";
	const server = createServer((request, response) => {
		response.writeHead(200, { "content-type": "text/html" }).end(
			"<html><head><link rel=\"stylesheet\" href=\"" + styleUrl + "\"></head><body><h2>styled</h2></body></html>");
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		const url = "http://localhost:" + server.address().port + "/top.html";
		await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, url, outputPath,
			"--http-proxy-server", "127.0.0.1:" + proxy.address().port
		], { cwd: cliDirectory });
		const browserRequests = requests.filter(({ headers }) => headers["sec-fetch-dest"] !== undefined);
		const backendRequests = requests.filter(({ headers }) => headers["sec-fetch-dest"] === undefined);
		assert.ok(browserRequests.length, "the resource was not fetched by the browser");
		assert.equal(backendRequests.length, 0, "a request made outside the browser reached the resource around the proxy");
	} finally {
		await rm(directory, { recursive: true });
		server.close();
		resourceServer.close();
		proxy.close();
	}
});

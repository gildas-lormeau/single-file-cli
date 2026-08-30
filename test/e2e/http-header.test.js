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

test("extra HTTP headers do not make cross-origin resources send a preflight", { timeout: 120000 }, async () => {
	const STYLE = "rgb(11,22,33)";
	const requests = [];
	// a server sharing its resources with any origin but not answering preflights,
	// the shape that loses the resource when the request is preflighted
	const resourceServer = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://127.0.0.1");
		requests.push({ method: request.method, headers: request.headers });
		if (request.method === "OPTIONS") {
			response.writeHead(403).end();
		} else if (pathname === "/cors.css") {
			response.writeHead(200, { "content-type": "text/css", "access-control-allow-origin": "*" }).end("h2 { color: " + STYLE + "; }");
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => resourceServer.listen(0, "127.0.0.1", resolve));
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
			"single-file-node.js", url, outputPath,
			"--http-header", "x-test-header=yes"
		], { cwd: cliDirectory });
		const content = await readFile(outputPath, "utf8");
		assert.ok(!requests.some(({ method }) => method === "OPTIONS"), "the extra HTTP header made the request send a preflight");
		// the browser is what fetched the resource, the backend fetch sends no
		// sec-fetch-mode and would hide a preflight failure behind a working save
		const corsRequest = requests.find(({ headers }) => headers["sec-fetch-mode"] === "cors");
		assert.ok(corsRequest, "the resource was not fetched by the browser");
		assert.equal(corsRequest.headers["x-test-header"], "yes", "the extra HTTP header was not sent");
		assert.ok(content.includes(STYLE), "the cross-origin stylesheet was not inlined");
	} finally {
		await rm(directory, { recursive: true });
		server.close();
		resourceServer.close();
	}
});

/* global URL */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory } from "../target.js";

const execFileAsync = promisify(execFile);

test("the backend fetch presents the same user agent as the browser", { timeout: 120000 }, async () => {
	const requests = [];
	// no access-control-allow-origin, so the browser sends the request, refuses the
	// response and the page falls back to the fetch made outside the browser
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
		await execFileAsync(process.execPath, ["single-file-node.js", url, outputPath], { cwd: cliDirectory });
		// the fetch made outside the browser sends no sec-fetch-dest; it does send
		// sec-fetch-mode, which node sets on every request, so that one tells nothing
		const browserRequest = requests.find(({ headers }) => headers["sec-fetch-dest"] !== undefined);
		const backendRequest = requests.find(({ headers }) => headers["sec-fetch-dest"] === undefined);
		assert.ok(browserRequest, "the resource was not fetched by the browser");
		assert.ok(backendRequest, "the resource was not fetched outside the browser");
		assert.equal(backendRequest.headers["user-agent"], browserRequest.headers["user-agent"],
			"the backend fetch presented another user agent than the browser");
	} finally {
		await rm(directory, { recursive: true });
		server.close();
		resourceServer.close();
	}
});

test("the backend fetch presents the user agent given on the command line", { timeout: 120000 }, async () => {
	const USER_AGENT = "SingleFileProbe/1.0";
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
			"--user-agent", USER_AGENT
		], { cwd: cliDirectory });
		assert.ok(requests.length, "the resource was not fetched");
		assert.ok(requests.every(({ headers }) => headers["user-agent"] === USER_AGENT),
			"a request presented another user agent: " + JSON.stringify(requests.map(({ headers }) => headers["user-agent"])));
	} finally {
		await rm(directory, { recursive: true });
		server.close();
		resourceServer.close();
	}
});

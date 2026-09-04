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
const USERNAME = "single";
const PASSWORD = "file";
// a name the browser cannot resolve itself, so the request can only reach the proxy;
// a loopback address would be bypassed by both engines
const PAGE_URL = "http://proxy-auth.test/page.html";
const MARKER = "served through the proxy";
const CREDENTIALS = "Basic " + Buffer.from(USERNAME + ":" + PASSWORD).toString("base64");

test("proxy credentials answer the 407 challenge of the proxy", { timeout: 120000 }, async () => {
	const requests = [];
	const proxy = createServer((request, response) => {
		const authorization = request.headers["proxy-authorization"];
		requests.push({ url: request.url, authorization });
		if (authorization !== CREDENTIALS) {
			response.writeHead(407, { "proxy-authenticate": "Basic realm=\"single-file\"", "content-type": "text/plain" }).end("proxy authentication required");
		} else if (request.url === PAGE_URL) {
			response.writeHead(200, { "content-type": "text/html" }).end("<html><head><title>proxied</title></head><body><p>" + MARKER + "</p></body></html>");
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		await execFileAsync(process.execPath, [
			"single-file-node.js", PAGE_URL, outputPath,
			"--http-proxy-server", "127.0.0.1:" + proxy.address().port,
			"--http-proxy-username", USERNAME,
			"--http-proxy-password", PASSWORD
		], { cwd: cliDirectory });
		const content = await readFile(outputPath, "utf8");
		assert.ok(content.includes(MARKER), "the page was not fetched through the proxy");
		assert.ok(requests.some(({ authorization }) => !authorization), "the proxy never challenged the browser");
		assert.ok(requests.some(({ url, authorization }) => url === PAGE_URL && authorization === CREDENTIALS), "the credentials were never sent to the proxy");
	} finally {
		await rm(directory, { recursive: true, force: true });
		proxy.close();
	}
});

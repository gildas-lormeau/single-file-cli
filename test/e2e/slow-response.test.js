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

// The server answers after the network of the blank page went idle, and sends
// the body of the page later still. A wait satisfied by the blank page captures
// the document as soon as it commits, while it has a head and no body yet.
test("a page whose server answers late is captured once loaded", { timeout: 120000 }, async () => {
	const server = createServer((request, response) => {
		if (request.url == "/") {
			setTimeout(() => {
				response.writeHead(200, { "content-type": "text/html" });
				response.write("<!doctype html><html><head><title>late</title>");
				setTimeout(() => response.end("</head><body><p id=late>body arrived late</p></body></html>"), 3000);
			}, 3000);
		} else {
			response.writeHead(404);
			response.end();
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const url = "http://localhost:" + server.address().port + "/";
		const output = join(directory, "out.html");
		await execFileAsync(process.execPath, ["single-file-node.js", url, output], { cwd: cliDirectory });
		const content = await readFile(output, "utf8");
		assert.ok(content.includes("body arrived late"), "the page was captured before its body arrived");
	} finally {
		await rm(directory, { recursive: true });
		server.closeAllConnections();
		server.close();
	}
});

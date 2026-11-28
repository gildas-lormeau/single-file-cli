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
import { cliDirectory, fastCaptureArgs } from "../target.js";

// --remove-saved-date promises a file that does not tell when it was saved. In a ZIP file the date
// was still written on every entry, as its modification date, and in manifest.json as
// `archiveTime`, so two captures of the same page never gave the same file (SingleFile#1918).
//
// Each test captures the same page twice, from the same server so that the address of the page
// is the same, and compares the two files byte for byte. `archiveTime` is written in
// milliseconds: without the option the two files differ however close the captures are, which is
// what the last test checks.

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 120000;
const PAGE = "<html><head><title>Undated page</title><link rel=stylesheet href=/style.css></head><body><p>content</p></body></html>";
const STYLESHEET = "p { color: navy }";

test("a ZIP file captured twice with --remove-saved-date is the same file", { timeout: TEST_TIMEOUT }, async () => {
	const [first, second] = await captureTwice(["--compress-content", "--self-extracting-archive=false", "--remove-saved-date"]);
	assert.deepEqual(first, second);
});

test("a self-extracting file captured twice with --remove-saved-date is the same file", { timeout: TEST_TIMEOUT }, async () => {
	const [first, second] = await captureTwice(["--compress-content", "--remove-saved-date"]);
	assert.deepEqual(first, second);
});

test("a ZIP file captured twice without --remove-saved-date differs", { timeout: TEST_TIMEOUT }, async () => {
	const [first, second] = await captureTwice(["--compress-content", "--self-extracting-archive=false"]);
	assert.notDeepEqual(first, second);
});

async function captureTwice(args) {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		if (pathname === "/") {
			response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
		} else if (pathname === "/style.css") {
			response.writeHead(200, { "content-type": "text/css" }).end(STYLESHEET);
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const origin = "http://localhost:" + server.address().port;
		const captures = [];
		for (const filename of ["first.html", "second.html"]) {
			await execFileAsync(process.execPath, ["single-file-node.js", ...fastCaptureArgs, origin + "/", join(directory, filename), ...args], { cwd: cliDirectory });
			captures.push(new Uint8Array(await readFile(join(directory, filename))));
		}
		return captures;
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
}

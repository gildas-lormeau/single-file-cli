/* global URL */

// Every other test in this suite reads a capture as bytes: zip fields, entry names, JSON shape.
// None of them opened one. That is how single-file-cli 2.6.0 and 2.6.1 shipped producing
// self-extracting archives that rendered a blank page — the zip was valid, `index.html` was
// correct, every assertion those tests make stayed true, and the script that unpacks the archive
// in the browser threw `ReferenceError` before writing anything.
//
// So this file asserts the only thing a user actually cares about: the saved file opens, its
// console is clean, and the page that appears is the page that was saved. It captures a marker,
// then re-captures the saved file from a file:// URL and looks for that marker in the result —
// a capture of a blank page cannot contain it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { cliDirectory } from "../target.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 180000;
const MARKER = "single-file-render-marker-9f2c";
const PAGE = "<html><head><title>Saved Page</title></head><body><p id=\"marker\">" + MARKER + "</p></body></html>";

test("a self-extracting archive opens with no console error and shows the saved page", { timeout: TEST_TIMEOUT }, async () => {
	const { consoleMessages, reopened } = await captureAndReopen(["--compress-content"]);
	assertNoConsoleError(consoleMessages);
	assert.ok(reopened.includes(MARKER), "the reopened archive does not contain the saved content");
});

test("a plain saved page opens with no console error and shows the saved page", { timeout: TEST_TIMEOUT }, async () => {
	const { consoleMessages, reopened } = await captureAndReopen([]);
	assertNoConsoleError(consoleMessages);
	assert.ok(reopened.includes(MARKER), "the reopened page does not contain the saved content");
});

function assertNoConsoleError(consoleMessages) {
	const errors = consoleMessages.filter(message => message.level === "error");
	assert.deepEqual(errors.map(message => message.text), [], "the saved page logged errors when opened");
}

async function captureAndReopen(options) {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		if (pathname === "/") {
			response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const savedPath = join(directory, "saved.html");
		await runCli(["http://localhost:" + server.address().port + "/", savedPath, ...options]);
		// re-capturing the saved file runs it in the browser: whatever the page ends up displaying
		// is what gets written out, so a page that failed to render comes back without the marker
		const reopenedPath = join(directory, "reopened.html");
		const consolePath = join(directory, "console.json");
		await runCli([pathToFileURL(savedPath).href, reopenedPath, "--console-messages-file", consolePath]);
		return {
			consoleMessages: JSON.parse(await readFile(consolePath, "utf-8")),
			reopened: await readFile(reopenedPath, "utf-8")
		};
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
}

function runCli(args) {
	return execFileAsync(process.execPath, ["single-file-node.js", ...args], { cwd: cliDirectory });
}

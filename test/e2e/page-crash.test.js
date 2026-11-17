/* global setTimeout, clearTimeout */

// When the process rendering a page ends, the browser stays up and stops answering for that page.
// The tool used to wait for the whole of --browser-capture-max-time and report "Capture timeout",
// which tells the user to raise a delay when no delay can help. It was found on a Reddit thread of
// 577 comments (SingleFile #1514): the renderer ran out of memory 78 seconds into the capture, and
// the tool said "Capture timeout" 24 minutes later.
//
// The pages below run out of memory on purpose. The limit of the JavaScript heap is lowered to
// 64 MB for these captures, so that the crash comes in a second and costs no memory on the machine
// running the tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory, fastCaptureArgs, firefox } from "../target.js";

const TEST_TIMEOUT = 120000;
const PROCESS_TIMEOUT = 90000;
const MAX_ELAPSED_TIME = 45000;
const LOW_MEMORY_ARGS = ["--browser-args", JSON.stringify(["--js-flags=--max-old-space-size=64"])];
const FILL_MEMORY = "const hold = []; for (;;) { hold.push(new Array(100000).fill({})); }";
const SKIP_REASON = firefox && "the crash of a page is reported through CDP only";

test("a page that crashes while it loads ends the capture at once, with its own error", { timeout: TEST_TIMEOUT, skip: SKIP_REASON }, async () => {
	await withCapture("<html><body><p>text</p><script>" + FILL_MEMORY + "</script></body></html>", [], ({ code, stderr, elapsedTime }) => {
		assert.notEqual(code, 0);
		assert.match(stderr, /Page crashed/, "stderr: " + stderr);
		assert.doesNotMatch(stderr, /timeout/i, "stderr: " + stderr);
		assert.ok(elapsedTime < MAX_ELAPSED_TIME, "elapsed: " + elapsedTime + " ms");
	});
});

// the page is loaded and the tool is waiting before the capture, as it is while a capture runs:
// no command is in flight that the crash could fail
test("a page that crashes after it loaded ends the capture at once too", { timeout: TEST_TIMEOUT, skip: SKIP_REASON }, async () => {
	const page = "<html><body><p>text</p><script>addEventListener(\"load\", () => setTimeout(() => { " + FILL_MEMORY + " }, 3000));</script></body></html>";
	await withCapture(page, ["--browser-wait-delay", "60000"], ({ code, stderr, elapsedTime }) => {
		assert.notEqual(code, 0);
		assert.match(stderr, /Page crashed/, "stderr: " + stderr);
		assert.ok(elapsedTime < MAX_ELAPSED_TIME, "elapsed: " + elapsedTime + " ms");
	});
});

// the control: the lowered limit alone does not crash a page
test("a page that does not crash is saved with the same memory limit", { timeout: TEST_TIMEOUT, skip: SKIP_REASON }, async () => {
	await withCapture("<html><body><p>text</p></body></html>", [], ({ code, stderr }) => {
		assert.equal(code, 0, "stderr: " + stderr);
	});
});

async function withCapture(page, args, check) {
	const server = createServer((request, response) => {
		response.writeHead(200, { "content-type": "text/html" });
		response.end(page);
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const startTime = Date.now();
		const result = await runCli(["http://127.0.0.1:" + server.address().port + "/", join(directory, "out.html"), ...fastCaptureArgs, ...LOW_MEMORY_ARGS, ...args]);
		check({ ...result, elapsedTime: Date.now() - startTime });
	} finally {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
		await rm(directory, { recursive: true });
	}
}

function runCli(args) {
	return new Promise((resolve, reject) => {
		let terminated = false, killTimeoutId;
		const child = execFile(process.execPath, ["single-file-node.js", ...args], { cwd: cliDirectory }, (error, stdout, stderr) => {
			clearTimeout(terminateTimeoutId);
			clearTimeout(killTimeoutId);
			if (terminated) {
				reject(new Error("the process did not exit before the timeout, stderr: " + stderr));
			} else {
				resolve({ code: error ? error.code : 0, stdout, stderr });
			}
		});
		const terminateTimeoutId = setTimeout(() => {
			terminated = true;
			child.kill("SIGTERM");
			killTimeoutId = setTimeout(() => child.kill("SIGKILL"), 10000);
		}, PROCESS_TIMEOUT);
	});
}

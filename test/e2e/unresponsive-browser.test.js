/* global setTimeout, clearTimeout */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { cliDirectory, firefox } from "../target.js";

const FAKE_BROWSER_PATH = join(dirname(fileURLToPath(import.meta.url)), "unresponsive-browser.js");

// Before the setup steps had a time limit, a browser that never answered one CDP command held
// the CLI for ever: --browser-load-max-time and --browser-capture-max-time only start once the
// page is navigated. The stand-in browser leaves Emulation.setUserAgentOverride unanswered.
test("a browser that stops answering during the setup ends in a setup timeout", { timeout: 120000, skip: (firefox && "the fake browser speaks CDP only") || (process.platform == "win32" && "the fake browser is a script with a shebang") }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const start = Date.now();
		const { code, stderr } = await runCli([
			"https://example.com", join(directory, "out.html"),
			"--browser-executable-path", FAKE_BROWSER_PATH,
			"--browser-load-max-time", "3000"
		]);
		assert.notEqual(code, 0);
		assert.ok(stderr.includes("Setup timeout"), "stderr: " + stderr);
		assert.ok(Date.now() - start < 30000, "elapsed: " + (Date.now() - start) + " ms");
	} finally {
		await rm(directory, { recursive: true });
	}
});

function runCli(args) {
	return new Promise((resolve, reject) => {
		let terminated = false, killTimeoutId;
		const child = execFile(process.execPath, ["single-file-node.js", ...args], { cwd: cliDirectory }, (error, stdout, stderr) => {
			clearTimeout(terminateTimeoutId);
			clearTimeout(killTimeoutId);
			if (terminated) {
				reject(new Error("the process did not exit before the timeout"));
			} else {
				resolve({ code: error ? error.code : 0, stdout, stderr });
			}
		});
		const terminateTimeoutId = setTimeout(() => {
			terminated = true;
			child.kill("SIGTERM");
			killTimeoutId = setTimeout(() => child.kill("SIGKILL"), 10000);
		}, 60000);
	});
}

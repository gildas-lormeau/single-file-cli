// --browser-width and --browser-height are the size of the viewport, which is what a page is laid
// out in. With Chromium they were only the size of the window: Chrome keeps 87 px of its height for
// the window frame, in headless mode too, so the default 1280x720 gave pages a viewport of 1280x633
// and `--browser-height 600` gave 513. Firefox was given the viewport itself, and the two engines
// saved different layouts of the same page from the same options.

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

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 120000;
// the size is written by a script, which the saved page does not keep, into text that it does
const PAGE = `<!doctype html><html><head><title>browser size</title></head><body><p id=size></p>
	<script>document.querySelector("#size").textContent = "viewport " + innerWidth + "x" + innerHeight + ", vh " + Math.round(document.documentElement.clientHeight);</script>
</body></html>`;

test("the default viewport is 1280x720", { timeout: TEST_TIMEOUT }, async () => {
	assert.match(await getSavedPage([]), /viewport 1280x720, vh 720/);
});

test("--browser-width and --browser-height set the size of the viewport", { timeout: TEST_TIMEOUT }, async () => {
	assert.match(await getSavedPage(["--browser-width", "1000", "--browser-height", "600"]), /viewport 1000x600, vh 600/);
});

test("--browser-device-width and --browser-device-height still take precedence", { timeout: TEST_TIMEOUT }, async () => {
	assert.match(await getSavedPage(["--browser-width", "1000", "--browser-height", "600", "--browser-device-width", "800", "--browser-device-height", "500"]), /viewport 800x500, vh 500/);
});

async function getSavedPage(args) {
	const server = createServer((request, response) =>
		response.writeHead(200, { "content-type": "text/html" }).end(PAGE));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, "http://localhost:" + server.address().port + "/", outputPath, ...args
		], { cwd: cliDirectory });
		return await readFile(outputPath, "utf8");
	} finally {
		await rm(directory, { recursive: true, force: true });
		server.close();
	}
}

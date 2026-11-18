// --embed-screenshot and --embed-pdf embedded nothing for five weeks, and said nothing about it
// (issue #212). The page script receives the screenshot while the page is processed and stored it
// on the options object it had passed to single-file-core. Core copies that object when it holds an
// option under a deprecated name, to add the current name, and then reads the copy only. The tool
// itself passed such a name on every run: --remove-alternative-images filled `blockAlternativeImages`,
// the key of the option it had been merged with. A settings file defining `removeAlternativeImages`
// hid the bug, since core then had nothing to rename.
//
// Both halves are checked: the default run, and a settings file that still brings a deprecated name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory, fastCaptureArgs } from "../target.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 120000;
const PAGE = "<!doctype html><html><head><title>embedded</title></head><body><p>content</p></body></html>";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF_SIGNATURE = "%PDF-";
// an option that has no default value, so that nothing but the profile defines it
const DEPRECATED_SETTINGS = { profiles: { __Default_Settings__: { loadDeferredImagesKeepZoomLevel: true } }, rules: [] };

test("--embed-screenshot makes the saved file a PNG image", { timeout: TEST_TIMEOUT }, async () => {
	const content = await getSavedPage(["--compress-content", "--embed-screenshot"]);
	assert.deepEqual(Array.from(content.subarray(0, PNG_SIGNATURE.length)), PNG_SIGNATURE);
});

test("--embed-screenshot=false leaves the saved file an HTML page", { timeout: TEST_TIMEOUT }, async () => {
	const content = await getSavedPage(["--compress-content"]);
	assert.notDeepEqual(Array.from(content.subarray(0, PNG_SIGNATURE.length)), PNG_SIGNATURE);
});

// the PDF document does not start the file, it is wrapped in the HTML that precedes the ZIP data
test("--embed-pdf writes the PDF document in the saved file", { timeout: TEST_TIMEOUT }, async () => {
	const content = await getSavedPage(["--compress-content", "--embed-pdf"]);
	assert.ok(content.includes(PDF_SIGNATURE));
	assert.ok(!(await getSavedPage(["--compress-content"])).includes(PDF_SIGNATURE));
});

test("a settings file with a deprecated option name does not lose the screenshot", { timeout: TEST_TIMEOUT }, async () => {
	const content = await getSavedPage(["--compress-content", "--embed-screenshot"], DEPRECATED_SETTINGS);
	assert.deepEqual(Array.from(content.subarray(0, PNG_SIGNATURE.length)), PNG_SIGNATURE);
});

async function getSavedPage(args, settings) {
	const server = createServer((request, response) =>
		response.writeHead(200, { "content-type": "text/html" }).end(PAGE));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		if (settings) {
			const settingsPath = join(directory, "settings.json");
			await writeFile(settingsPath, JSON.stringify(settings));
			args = [...args, "--settings-file", settingsPath];
		}
		await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, "http://localhost:" + server.address().port + "/", outputPath, ...args
		], { cwd: cliDirectory });
		return await readFile(outputPath);
	} finally {
		await rm(directory, { recursive: true, force: true });
		server.close();
	}
}

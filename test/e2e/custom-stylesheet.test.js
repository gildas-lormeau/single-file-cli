// --custom-stylesheet hands CSS to SingleFile itself (the customStylesheet option of the core), which
// inserts it as the last stylesheet of the page and of every frame before it reads them. So the
// rules are in effect when hidden elements are marked for removal, which is what distinguishes it
// from --browser-stylesheet: that one is inserted by the browser when the page loads, and a page
// script that runs later can override it. The marker attribute the core uses to recognise its own
// stylesheet must not reach the saved page.

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
const PAGE = "<html><body><h1>page</h1><div id=\"hidden\" style=\"display:none\"><p>revealed text</p></div></body></html>";
const CUSTOM_CSS = "#hidden{display:block !important}";

test("a custom stylesheet is in effect when the page is saved", { timeout: TEST_TIMEOUT }, async () => {
	await withPage(async ({ url, directory }) => {
		const outputPath = join(directory, "out.html");
		await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, "--remove-hidden-elements", url, outputPath,
			"--custom-stylesheet", CUSTOM_CSS
		], { cwd: cliDirectory });
		const content = await readFile(outputPath, "utf8");
		assert.match(content, /revealed text/, "the element the stylesheet reveals was removed as hidden");
		assert.match(content, /#hidden\{display:block\s*!important\}/, "the rules are not in the saved page");
		assert.doesNotMatch(content, /data-single-file-custom-stylesheet/, "the marker attribute reached the saved page");
	});
});

test("control: without the option the hidden element is removed", { timeout: TEST_TIMEOUT }, async () => {
	await withPage(async ({ url, directory }) => {
		const outputPath = join(directory, "out.html");
		await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, "--remove-hidden-elements", url, outputPath
		], { cwd: cliDirectory });
		assert.doesNotMatch(await readFile(outputPath, "utf8"), /revealed text/);
	});
});

async function withPage(run) {
	const server = createServer((request, response) =>
		response.writeHead(200, { "content-type": "text/html" }).end(PAGE));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		await run({ url: "http://localhost:" + server.address().port + "/", directory });
	} finally {
		await rm(directory, { recursive: true, force: true });
		server.close();
	}
}

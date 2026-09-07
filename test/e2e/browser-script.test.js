// The injected script is one concatenation: the SingleFile bundle, then the scripts named by
// --browser-script, then the call that hands SingleFile its options and its fetch fallback. A
// throw anywhere in it stops the rest, and nothing reported it — the browser does not surface an
// exception raised by a preload script, and the only guard was "is `singlefile` defined", which is
// already true by then. So a script that threw produced a save that looked ordinary and was
// missing the fetch fallback the CLI installs for the resources the page itself cannot get.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory } from "../target.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 120000;

test("a browser script runs in the page it saves", { timeout: TEST_TIMEOUT }, async () => {
	const MARKER = "browser-script-marker";
	await withPage(async ({ url, directory }) => {
		const scriptPath = join(directory, "marker.js");
		await writeFile(scriptPath, "addEventListener(\"DOMContentLoaded\",()=>{" +
			"const marker=document.createElement(\"p\");marker.id=\"" + MARKER + "\";document.body.appendChild(marker);});");
		const outputPath = join(directory, "out.html");
		await execFileAsync(process.execPath, [
			"single-file-node.js", url, outputPath,
			"--browser-script", scriptPath
		], { cwd: cliDirectory });
		assert.match(await readFile(outputPath, "utf8"), new RegExp(MARKER));
	});
});

test("a browser script that throws fails the save instead of degrading it", { timeout: TEST_TIMEOUT }, async () => {
	const SCRIPT_ERROR_MESSAGE = "browser script boom";
	await withPage(async ({ url, directory }) => {
		const scriptPath = join(directory, "throwing.js");
		await writeFile(scriptPath, "throw new Error(\"" + SCRIPT_ERROR_MESSAGE + "\");");
		const outputPath = join(directory, "out.html");
		let exitCode = 0, stderr = "";
		try {
			await execFileAsync(process.execPath, [
				"single-file-node.js", url, outputPath,
				"--browser-script", scriptPath
			], { cwd: cliDirectory });
		} catch (error) {
			({ code: exitCode, stderr } = error);
		}
		assert.notEqual(exitCode, 0, "a save whose injected script threw was reported as a success");
		// the message the script threw is what says which script to look at: without it the
		// failure names the execution context and leaves the cause to be guessed
		assert.match(stderr, new RegExp(SCRIPT_ERROR_MESSAGE), "the failure does not name the error the script threw");
		assert.ok(!existsSync(outputPath), "a page was written for a save that failed");
	});
});

// The same concatenation swallowed code across file boundaries. The scripts were joined with "",
// and the initSingleFile call appended straight onto the last one, so a file whose final line was a
// // comment commented out whatever came next. It only bites when that file has no trailing newline,
// which is why it went unnoticed: an editor that adds one hides it completely. The last-file case
// failed loudly (initSingleFile never ran, "no valid SingleFile execution context"), but a file
// eating the NEXT script was silent — exit 0, a valid save, and one script quietly skipped.
test("a browser script ending in a comment does not swallow the next one", { timeout: TEST_TIMEOUT }, async () => {
	const MARKER = "second-script-marker";
	await withPage(async ({ url, directory }) => {
		const firstPath = join(directory, "first.js");
		const secondPath = join(directory, "second.js");
		// deliberately no trailing newline: that is the whole trigger
		await writeFile(firstPath, "globalThis.__first = 1; // a trailing comment");
		await writeFile(secondPath, "addEventListener(\"DOMContentLoaded\",()=>{" +
			"const marker=document.createElement(\"p\");marker.id=\"" + MARKER + "\";document.body.appendChild(marker);});\n");
		const outputPath = join(directory, "out.html");
		await execFileAsync(process.execPath, [
			"single-file-node.js", url, outputPath,
			"--browser-script", firstPath,
			"--browser-script", secondPath
		], { cwd: cliDirectory });
		assert.match(await readFile(outputPath, "utf8"), new RegExp(MARKER),
			"the first script's trailing comment swallowed the second one");
	});
});

test("a lone browser script ending in a comment still saves the page", { timeout: TEST_TIMEOUT }, async () => {
	await withPage(async ({ url, directory }) => {
		const scriptPath = join(directory, "only.js");
		await writeFile(scriptPath, "globalThis.__only = 1; // a trailing comment");
		const outputPath = join(directory, "out.html");
		await execFileAsync(process.execPath, [
			"single-file-node.js", url, outputPath,
			"--browser-script", scriptPath
		], { cwd: cliDirectory });
		assert.match(await readFile(outputPath, "utf8"), /<h1>page<\/h1>/,
			"the trailing comment reached the initSingleFile call");
	});
});

async function withPage(run) {
	const server = createServer((request, response) =>
		response.writeHead(200, { "content-type": "text/html" }).end("<html><body><h1>page</h1></body></html>"));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		await run({ url: "http://localhost:" + server.address().port + "/", directory });
	} finally {
		await rm(directory, { recursive: true, force: true });
		server.close();
	}
}

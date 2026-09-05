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

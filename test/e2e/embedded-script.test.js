// --embedded-script hands JavaScript to the core (its embeddedScript option), which appends it as
// the last element of the saved page after the page's own scripts have been emptied (the core
// leaves an empty placeholder where a script stood in the body, to keep sibling positions). It is kept
// whatever --block-scripts says, since that option is about the page being captured, and it runs
// when the saved file is opened, which is what a user wants it for: putting back the tabs of a
// scorecard, a product page or a documentation page whose scripts are gone. --embedded-script-file
// is the same option read from a file, for a script that no shell would let through unharmed.
//
// The proof that it runs is a re-capture of the saved file from a file:// URL with scripts
// allowed: a capture of a page where the script did not run cannot hold the marker it writes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { cliDirectory, fastCaptureArgs } from "../target.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 180000;
const MARKER = "embedded-script-marker-4b1e";
const PAGE = "<html><body><p>page</p><script>document.body.append(\"page-script-ran\")</script></body></html>";
const SCRIPT = "document.body.append(\"" + MARKER + "\")";

test("the embedded script replaces the page's scripts and runs when the saved page opens", { timeout: TEST_TIMEOUT }, async () => {
	await withPage(async ({ url, directory }) => {
		const outputPath = join(directory, "out.html");
		await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, url, outputPath, "--embedded-script", SCRIPT
		], { cwd: cliDirectory });
		const content = await readFile(outputPath, "utf8");
		assert.doesNotMatch(content, /append\("page-script-ran"\)/, "the page's own script survived");
		assert.equal(content.split("page-script-ran").length - 1, 1, "the page script ran a different number of times than once, while the page was captured");
		assert.match(content, /<script>document\.body\.append\("embedded-script-marker-4b1e"\)<\/script>\s*$/, "the script is not the last element of the page");
		const reopenedPath = join(directory, "reopened.html");
		await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, "--block-scripts=false", pathToFileURL(outputPath).href, reopenedPath
		], { cwd: cliDirectory });
		const reopened = await readFile(reopenedPath, "utf8");
		assert.match(reopened, new RegExp("</script>" + MARKER + "\\s*$"), "the script did not run in the saved page");
		assert.equal(reopened.split("page-script-ran").length - 1, 1, "the page's own script ran again in the saved page");
	});
});

test("--embedded-script-file reads the script from a file", { timeout: TEST_TIMEOUT }, async () => {
	await withPage(async ({ url, directory }) => {
		const scriptPath = join(directory, "tabs.js");
		const multiLineScript = "const marker = \"" + MARKER + "\";\ndocument.body.append(marker);\n";
		await writeFile(scriptPath, multiLineScript);
		const outputPath = join(directory, "out.html");
		await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, url, outputPath, "--embedded-script-file", scriptPath
		], { cwd: cliDirectory });
		const content = await readFile(outputPath, "utf8");
		assert.ok(content.includes("<script>" + multiLineScript + "</script>"), "the file content is not in the saved page verbatim");
	});
});

test("--embedded-script and --embedded-script-file together are refused", { timeout: TEST_TIMEOUT }, async () => {
	await withPage(async ({ url, directory }) => {
		const scriptPath = join(directory, "tabs.js");
		await writeFile(scriptPath, SCRIPT);
		await assert.rejects(execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, url, join(directory, "out.html"), "--embedded-script", SCRIPT, "--embedded-script-file", scriptPath
		], { cwd: cliDirectory }), error => /--embedded-script cannot be used with --embedded-script-file/.test(error.stderr));
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

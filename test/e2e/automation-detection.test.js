import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const execFileAsync = promisify(execFile);
const cliDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("pages are not captured as controlled by automation", { timeout: 120000 }, async () => {
	const server = createServer((_, response) => response
		.writeHead(200, { "content-type": "text/html" })
		.end("<html><head><title>Automation</title></head><body><p id=result></p>" +
			"<script>document.getElementById(\"result\").textContent = \"webdriver=\" + navigator.webdriver;</script>" +
			"</body></html>"));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "page.html");
		const url = "http://localhost:" + server.address().port + "/";
		const { stderr } = await execFileAsync(process.execPath, [
			"single-file-node.js", url, outputPath
		], { cwd: cliDirectory });
		let content;
		try {
			content = await readFile(outputPath, "utf8");
		} catch (error) {
			throw new Error("missing output file, stderr: " + stderr, { cause: error });
		}
		assert.ok(content.includes("webdriver=false"), "expected navigator.webdriver to be false, got: " + content.match(/webdriver=\w+/));
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
});

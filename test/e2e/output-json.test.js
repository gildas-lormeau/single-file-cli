import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import process from "node:process";

const execFileAsync = promisify(execFile);
const cliDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ZIP_SIGNATURE = "PK\u0003\u0004";

test("output-json embeds compressed content as base64", { timeout: 60000 }, async () => {
	const server = createServer((_, response) => response
		.writeHead(200, { "content-type": "text/html" })
		.end("<html><head><title>JSON Output</title></head><body>content</body></html>"));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "page.json");
		const url = "http://localhost:" + server.address().port + "/";
		await execFileAsync(process.execPath, [
			"single-file-node.js", url, outputPath,
			"--compress-content",
			"--output-json"
		], { cwd: cliDirectory });
		const pageData = JSON.parse(await readFile(outputPath, "utf8"));
		assert.ok(pageData.binaryContent);
		const content = Buffer.from(pageData.binaryContent, "base64").toString("latin1");
		assert.ok(content.includes(ZIP_SIGNATURE));
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
});

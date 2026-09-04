/* global TextDecoder */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory, importLibModule } from "../target.js";

const { configure, ZipReader, Uint8ArrayReader, TextWriter } = await importLibModule("single-file-archive.js");
const execFileAsync = promisify(execFile);
const PASSWORD = "s3cret";
const MARKER = "protected by a password";

configure({ useWebWorkers: false });

test("a password-protected archive decrypts with the password", { timeout: 120000 }, async () => {
	const server = createServer((_, response) => response
		.writeHead(200, { "content-type": "text/html" })
		.end("<html><head><title>locked</title></head><body><p>" + MARKER + "</p></body></html>"));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		await execFileAsync(process.execPath, [
			"single-file-node.js", "http://localhost:" + server.address().port + "/", outputPath,
			"--compress-content", "--password", PASSWORD
		], { cwd: cliDirectory });
		const data = new Uint8Array(await readFile(outputPath));
		assert.ok(!new TextDecoder().decode(data).includes(MARKER), "the page content is readable without the password");
		const zipReader = new ZipReader(new Uint8ArrayReader(data), { extractPrependedData: true, extractAppendedData: true, password: PASSWORD });
		const entries = await zipReader.getEntries();
		const pageEntry = entries.find(entry => entry.filename.endsWith("index.html"));
		assert.ok(pageEntry, "the archive has no index.html entry");
		assert.ok(pageEntry.encrypted, "the page entry is not encrypted");
		const content = await pageEntry.getData(new TextWriter());
		assert.ok(content.includes(MARKER), "the page entry does not decrypt to the page");
		await zipReader.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
		server.close();
	}
});

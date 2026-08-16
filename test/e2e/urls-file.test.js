import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const execFileAsync = promisify(execFile);
const cliDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("duplicate urls in a urls file are captured once", { timeout: 120000 }, async () => {
	const server = createServer((_, response) => response
		.writeHead(200, { "content-type": "text/html" })
		.end("<html><head><title>Same Page</title></head><body>content</body></html>"));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const url = "http://localhost:" + server.address().port + "/";
		const urlsFilePath = join(directory, "urls.txt");
		await writeFile(urlsFilePath, url + "\n\n" + url + "\n");
		const { stderr } = await execFileAsync(process.execPath, [
			"single-file-node.js",
			"--urls-file", urlsFilePath,
			"--output-directory", directory,
			"--filename-template", "{page-title}.html"
		], { cwd: cliDirectory });
		const files = (await readdir(directory)).filter(file => file.endsWith(".html"));
		assert.deepEqual(files, ["Same Page.html"], "stderr: " + stderr);
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const execFileAsync = promisify(execFile);
const cliDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("errors file lines include the error message", { timeout: 120000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const errorsPath = join(directory, "errors.txt");
		const url = "http://localhost:1/";
		await execFileAsync(process.execPath, [
			"single-file-node.js", url, join(directory, "out.html"),
			"--errors-file", errorsPath
		], { cwd: cliDirectory });
		const content = await readFile(errorsPath, "utf8");
		assert.ok(content.includes("URL: " + url));
		const errorMessage = content.match(/Error: (.*)/);
		assert.ok(errorMessage);
		assert.ok(errorMessage[1].trim().length > 0);
	} finally {
		await rm(directory, { recursive: true });
	}
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const execFileAsync = promisify(execFile);
const cliDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("a browser profile is copied and left unmodified by a capture", { timeout: 120000 }, async () => {
	const server = createServer((_, response) => response
		.writeHead(200, { "content-type": "text/html" })
		.end("<html><head><title>Profile</title></head><body>content</body></html>"));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const profilePath = join(directory, "profile");
		await mkdir(join(profilePath, "Default"), { recursive: true });
		await writeFile(join(profilePath, "Default", "Preferences"), "{}");
		const outputPath = join(directory, "page.html");
		const url = "http://localhost:" + server.address().port + "/";
		const { stderr } = await execFileAsync(process.execPath, [
			"single-file-node.js", url, outputPath,
			"--browser-profile", profilePath
		], { cwd: cliDirectory });
		let content;
		try {
			content = await readFile(outputPath, "utf8");
		} catch (error) {
			throw new Error("missing output file, stderr: " + stderr, { cause: error });
		}
		assert.ok(content.includes("<title>Profile</title>"));
		assert.deepEqual(await readdir(profilePath), ["Default"]);
		assert.deepEqual(await readdir(join(profilePath, "Default")), ["Preferences"]);
		assert.equal(await readFile(join(profilePath, "Default", "Preferences"), "utf8"), "{}");
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
});

test("a missing browser profile is reported with its path", { timeout: 120000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const profilePath = join(directory, "missing");
		let exitCode = 0;
		let stderr = "";
		try {
			await execFileAsync(process.execPath, [
				"single-file-node.js", "https://example.com", join(directory, "page.html"),
				"--browser-profile", profilePath
			], { cwd: cliDirectory });
		} catch (error) {
			exitCode = error.code;
			stderr = error.stderr;
		}
		assert.notEqual(exitCode, 0);
		assert.ok(stderr.includes(`The browser profile directory was not found at ${JSON.stringify(profilePath)}`));
	} finally {
		await rm(directory, { recursive: true });
	}
});

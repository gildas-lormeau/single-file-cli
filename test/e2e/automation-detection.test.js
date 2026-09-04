import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory, firefox } from "../target.js";

const execFileAsync = promisify(execFile);

test("pages are not captured as controlled by automation", { timeout: 120000, skip: firefox && "navigator.webdriver is always true under the Firefox remote agent" }, async () => {
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

test("pages are not captured with a headless user agent", { timeout: 120000 }, async () => {
	const server = createServer((request, response) => response
		.writeHead(200, { "content-type": "text/html" })
		.end("<html><head><title>User agent</title></head><body>" +
			"<p id=header-agent>header-agent=" + request.headers["user-agent"] + "</p>" +
			"<p id=script-agent></p>" +
			"<script>document.getElementById(\"script-agent\").textContent = \"script-agent=\" + navigator.userAgent;</script>" +
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
		const headerAgent = content.match(/header-agent=([^<]*)/);
		const scriptAgent = content.match(/script-agent=([^<]*)/);
		assert.ok(headerAgent, "missing the user agent sent to the server");
		assert.ok(scriptAgent, "missing the user agent read in the page");
		assert.ok(!headerAgent[1].includes("Headless"), "unexpected headless token in the user agent sent to the server: " + headerAgent[1]);
		assert.ok(!scriptAgent[1].includes("Headless"), "unexpected headless token in the user agent read in the page: " + scriptAgent[1]);
		const engineToken = firefox ? "Firefox/" : "Chrome/";
		assert.ok(scriptAgent[1].includes(engineToken), "expected a user agent naming " + engineToken + ", got: " + scriptAgent[1]);
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
});

test("the user agent option overrides the browser user agent", { timeout: 120000 }, async () => {
	const userAgent = "Mozilla/5.0 (SingleFile test) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
	const server = createServer((request, response) => response
		.writeHead(200, { "content-type": "text/html" })
		.end("<html><head><title>User agent</title></head><body>" +
			"<p id=header-agent>header-agent=" + request.headers["user-agent"] + "</p>" +
			"</body></html>"));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "page.html");
		const url = "http://localhost:" + server.address().port + "/";
		const { stderr } = await execFileAsync(process.execPath, [
			"single-file-node.js", url, outputPath, "--user-agent=" + userAgent
		], { cwd: cliDirectory });
		let content;
		try {
			content = await readFile(outputPath, "utf8");
		} catch (error) {
			throw new Error("missing output file, stderr: " + stderr, { cause: error });
		}
		assert.ok(content.includes("header-agent=" + userAgent), "expected the user agent option to be sent, got: " + content.match(/header-agent=[^<]*/));
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
});

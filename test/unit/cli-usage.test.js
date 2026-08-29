import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const execFileAsync = promisify(execFile);
const cliDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function runCli(args) {
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, ["single-file-node.js", ...args], { cwd: cliDirectory });
		return { code: 0, stdout, stderr };
	} catch (error) {
		return { code: error.code, stdout: error.stdout, stderr: error.stderr };
	}
}

test("help is displayed with an exit code of 0", async () => {
	const { code, stdout } = await runCli(["--help"]);
	assert.equal(code, 0);
	assert.ok(stdout.includes("--browser-executable-path"));
});

test("every option of the help is named in lowercase", async () => {
	const { stdout } = await runCli(["--help"]);
	const optionNames = Array.from(stdout.matchAll(/^\s+--(\S+):/gm)).map(([, name]) => name);
	assert.ok(optionNames.length > 100);
	assert.deepEqual(optionNames.filter(name => name != name.toLowerCase()), []);
});

test("a byte order mark that cannot be written is reported as a warning", async () => {
	const { stderr } = await runCli(["--include-bom", "--compress-content"]);
	assert.ok(stderr.includes("Warning: --include-bom is ignored"));
});

test("a byte order mark that can be written is not reported", async () => {
	const { stderr } = await runCli(["--include-bom", "--compress-content", "--extract-data-from-page=false"]);
	assert.equal(stderr.includes("--include-bom is ignored"), false);
	const plain = await runCli(["--include-bom"]);
	assert.equal(plain.stderr.includes("--include-bom is ignored"), false);
});

test("a missing url is reported as an error", async () => {
	const { code, stderr } = await runCli(["--browser-executable-path", "/path/to/chrome"]);
	assert.equal(code, 1);
	assert.ok(stderr.includes("The URL or path of the page to save is required"));
});

test("unknown options are reported as errors", async () => {
	const { code, stderr } = await runCli(["--foo", "--bar", "https://example.com", "out.html"]);
	assert.equal(code, 1);
	assert.ok(stderr.includes("Unknown option --foo"));
	assert.ok(stderr.includes("Unknown option --bar"));
});

test("invalid option values are reported as errors", async () => {
	const { code, stderr } = await runCli(["--browser-width", "abc", "https://example.com"]);
	assert.equal(code, 1);
	assert.ok(stderr.includes("Invalid value for --browser-width: \"abc\""));
});

test("a wrong browser executable path is reported with the path", async () => {
	const { code, stderr } = await runCli(["https://localhost:1/", "out.html", "--browser-executable-path", "/nonexistent/chrome"]);
	assert.notEqual(code, 0);
	assert.ok(stderr.includes("The browser executable was not found at \"/nonexistent/chrome\""));
});

test("creating a browser profile does not require a url", async () => {
	const { code, stderr } = await runCli(["--create-browser-profile", "/path/to/profile", "--browser-executable-path", "/nonexistent/chrome"]);
	assert.notEqual(code, 0);
	assert.equal(stderr.includes("The URL or path of the page to save is required"), false);
});

test("conflicting browser profile options are reported as errors", async () => {
	const { code, stderr } = await runCli(["--create-browser-profile", "/path/to/profile", "--browser-profile", "/path/to/other"]);
	assert.equal(code, 1);
	assert.ok(stderr.includes("--create-browser-profile cannot be used with --browser-profile"));
	const remoteResult = await runCli(["https://example.com", "--browser-profile", "/path/to/profile", "--browser-server", "http://localhost:9222"]);
	assert.equal(remoteResult.code, 1);
	assert.ok(remoteResult.stderr.includes("--browser-profile cannot be used with --browser-server"));
});

test("unexpected extra arguments are reported as errors", async () => {
	const { code, stderr } = await runCli(["https://example.com", "out.html", "extra.html"]);
	assert.equal(code, 1);
	assert.ok(stderr.includes("Unexpected arguments: extra.html"));
});

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

test("unexpected extra arguments are reported as errors", async () => {
	const { code, stderr } = await runCli(["https://example.com", "out.html", "extra.html"]);
	assert.equal(code, 1);
	assert.ok(stderr.includes("Unexpected arguments: extra.html"));
});

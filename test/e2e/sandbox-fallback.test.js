import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory, firefox, fastCaptureArgs } from "../target.js";
import { CHROMIUM_PATHS } from "../../lib/constants.js";
import { getExecutablePaths, findExecutablePath } from "../../lib/browser.js";

// On macOS and Windows the browser is launched with its sandbox, and again with --no-sandbox when
// it exits at startup. On Linux --no-sandbox is a default argument, as it was everywhere until
// 2.27.3 (the reasons are in lib/chromium.js). The stand-in browsers below are shell scripts that
// write each launch in a log, with or without the flag, then exit or run the real browser.
const NO_SANDBOX_ARG = "--no-sandbox";
const PAGE_URL = "data:text/html,<title>sandbox check</title>";
const PAGE_TITLE = "<title>sandbox check</title>";
const SANDBOX_LAUNCH = "sandbox";
const NO_SANDBOX_LAUNCH = "no-sandbox";
const WARNING_PREFIX = "Warning:";
const skip = (firefox && "the sandbox arguments are the ones of Chromium") ||
	(process.platform == "win32" && "the stand-in browsers are shell scripts");
const linux = process.platform == "linux";
const skipSandbox = skip || (linux && "the browser is launched without its sandbox on Linux");
const skipNoSandbox = skip || (!linux && "the browser is launched with its sandbox on this system");
const browserPath = skip ? undefined : await findExecutablePath(getExecutablePaths(CHROMIUM_PATHS));

// "sandbox" is logged for a launch without the flag, "no-sandbox" for a launch with it
function getScript(logPath, sandboxLaunchCommand, noSandboxLaunchCommand) {
	return [
		"#!/bin/sh",
		"for arg in \"$@\"; do",
		"if [ \"$arg\" = \"" + NO_SANDBOX_ARG + "\" ]; then",
		"echo " + NO_SANDBOX_LAUNCH + " >> \"" + logPath + "\"",
		noSandboxLaunchCommand,
		"fi",
		"done",
		"echo " + SANDBOX_LAUNCH + " >> \"" + logPath + "\"",
		sandboxLaunchCommand
	].join("\n") + "\n";
}

// The launcher draws a debugging port at random and launches the browser again, the same way, when
// the browser of another process answers on that port (see lib/chromium.js). The test files run in
// parallel with browsers of their own, so a launch can be repeated here by a neighbour. What is
// asserted is the order of the ways the browser was launched: a way logged several times in a row
// counts once.
function getLaunchSequence(launches) {
	return launches.filter((launch, index) => launch != launches[index - 1]);
}

async function capture(sandboxLaunchCommand, noSandboxLaunchCommand, args = []) {
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const logPath = join(directory, "launches.log");
		const scriptPath = join(directory, "browser.sh");
		const outputPath = join(directory, "out.html");
		await writeFile(scriptPath, getScript(logPath, sandboxLaunchCommand, noSandboxLaunchCommand));
		await chmod(scriptPath, 0o755);
		const { code, stderr } = await new Promise(resolve => execFile(process.execPath,
			["single-file-node.js", PAGE_URL, outputPath, "--browser-executable-path", scriptPath, ...fastCaptureArgs, ...args],
			{ cwd: cliDirectory, timeout: 90000 },
			(error, stdout, stderr) => resolve({ code: error ? error.code : 0, stderr })));
		const launches = getLaunchSequence((await readFile(logPath, "utf8")).trim().split("\n"));
		const content = await readFile(outputPath, "utf8").catch(() => "");
		return { code, stderr, launches, content };
	} finally {
		await rm(directory, { recursive: true });
	}
}

const runBrowser = "exec \"" + browserPath + "\" \"$@\"";
const exit = "exit 1";

test("the browser is launched without its sandbox on Linux", { timeout: 120000, skip: skipNoSandbox }, async () => {
	const { code, stderr, launches, content } = await capture(exit, runBrowser);
	assert.equal(code, 0, stderr);
	assert.deepEqual(launches, [NO_SANDBOX_LAUNCH]);
	assert.ok(!stderr.includes(WARNING_PREFIX), stderr);
	assert.ok(content.includes(PAGE_TITLE));
});

test("the browser is launched with its sandbox", { timeout: 120000, skip: skipSandbox }, async () => {
	const { code, stderr, launches, content } = await capture(runBrowser, runBrowser);
	assert.equal(code, 0, stderr);
	assert.deepEqual(launches, [SANDBOX_LAUNCH]);
	assert.ok(!stderr.includes(WARNING_PREFIX), stderr);
	assert.ok(content.includes(PAGE_TITLE));
});

test("a browser that exits with its sandbox is launched again without it, with a warning", { timeout: 120000, skip: skipSandbox }, async () => {
	const { code, stderr, launches, content } = await capture(exit, runBrowser);
	assert.equal(code, 0, stderr);
	assert.deepEqual(launches, [SANDBOX_LAUNCH, NO_SANDBOX_LAUNCH]);
	assert.ok(stderr.includes(WARNING_PREFIX) && stderr.includes(NO_SANDBOX_ARG), stderr);
	assert.ok(content.includes(PAGE_TITLE));
});

test("--browser-arg=--no-sandbox skips the launch with the sandbox and the warning", { timeout: 120000, skip: skipSandbox }, async () => {
	const { code, stderr, launches, content } = await capture(exit, runBrowser, ["--browser-arg=" + NO_SANDBOX_ARG]);
	assert.equal(code, 0, stderr);
	assert.deepEqual(launches, [NO_SANDBOX_LAUNCH]);
	assert.ok(!stderr.includes(WARNING_PREFIX), stderr);
	assert.ok(content.includes(PAGE_TITLE));
});

// the sandbox is not blamed for a browser that does not start without it either
test("a browser that never starts is reported without the sandbox warning", { timeout: 120000, skip: skipSandbox }, async () => {
	const { code, stderr, launches } = await capture(exit, exit);
	assert.notEqual(code, 0);
	assert.deepEqual(launches, [SANDBOX_LAUNCH, NO_SANDBOX_LAUNCH]);
	assert.ok(stderr.includes("The browser exited unexpectedly"), stderr);
	assert.ok(!stderr.includes(WARNING_PREFIX), stderr);
});

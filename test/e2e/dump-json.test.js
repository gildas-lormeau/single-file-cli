/* global URL */

// --dump-json exists because --output-json replaces the page with its JSON: given an explicit
// output path it wrote <output>.json and no page file at all, so a script that wanted the saved
// page AND its metadata got neither. --dump-json writes the metadata to stdout and leaves the page
// file exactly where it would have been, so the two outputs combine.
//
// Two things have to hold for that to be worth anything. The page file must still be written where
// it was asked for, and the JSON must NOT carry the page content, which is what made the
// --output-json file 34 MB in the first place. The network info is the third: it is captured only
// when the JSON is asked for, so a flag that reaches the writer but not the capture would emit a
// JSON with the request and response fields silently missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory } from "../target.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 120000;
const PAGE = "<html><head><title>Dumped Page</title></head><body><a href=\"/other\">other</a></body></html>";

let capturePromise;

test("--dump-json still writes the page file where it was asked for", { timeout: TEST_TIMEOUT }, async () => {
	const { pageContent } = await getCaptureResult();
	assert.match(pageContent, /<title>Dumped Page<\/title>/, "the page file is missing or is not the saved page");
});

test("--dump-json writes the metadata to stdout as JSON", { timeout: TEST_TIMEOUT }, async () => {
	const { metadata } = await getCaptureResult();
	assert.equal(metadata.title, "Dumped Page");
	assert.ok(Array.isArray(metadata.links), "the links are missing from the dumped metadata");
});

test("--dump-json leaves the page content out of the JSON", { timeout: TEST_TIMEOUT }, async () => {
	const { metadata } = await getCaptureResult();
	assert.equal(metadata.content, undefined, "the page content was dumped, which is what --output-json already does");
	assert.equal(metadata.binaryContent, undefined, "the page content was dumped as base64");
});

test("--dump-json reaches the network capture, not only the writer", { timeout: TEST_TIMEOUT }, async () => {
	const { metadata } = await getCaptureResult();
	assert.ok(metadata.response, "no response info: the flag reached the writer but not the capture");
	assert.equal(metadata.response.status, 200);
});

test("--dump-json is refused with --output-json", { timeout: TEST_TIMEOUT }, async () => {
	const { stderr } = await runCapture(["--dump-json", "--output-json"], { expectFailure: true });
	assert.match(stderr, /--dump-json is not compatible with --output-json/);
});

test("--dump-json is refused with --dump-content writing to the same stream", { timeout: TEST_TIMEOUT }, async () => {
	const { stderr } = await runCapture(["--dump-json", "--dump-content"], { expectFailure: true, noOutput: true });
	assert.match(stderr, /--dump-json is not compatible with --dump-content/);
});

function getCaptureResult() {
	if (!capturePromise) {
		capturePromise = runDumpCapture();
	}
	return capturePromise;
}

async function runDumpCapture() {
	const { stdout, outputPath, directory } = await runCapture(["--dump-json"], { keep: true });
	try {
		return { metadata: JSON.parse(stdout), pageContent: (await readFile(outputPath)).toString("utf8") };
	} finally {
		await rm(directory, { recursive: true });
	}
}

async function runCapture(extraArguments, { expectFailure = false, noOutput = false, keep = false } = {}) {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		if (pathname === "/") {
			response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	const outputPath = join(directory, "page.html");
	try {
		const args = ["single-file-node.js", "http://localhost:" + server.address().port + "/"];
		if (!noOutput) {
			args.push(outputPath);
		}
		const { stdout, stderr } = await execFileAsync(process.execPath, args.concat(extraArguments), { cwd: cliDirectory, maxBuffer: 64 * 1024 * 1024 });
		assert.ok(!expectFailure, "the run was expected to fail, stderr: " + stderr);
		return { stdout, stderr, outputPath, directory };
	} catch (error) {
		if (!expectFailure) {
			throw error;
		}
		return { stdout: error.stdout || "", stderr: error.stderr || "", outputPath, directory };
	} finally {
		server.close();
		if (!keep) {
			await rm(directory, { recursive: true });
		}
	}
}

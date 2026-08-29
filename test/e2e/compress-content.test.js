/* global URL, TextDecoder */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { configure, ZipReader, Uint8ArrayReader } from "../../lib/single-file-archive.js";

const execFileAsync = promisify(execFile);
const cliDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_TIMEOUT = 120000;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_LENGTH = 22;
const COMMENT_LENGTH_OFFSET = 20;

const capturePromises = new Map();

test("data is appended after the end of central directory record by default", { timeout: TEST_TIMEOUT }, async () => {
	const { data, stderr } = await getCaptureResult();
	const { offset, commentLength } = findEndOfCentralDirectory(data);
	assert.equal(commentLength, 0, "stderr: " + stderr);
	assert.ok(data.length > offset + END_OF_CENTRAL_DIRECTORY_LENGTH, "the capture appends no data to declare");
});

test("--declare-appended-data declares the appended data as the archive comment", { timeout: TEST_TIMEOUT }, async () => {
	const { data, stderr } = await getCaptureResult(true);
	const { offset, commentLength } = findEndOfCentralDirectory(data);
	assert.ok(commentLength > 0, "stderr: " + stderr);
	assert.equal(offset + END_OF_CENTRAL_DIRECTORY_LENGTH + commentLength, data.length,
		"the comment must cover every byte after the end of central directory record");
	const comment = new TextDecoder("windows-1252").decode(data.subarray(data.length - commentLength));
	assert.ok(comment.startsWith("-->"), "the comment must hold the appended data itself, got " + JSON.stringify(comment.slice(0, 32)));
});

test("the archive stays readable whether or not the appended data is declared", { timeout: TEST_TIMEOUT }, async () => {
	for (const declareAppendedData of [false, true]) {
		const { data } = await getCaptureResult(declareAppendedData);
		configure({ useWebWorkers: false });
		const zipReader = new ZipReader(new Uint8ArrayReader(data));
		const entryNames = (await zipReader.getEntries()).map(entry => entry.filename);
		assert.ok(entryNames.includes("index.html"), "declareAppendedData: " + declareAppendedData);
	}
});

function getCaptureResult(declareAppendedData = false) {
	if (!capturePromises.has(declareAppendedData)) {
		capturePromises.set(declareAppendedData, runCapture(declareAppendedData));
	}
	return capturePromises.get(declareAppendedData);
}

async function runCapture(declareAppendedData) {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		if (pathname === "/") {
			response.writeHead(200, { "content-type": "text/html" })
				.end("<html><head><title>Compressed Page</title></head><body>content</body></html>");
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const origin = "http://localhost:" + server.address().port;
		const { stderr } = await execFileAsync(process.execPath, [
			"single-file-node.js", origin + "/", join(directory, "page.html"),
			"--compress-content",
			...(declareAppendedData ? ["--declare-appended-data"] : [])
		], { cwd: cliDirectory });
		const data = new Uint8Array(await readFile(join(directory, "page.html")));
		return { data, stderr };
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
}

function findEndOfCentralDirectory(data) {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	for (let offset = data.length - END_OF_CENTRAL_DIRECTORY_LENGTH; offset >= 0; offset--) {
		if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
			return { offset, commentLength: view.getUint16(offset + COMMENT_LENGTH_OFFSET, true) };
		}
	}
	throw new Error("end of central directory record not found");
}

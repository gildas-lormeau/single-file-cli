/* global URL */

// --max-appended-data-length caps the bytes a self-extracting page leaves after the ZIP end of
// central directory record. A recovery payload over the cap is relocated ahead of the compressed
// data instead, which is what makes the file readable by a reader whose end-of-archive scan window
// is narrow (16383 bytes for libarchive, against 65557 for Python zipfile).
//
// The assertion that matters is that the switch REACHES core at all. --declare-appended-data once
// shipped inert because core filtered the options it forwarded through a hand-written whitelist,
// and the CLI has an explicit list of its own on the multi-page path, so an option can be declared,
// parsed, documented and still do nothing. A capture at each end of the range is the cheap proof.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
const { configure, ZipReader, Uint8ArrayReader } = await importLibModule("single-file-archive.js");
import { cliDirectory, importLibModule } from "../target.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 120000;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_LENGTH = 22;
const COMMENT_LENGTH_OFFSET = 20;

const capturePromises = new Map();

test("a payload over --max-appended-data-length is not appended", { timeout: TEST_TIMEOUT }, async () => {
	const { data, stderr } = await getCaptureResult(0);
	assert.equal(trailingBytes(data), 0, "nothing may follow the record when the budget is zero, stderr: " + stderr);
});

test("a payload within --max-appended-data-length is appended", { timeout: TEST_TIMEOUT }, async () => {
	const { data, stderr } = await getCaptureResult(1000000);
	assert.ok(trailingBytes(data) > 0, "a generous budget must leave the payload appended, stderr: " + stderr);
});

test("the archive stays readable at either end of the range", { timeout: TEST_TIMEOUT }, async () => {
	for (const maxAppendedDataLength of [0, 1000000]) {
		const { data } = await getCaptureResult(maxAppendedDataLength);
		configure({ useWebWorkers: false });
		const zipReader = new ZipReader(new Uint8ArrayReader(data));
		const entryNames = (await zipReader.getEntries()).map(entry => entry.filename);
		assert.ok(entryNames.includes("index.html"), "maxAppendedDataLength: " + maxAppendedDataLength);
	}
});

function trailingBytes(data) {
	const { offset, commentLength } = findEndOfCentralDirectory(data);
	return data.length - (offset + END_OF_CENTRAL_DIRECTORY_LENGTH + commentLength);
}

function getCaptureResult(maxAppendedDataLength) {
	if (!capturePromises.has(maxAppendedDataLength)) {
		capturePromises.set(maxAppendedDataLength, runCapture(maxAppendedDataLength));
	}
	return capturePromises.get(maxAppendedDataLength);
}

async function runCapture(maxAppendedDataLength) {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		if (pathname === "/") {
			response.writeHead(200, { "content-type": "text/html" })
				.end("<html><head><title>Budget Page</title></head><body>content</body></html>");
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
			"--max-appended-data-length=" + maxAppendedDataLength
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

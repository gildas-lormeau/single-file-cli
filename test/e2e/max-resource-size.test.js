/* global URL, TextEncoder */

// --max-resource-size drops a fetched resource over the given number of megabytes, and
// --max-resource-size-enabled is the switch that turns the limit on at all. Both are declared in
// options.js, and neither was named by any test in this repository, in single-file-core or in
// single-file-tests. An option can be declared, parsed, documented and still do nothing, so what
// these cases prove first is that the pair REACHES core: the capture runs twice over the same
// oversized image and the output has to differ.
//
// The last case guards the other half of the rule. The limit is documented to apply to "images,
// fonts, stylesheets, scripts, frames, videos and audios" — never to the page itself. It used to
// apply to the page too, so --save-raw-page with the limit on saved a 2.5 MB document as 525 bytes
// with no body at all, exit code 0 and no warning. Core fixed that in 90029cf and covers it in
// test/capture/resource-cap.js; this repository pins a core release, so the same case here is what
// notices if a future bump loses it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { cliDirectory, fastCaptureArgs } from "../target.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 120000;
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_WIDTH = 700;
const EMBEDDED_IMAGE = "data:image/png;base64";
const PAGE_MARKER = "RESOURCE CAP MARKER";
const CAP_MEGABYTES = 1;

const capturePromises = new Map();

test("an image over --max-resource-size is not embedded", { timeout: TEST_TIMEOUT }, async () => {
	const { page, stderr } = await getCaptureResult("capped");
	assert.ok(!page.includes(EMBEDDED_IMAGE), "the image must be left out, stderr: " + stderr);
	assert.ok(page.includes(PAGE_MARKER), "the page holding it must be kept, stderr: " + stderr);
});

test("the same image is embedded with the limit off", { timeout: TEST_TIMEOUT }, async () => {
	const { page, stderr } = await getCaptureResult("uncapped");
	assert.ok(page.includes(EMBEDDED_IMAGE), "without the limit the image must be embedded, stderr: " + stderr);
});

test("--save-raw-page keeps a page over --max-resource-size", { timeout: TEST_TIMEOUT }, async () => {
	const { page, stderr } = await getCaptureResult("raw");
	assert.ok(page.includes(PAGE_MARKER), "the limit must not apply to the page itself, stderr: " + stderr);
});

function getCaptureResult(mode) {
	if (!capturePromises.has(mode)) {
		capturePromises.set(mode, runCapture(mode));
	}
	return capturePromises.get(mode);
}

async function runCapture(mode) {
	const image = makePng();
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		if (pathname === "/") {
			response.writeHead(200, { "content-type": "text/html" })
				.end(`<html><head><title>Capped Page</title></head><body><h1>${PAGE_MARKER}</h1>` +
					"<img src=\"/big.png\" width=\"300\" height=\"300\"></body></html>");
		} else if (pathname === "/big.png") {
			response.writeHead(200, { "content-type": "image/png" }).end(image);
		} else if (pathname === "/big.html") {
			// one paragraph rather than many, so the page is over the limit by text and not by nodes
			response.writeHead(200, { "content-type": "text/html" })
				.end(`<html><head><title>Big Page</title></head><body><h1>${PAGE_MARKER}</h1><p>` +
					"filler ".repeat(200000) + "</p></body></html>");
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const origin = "http://localhost:" + server.address().port;
		const url = mode === "raw" ? origin + "/big.html" : origin + "/";
		const options = ["--max-resource-size-enabled", "--max-resource-size=" + CAP_MEGABYTES];
		const { stderr } = await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, url, join(directory, "page.html"),
			...mode === "uncapped" ? [] : options,
			...mode === "raw" ? ["--save-raw-page"] : []
		], { cwd: cliDirectory, maxBuffer: 16 * 1024 * 1024 });
		const page = await readFile(join(directory, "page.html"), "utf-8");
		return { page, stderr };
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
}

// A resource has to be over the limit to be dropped, and it has to decode, or the capture would skip
// it for reasons of its own. Stored deflate keeps the bytes their own size, so the image is 1.4 MB.
function makePng() {
	const rowLength = IMAGE_WIDTH * 3;
	const raw = new Uint8Array((rowLength + 1) * IMAGE_WIDTH);
	for (let row = 0; row < IMAGE_WIDTH; row++) {
		const start = row * (rowLength + 1);
		for (let index = 0; index < rowLength; index++) {
			raw[start + 1 + index] = (index + row) % 256;
		}
	}
	const header = new Uint8Array(13);
	const headerView = new DataView(header.buffer);
	headerView.setUint32(0, IMAGE_WIDTH);
	headerView.setUint32(4, IMAGE_WIDTH);
	header[8] = 8;
	header[9] = 2;
	return concat(
		PNG_SIGNATURE,
		pngChunk("IHDR", header),
		pngChunk("IDAT", new Uint8Array(zlib.deflateSync(raw, { level: 0 }))),
		pngChunk("IEND", new Uint8Array(0))
	);
}

function pngChunk(tag, data) {
	const length = new Uint8Array(4);
	new DataView(length.buffer).setUint32(0, data.length);
	const body = concat(new TextEncoder().encode(tag), data);
	const crc = new Uint8Array(4);
	new DataView(crc.buffer).setUint32(0, zlib.crc32(body));
	return concat(length, body, crc);
}

function concat(...parts) {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

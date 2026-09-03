/* global URL */

// A misconfigured server answers a font or image URL with an HTML error page and a 200 status
// (money.rediff.com does it for its six Roboto faces). The fetcher used to trust the declared type,
// so a plain save embedded the HTML as src:url(data:text/html;base64,...) inside the @font-face,
// while --compress-content dropped it because only that path tests the bytes with FontFace. An
// HTML body at a media URL is never a usable resource, so both modes now treat it like a 404.
//
// The controls are a real font and a real image on the same page: they must still be embedded.

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
import { Buffer } from "node:buffer";
const { configure, ZipReader, Uint8ArrayReader } = await importLibModule("single-file-archive.js");
import { cliDirectory, importLibModule } from "../target.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 120000;
const FONT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "fidelity", "pages", "fonts", "block.ttf");
const RED_DOT = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ERROR_PAGE = "<!doctype html><html><head><title>Not found</title></head><body><h1>Not found</h1></body></html>";
const PAGE = "<html><head><style>" +
	"@font-face{font-family:\"Fake\";src:url(/fonts/fake.woff2) format(\"woff2\")}" +
	"@font-face{font-family:\"Real\";src:url(/fonts/block.ttf) format(\"truetype\")}" +
	"h1{font-family:\"Real\",serif}p{font-family:\"Fake\",serif}" +
	"</style></head><body><h1>Head</h1><p>Body</p>" +
	"<img id=\"broken\" src=\"/images/photo.png\"><img id=\"kept\" src=\"/images/dot.png\"></body></html>";

const capturePromises = new Map();

test("an HTML page served at a font URL is dropped from a plain save", { timeout: TEST_TIMEOUT }, async () => {
	const content = (await getCaptureResult(false)).toString("utf8");
	assert.ok(!content.includes("data:text/html"), "an HTML body was embedded as a resource");
	assert.match(content, /font-family:\s*"?Fake"?;\s*src:\s*[;}]/, "the unusable font source was not removed");
	assert.match(content, /font-family:\s*"?Real"?;\s*src:\s*url\("?data:font\/ttf;base64,/, "the real font was not embedded");
});

test("an HTML page served at an image URL is treated like a missing image in a plain save", { timeout: TEST_TIMEOUT }, async () => {
	const content = (await getCaptureResult(false)).toString("utf8");
	assert.match(content, /id="?broken"?\s+src="?data:,"?/, "the HTML body was kept as the image source");
	assert.match(content, /id="?kept"?\s+src="?data:image\/png;base64,/, "the real image was not embedded");
});

test("an HTML page served at a media URL gets no archive entry", { timeout: TEST_TIMEOUT }, async () => {
	const data = await getCaptureResult(true);
	configure({ useWebWorkers: false });
	const zipReader = new ZipReader(new Uint8ArrayReader(new Uint8Array(data)));
	const entryNames = (await zipReader.getEntries()).map(entry => entry.filename);
	assert.deepEqual(entryNames.filter(name => name.startsWith("fonts/")).length, 1, "entries: " + entryNames.join(", "));
	assert.deepEqual(entryNames.filter(name => name.startsWith("images/")).length, 1, "entries: " + entryNames.join(", "));
});

function getCaptureResult(compressContent) {
	if (!capturePromises.has(compressContent)) {
		capturePromises.set(compressContent, runCapture(compressContent));
	}
	return capturePromises.get(compressContent);
}

async function runCapture(compressContent) {
	const font = await readFile(FONT_PATH);
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		if (pathname === "/") {
			response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
		} else if (pathname === "/fonts/block.ttf") {
			response.writeHead(200, { "content-type": "font/ttf" }).end(font);
		} else if (pathname === "/images/dot.png") {
			response.writeHead(200, { "content-type": "image/png" }).end(RED_DOT);
		} else {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ERROR_PAGE);
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, compressContent ? "out.zip.html" : "out.html");
		const args = ["single-file-node.js", "http://localhost:" + server.address().port + "/", outputPath];
		if (compressContent) {
			args.push("--compress-content");
		}
		await execFileAsync(process.execPath, args, { cwd: cliDirectory });
		return await readFile(outputPath);
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
}

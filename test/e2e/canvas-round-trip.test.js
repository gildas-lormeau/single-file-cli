/* global URL */

// A canvas drawing is saved as a background-image data URI on the canvas element itself. Save the
// saved page again and that element is a real, EMPTY canvas — no script ran to draw into it — so
// toDataURL() returned a blank bitmap and it OVERWROTE the picture the first save had stored.
// Measured on the MDN Canvas API page and reproduced here: generation 1 held the drawing, and
// generation 2 held a blank PNG of the same dimensions, 890 against 874 bytes. Nothing but
// decoding the image would have caught it — a blank PNG is not conspicuously small.
//
// The two controls matter as much as the round trip: a canvas that is drawn on top of a CSS
// background must still store its drawing, and a canvas nothing ever drew into must keep behaving
// as it always has. The fix skips the capture only when the fresh bitmap is blank AND the element
// already carries a background image, so both of those paths have to stay untouched.
//
// The fix shipped in single-file-core 1.5.119, so these run against the committed lib/ as well.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { cliDirectory } from "../target.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 180000;
const RED_DOT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const DRAWING = "<script>const context=document.getElementById(\"probe\").getContext(\"2d\");context.fillStyle=\"#00aa00\";context.fillRect(10,10,150,80);</script>";
const PAGES = {
	"/drawn": "<html><head><title>drawn</title></head><body><canvas id=\"probe\" width=\"200\" height=\"100\"></canvas>" + DRAWING + "</body></html>",
	"/drawn-with-background": "<html><head><title>drawn with background</title></head><body><canvas id=\"probe\" width=\"200\" height=\"100\" style=\"background-image:url(" + RED_DOT + ")\"></canvas>" + DRAWING + "</body></html>",
	"/blank": "<html><head><title>blank</title></head><body><canvas id=\"probe\" width=\"200\" height=\"100\"></canvas></body></html>"
};

test("re-saving a saved page keeps the canvas drawing", { timeout: TEST_TIMEOUT }, async () => {
	const generations = await capture("/drawn", 3);
	assert.ok(generations[0], "the first save stored no canvas image");
	assert.equal(generations[1], generations[0], "the second save replaced the canvas image");
	assert.equal(generations[2], generations[0], "the third save replaced the canvas image");
});

test("a canvas drawn over a background image still stores its drawing", { timeout: TEST_TIMEOUT }, async () => {
	const [saved] = await capture("/drawn-with-background", 1);
	assert.ok(saved, "the save stored no canvas image");
	assert.notEqual(saved, RED_DOT.split(",")[1], "the save kept the background image instead of the drawing");
});

test("a canvas nothing drew into is still captured when there is no background", { timeout: TEST_TIMEOUT }, async () => {
	const [saved] = await capture("/blank", 1);
	assert.ok(saved, "the save stored no canvas image");
});

// returns the base64 payload of the canvas background-image of each generation, each one captured
// from the file the previous one produced
async function capture(pathname, generations) {
	const server = createServer((request, response) => {
		const page = PAGES[new URL(request.url, "http://localhost").pathname];
		if (page) {
			response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(page);
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const images = [];
		let source = "http://localhost:" + server.address().port + pathname;
		for (let generation = 0; generation < generations; generation++) {
			const savedPath = join(directory, "generation-" + generation + ".html");
			await runCli([source, savedPath]);
			images.push(getCanvasImage(await readFile(savedPath, "utf-8")));
			source = pathToFileURL(savedPath).href;
		}
		return images;
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
}

function getCanvasImage(html) {
	const match = html.match(/background-image:\s*url\(["']?data:image\/png;base64,([^"')]+)["']?\)/);
	return match && match[1];
}

function runCli(args) {
	return execFileAsync(process.execPath, ["single-file-node.js", ...args], { cwd: cliDirectory });
}

/* global URL, atob */

// --link-blocked-images changes what --block-images leaves behind: the address the image came from
// instead of an empty image. The saved page is as light as one without images and still shows them,
// from the original site, which is also its cost: it is not self-contained and it contacts that
// site when it is opened. The policy written into the page has to let those requests through, and
// only then.
//
// The option is implemented in single-file-core, which tests each element and both helpers. What
// these cases prove is that the switch REACHES core through options.js, alone and with
// --block-images. That no image is fetched is checked in core: here the page loads its images itself
// while it is displayed, so the requests the server sees say nothing about the capture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory, fastCaptureArgs } from "../target.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 120000;
// the smallest PNG a browser decodes, one transparent pixel
const PIXEL = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), character => character.charCodeAt(0));
const EMBEDDED_IMAGE = "data:image/png;base64";
const EMPTY_IMAGE = "data:,";
const REMOTE_IMAGES_POLICY = /img-src [^;]*http: https:;/;
const MODES = {
	linked: ["--block-images", "--link-blocked-images"],
	blocked: ["--block-images"],
	alone: ["--link-blocked-images"]
};

const capturePromises = new Map();

test("--block-images with --link-blocked-images keeps the addresses of the images", { timeout: TEST_TIMEOUT }, async () => {
	const { page, origin, stderr } = await getCaptureResult("linked");
	assert.equal(getSource(page, "plain"), origin + "/images/plain.png", "the address must be absolute, stderr: " + stderr);
	assert.ok(page.includes("srcset=\"" + origin + "/images/small.png 1x, " + origin + "/images/large.png 2x\"")
		|| page.includes("srcset=\"" + origin + "/images/small.png 1x," + origin + "/images/large.png 2x\""), "every candidate of srcset must be kept, got: " + getAttribute(page, "candidates", "srcset"));
	assert.ok(page.includes("url(" + origin + "/images/background.png)"), "the url() of a stylesheet rule must be kept");
	assert.ok(!page.includes(EMBEDDED_IMAGE), "no image must be embedded");
	assert.match(page, REMOTE_IMAGES_POLICY, "the policy of the page must let remote images through");
});

test("--block-images alone still empties the images", { timeout: TEST_TIMEOUT }, async () => {
	const { page, stderr } = await getCaptureResult("blocked");
	assert.equal(getSource(page, "plain"), EMPTY_IMAGE, "the image must be emptied, stderr: " + stderr);
	assert.doesNotMatch(page, REMOTE_IMAGES_POLICY, "the policy of the page must stay closed");
});

test("--link-blocked-images alone changes nothing", { timeout: TEST_TIMEOUT }, async () => {
	const { page, stderr } = await getCaptureResult("alone");
	assert.ok(getSource(page, "plain").startsWith(EMBEDDED_IMAGE), "the image must be embedded, stderr: " + stderr);
	assert.doesNotMatch(page, REMOTE_IMAGES_POLICY, "the policy of the page must stay closed");
});

function getCaptureResult(mode) {
	if (!capturePromises.has(mode)) {
		capturePromises.set(mode, runCapture(mode));
	}
	return capturePromises.get(mode);
}

async function runCapture(mode) {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		if (pathname === "/") {
			response.writeHead(200, { "content-type": "text/html" })
				.end("<html><head><title>Linked Images</title><style>#rule { width: 10px; height: 10px; background: url(images/background.png) }</style></head><body>" +
					"<img id=\"plain\" src=\"images/plain.png\" width=\"10\" height=\"10\">" +
					"<img id=\"candidates\" src=\"images/small.png\" srcset=\"images/small.png 1x, images/large.png 2x\" width=\"10\" height=\"10\">" +
					"<div id=\"rule\"></div></body></html>");
		} else if (pathname.startsWith("/images/")) {
			response.writeHead(200, { "content-type": "image/png" }).end(PIXEL);
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const origin = "http://localhost:" + server.address().port;
		const { stderr } = await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, origin + "/", join(directory, "page.html"), ...MODES[mode]
		], { cwd: cliDirectory, maxBuffer: 16 * 1024 * 1024 });
		const page = await readFile(join(directory, "page.html"), "utf-8");
		return { page, origin, stderr };
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
}

function getSource(page, id) {
	return getAttribute(page, id, "src");
}

function getAttribute(page, id, name) {
	const element = page.match(new RegExp("<img[^>]*id=\"?" + id + "\"?[ >][^>]*>?"));
	const value = element && element[0].match(new RegExp(" " + name + "=(?:\"([^\"]*)\"|([^\" >]*))"));
	return value ? (value[1] !== undefined ? value[1] : value[2]) : "";
}

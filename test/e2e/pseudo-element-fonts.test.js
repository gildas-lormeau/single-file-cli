/* global URL */

// removeUnusedFonts keeps a @font-face rule only when the browser reports having drawn with its
// family, and the content script reads that off the computed style of every element and of three
// pseudo-elements per element: :first-letter, :before and :after. Four other pseudo-elements take
// font properties and were read for no element at all, so a face declared on one of them alone was
// dropped from every save: li::marker, p::first-line, input::placeholder and
// input[type=file]::file-selector-button. Measured with the released core on the page below: the
// four rules gone, the body's kept. The reads are gated on what the element already told us, so a
// page that declares none of them costs nothing measurable.
//
// The fonts are data: URIs of a few bytes on purpose. Nothing here needs a glyph to render; what is
// under test is whether the rule survives the save, and a data: source keeps the capture's fetch
// and dedup layers out of the picture.

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
const PAGE = "<!DOCTYPE html><html><head><style>" +
	"@font-face{font-family:BodyFace;src:url(data:font/woff2;base64,AAAAAAAAAAAA)}" +
	"@font-face{font-family:MarkerFace;src:url(data:font/woff2;base64,AAAAAAAAAAAB)}" +
	"@font-face{font-family:FirstLineFace;src:url(data:font/woff2;base64,AAAAAAAAAAAC)}" +
	"@font-face{font-family:PlaceholderFace;src:url(data:font/woff2;base64,AAAAAAAAAAAD)}" +
	"@font-face{font-family:ButtonFace;src:url(data:font/woff2;base64,AAAAAAAAAAAE)}" +
	"@font-face{font-family:UnusedFace;src:url(data:font/woff2;base64,AAAAAAAAAAAF)}" +
	"body{font-family:BodyFace,sans-serif}" +
	"li::marker{font-family:MarkerFace,monospace}" +
	"p::first-line{font-family:FirstLineFace,serif}" +
	"input::placeholder{font-family:PlaceholderFace,cursive}" +
	"input[type=file]::file-selector-button{font-family:ButtonFace,fantasy}" +
	"</style></head><body>" +
	"<p>A paragraph whose first line is set in its own face.</p>" +
	"<ul><li>An item with a marker in its own face</li></ul>" +
	"<form><input placeholder=\"A placeholder in its own face\"><input type=\"file\"></form>" +
	"</body></html>";

let capturePromise;

for (const [pseudoElement, family] of [
	["::marker", "MarkerFace"],
	["::first-line", "FirstLineFace"],
	["::placeholder", "PlaceholderFace"],
	["::file-selector-button", "ButtonFace"]
]) {
	test("a face declared on " + pseudoElement + " alone is kept", { timeout: TEST_TIMEOUT }, async () => {
		const families = await getCaptureResult();
		assert.equal(families.filter(name => name === family).length, 1,
			"the @font-face rule of " + family + " was dropped, so the " + pseudoElement + " it styles falls back to another font in the saved page");
	});
}

test("a face the page draws text with is kept", { timeout: TEST_TIMEOUT }, async () => {
	const families = await getCaptureResult();
	assert.equal(families.filter(name => name === "BodyFace").length, 1);
});

// the control: the four reads above must not have turned removeUnusedFonts into a no-op
test("a face nothing draws with is still dropped", { timeout: TEST_TIMEOUT }, async () => {
	const families = await getCaptureResult();
	assert.equal(families.includes("UnusedFace"), false, "the unused rule survived, so unused faces are no longer removed at all");
});

function getCaptureResult() {
	if (!capturePromise) {
		capturePromise = runCapture();
	}
	return capturePromise;
}

async function runCapture() {
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
	try {
		const outputPath = join(directory, "out.html");
		await execFileAsync(process.execPath, ["single-file-node.js", ...fastCaptureArgs, "http://localhost:" + server.address().port + "/", outputPath], { cwd: cliDirectory });
		const content = (await readFile(outputPath)).toString("utf8");
		return [...content.matchAll(/@font-face\s*{[^}]*font-family:\s*"?([^;"}]+)"?/g)].map(match => match[1].trim());
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
}

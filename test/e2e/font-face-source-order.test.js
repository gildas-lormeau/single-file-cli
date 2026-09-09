/* global URL */

// CSS orders @font-face sources two ways at once, and a saved page has to honour both.
// Within one rule the browser uses the FIRST source that loads. Across rules sharing the same
// family, style, weight and stretch the rules form a single COMPOSITE face: they are checked in
// reverse declaration order for each character, so a character the last rule's font lacks is drawn
// from an earlier rule's font, under that rule's own descriptors. Measured in Chrome with two
// generated fonts, one mapping A-Z and one mapping only A: both are fetched, the later font draws
// A, the earlier draws B, and each glyph carries its own rule's size-adjust. A control with the
// same page and only the later rule draws B in serif and never fetches the other font, so the
// fallback is real and not an eager download. size-adjust does NOT split the composite face.
// SingleFile merged every rule sharing a font key into one array built with unshift, which reversed
// both axes at once, and a later fix dropped the earlier rule outright, which lost every glyph only
// its font carried. The cases below pin the axes against each other, because a fix that satisfies
// only one of them is the bug in the other direction.

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
import { cliDirectory } from "../target.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 120000;
const FONTS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "fidelity", "pages", "fonts");
// three distinct fixtures, told apart in the save by their byte length
const FONT_NAMES = ["band.ttf", "bar.ttf", "block.ttf"];
// the two Dup rules differ in size-adjust, which getFontKey does not cover, so they share a key
// while rendering differently. That is what makes per-rule pairing the thing to test: any reduction
// that keeps one rule pairs its metrics with the other rule's font
const PAGE = "<html><head><style>" +
	"@font-face{font-family:\"Dup\";src:url(/fonts/band.ttf) format(\"truetype\");size-adjust:50%}" +
	"@font-face{font-family:\"Dup\";src:url(/fonts/bar.ttf) format(\"truetype\");size-adjust:150%}" +
	"@font-face{font-family:\"Solo\";src:url(/fonts/block.ttf) format(\"truetype\"),url(/fonts/band.ttf) format(\"truetype\")}" +
	"h1{font-family:\"Dup\",serif}p{font-family:\"Solo\",serif}" +
	"</style></head><body><h1>Head</h1><p>Body</p></body></html>";

let capturePromise;

test("every @font-face rule of a composite face is kept", { timeout: TEST_TIMEOUT }, async () => {
	const { embedded } = await getCaptureResult();
	const dup = embedded.filter(rule => rule.family === "Dup");
	assert.equal(dup.length, 2, "a rule of the composite face was dropped, so it lost the glyphs only its font carries");
});

test("each rule of a composite face keeps its own source", { timeout: TEST_TIMEOUT }, async () => {
	const { embedded, sizes } = await getCaptureResult();
	const { earlier, later } = getCompositeRules(embedded);
	assert.equal(earlier.length, sizes["band.ttf"],
		`the size-adjust:50% rule embedded ${describe(earlier.length, sizes)} instead of band.ttf, its own source`);
	assert.equal(later.length, sizes["bar.ttf"],
		`the size-adjust:150% rule embedded ${describe(later.length, sizes)} instead of bar.ttf, its own source`);
});

test("a composite face keeps its declaration order", { timeout: TEST_TIMEOUT }, async () => {
	const { embedded } = await getCaptureResult();
	const { earlier, later } = getCompositeRules(embedded);
	assert.ok(embedded.indexOf(earlier) < embedded.indexOf(later),
		"the rules were reordered, which inverts which font the browser reaches for first");
});

function getCompositeRules(embedded) {
	const dup = embedded.filter(rule => rule.family === "Dup");
	const earlier = dup.find(rule => /size-adjust:\s*50%/.test(rule.text));
	const later = dup.find(rule => /size-adjust:\s*150%/.test(rule.text));
	assert.ok(earlier, "no rule carries the earlier rule's size-adjust:50%");
	assert.ok(later, "no rule carries the later rule's size-adjust:150%");
	return { earlier, later };
}

test("a single @font-face rule still resolves to its first source", { timeout: TEST_TIMEOUT }, async () => {
	const { embedded, sizes } = await getCaptureResult();
	const solo = embedded.filter(rule => rule.family === "Solo");
	assert.equal(solo.length, 1, "expected one Solo rule");
	assert.equal(solo[0].length, sizes["block.ttf"],
		`the Solo rule embedded ${describe(solo[0].length, sizes)} instead of block.ttf, its first source`);
});

function describe(length, sizes) {
	const name = Object.keys(sizes).find(fontName => sizes[fontName] === length);
	return name || length + " bytes";
}

function getCaptureResult() {
	if (!capturePromise) {
		capturePromise = runCapture();
	}
	return capturePromise;
}

async function runCapture() {
	const fonts = new Map();
	const sizes = {};
	for (const name of FONT_NAMES) {
		const data = await readFile(join(FONTS_DIRECTORY, name));
		fonts.set(name, data);
		sizes[name] = data.length;
	}
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		const name = pathname.startsWith("/fonts/") && pathname.slice("/fonts/".length);
		if (name && fonts.has(name)) {
			response.writeHead(200, { "content-type": "font/ttf" }).end(fonts.get(name));
		} else if (pathname === "/") {
			response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		await execFileAsync(process.execPath, ["single-file-node.js", "http://localhost:" + server.address().port + "/", outputPath], { cwd: cliDirectory });
		const content = (await readFile(outputPath)).toString("utf8");
		const embedded = [...content.matchAll(/@font-face\s*{[^}]*}/g)].map(match => {
			const family = match[0].match(/font-family:\s*"?([^;"}]+)"?/);
			const data = match[0].match(/base64,([A-Za-z0-9+/=]+)/);
			return {
				family: family && family[1].trim(),
				length: data ? Buffer.from(data[1], "base64").length : 0,
				text: match[0].replace(/base64,[A-Za-z0-9+/=]+/, "base64,...")
			};
		});
		return { embedded, sizes };
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
}

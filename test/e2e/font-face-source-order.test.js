/* global URL */

// CSS orders @font-face sources two ways at once, and a saved page has to honour both.
// Within one rule the browser uses the FIRST source that loads. Across duplicate rules sharing the
// same descriptors the LAST rule wins outright: measured in Chrome, only the later rule's font is
// fetched and document.fonts reports the earlier face as "unloaded", so it is never a fallback.
// SingleFile merged every rule sharing a font key into one array built with unshift, which reversed
// both axes at once. The within-rule axis then read correctly and the across-rule axis backwards,
// so the save embedded the font from the rule the browser had overridden — the right font was
// absent from the file entirely. The two cases below pin the axes against each other, because a fix
// that satisfies only one of them is the bug in the other direction.

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
const PAGE = "<html><head><style>" +
	"@font-face{font-family:\"Dup\";src:url(/fonts/band.ttf) format(\"truetype\")}" +
	"@font-face{font-family:\"Dup\";src:url(/fonts/bar.ttf) format(\"truetype\")}" +
	"@font-face{font-family:\"Solo\";src:url(/fonts/block.ttf) format(\"truetype\"),url(/fonts/band.ttf) format(\"truetype\")}" +
	"h1{font-family:\"Dup\",serif}p{font-family:\"Solo\",serif}" +
	"</style></head><body><h1>Head</h1><p>Body</p></body></html>";

let capturePromise;

test("duplicate @font-face rules resolve to the later rule, as the browser does", { timeout: TEST_TIMEOUT }, async () => {
	const { embedded, sizes } = await getCaptureResult();
	const dup = embedded.filter(rule => rule.family === "Dup");
	assert.ok(dup.length > 0, "no Dup rule survived the save");
	dup.forEach(rule => assert.equal(rule.length, sizes["bar.ttf"],
		`a Dup rule embedded ${describe(rule.length, sizes)} instead of bar.ttf, the later rule's font`));
});

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
				length: data ? Buffer.from(data[1], "base64").length : 0
			};
		});
		return { embedded, sizes };
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
}

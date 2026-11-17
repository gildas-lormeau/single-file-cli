// The stylesheets adopted by a shadow root come after its own style elements in the cascade: at
// equal specificity, a rule of an adopted stylesheet wins over a rule of a style element. They were
// saved as style elements written first in the shadow root, so the order was reversed and the rules
// of the adopted stylesheets lost. Written first, they also shifted the content: the first element
// of the shadow root was no longer its first child, and `:first-child`, `:nth-child()` or `* + *`
// matched other elements than in the page.
//
// Measured in Chrome 157: with `<style>p{color:red}</style><p>first<p>last` in the shadow root and
// an adopted stylesheet `p{color:green} p:nth-child(2){font-weight:700}`, the page shows the first
// paragraph green and bold, and the saved page showed it red and not bold.
//
// They are now written last. The saved shadow root still has one more child than the original, at
// its end, which `:last-child` can see: no place in the shadow root is free of that.
//
// This needs a browser: adopted stylesheets do not exist in the DOM used by the unit tests of the core.

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
const PAGE = `<html><head><title>adopted stylesheets order</title></head><body>
	<x-box></x-box>
	<script>
		customElements.define("x-box", class extends HTMLElement {
			constructor() {
				super();
				const root = this.attachShadow({ mode: "open" });
				root.innerHTML = "<style>p{color:red}</style><p id=first>first</p><p id=last>last</p>";
				const first = new CSSStyleSheet();
				first.replaceSync("p{color:green}p:nth-child(2){font-weight:700}");
				const second = new CSSStyleSheet();
				second.replaceSync("p{color:blue}");
				root.adoptedStyleSheets = [first, second];
			}
		});
	</script>
</body></html>`;

test("the stylesheets adopted by a shadow root are saved after its own style elements", { timeout: TEST_TIMEOUT }, async () => {
	await withSavedPage(content => {
		const shadowRoot = getShadowRoot(content);
		const ownIndex = shadowRoot.indexOf("color:red");
		const firstAdoptedIndex = shadowRoot.indexOf("color:green");
		const secondAdoptedIndex = shadowRoot.indexOf("color:blue");
		assert.ok(ownIndex != -1 && firstAdoptedIndex != -1 && secondAdoptedIndex != -1, "a stylesheet is missing: " + shadowRoot);
		assert.ok(ownIndex < firstAdoptedIndex, "the adopted stylesheet comes before the style element: " + shadowRoot);
		assert.ok(firstAdoptedIndex < secondAdoptedIndex, "the adopted stylesheets are not in the order they were adopted in: " + shadowRoot);
	});
});

test("they are saved after the content of the shadow root", { timeout: TEST_TIMEOUT }, async () => {
	await withSavedPage(content => {
		const shadowRoot = getShadowRoot(content);
		assert.match(shadowRoot, /^<style[^>]*>[^<]*color:red[^<]*<\/style><p id=first>/, "the first paragraph is not the second child of the shadow root: " + shadowRoot);
		assert.ok(shadowRoot.indexOf("<p id=last>") < shadowRoot.indexOf("color:green"), "the adopted stylesheet comes before the content: " + shadowRoot);
	});
});

function getShadowRoot(content) {
	const match = content.match(/<x-box[^>]*>\s*<template[^>]*>(.*?)<\/template>/s);
	assert.ok(match, "no shadow root was saved for x-box");
	return match[1];
}

async function withSavedPage(check) {
	const server = createServer((request, response) =>
		response.writeHead(200, { "content-type": "text/html" }).end(PAGE));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, "http://localhost:" + server.address().port + "/", outputPath
		], { cwd: cliDirectory });
		check(await readFile(outputPath, "utf8"));
	} finally {
		await rm(directory, { recursive: true, force: true });
		server.close();
	}
}

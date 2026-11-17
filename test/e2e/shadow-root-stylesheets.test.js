// The stylesheets of shadow roots were saved whole: the pass removing the unused rules only read the
// stylesheets of the document. A page built from components that all adopt one large stylesheet got
// that stylesheet written in full into every shadow root (a Reddit thread with 240 comments was saved
// as 394 MB, SingleFile #1514). The rules matching nothing in the shadow roots of a component are
// now removed, and each component (the hosts with the same tag name) keeps its own copy.
//
// This needs a browser: the copies are grouped and pruned on the tree of the saved page, where the
// shadow roots are templates, which the DOM used by the unit tests of the core does not expose.

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
const SHARED_CSS = ":host{display:block}::slotted(span){color:green}.used{color:red}.used:hover{color:orange}.other{color:purple}.unused{color:blue}" +
	"@media screen{.used{margin:1px}.unused{margin:2px}}@keyframes spin{from{opacity:0}to{opacity:1}}";
const PAGE = `<html><head><title>shadow root stylesheets</title></head><body>
	<x-item><span>slotted</span></x-item><x-item></x-item><x-other></x-other>
	<script>
		const shared = new CSSStyleSheet();
		shared.replaceSync(${JSON.stringify(SHARED_CSS)});
		const own = new CSSStyleSheet();
		own.replaceSync(".own{color:teal}.own-unused{color:gray}");
		customElements.define("x-item", class extends HTMLElement {
			constructor() {
				super();
				const root = this.attachShadow({ mode: "open" });
				root.adoptedStyleSheets = [shared];
				root.innerHTML = "<p class=used>item</p><slot></slot>";
			}
		});
		customElements.define("x-other", class extends HTMLElement {
			constructor() {
				super();
				const root = this.attachShadow({ mode: "open" });
				root.adoptedStyleSheets = [shared, own];
				root.innerHTML = "<div class='other own'>other</div>";
			}
		});
	</script>
</body></html>`;

test("the unused rules of a stylesheet adopted in shadow roots are removed", { timeout: TEST_TIMEOUT }, async () => {
	await withSavedPage([], content => {
		const itemStyles = getShadowRootStyles(content, "x-item");
		assert.equal(itemStyles.length, 2, "the two x-item roots were not both saved with their stylesheet");
		assert.match(itemStyles[0], /\.used\{color:red\}/, "a rule matching in the root was removed");
		assert.match(itemStyles[0], /\.used:hover\{color:orange\}/, "a state rule whose element exists was removed");
		assert.match(itemStyles[0], /@media screen\{\.used\{margin:1px\}\}/, "the conditional rule was not pruned inside");
		assert.doesNotMatch(itemStyles[0], /\.unused/, "a rule matching nothing was kept");
		assert.equal(itemStyles[1], itemStyles[0], "two roots of the same component do not hold the same stylesheet");
	});
});

test("the rules a shadow root cannot be queried for are kept", { timeout: TEST_TIMEOUT }, async () => {
	await withSavedPage([], content => {
		const [itemStyle] = getShadowRootStyles(content, "x-item");
		assert.match(itemStyle, /:host\{display:block\}/, "the :host rule was removed");
		assert.match(itemStyle, /::slotted\(span\)\{color:green\}/, "the ::slotted() rule was removed");
		assert.match(itemStyle, /@keyframes spin\{/, "the keyframes were removed");
	});
});

test("each component keeps its own copy of a shared stylesheet", { timeout: TEST_TIMEOUT }, async () => {
	await withSavedPage([], content => {
		const [itemStyle] = getShadowRootStyles(content, "x-item");
		const [otherStyle] = getShadowRootStyles(content, "x-other");
		assert.doesNotMatch(itemStyle, /\.other/, "x-item holds a rule only x-other uses");
		assert.match(otherStyle, /\.other\{color:purple\}/, "x-other lost the rule it uses");
		assert.doesNotMatch(otherStyle, /\.used\{color:red\}/, "x-other holds a rule only x-item uses");
		assert.match(content, /\.own\{color:teal\}/, "the second stylesheet of x-other lost the rule it uses");
		assert.doesNotMatch(content, /\.own-unused/, "the second stylesheet of x-other was not pruned");
	});
});

test("control: with --remove-unused-styles=false the stylesheet is saved whole", { timeout: TEST_TIMEOUT }, async () => {
	await withSavedPage(["--remove-unused-styles=false"], content => {
		const [itemStyle] = getShadowRootStyles(content, "x-item");
		assert.match(itemStyle, /\.unused\{color:blue\}/);
		assert.match(itemStyle, /\.other\{color:purple\}/);
	});
});

// The first style element of each shadow root of the component. The adopted stylesheets are saved
// after the content of the shadow root, see adopted-stylesheets-order.test.js.
function getShadowRootStyles(content, tagName) {
	return Array.from(content.matchAll(new RegExp("<" + tagName + "[^>]*>\\s*<template[^>]*>(?:(?!</template>|<style>).)*<style>([^<]*)</style>", "gs"))).map(match => match[1]);
}

async function withSavedPage(args, check) {
	const server = createServer((request, response) =>
		response.writeHead(200, { "content-type": "text/html" }).end(PAGE));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, "http://localhost:" + server.address().port + "/", outputPath, ...args
		], { cwd: cliDirectory });
		check(await readFile(outputPath, "utf8"));
	} finally {
		await rm(directory, { recursive: true, force: true });
		server.close();
	}
}

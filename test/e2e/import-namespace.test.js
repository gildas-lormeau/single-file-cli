/* global URL */

// An `@namespace` rule applies to its whole stylesheet and must come before every style rule. A
// saved page holds an imported stylesheet in the sheet that imported it, so the namespace rules of
// the two sheets ended in one sheet: the default namespace of an import reached the rules of the
// importing sheet, and a namespace rule written after the rules of an import was ignored, with every
// selector using its prefix (SingleFile issue 1513).
//
// Measured in Chrome 158 on the page below: its six rules apply in the page, and three of them
// applied in the saved page. Each run of rules sharing the same namespace rules is now saved in a
// style element of its own.
//
// The unit tests of the core pin the sheets written. Whether the rules apply is decided by the
// browser: here the saved page is opened again, and a script reads the styles the browser computed
// for each element. The same script is run on the page itself first, so that a script reading
// nothing cannot pass for a saved page that is right.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { cliDirectory, fastCaptureArgs } from "../target.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 180000;
const SVG = "http://www.w3.org/2000/svg";
const XHTML = "http://www.w3.org/1999/xhtml";
const FILES = {
	"/": `<!DOCTYPE html><html><head><title>import namespace</title>
		<style>@import "a.css"; @namespace svg url("${SVG}"); svg|rect.case-a { fill: lime; }</style>
		<style>@import "a.css"; @import "b.css";</style>
		<style>@import "c.css"; p.case-c { background-color: lime; }</style>
		<style>@import "d.css"; @namespace n url("${XHTML}"); n|p.case-d { background-color: lime; }</style>
		</head><body>
		<p class="plain">plain</p><p class="case-c">c</p><p class="case-d">d</p>
		<svg width="200" height="20"><rect class="case-a" width="20" height="20"/><rect class="case-b" x="30" width="20" height="20"/>
		<rect class="case-c2" x="60" width="20" height="20"/><rect class="case-d2" x="90" width="20" height="20"/></svg>
		</body></html>`,
	"/a.css": ".plain { color: rgb(1, 2, 3); }",
	"/b.css": `@namespace svg url("${SVG}"); svg|rect.case-b { fill: lime; }`,
	"/c.css": `@namespace url("${SVG}"); rect.case-c2 { fill: lime; }`,
	"/d.css": `@namespace n url("${SVG}"); n|rect.case-d2 { fill: lime; }`
};
const RESULT_ATTRIBUTE = "data-applied-rules";
// writes, for each test element, whether the rule written for it applies
const READ_STYLES_SCRIPT = `addEventListener("load", () => {
	const lime = "rgb(0, 255, 0)";
	const result = Array.from(document.querySelectorAll("[class^=case-]")).map(element => {
		const style = getComputedStyle(element);
		return element.getAttribute("class") + ":" + (style.backgroundColor == lime || style.fill == lime ? "yes" : "no");
	});
	document.body.setAttribute("${RESULT_ATTRIBUTE}", result.join(" "));
});`;
const EXPECTED = "case-c:yes case-d:yes case-a:yes case-b:yes case-c2:yes case-d2:yes";

test("the rules of stylesheets with namespace rules and imports apply in the saved page", { timeout: TEST_TIMEOUT }, async () => {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		if (FILES[pathname] === undefined) {
			response.writeHead(404).end();
		} else {
			response.writeHead(200, { "content-type": pathname.endsWith(".css") ? "text/css" : "text/html" }).end(FILES[pathname]);
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const pageURL = "http://localhost:" + server.address().port + "/";
		const scriptPath = join(directory, "read-styles.js");
		await writeFile(scriptPath, READ_STYLES_SCRIPT);
		const savedPath = join(directory, "saved.html");
		await runCli([pageURL, savedPath]);
		assert.equal(await readAppliedRules(pageURL, scriptPath, join(directory, "page-read.html")), EXPECTED,
			"the rules do not all apply in the page itself, the test measures nothing");
		assert.equal(await readAppliedRules(pathToFileURL(savedPath).href, scriptPath, join(directory, "saved-read.html")), EXPECTED,
			"some rules no longer apply in the saved page");
	} finally {
		await rm(directory, { recursive: true, force: true });
		server.close();
	}
});

async function readAppliedRules(url, scriptPath, outputPath) {
	await runCli([url, outputPath, "--browser-script", scriptPath]);
	const match = (await readFile(outputPath, "utf8")).match(new RegExp(RESULT_ATTRIBUTE + "=\"([^\"]*)\""));
	assert.ok(match, "the script reading the styles did not run in " + url);
	return match[1];
}

function runCli(args) {
	return execFileAsync(process.execPath, ["single-file-node.js", ...fastCaptureArgs, ...args], { cwd: cliDirectory });
}

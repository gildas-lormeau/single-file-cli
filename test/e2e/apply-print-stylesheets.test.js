/* global URL */

// --apply-print-stylesheets saves a page the way it would be printed (SingleFile#1567): on sites
// that wrote a stylesheet for paper, that is the article without the navigation and the ads. The
// saved page is read on a screen, so single-file-core rewrites every media query for a reader whose
// medium is "print". Its unit tests check the rewritten text; only a browser can say what the saved
// page then displays, which is what this file asserts.
//
// The saved file is opened a second time from its file:// URL, with a script that writes on the body
// the list of the elements the browser displays, and that second capture is what the tests read.
// Reading the text of the page would not do: an element that is not displayed is not always removed
// from a capture, it may be kept and hidden.

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
const SCREEN_LAYOUT = "navigation,article";
const PRINT_LAYOUT = "article,print-note,linked-note";
// the navigation is hidden on paper by a rule of the page, the two notes are hidden on screens: one
// by a rule under @media screen, the other until a stylesheet linked with media="print" shows it
const PAGE = "<html><head><title>Print</title>" +
	"<style>#linked-note{display:none}@media screen{#print-note{display:none}}@media print{#navigation{display:none}}</style>" +
	"<link rel=\"stylesheet\" media=\"print\" href=\"print.css\">" +
	"</head><body><nav id=\"navigation\">navigation</nav><p id=\"article\">article</p><p id=\"print-note\">note</p><p id=\"linked-note\">note</p></body></html>";
const PRINT_SHEET = "#linked-note{display:block}";
const DISPLAYED_SCRIPT = "addEventListener(\"load\",()=>{document.body.dataset.displayed=[\"navigation\",\"article\",\"print-note\",\"linked-note\"]" +
	".filter(id=>document.getElementById(id)&&getComputedStyle(document.getElementById(id)).display!=\"none\").join(\",\");});";

// The control: it shows that the second capture does tell the two layouts apart, and that the page
// is saved with its screen layout unless the option is given.
test("without the option the saved page shows the screen layout", { timeout: TEST_TIMEOUT }, async () => {
	assert.equal(await saveAndReopen([]), SCREEN_LAYOUT);
});

test("with the option the saved page shows the print layout on a screen", { timeout: TEST_TIMEOUT }, async () => {
	assert.equal(await saveAndReopen(["--apply-print-stylesheets"]), PRINT_LAYOUT);
});

async function saveAndReopen(options) {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		if (pathname === "/") {
			response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
		} else if (pathname === "/print.css") {
			response.writeHead(200, { "content-type": "text/css" }).end(PRINT_SHEET);
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const savedPath = join(directory, "saved.html");
		await runCli(["http://localhost:" + server.address().port + "/", savedPath, ...options]);
		const scriptPath = join(directory, "displayed.js");
		await writeFile(scriptPath, DISPLAYED_SCRIPT);
		const reopenedPath = join(directory, "reopened.html");
		await runCli([pathToFileURL(savedPath).href, reopenedPath, "--browser-script", scriptPath]);
		// attributes are quoted only when they have to be in a saved page
		const displayed = /data-displayed="?([a-z,-]*)/.exec(await readFile(reopenedPath, "utf-8"));
		return displayed ? displayed[1] : "no list of the displayed elements in the reopened page";
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
}

function runCli(args) {
	return execFileAsync(process.execPath, ["single-file-node.js", ...fastCaptureArgs, ...args], { cwd: cliDirectory });
}

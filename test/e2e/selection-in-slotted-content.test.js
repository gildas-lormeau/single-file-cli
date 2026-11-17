// Saving a selection keeps the selected elements with their ancestors, hides what comes before and
// removes what comes after. The shadow root of an ancestor was treated as content that comes before:
// it was emptied, its slots went with it, and a shadow root without a slot displays none of the
// children of its host. A selection made in content slotted through a component was saved as a blank
// page with the text still in the source (SingleFile #2060).
//
// The slots receiving the selected content are now kept, with their ancestors in the shadow root, and
// the rest of the shadow root is hidden like any other content outside the selection. The shadow root
// of a host that is selected whole is left as it is.
//
// This needs a browser: the DOM used by the unit tests of the core keeps the content of a template
// out of its children, so the pass emptying the shadow root finds nothing to empty there.

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
// x-shell draws a banner and two slots, x-pass forwards its children to a nested x-inner, and x-leaf
// draws everything in its shadow root; the article is slotted through x-shell and x-pass
const PAGE = `<html><head><title>selection in slotted content</title></head><body>
	<x-shell>
		<nav slot="side">menu</nav>
		<x-pass>
			<aside>related</aside>
			<article><h1>title</h1><p>body text</p><x-leaf></x-leaf></article>
		</x-pass>
	</x-shell>
	<script>
		define("x-shell", "<header class=banner>banner</header><div class=main><slot></slot></div><div class=side><slot name=side><em>no menu</em></slot></div>");
		define("x-pass", "<x-inner><slot></slot><b>label</b></x-inner>");
		define("x-inner", "<section class=inner><slot></slot></section><footer class=inner-footer>inner footer</footer>");
		define("x-leaf", "<span class=leaf>leaf content</span>");
		function define(name, content) {
			customElements.define(name, class extends HTMLElement {
				constructor() {
					super();
					this.attachShadow({ mode: "open" }).innerHTML = content;
				}
			});
		}
	</script>
</body></html>`;

test("the slots receiving the selected content are kept in the shadow roots of its ancestors", { timeout: TEST_TIMEOUT }, async () => {
	await withSavedPage(["--selected-elements-selector=article"], content => {
		assert.match(content, /<h1>title<\/h1>/, "the selected content was not saved");
		assert.match(getShadowRoot(content, "x-shell"), /<div class=main><slot><\/slot><\/div>/, "the default slot of x-shell was not kept as it was");
		assert.match(getShadowRoot(content, "x-pass"), /<x-inner><template[^>]*>.*<\/template><slot><\/slot>/s, "the slot of x-pass was not kept");
		assert.match(getShadowRoot(content, "x-inner"), /<section class=inner><slot><\/slot><\/section>/, "the slot of the nested x-inner was not kept");
	});
});

test("the rest of these shadow roots is hidden or removed", { timeout: TEST_TIMEOUT }, async () => {
	await withSavedPage(["--selected-elements-selector=article"], content => {
		const shellRoot = getShadowRoot(content, "x-shell");
		assert.match(shellRoot, /<header class=banner style="?visibility:\s*hidden/, "the banner before the slot was not hidden");
		assert.doesNotMatch(shellRoot, /banner<\/header>/, "the banner was not emptied");
		assert.doesNotMatch(shellRoot, /name=side|no menu/, "the slot receiving no selected content was kept");
		assert.doesNotMatch(getShadowRoot(content, "x-pass"), /label/, "the content after the slot of x-pass was kept");
		assert.doesNotMatch(getShadowRoot(content, "x-inner"), /inner footer/, "the content after the slot of x-inner was kept");
		assert.doesNotMatch(content, /menu<\/nav>|related/, "the unselected children of the hosts were kept");
	});
});

test("the shadow root of a host inside the selection is saved whole", { timeout: TEST_TIMEOUT }, async () => {
	await withSavedPage(["--selected-elements-selector=article"], content => {
		assert.match(getShadowRoot(content, "x-leaf"), /<span class=leaf>leaf content<\/span>/);
	});
});

test("no mark is left in the saved page", { timeout: TEST_TIMEOUT }, async () => {
	await withSavedPage(["--selected-elements-selector=article"], content => {
		assert.doesNotMatch(content, /selected-content/);
	});
});

test("control: without a selection the shadow roots are saved whole", { timeout: TEST_TIMEOUT }, async () => {
	await withSavedPage([], content => {
		const shellRoot = getShadowRoot(content, "x-shell");
		assert.match(shellRoot, /banner<\/header>/);
		assert.match(shellRoot, /<slot name=side><em>no menu<\/em><\/slot>/);
		assert.match(getShadowRoot(content, "x-inner"), /inner footer/);
	});
});

// the shadow root of the first host with this tag name: what its template holds, the templates of
// the hosts nested in it included
function getShadowRoot(content, tagName) {
	const start = content.search(new RegExp("<" + tagName + "[^>]*><template"));
	assert.notEqual(start, -1, "no shadow root was saved for " + tagName);
	const templatePattern = /<template\b[^>]*>|<\/template>/g;
	templatePattern.lastIndex = start;
	let depth = 0, contentStart, match;
	while ((match = templatePattern.exec(content))) {
		if (match[0].startsWith("</")) {
			depth--;
			if (!depth) {
				return content.substring(contentStart, match.index);
			}
		} else {
			if (!depth) {
				contentStart = templatePattern.lastIndex;
			}
			depth++;
		}
	}
	assert.fail("the shadow root of " + tagName + " is not closed");
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

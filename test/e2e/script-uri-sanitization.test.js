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

// blockScripts promises that a saved page holds no script, and these are the cases that need a real
// DOM to write down at all. single-file-core tests the rest under deno-dom, which reports every
// attribute as null-namespace and lowercases nothing, so an xlink:href or a mixed-case ONLOAD cannot
// be expressed there: deno-dom parses xlink:href into a plain href and enumerates no on* IDL
// properties. Only a browser puts the attribute in a namespace or keeps the case the page chose.
//
// The sanitizer used to read the resolved IDL property, so it skipped SVG links, whose href is an
// SVGAnimatedString and not a string, and it never saw xlink:href, which no [href] selector matches.

const PAGE = "<html><head><title>Script URIs</title></head><body>" +
	"<svg id=svg width=60 height=60 xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\">" +
	"<a id=svg-href href=\"javascript:alert(1)\"><rect width=25 height=25/></a>" +
	"<a id=svg-xlink xlink:href=\"javascript:alert(2)\"><rect x=30 width=25 height=25/></a>" +
	"</svg>" +
	"<div id=mixed>a</div><div id=namespaced>b</div><div id=plain>c</div>" +
	"<a id=svg-runtime>d</a>" +
	"<script>" +
	"document.getElementById(\"mixed\").setAttributeNS(null, \"ONLOAD\", \"alert(3)\");" +
	"document.getElementById(\"namespaced\").setAttributeNS(\"http://example.org/ns\", \"ONERROR\", \"alert(4)\");" +
	"document.getElementById(\"plain\").setAttribute(\"onclick\", \"alert(5)\");" +
	"document.getElementById(\"svg-runtime\").setAttributeNS(null, \"HREF\", \"  \\tJaVaScRiPt:alert(6)\");" +
	"</script></body></html>";

async function capture() {
	const server = createServer((_, response) => response
		.writeHead(200, { "content-type": "text/html" })
		.end(PAGE));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "page.html");
		const url = "http://localhost:" + server.address().port + "/";
		const { stderr } = await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, url, outputPath
		], { cwd: cliDirectory });
		try {
			return await readFile(outputPath, "utf8");
		} catch (error) {
			throw new Error("missing output file, stderr: " + stderr, { cause: error });
		}
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
}

test("no javascript: URI survives in a saved page", { timeout: 120000 }, async () => {
	const content = await capture();
	assert.ok(!content.includes("javascript:alert"), "a javascript: URI was kept: " + (content.match(/[^\s"']*javascript:alert[^\s"']*/) || []));
	assert.ok(content.includes("javascript:void(0)"), "expected the links to be rewritten, got: " + content);
});

test("a neutralized xlink:href stays in the xlink namespace", { timeout: 120000 }, async () => {
	const content = await capture();
	// setAttribute would have added a second, null-namespace href and left the xlink one live, and on
	// re-parse the first of the two duplicates wins — which would be the original.
	assert.ok(content.includes("xlink:href=javascript:void(0)") || content.includes("xlink:href=\"javascript:void(0)\""),
		"expected xlink:href to be rewritten in place, got: " + (content.match(/<a id=svg-xlink[^>]*>/) || []));
	assert.ok(!/<a id=svg-xlink[^>]*\shref=/.test(content), "a duplicate null-namespace href was added: " + (content.match(/<a id=svg-xlink[^>]*>/) || []));
});

test("event handler attributes are removed whatever their case or namespace", { timeout: 120000 }, async () => {
	const content = await capture();
	assert.ok(!/alert\(3\)/.test(content), "a mixed-case ONLOAD survived: " + (content.match(/<div id=mixed[^>]*>/) || []));
	assert.ok(!/alert\(4\)/.test(content), "a namespaced ONERROR survived: " + (content.match(/<div id=namespaced[^>]*>/) || []));
	assert.ok(!/alert\(5\)/.test(content), "a plain onclick survived: " + (content.match(/<div id=plain[^>]*>/) || []));
	assert.ok(!/alert\(6\)/.test(content), "an obfuscated mixed-case HREF survived: " + (content.match(/<a id=svg-runtime[^>]*>/) || []));
});

test("the saved page forbids form submission", { timeout: 120000 }, async () => {
	const content = await capture();
	// The one channel the rest of the policy leaves open: default-src does not cover form-action, so
	// without this a surviving javascript: form action could post the page anywhere.
	const csp = content.match(/content="(default-src[^"]*)"/);
	assert.ok(csp, "no content-security-policy in the saved page");
	assert.ok(csp[1].includes("form-action 'none'"), "expected form-action 'none', got: " + csp[1]);
});

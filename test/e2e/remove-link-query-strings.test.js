/* global URL */

// --remove-link-query-strings maps to the core option removeLinkQueryStrings, which strips the
// query of every a/area href that is relative or http(s) and keeps the fragment. The baseline
// capture is what gives the first assertion its meaning: without the flag the query must survive,
// otherwise a page saved without any query would pass on its own.

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
const PAGE = "<html><head><title>Links Page</title></head><body>" +
	"<a id=\"tracked\" href=\"/article?utm_source=mail&amp;session=42#comments\">article</a>" +
	"<a id=\"mail\" href=\"mailto:someone@example.com?subject=hello\">mail</a>" +
	"<form id=\"search\" action=\"/search?lang=en\"><input name=\"q\"></form>" +
	"</body></html>";

const capturePromises = new Map();

test("--remove-link-query-strings strips the query of the links and keeps the fragment", { timeout: TEST_TIMEOUT }, async () => {
	const { content, origin } = await getCaptureResult("stripped");
	assert.match(content, new RegExp("id=\"?tracked\"? href=\"?" + origin + "/article#comments\"?>"), "the query is still in the link, so the flag never reached core");
});

test("--remove-link-query-strings leaves mailto links and form actions alone", { timeout: TEST_TIMEOUT }, async () => {
	const { content } = await getCaptureResult("stripped");
	assert.match(content, /href="mailto:someone@example\.com\?subject=hello"/, "the mailto query was removed");
	assert.match(content, /action="\/search\?lang=en"/, "the form action query was removed");
});

test("the query of the links is kept without the flag", { timeout: TEST_TIMEOUT }, async () => {
	const { content, origin } = await getCaptureResult("baseline");
	assert.match(content, new RegExp("id=\"?tracked\"? href=\"" + origin + "/article\\?utm_source=mail&amp;session=42#comments\">"), "the query disappeared without --remove-link-query-strings");
});

function getCaptureResult(variant) {
	if (!capturePromises.has(variant)) {
		capturePromises.set(variant, runCapture(variant == "stripped" ? ["--remove-link-query-strings"] : []));
	}
	return capturePromises.get(variant);
}

async function runCapture(extraArguments) {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		if (pathname === "/") {
			response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const origin = "http://localhost:" + server.address().port;
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "page.html");
		await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, origin + "/", outputPath
		].concat(extraArguments), { cwd: cliDirectory });
		return { content: (await readFile(outputPath)).toString("utf8"), origin };
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
}

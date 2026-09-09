/* global URL */

// --insert-meta-noindex is a core option that had no CLI flag at all until now, so nothing here
// ever proved it arrives. That is the failure this file guards: an option can be declared, parsed
// and documented and still do nothing, because the value has to survive the whole trip from the
// command line into the page's own context.
//
// The baseline capture is the half that makes it mean something: without the flag the element may
// not appear, otherwise the assertion above would pass on a page that was going to carry it anyway.
//
// Its neighbour insertCanonicalLink deliberately has NO flag. It sits in the same core list, but
// single-file.js forces it to true on every capture, so a flag for it would be a switch that reads
// as configurable and cannot turn anything off.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory } from "../target.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 120000;
const PAGE = "<html><head><title>Head Page</title></head><body>content</body></html>";
const ROBOTS_META = /<meta[^>]*name=["']?robots["']?[^>]*content=["']?noindex/i;

const capturePromises = new Map();

test("--insert-meta-noindex inserts the robots meta", { timeout: TEST_TIMEOUT }, async () => {
	const content = await getCaptureResult("inserted");
	assert.match(content, ROBOTS_META, "the robots meta is missing, so the flag never reached core");
});

test("the robots meta is not inserted without the flag", { timeout: TEST_TIMEOUT }, async () => {
	const content = await getCaptureResult("baseline");
	assert.doesNotMatch(content, ROBOTS_META, "the robots meta appears without --insert-meta-noindex");
});

function getCaptureResult(variant) {
	if (!capturePromises.has(variant)) {
		capturePromises.set(variant, runCapture(variant == "inserted" ? ["--insert-meta-noindex"] : []));
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
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "page.html");
		await execFileAsync(process.execPath, [
			"single-file-node.js", "http://localhost:" + server.address().port + "/", outputPath
		].concat(extraArguments), { cwd: cliDirectory });
		return (await readFile(outputPath)).toString("utf8");
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
}

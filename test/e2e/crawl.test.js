/* global URL */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const execFileAsync = promisify(execFile);
const cliDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_TIMEOUT = 120000;

let crawlPromise;

test("a page linked with and without fragment is captured once", { timeout: TEST_TIMEOUT }, async () => {
	const { filenames } = await getCrawlResult();
	assert.ok(filenames.includes("Top Page.html"));
	assert.equal(filenames.filter(filename => filename.startsWith("Linked Page")).length, 1);
});

test("links to pages with the same title are rewritten to distinct filenames", { timeout: TEST_TIMEOUT }, async () => {
	const { filenames, pages } = await getCrawlResult();
	assert.ok(filenames.includes("Same Title.html"));
	assert.ok(filenames.includes("Same Title (2).html"));
	assert.ok(pages["Top Page.html"].includes("=Same%20Title.html>"));
	assert.ok(pages["Top Page.html"].includes("=Same%20Title%20(2).html>"));
});

function getCrawlResult() {
	if (!crawlPromise) {
		crawlPromise = runCrawl();
	}
	return crawlPromise;
}

async function runCrawl() {
	const otherServerRequests = [];
	const otherServer = createServer((request, response) => {
		otherServerRequests.push(request.url);
		servePage(response, "Other Server");
	});
	await new Promise(resolve => otherServer.listen(0, "localhost", resolve));
	const otherServerOrigin = "http://localhost:" + otherServer.address().port;
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		if (pathname === "/") {
			servePage(response, "Top Page", `
				<a href="/page.html">page</a>
				<a href="/page.html#section">section</a>
				<a href="/fragment.html#top">fragment</a>
				<a href="/same-title-1.html">first</a>
				<a href="/same-title-2.html">second</a>
				<a href="${otherServerOrigin}/other.html">other</a>
				<a href="mailto:contact@example.net">mail</a>`);
		} else if (pathname === "/page.html") {
			servePage(response, "Linked Page");
		} else if (pathname === "/fragment.html") {
			servePage(response, "Fragment Page");
		} else if (pathname === "/same-title-1.html") {
			servePage(response, "Same Title", "first");
		} else if (pathname === "/same-title-2.html") {
			servePage(response, "Same Title", "second");
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const url = "http://localhost:" + server.address().port + "/";
		await execFileAsync(process.execPath, [
			"single-file-node.js", url,
			"--crawl-links",
			"--crawl-replace-URLs",
			"--output-directory", directory,
			"--filename-template", "{page-title}.html",
			"--max-parallel-workers", "1"
		], { cwd: cliDirectory });
		const filenames = await readdir(directory);
		const pages = {};
		for (const filename of filenames) {
			pages[filename] = await readFile(join(directory, filename), "utf8");
		}
		return { filenames, pages, otherServerRequests };
	} finally {
		await rm(directory, { recursive: true });
		server.close();
		otherServer.close();
	}
}

function servePage(response, title, body = "") {
	response.writeHead(200, { "content-type": "text/html" })
		.end(`<html><head><title>${title}</title></head><body>${body}</body></html>`);
}

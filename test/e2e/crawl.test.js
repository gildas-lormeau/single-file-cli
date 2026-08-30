/* global URL */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory } from "../target.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 120000;

let crawlPromise;

test("a page linked with and without fragment is captured once", { timeout: TEST_TIMEOUT }, async () => {
	const { filenames, stderr } = await getCrawlResult();
	assert.ok(filenames.includes("Top Page.html"), "missing top page, captured: " + filenames.join(", ") + ", stderr: " + stderr);
	assert.equal(filenames.filter(filename => filename.startsWith("Linked Page")).length, 1);
});

test("links to pages with the same title are rewritten to distinct filenames", { timeout: TEST_TIMEOUT }, async () => {
	const { filenames, pages } = await getCrawlResult();
	assert.ok(filenames.includes("Same Title.html"));
	assert.ok(filenames.includes("Same Title (2).html"));
	assert.ok(pages["Top Page.html"].includes("=Same%20Title.html>"));
	assert.ok(pages["Top Page.html"].includes("=Same%20Title%20(2).html>"));
});

test("links to another port are not crawled as inner links", { timeout: TEST_TIMEOUT }, async () => {
	const { filenames, otherServerRequests } = await getCrawlResult();
	assert.ok(!filenames.includes("Other Server.html"));
	assert.equal(otherServerRequests.length, 0);
});

test("fragment links are rewritten to the captured filename", { timeout: TEST_TIMEOUT }, async () => {
	const { pages } = await getCrawlResult();
	assert.ok(pages["Top Page.html"].includes("=Fragment%20Page.html>"));
});

test("all link variants of a deduplicated page are rewritten", { timeout: TEST_TIMEOUT }, async () => {
	const { pages } = await getCrawlResult();
	assert.ok(!pages["Top Page.html"].includes("page.html#section"));
	assert.equal((pages["Top Page.html"].match(/=Linked%20Page\.html>/g) || []).length, 2);
});

test("mail and script links are not crawled as external links", { timeout: TEST_TIMEOUT }, async () => {
	const server = createServer((_, response) => servePage(response, "Mail Top", `
		<a href="mailto:contact@example.net">mail</a>
		<a href="javascript:void(0)">script</a>
		<a href="tel:+15550100">phone</a>`));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const url = "http://localhost:" + server.address().port + "/";
		await execFileAsync(process.execPath, [
			"single-file-node.js", url,
			"--crawl-links",
			"--crawl-inner-links-only=false",
			"--output-directory", directory,
			"--filename-template", "{page-title}.html",
			"--errors-file", join(directory, "errors.txt"),
			"--max-parallel-workers", "1"
		], { cwd: cliDirectory });
		const filenames = await readdir(directory);
		const errors = filenames.includes("errors.txt") ? await readFile(join(directory, "errors.txt"), "utf8") : "";
		assert.deepEqual(filenames, ["Mail Top.html"], "errors: " + errors);
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
});

test("crawl options require --crawl-links", { timeout: TEST_TIMEOUT }, async () => {
	await assert.rejects(
		execFileAsync(process.execPath, [
			"single-file-node.js", "http://localhost/",
			"--crawl-no-parent",
			"--crawl-max-depth", "2",
			"--crawl-rewrite-rule", "a b"
		], { cwd: cliDirectory }),
		error => error.stderr.includes("--crawl-no-parent requires --crawl-links") &&
			error.stderr.includes("--crawl-max-depth requires --crawl-links") &&
			error.stderr.includes("--crawl-rewrite-rule requires --crawl-links"));
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
		const { stderr } = await execFileAsync(process.execPath, [
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
		return { filenames, pages, otherServerRequests, stderr };
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

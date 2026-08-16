/* global URL, TextDecoder */

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
import { configure, ZipReader, Uint8ArrayReader, TextWriter } from "../../lib/single-file-archive.js";

const execFileAsync = promisify(execFile);
const cliDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_TIMEOUT = 120000;

let crawlPromise;

test("crawled pages are merged into a single self-extracting archive", { timeout: TEST_TIMEOUT }, async () => {
	const { filenames, entryNames, data, stderr } = await getCrawlResult();
	assert.deepEqual(filenames, ["archive.html"], "stderr: " + stderr);
	assert.ok(entryNames.includes("index.html"));
	assert.ok(entryNames.includes("pages/2/index.html"));
	assert.ok(entryNames.includes("pages/3/index.html"));
	assert.ok(entryNames.includes("sfz-pages.json"));
	const prelude = new TextDecoder("windows-1252").decode(data.subarray(0, 64));
	assert.ok(prelude.startsWith("<!DOCTYPE html><html data-sfz>"));
});

test("the pages manifest maps paths to the crawled URLs", { timeout: TEST_TIMEOUT }, async () => {
	const { manifest, origin } = await getCrawlResult();
	assert.equal(manifest.pages.length, 3);
	assert.equal(manifest.pages[0].path, "");
	assert.equal(manifest.pages[0].url, origin + "/");
	assert.equal(manifest.pages[0].title, "Top Page");
	assert.equal(manifest.pages[1].path, "pages/2/");
	assert.equal(manifest.pages[1].title, "Linked Page");
	assert.equal(manifest.pages[2].path, "pages/3/");
	assert.equal(manifest.pages[2].title, "Other Page");
	assert.ok(manifest.pages[1].originalUrls.includes(origin + "/page.html"));
});

test("merged page entries can be extracted", { timeout: TEST_TIMEOUT }, async () => {
	const { entries } = await getCrawlResult();
	const entry = entries.find(entry => entry.filename == "pages/2/index.html");
	const content = await entry.getData(new TextWriter());
	assert.ok(content.includes("Linked Page"));
});

test("--crawl-save-archive requires --compress-content", { timeout: TEST_TIMEOUT }, async () => {
	await assert.rejects(
		execFileAsync(process.execPath, ["single-file-node.js", "http://localhost/", "--crawl-save-archive"], { cwd: cliDirectory }),
		error => error.stderr.includes("--crawl-save-archive requires --compress-content"));
});

function getCrawlResult() {
	if (!crawlPromise) {
		crawlPromise = runCrawl();
	}
	return crawlPromise;
}

async function runCrawl() {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		if (pathname === "/") {
			servePage(response, "Top Page", `
				<a href="/page.html">page</a>
				<a href="/other.html">other</a>`);
		} else if (pathname === "/page.html") {
			servePage(response, "Linked Page");
		} else if (pathname === "/other.html") {
			servePage(response, "Other Page");
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const origin = "http://localhost:" + server.address().port;
		const { stderr } = await execFileAsync(process.execPath, [
			"single-file-node.js", origin + "/", join(directory, "archive.html"),
			"--crawl-links",
			"--crawl-save-archive",
			"--compress-content",
			"--max-parallel-workers", "1"
		], { cwd: cliDirectory });
		const filenames = await readdir(directory);
		const data = new Uint8Array(await readFile(join(directory, "archive.html")));
		configure({ useWebWorkers: false });
		const zipReader = new ZipReader(new Uint8ArrayReader(data));
		const entries = await zipReader.getEntries();
		const entryNames = entries.map(entry => entry.filename);
		const manifestEntry = entries.find(entry => entry.filename == "sfz-pages.json");
		const manifest = manifestEntry ? JSON.parse(await manifestEntry.getData(new TextWriter())) : undefined;
		return { filenames, entries, entryNames, manifest, data, origin, stderr };
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
}

function servePage(response, title, body = "") {
	response.writeHead(200, { "content-type": "text/html" })
		.end(`<html><head><title>${title}</title></head><body>${body}</body></html>`);
}

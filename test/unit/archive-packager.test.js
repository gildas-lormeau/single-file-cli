import { test } from "node:test";
import assert from "node:assert/strict";
import { createPagesArchive } from "../../lib/archive-packager.js";
import { configure, ZipWriter, ZipReader, Uint8ArrayReader, Uint8ArrayWriter, TextReader, TextWriter } from "../../lib/single-file-archive.js";

configure({ useWebWorkers: false });

test("the stored table of contents groups pages by URL path segments", async () => {
	const archive = await createArchive([
		{ url: "https://example.com/", title: "Home" },
		{ url: "https://example.com/docs/api/reader.html", title: "Reader" },
		{ url: "https://example.com/docs/api/writer.html", title: "" },
		{ url: "https://example.com/docs/guide.html", title: "Guide <em> & \"quotes\"" }
	]);
	const toc = await readEntry(archive, "sfz-toc.html");
	assert.ok(toc.includes("<a href=\"index.html\">Home</a>"));
	assert.ok(toc.includes("<details open><summary>docs</summary>"));
	assert.ok(toc.includes("<summary>api</summary>"));
	assert.ok(toc.includes("<a href=\"pages/2/index.html\">Reader</a>"));
	assert.ok(toc.includes(">https://example.com/docs/api/writer.html</a>"), "empty title falls back to the URL");
	assert.ok(toc.includes("Guide &lt;em&gt; &amp; &quot;quotes&quot;"), "titles are escaped");
});

test("the table of contents groups by origin when the crawl crossed hosts", async () => {
	const archive = await createArchive([
		{ url: "https://example.com/", title: "Home" },
		{ url: "https://other.example/about.html", title: "About" }
	]);
	const toc = await readEntry(archive, "sfz-toc.html");
	assert.ok(toc.includes("<summary>https://example.com</summary>"));
	assert.ok(toc.includes("<summary>https://other.example</summary>"));
});

async function createArchive(pages) {
	return createPagesArchive(pages.map(page => ({
		url: page.url,
		originalUrls: [page.url],
		title: page.title,
		getData: () => createPageData(page)
	})), { tocPage: true, selfExtractingArchive: false });
}

async function createPageData(page) {
	const zipWriter = new ZipWriter(new Uint8ArrayWriter());
	await zipWriter.add("index.html", new TextReader("<!DOCTYPE html><html><head><title>" + page.title + "</title></head><body></body></html>"));
	return zipWriter.close();
}

async function readEntry(archive, filename) {
	const zipReader = new ZipReader(new Uint8ArrayReader(archive));
	const entries = await zipReader.getEntries();
	const entry = entries.find(entry => entry.filename == filename);
	assert.ok(entry, filename + " entry exists");
	return entry.getData(new TextWriter());
}

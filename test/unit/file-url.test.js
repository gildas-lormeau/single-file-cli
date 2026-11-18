/* global TextDecoder */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { path } from "../../lib/deno-polyfill.js";
import { fetch as fetchWithFileSupport } from "../../lib/cdp-client-util.js";

// on Windows, a file URL without a drive letter is not a path and is refused
const windows = process.platform == "win32";
const ROOT_URL = windows ? "file:///C:/" : "file:///";
const ROOT_PATH = windows ? "C:\\" : "/";

test("fromFileUrl decodes percent-encoded characters", async () => {
	assert.equal(await path.fromFileUrl(ROOT_URL + "tmp/some%20dir/page.html"), join(ROOT_PATH, "tmp", "some dir", "page.html"));
});

test("fromFileUrl ignores query and fragment", async () => {
	assert.equal(await path.fromFileUrl(ROOT_URL + "tmp/page.html?query=1#fragment"), join(ROOT_PATH, "tmp", "page.html"));
});

test("fetch reads a file URL with a query", async () => {
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const filePath = join(directory, "resource dir");
		await writeFile(filePath, "file content");
		const fileUrl = await path.toFileUrl(filePath);
		const response = await fetchWithFileSupport(fileUrl + "?query=1");
		assert.equal(response.status, 200);
		const content = new TextDecoder().decode(await response.arrayBuffer());
		assert.equal(content, "file content");
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("fetch returns 404 for a missing file URL", async () => {
	const response = await fetchWithFileSupport("file:///nonexistent/path/resource");
	assert.equal(response.status, 404);
});

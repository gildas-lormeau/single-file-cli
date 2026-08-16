/* global TextDecoder */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { path } from "../../lib/deno-polyfill.js";
import { fetch as fetchWithFileSupport } from "../../lib/cdp-client-util.js";

test("fromFileUrl decodes percent-encoded characters", async () => {
	assert.equal(await path.fromFileUrl("file:///tmp/some%20dir/page.html"), "/tmp/some dir/page.html");
});

test("fromFileUrl ignores query and fragment", async () => {
	assert.equal(await path.fromFileUrl("file:///tmp/page.html?query=1#fragment"), "/tmp/page.html");
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

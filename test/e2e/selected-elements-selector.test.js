// --selected-elements-selector is "save selection" for the CLI, which has no user to select
// anything: the elements matching the selector are kept with their ancestors, the elements before
// them are hidden and the elements after them removed, exactly what the extension does with a
// selection. --removed-elements-selector runs afterwards, so it can still remove part of what was
// kept. A selector matching nothing saves the whole page rather than an empty one.

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
// the committed lib/ is a build of the pinned single-file-core release, so the option is only there
// once the pin carries it, and always in the dev build
const BUNDLE = await readFile(join(cliDirectory, "lib", "single-file-bundle.js"), "utf8");
const SUPPORTED = BUNDLE.includes("selectedElementsSelector");
const SKIP = SUPPORTED ? false : "the pinned single-file-core does not carry the option yet";
const PAGE = "<html><body><header>top</header><main><nav>menu</nav><article><h1>title</h1><p class=\"ad\">advert</p><p>body text</p></article><aside>related</aside></main><footer>bottom</footer></body></html>";

test("the matching elements are kept and the rest hidden or removed", { timeout: TEST_TIMEOUT, skip: SKIP }, async () => {
	const content = await save(["--selected-elements-selector", "main article"]);
	assert.match(content, /body text/, "the selected content is missing");
	assert.match(content, /<header[^>]*visibility:\s*hidden/, "the element before the selection is not hidden");
	assert.doesNotMatch(content, /related|bottom/, "an element after the selection was kept");
	assert.doesNotMatch(content, /data-single-file-selected-content/, "a selection mark reached the saved page");
});

test("--removed-elements-selector is applied after it", { timeout: TEST_TIMEOUT, skip: SKIP }, async () => {
	const content = await save(["--selected-elements-selector", "main article", "--removed-elements-selector", ".ad"]);
	assert.match(content, /body text/);
	assert.doesNotMatch(content, /advert/, "the removed selector did not apply inside the kept elements");
});

test("control: a selector matching nothing saves the whole page", { timeout: TEST_TIMEOUT, skip: SKIP }, async () => {
	const content = await save(["--selected-elements-selector", "video"]);
	assert.match(content, /top<\/header>/);
	assert.match(content, /bottom<\/footer>/);
});

async function save(args) {
	const server = createServer((request, response) =>
		response.writeHead(200, { "content-type": "text/html" }).end(PAGE));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, "http://localhost:" + server.address().port + "/", outputPath, ...args
		], { cwd: cliDirectory });
		return await readFile(outputPath, "utf8");
	} finally {
		await rm(directory, { recursive: true, force: true });
		await new Promise(resolve => server.close(resolve));
	}
}

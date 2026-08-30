/* global TextDecoder */

// Every other e2e test reads a save as text or as bytes: a marker is present, an entry is named
// what it should be, the console is clean. None of them looks at the page. A save can pass all of
// them and still come back with its type in a fallback family, its grid collapsed, or a frame
// rendered blank — the markup is there, it just does not draw the same picture.
//
// So this suite renders the source page and the saved page and compares the pixels. What it can
// assert is bounded by one thing: a page that does not render identically to ITSELF cannot be held
// to rendering identically to its save. Every check therefore measures that first — the same source
// captured twice — and uses it as the floor. On these fixtures the floor is zero, which is why they
// are hand-built and static rather than mirrored from the web; the real-page matrix is a different
// tool, and it reports rather than asserts.
//
// The fixtures are not decorative. Each one is a defect that shipped, kept in the shape that made
// it visible, with a comment in the page saying which.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import process from "node:process";
import { cliDirectory, importLibModule } from "../target.js";
import { openBrowser } from "../fidelity/browser.js";
import { startServer } from "../fidelity/server.js";
const { configure, ZipReader, Uint8ArrayReader, TextWriter } = await importLibModule("single-file-archive.js");

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 300000;
const PAGES_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "fidelity", "pages");

let browser;

before(async () => browser = await openBrowser(), { timeout: TEST_TIMEOUT });
after(async () => browser && await browser.close(), { timeout: TEST_TIMEOUT });

test("an archived page renders exactly like its source", { timeout: TEST_TIMEOUT }, async () => {
	const { comparison, noise } = await compareSaveWithSource("duplicate-stylesheet", ["--compress-content"]);
	assertNoWorseThanNoise(comparison, noise);
});

test("a plain saved page renders exactly like its source", { timeout: TEST_TIMEOUT }, async () => {
	const { comparison, noise } = await compareSaveWithSource("duplicate-stylesheet", []);
	assertNoWorseThanNoise(comparison, noise);
});

// The pixels say the page still draws the same picture; they cannot say the element that draws it
// is still the element the page named. An id a script looks up and a class a selector matches are
// invisible until something goes looking for them, so they are read out of the save directly.
test("the archived page keeps the attributes of the stylesheets it rewrites", { timeout: TEST_TIMEOUT }, async () => {
	const { saved } = await compareSaveWithSource("duplicate-stylesheet", ["--compress-content"]);
	const page = await readArchiveEntry(saved, "index.html");
	assert.match(page, /id=palette/, "the id of the folded stylesheet was dropped");
	assert.match(page, /class=theme/, "the class of the folded stylesheet was dropped");
	assert.match(page, /data-role=tokens/, "the data attribute of the folded stylesheet was dropped");
	// the point of folding them is that the content is stored once. A page that still carries the
	// declarations inline as well is the bug this fixture was built for, and it passes every
	// assertion above
	assert.doesNotMatch(page, /--accent:/, "the folded stylesheet is still stored inline in the page");
});

// the saved file is a self-extracting archive: what a reader sees as the page is an entry inside
// the zip, and the wrapper around it holds none of the markup being asserted on
async function readArchiveEntry(data, filename) {
	configure({ useWebWorkers: false });
	const entries = await new ZipReader(new Uint8ArrayReader(data)).getEntries();
	const entry = entries.find(entry => entry.filename == filename);
	assert.ok(entry, "the archive holds no entry named " + filename);
	return entry.getData(new TextWriter());
}

// The font minifier keeps a declared face when something on the page draws with it, and the three
// samples name their family in the three ways it has to read. It has given up on all three at some
// point: a property declared on a descendant resolved to nothing, the shorthand was unreadable, and
// a name that could not be resolved switched pruning off for the whole document.
test("a saved page still draws with the fonts it used", { timeout: TEST_TIMEOUT }, async () => {
	const { comparison, noise } = await compareSaveWithSource("used-fonts", []);
	assertNoWorseThanNoise(comparison, noise);
});

// keeping every face renders identically to keeping the right ones, so the half of the contract the
// pixels cannot see is read out of the save: the faces nothing draws with are gone, and the three
// the page draws with are still declared
test("a saved page drops the fonts it did not use", { timeout: TEST_TIMEOUT }, async () => {
	const { saved } = await compareSaveWithSource("used-fonts", []);
	assert.deepEqual(getDeclaredFontFamilies(saved).sort(), ["Fidelity Band", "Fidelity Bar", "Fidelity Block"]);
});

// the faces are read out of the @font-face rules rather than looked for anywhere in the page: a
// family name also appears in the declarations that USE it, and a check that searched the whole
// text called a pruned face present because the custom property naming it was still there
function getDeclaredFontFamilies(saved) {
	return new TextDecoder().decode(saved).split("@font-face").slice(1).map(rule => {
		const [, quoted, single, plain] = rule.match(/font-family:\s*(?:"([^"]*)"|'([^']*)'|([^;}]*))/) || [];
		return (quoted || single || plain || "").trim();
	});
}

test("a saved page keeps the fonts declared inside a frame it cannot read", { timeout: TEST_TIMEOUT }, async () => {
	const { comparison, noise } = await compareSaveWithSource("frame-fonts", []);
	assertNoWorseThanNoise(comparison, noise);
});

// A family drawn in a style it declares no face for is drawn by the browser slanting or thickening
// the face it has. It is still the family being used, and narrowing the used list to the faces that
// match the computed style dropped it from the page that draws it — while the upright sample kept
// the list non-empty, so nothing else noticed.
test("a saved page keeps a font drawn in a style it declares no face for", { timeout: TEST_TIMEOUT }, async () => {
	const { comparison, noise, saved } = await compareSaveWithSource("synthetic-italic", []);
	assertNoWorseThanNoise(comparison, noise);
	assert.deepEqual(getDeclaredFontFamilies(saved).sort(), ["Fidelity Bar", "Fidelity Block"]);
});

// The two halves of what happens when a family cannot be resolved from the stylesheets. The face
// the browser drew with has to survive — the rendered list is the only thing left that names it —
// and the faces nothing drew have to go, which is the half that says the document was pruned at all
// rather than given up on. Both are needed: keeping everything passes the first check alone.
test("a saved page keeps a font named through a value it cannot resolve", { timeout: TEST_TIMEOUT }, async () => {
	const { comparison, noise } = await compareSaveWithSource("unresolved-font-property", []);
	assertNoWorseThanNoise(comparison, noise);
});

test("a value it cannot resolve does not stop the rest of the page being pruned", { timeout: TEST_TIMEOUT }, async () => {
	const { saved } = await compareSaveWithSource("unresolved-font-property", []);
	assert.deepEqual(getDeclaredFontFamilies(saved), ["Fidelity Block"],
		"one unreadable value decided what happens to every face the page declares");
});

function assertNoWorseThanNoise(comparison, noise) {
	assert.ok(comparison.differing <= noise.differing, describe(comparison, noise));
}

// a failure that says "1382914 pixels differ" is a failure nobody can act on: the report names the
// bands, so the first thing read is where on the page the two renderings parted company
function describe(comparison, noise) {
	const worst = comparison.bands
		.filter(band => band.differing > 0)
		.sort((first, second) => second.differing - first.differing)
		.slice(0, 3)
		.map(band => `\trows ${band.top}-${band.bottom}: ${band.differing} of ${band.total} pixels`);
	return [
		`the saved page does not render like its source: ${comparison.differing} of ${comparison.total} pixels differ`,
		`\tnoise floor (the same source captured twice): ${noise.differing} pixels`,
		comparison.sizeMatches ? "\tboth renderings are the same size" : `\tthe renderings are NOT the same size (union ${comparison.width}x${comparison.height})`,
		...worst
	].join("\n");
}

async function compareSaveWithSource(fixtureName, options) {
	// the whole pages directory is served, not one fixture: the fonts sit beside the fixtures and
	// are shared, so that regenerating them cannot leave one copy behind and one up to date
	const server = await startServer(PAGES_DIRECTORY);
	const url = server.url + fixtureName + "/";
	const directory = await mkdtemp(join(tmpdir(), "single-file-fidelity-"));
	try {
		// the control is captured first and last is never assumed: the source is rendered twice
		// before anything is saved, and the two shots set the floor the save is measured against
		const source = await browser.capture(url);
		const noise = await browser.compare(source, await browser.capture(url));
		const savedPath = join(directory, "saved.html");
		// the default conflict action is to uniquify, which writes "saved (2).html" and leaves the
		// stale file exactly where the test looks for it
		await rm(savedPath, { force: true });
		await execFileAsync(process.execPath, ["single-file-node.js", url, savedPath, ...options], { cwd: cliDirectory });
		const comparison = await browser.compare(source, await browser.capture(pathToFileURL(savedPath).href));
		// asserted rather than returned: a fixture that asks for something the server does not have
		// is not a result to interpret, it is a fixture to fix
		assert.deepEqual(server.misses, [], "the fixture asked for files the server does not have");
		return { comparison, noise, saved: new Uint8Array(await readFile(savedPath)) };
	} finally {
		await rm(directory, { recursive: true, force: true });
		await server.close();
	}
}

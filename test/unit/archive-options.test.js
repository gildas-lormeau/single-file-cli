// The multi-page archive path used to hand-list the 19 options it forwarded to createPagesArchive.
// The single-page path passes the whole options object through, so a compression option added to
// core reached every ordinary capture and was silently ignored by --crawl-save-archive alone —
// which is the worst shape for this kind of gap, because the option looks wired. Core removed the
// same trap on its side by exporting PROCESS_OPTION_NAMES instead of copying the names; the
// forwarding here now derives from that list, and what is deliberately withheld is named.
//
// --max-appended-data-length is what found this: it needed a line here as well as in options.js,
// and would otherwise have shipped working everywhere except archives.
//
// Being on the withheld list is not free either, and --create-root-directory is the proof: it sat
// there while options.js advertised it with no mention of archives, so `--crawl-save-archive
// --create-root-directory` exited 0 and produced an archive with no root directory at all. The
// list means "the archive writer must not receive this", never "this option does not apply here".

import { test } from "node:test";
import assert from "node:assert/strict";
import { importLibModule } from "../target.js";
import { getArchiveOptions, ARCHIVE_EXCLUDED_OPTION_NAMES } from "../../single-file-cli-api.js";
const { PROCESS_OPTION_NAMES } = await importLibModule("single-file-archive.js");

// the keys forwarded before the refactor, pinned so the derivation cannot quietly change what the
// archive path receives
const FORWARDED = [
	"zipScript", "dedupPages", "markUnarchivedLinks", "tocPage", "pageList", "pageTransitions",
	"insertSingleFileComment", "removeSavedDate", "createRootDirectory", "declareAppendedData",
	"embeddedImage", "embeddedPdf", "extractDataFromPage", "includeBOM", "insertCanonicalLink",
	"insertMetaCSP", "insertMetaNoIndex", "maxAppendedDataLength", "preventAppendedData",
	"selfExtractingArchive"
];

test("every compression option is either forwarded to the archive or deliberately withheld", () => {
	const forwarded = Object.keys(getArchiveOptions({}));
	const unaccounted = PROCESS_OPTION_NAMES
		.filter(name => !forwarded.includes(name) && !ARCHIVE_EXCLUDED_OPTION_NAMES.includes(name));
	assert.deepEqual(unaccounted, [],
		"core gained a compression option the archive path neither forwards nor names as withheld, so it is silently ignored by --crawl-save-archive; forward it, or add it to ARCHIVE_EXCLUDED_OPTION_NAMES");
});

test("the archive receives exactly the options it received before the derivation", () => {
	assert.deepEqual(Object.keys(getArchiveOptions({})).sort(), FORWARDED.slice().sort());
});

test("the withheld options are real compression options, not typos", () => {
	const unknown = ARCHIVE_EXCLUDED_OPTION_NAMES.filter(name => !PROCESS_OPTION_NAMES.includes(name));
	assert.deepEqual(unknown, [], "a withheld name that core does not define hides a real gap behind a dead entry");
});

test("a crawl option is renamed on its way to the archive", () => {
	const forwarded = getArchiveOptions({ crawlSaveArchiveDedup: true, crawlSaveArchiveToc: true });
	assert.equal(forwarded.dedupPages, true);
	assert.equal(forwarded.tocPage, true);
});

test("a compression option reaches the archive under its own name", () => {
	assert.equal(getArchiveOptions({ maxAppendedDataLength: 4096 }).maxAppendedDataLength, 4096);
});

test("the root directory option reaches the archive", () => {
	assert.equal(getArchiveOptions({ createRootDirectory: true }).createRootDirectory, true);
});

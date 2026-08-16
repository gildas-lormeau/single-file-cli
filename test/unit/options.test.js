import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../../options.js";

const parse = args => parseArgs(args).options;

test("boolean options with uppercase canonical names can be disabled", () => {
	assert.equal(parse(["--compress-html", "false"]).compressHTML, false);
	assert.equal(parse(["--compress-HTML", "false"]).compressHTML, false);
	assert.equal(parse(["--crawl-remove-url-fragment", "false"]).crawlRemoveURLFragment, false);
	assert.equal(parse(["--insert-meta-csp", "false"]).insertMetaCSP, false);
});

test("option names are canonicalized regardless of case", () => {
	assert.equal(parse(["--include-bom"]).includeBOM, true);
	assert.equal(parse(["--Include-BOM"]).includeBOM, true);
	assert.equal(parse(["--crawl-replace-urls"]).crawlReplaceURLs, true);
	assert.equal(parse(["--save-original-urls"]).saveOriginalURLs, true);
	assert.deepEqual(parse(["--blocked-url-pattern", "ads"]).blockedURLPatterns, ["ads"]);
	const options = parse(["--compress-html", "false"]);
	assert.equal("compressHtml" in options, false);
});

test("aliases map to the canonical option", () => {
	assert.equal(parse(["--error-file", "errors.txt"]).errorsFile, "errors.txt");
	assert.equal(parse(["--errors-file", "errors.txt"]).errorsFile, "errors.txt");
	assert.equal(parse(["--error-traces-disabled", "false"]).errorsTracesDisabled, false);
	assert.equal(parse(["--errors-traces-disabled", "false"]).errorsTracesDisabled, false);
	assert.equal(parse([]).errorsTracesDisabled, true);
});

test("browser arguments are merged", () => {
	assert.deepEqual(parse(["--browser-arg", "--disable-gpu"]).browserArgs, ["--disable-gpu"]);
	assert.deepEqual(parse(["--browser-args", "[\"--mute-audio\"]"]).browserArgs, ["--mute-audio"]);
	assert.deepEqual(parse(["--browser-arg", "--disable-gpu", "--browser-args", "[\"--mute-audio\"]"]).browserArgs, ["--disable-gpu", "--mute-audio"]);
});

test("default values are applied under canonical keys", () => {
	const options = parse([]);
	assert.equal(options.compressHTML, true);
	assert.equal(options.crawlRemoveURLFragment, true);
	assert.equal(options.insertMetaCSP, true);
	assert.equal(options.browserWidth, 1280);
});

test("values are parsed from both spaced and equal forms", () => {
	assert.equal(parse(["--browser-width", "1024"]).browserWidth, 1024);
	assert.equal(parse(["--browser-width=1024"]).browserWidth, 1024);
	assert.equal(parse(["--browser-headless=false"]).browserHeadless, false);
	assert.equal(parse(["--filename-template={page-title}.html"]).filenameTemplate, "{page-title}.html");
});

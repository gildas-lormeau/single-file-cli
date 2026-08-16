import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, applySettings, parseUrlsFile } from "../../options.js";

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

test("invalid and missing values are reported", () => {
	assert.deepEqual(parseArgs(["--browser-width", "abc"]).invalidOptions, [{ name: "browser-width", value: "abc" }]);
	assert.deepEqual(parseArgs(["--browser-width=abc"]).invalidOptions, [{ name: "browser-width", value: "abc" }]);
	assert.deepEqual(parseArgs(["--browser-height="]).invalidOptions, [{ name: "browser-height", value: "" }]);
	assert.deepEqual(parseArgs(["--output-directory"]).invalidOptions, [{ name: "output-directory" }]);
	assert.deepEqual(parseArgs(["--browser-width", "abc"]).positionals, []);
	assert.deepEqual(parseArgs(["--browser-debug"]).invalidOptions, []);
});

test("the last value wins when a scalar option is repeated", () => {
	const { options, positionals } = parseArgs(["--browser-width", "100", "--browser-width", "200"]);
	assert.equal(options.browserWidth, 200);
	assert.deepEqual(positionals, []);
	assert.equal(parse(["--browser-width=100", "--browser-width=200"]).browserWidth, 200);
});

test("http headers keep characters after the first equals sign", () => {
	const options = parse(["--http-header", "authorization=Basic dGVzdA==", "--http-header", " x-test = value "]);
	assert.deepEqual(options.httpHeaders, { authorization: "Basic dGVzdA==", "x-test": "value" });
	assert.deepEqual(parseArgs(["--http-header", "no-separator"]).invalidOptions, [{ name: "http-header", value: "no-separator" }]);
});

test("media features are split on the first colon", () => {
	assert.deepEqual(parse(["--emulate-media-feature", "prefers-color-scheme:dark"]).emulateMediaFeatures, [{ name: "prefers-color-scheme", value: "dark" }]);
	assert.deepEqual(parseArgs(["--emulate-media-feature", "no-separator"]).invalidOptions, [{ name: "emulate-media-feature", value: "no-separator" }]);
});

test("browser cookies are parsed into objects", () => {
	const options = parse(["--browser-cookie", "name,value,example.com,/,,true,true,None,https://example.com"]);
	assert.deepEqual(options.browserCookies, [{
		name: "name",
		value: "value",
		url: "https://example.com",
		domain: "example.com",
		path: "/",
		secure: true,
		httpOnly: true,
		sameSite: "None",
		expires: undefined
	}]);
	assert.equal(parse(["--browser-cookie", "name,value,example.com,/,1893456000,false,false,Lax,https://example.com"]).browserCookies[0].expires, 1893456000);
});

test("invalid browser args json is reported", () => {
	assert.deepEqual(parseArgs(["--browser-args", "not json"]).invalidOptions, [{ name: "browser-args", value: "not json" }]);
});

test("explicit options win over settings file profiles", () => {
	const options = parse(["--settings-file-profile", "custom", "--browser-width", "1024"]);
	const settings = { profiles: { custom: { compressHTML: false, browserWidth: 800 } } };
	applySettings(options, settings, { browserWidth: 1024 });
	assert.equal(options.compressHTML, false);
	assert.equal(options.browserWidth, 1024);
});

test("the default profile maps to the default settings", () => {
	const options = parse([]);
	applySettings(options, { profiles: { __Default_Settings__: { compressHTML: false } } }, {});
	assert.equal(options.compressHTML, false);
});

test("an unknown settings profile is reported", () => {
	const options = parse(["--settings-file-profile", "missing"]);
	assert.throws(
		() => applySettings(options, { profiles: { __Default_Settings__: {}, work: {} } }, {}),
		/Unknown profile "missing", available profiles: work/);
});

test("blank lines in urls files are skipped", () => {
	assert.deepEqual(parseUrlsFile("https://a.example\n\n \nhttps://b.example\r\n"), ["https://a.example", "https://b.example"]);
});

test("single character values in urls file options are kept", () => {
	const [url, options] = parseUrlsFile("https://a.example --crawl-max-depth 2 --browser-width 100")[0];
	assert.equal(url, "https://a.example");
	assert.equal(options.crawlMaxDepth, 2);
	assert.equal(options.browserWidth, 100);
});

test("quoted and equal form values in urls files are parsed", () => {
	const [, options] = parseUrlsFile("https://a.example --filename-template \"My Page.html\" --browser-height=600")[0];
	assert.equal(options.filenameTemplate, "My Page.html");
	assert.equal(options.browserHeight, 600);
});

test("values are parsed from both spaced and equal forms", () => {
	assert.equal(parse(["--browser-width", "1024"]).browserWidth, 1024);
	assert.equal(parse(["--browser-width=1024"]).browserWidth, 1024);
	assert.equal(parse(["--browser-headless=false"]).browserHeadless, false);
	assert.equal(parse(["--filename-template={page-title}.html"]).filenameTemplate, "{page-title}.html");
});

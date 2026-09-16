import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, getDefaultOptions, applySettings, parseUrlsFile } from "../../options.js";
import { DEFAULT_OPTIONS, API_ONLY_DEFAULTS } from "../../single-file-cli-api.js";
import { DEFAULT_REPLACED_CHARACTERS, DEFAULT_REPLACEMENT_CHARACTER, DEFAULT_REPLACEMENT_CHARACTERS } from "../../lib/single-file-filename.js";

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

test("the compression of the entries can be disabled", () => {
	assert.equal(parse(["--disable-compression"]).disableCompression, true);
	assert.equal(parse([]).disableCompression, undefined);
});

test("aliases map to the canonical option", () => {
	assert.equal(parse(["--error-file", "errors.txt"]).errorsFile, "errors.txt");
	assert.equal(parse(["--errors-file", "errors.txt"]).errorsFile, "errors.txt");
	assert.equal(parse(["--error-traces-disabled", "false"]).errorsTracesDisabled, false);
	assert.equal(parse(["--errors-traces-disabled", "false"]).errorsTracesDisabled, false);
	assert.equal(parse([]).errorsTracesDisabled, true);
	assert.equal(parse(["--browser-remote-debugging-URL", "http://localhost:9222"]).browserServer, "http://localhost:9222");
	assert.equal(parse(["--browser-server", "http://localhost:9222"]).browserServer, "http://localhost:9222");
	assert.equal("browserRemoteDebuggingUrl" in parse(["--browser-remote-debugging-url", "http://localhost:9222"]), false);
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

// filenameReplacedCharacters and filenameReplacementCharacters are read positionally by
// getValidFilename, which since core 1.6.2 takes any falsy replacement as "use the fallback
// character". The parser therefore keeps the order it was given and writes "" where a replacement is
// missing. It used to move those entries to the end instead, because an older core read a missing
// index as undefined and wrote that word into the filename.
test("a replacement-less entry keeps its place among the pairs", () => {
	const options = parse(["--filename-replaced-character", "? ？", "--filename-replaced-character", "*", "--filename-replaced-character", ": ："]);
	assert.deepEqual(options.filenameReplacedCharacters, ["?", "*", ":"]);
	assert.deepEqual(options.filenameReplacementCharacters, ["？", "", "："]);
});

test("an entry with an empty replacement takes the fallback character", () => {
	const options = parse(["--filename-replaced-character", "* ", "--filename-replaced-character", ": ："]);
	assert.deepEqual(options.filenameReplacedCharacters, ["*", ":"]);
	assert.deepEqual(options.filenameReplacementCharacters, ["", "："]);
});

// the value is split on the FIRST space, not on every space, so everything after it is the
// replacement. Splitting on every space and keeping the first two tokens used to drop the rest.
test("a replacement can contain a space", () => {
	const options = parse(["--filename-replaced-character", "> _G T_"]);
	assert.deepEqual(options.filenameReplacedCharacters, [">"]);
	assert.deepEqual(options.filenameReplacementCharacters, ["_G T_"]);
});

// a value starting with a space leaves nothing on the left, and the core turns that into the
// character class [], which matches nothing — so the option used to do nothing at all, without a
// word. There is no reading under which an empty replaced character means something.
test("a value starting with a space is reported rather than silently matching nothing", () => {
	assert.deepEqual(parseArgs(["--filename-replaced-character", " _"]).invalidOptions, [{ name: "filename-replaced-character", value: " _" }]);
	assert.deepEqual(parse(["--filename-replaced-character", " _"]).filenameReplacedCharacters, []);
});

// the space-separated form cannot express a space as the replaced character, because the separator
// has to be found before either side is parsed. A JSON array says both sides outright.
test("a json array expresses what the space-separated form cannot", () => {
	const options = parse(["--filename-replaced-character", "[\" \", \"_\"]"]);
	assert.deepEqual(options.filenameReplacedCharacters, [" "]);
	assert.deepEqual(options.filenameReplacementCharacters, ["_"]);
	const withoutReplacement = parse(["--filename-replaced-character", "[\" \"]"]);
	assert.deepEqual(withoutReplacement.filenameReplacedCharacters, [" "]);
	assert.deepEqual(withoutReplacement.filenameReplacementCharacters, [""]);
});

// the default table is derived from the core one rather than written out again, and the two hold the
// control characters differently: core holds them as themselves, while the option prints them in the
// help text and reads them back, so it escapes them. Comparing the strings fails; what has to match
// is the characters their classes SELECT.
test("the default replaced characters select the same characters as the core table", () => {
	const options = parse([]);
	assert.equal(options.filenameReplacedCharacters.length, DEFAULT_REPLACED_CHARACTERS.length);
	options.filenameReplacedCharacters.forEach((characters, indexCharacter) => {
		assert.deepEqual(selectedCharacterCodes(characters), selectedCharacterCodes(DEFAULT_REPLACED_CHARACTERS[indexCharacter]), JSON.stringify(characters));
	});
	assert.deepEqual(options.filenameReplacementCharacters, DEFAULT_REPLACEMENT_CHARACTERS.concat(["", ""]));
	assert.equal(options.filenameReplacementCharacter, DEFAULT_REPLACEMENT_CHARACTER);
});

test("the default replaced characters carry no raw control character", () => {
	parse([]).filenameReplacedCharacters.forEach(characters => {
		Array.from(characters).forEach(character => {
			const characterCode = character.charCodeAt(0);
			assert.ok(characterCode >= 0x20 && characterCode != 0x7f, JSON.stringify(characters));
		});
	});
});

function selectedCharacterCodes(characters) {
	const regExp = new RegExp("[" + characters + "]");
	const characterCodes = [];
	for (let characterCode = 0; characterCode < 0x10000; characterCode++) {
		if (regExp.test(String.fromCharCode(characterCode))) {
			characterCodes.push(characterCode);
		}
	}
	return characterCodes;
}

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

// the command line is the single source of the defaults: the api derives its table from
// getDefaultOptions() and layers a named overlay on top. this asserts the overlay is exactly
// the two options the command line has no defaultValue for, so a third cannot be added by
// accident and the two tables cannot drift apart the way they did between 2024 and 2026.
test("the api defaults are the command line defaults plus a named overlay", () => {
	const commandLineDefaults = getDefaultOptions();
	assert.ok(Object.keys(commandLineDefaults).length > 40, "expected the command line to default many options");
	const differing = Object.keys(DEFAULT_OPTIONS).filter(name =>
		!(name in commandLineDefaults) ||
		JSON.stringify(DEFAULT_OPTIONS[name]) !== JSON.stringify(commandLineDefaults[name]));
	assert.deepEqual(differing, Object.keys(API_ONLY_DEFAULTS));
	assert.deepEqual(Object.keys(API_ONLY_DEFAULTS), ["backgroundSave", "saveFavicon"]);
});

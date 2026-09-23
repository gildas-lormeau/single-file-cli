import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutablePaths, findExecutablePath } from "../../lib/browser.js";
import { CHROMIUM_PATHS, FIREFOX_PATHS } from "../../lib/constants.js";

const LOCAL_APP_DATA = "C:\\Users\\user\\AppData\\Local";

function variables(values) {
	return { get: name => values[name] };
}

// The per-user locations below are where winget --scope user put each browser on a GitHub
// Windows runner (gildas-lormeau/tmp, run 35894558500). None of them was found before.
test("per-user Windows installs are searched after the machine-wide ones", () => {
	const paths = getExecutablePaths(CHROMIUM_PATHS, "windows", variables({ LOCALAPPDATA: LOCAL_APP_DATA }));
	for (const expected of [
		LOCAL_APP_DATA + "\\Google\\Chrome SxS\\Application\\chrome.exe",
		LOCAL_APP_DATA + "\\Google\\Chrome\\Application\\chrome.exe",
		LOCAL_APP_DATA + "\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
		LOCAL_APP_DATA + "\\Vivaldi\\Application\\vivaldi.exe",
		LOCAL_APP_DATA + "\\Yandex\\YandexBrowser\\Application\\browser.exe",
		LOCAL_APP_DATA + "\\Programs\\Opera\\opera.exe"
	]) {
		assert.ok(paths.includes(expected), expected);
	}
	assert.equal(paths[0], CHROMIUM_PATHS.windows[0]);
	const firstUserPath = paths.findIndex(path => path.startsWith(LOCAL_APP_DATA));
	assert.ok(paths.slice(firstUserPath).every(path => path.startsWith(LOCAL_APP_DATA)));
	assert.equal(paths.length, new Set(paths).size);
});

test("a Windows path relative to %LOCALAPPDATA% is dropped when the variable is not set", () => {
	const paths = getExecutablePaths(CHROMIUM_PATHS, "windows", variables({}));
	assert.ok(paths.every(path => !path.includes("%LOCALAPPDATA%")));
	assert.deepEqual(paths, CHROMIUM_PATHS.windows.filter(path => path.startsWith("C:\\")));
});

test("a per-user Firefox on Windows is searched", () => {
	const paths = getExecutablePaths(FIREFOX_PATHS, "windows", variables({ LOCALAPPDATA: LOCAL_APP_DATA + "\\" }));
	assert.ok(paths.includes(LOCAL_APP_DATA + "\\Mozilla Firefox\\firefox.exe"));
});

test("apps in ~/Applications are searched on macOS", () => {
	const paths = getExecutablePaths(FIREFOX_PATHS, "darwin", variables({ HOME: "/Users/user" }));
	assert.deepEqual(paths.slice(0, FIREFOX_PATHS.darwin.length), FIREFOX_PATHS.darwin);
	assert.ok(paths.includes("/Users/user/Applications/Firefox.app/Contents/MacOS/firefox"));
	assert.ok(getExecutablePaths(CHROMIUM_PATHS, "darwin", variables({ HOME: "/Users/user" }))
		.includes("/Users/user/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
});

test("snap Chromium and browsers on the PATH are searched on Linux", () => {
	const paths = getExecutablePaths(CHROMIUM_PATHS, "linux", variables({ PATH: "/home/user/.local/bin:relative/bin:/usr/bin/" }));
	assert.ok(paths.includes("/snap/bin/chromium"));
	assert.ok(paths.includes("/home/user/.local/bin/google-chrome"));
	assert.ok(paths.every(path => !path.startsWith("relative")));
	assert.equal(paths.length, new Set(paths).size);
	const listedPaths = Array.from(new Set(CHROMIUM_PATHS.linux));
	assert.deepEqual(paths.slice(0, listedPaths.length), listedPaths);
});

test("the first existing path is returned", async () => {
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const first = join(directory, "first");
		const second = join(directory, "second");
		await writeFile(first, "");
		await writeFile(second, "");
		assert.equal(await findExecutablePath([join(directory, "missing"), second, first]), second);
		assert.equal(await findExecutablePath([join(directory, "missing")]), undefined);
	} finally {
		await rm(directory, { recursive: true });
	}
});

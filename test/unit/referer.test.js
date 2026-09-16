import { test } from "node:test";
import assert from "node:assert/strict";
import { getReferer } from "../../lib/cdp-client-util.js";

// the fetches made outside the browser must present the referrer the browser would have computed
// from the referrer policy of the document, i.e. strict-origin-when-cross-origin, otherwise servers
// protecting their resources against hotlinking refuse to serve them. www.apple.com/wss/fonts
// answers an empty 404 without it, which is how a saved page loses all its fonts

test("a same-origin resource gets the full URL of the document", () => {
	assert.equal(getReferer("https://example.com/assets/font.woff2", "https://example.com/blog/page.html"),
		"https://example.com/blog/page.html");
});

test("a cross-origin resource gets the origin of the document", () => {
	assert.equal(getReferer("https://cdn.example.com/font.woff2", "https://example.com/blog/page.html"),
		"https://example.com/");
});

test("a cross-origin resource gets the origin with a trailing slash", () => {
	assert.equal(getReferer("https://www.apple.com/wss/fonts?families=SF+Pro", "https://security.apple.com/blog/apple-reference-image/"),
		"https://security.apple.com/");
});

test("the fragment and the credentials of the document are stripped", () => {
	assert.equal(getReferer("https://example.com/font.woff2", "https://user:password@example.com/page.html#section"),
		"https://example.com/page.html");
});

test("a downgrade from https to http gets no referer", () => {
	assert.equal(getReferer("http://example.org/font.woff2", "https://example.com/page.html"), "");
});

test("an upgrade from http to https gets the origin", () => {
	assert.equal(getReferer("https://example.org/font.woff2", "http://example.com/page.html"), "http://example.com/");
});

test("a document that is not served over http gets no referer", () => {
	assert.equal(getReferer("https://example.com/font.woff2", "file:///tmp/page.html"), "");
});

test("a resource that is not fetched over http gets no referer", () => {
	assert.equal(getReferer("data:font/woff2;base64,AAAA", "https://example.com/page.html"), "");
	assert.equal(getReferer("file:///tmp/font.woff2", "https://example.com/page.html"), "");
});

test("an invalid document URL gets no referer", () => {
	assert.equal(getReferer("https://example.com/font.woff2", ""), "");
	assert.equal(getReferer("https://example.com/font.woff2", undefined), "");
});

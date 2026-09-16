import { test } from "node:test";
import assert from "node:assert/strict";
import { getReferer, getReferrerPolicy, getDocumentReferrerPolicy, getDocumentHeaderReferrerPolicy } from "../../lib/cdp-client-util.js";

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

// a document can ask for less than the default with a "Referrer-Policy" header or a
// <meta name="referrer">, and sending it anyway would disclose an origin the browser withheld. It
// can also ask for more, which is what makes a resource load in the browser and fail without this
const PAGE_URL = "https://example.com/blog/page.html";
const SAME_ORIGIN_URL = "https://example.com/assets/font.woff2";
const CROSS_ORIGIN_URL = "https://cdn.example.org/font.woff2";
const DOWNGRADED_URL = "http://cdn.example.org/font.woff2";

test("no-referrer sends nothing at all", () => {
	assert.equal(getReferer(SAME_ORIGIN_URL, PAGE_URL, "no-referrer"), "");
	assert.equal(getReferer(CROSS_ORIGIN_URL, PAGE_URL, "no-referrer"), "");
});

test("same-origin sends nothing cross-origin", () => {
	assert.equal(getReferer(SAME_ORIGIN_URL, PAGE_URL, "same-origin"), PAGE_URL);
	assert.equal(getReferer(CROSS_ORIGIN_URL, PAGE_URL, "same-origin"), "");
});

test("origin sends the origin, downgrade included", () => {
	assert.equal(getReferer(SAME_ORIGIN_URL, PAGE_URL, "origin"), "https://example.com/");
	assert.equal(getReferer(CROSS_ORIGIN_URL, PAGE_URL, "origin"), "https://example.com/");
	assert.equal(getReferer(DOWNGRADED_URL, PAGE_URL, "origin"), "https://example.com/");
});

test("strict-origin sends the origin but not on a downgrade", () => {
	assert.equal(getReferer(CROSS_ORIGIN_URL, PAGE_URL, "strict-origin"), "https://example.com/");
	assert.equal(getReferer(DOWNGRADED_URL, PAGE_URL, "strict-origin"), "");
});

test("origin-when-cross-origin keeps the full URL same-origin, downgrade included", () => {
	assert.equal(getReferer(SAME_ORIGIN_URL, PAGE_URL, "origin-when-cross-origin"), PAGE_URL);
	assert.equal(getReferer(CROSS_ORIGIN_URL, PAGE_URL, "origin-when-cross-origin"), "https://example.com/");
	assert.equal(getReferer(DOWNGRADED_URL, PAGE_URL, "origin-when-cross-origin"), "https://example.com/");
});

test("no-referrer-when-downgrade sends the full URL cross-origin", () => {
	assert.equal(getReferer(CROSS_ORIGIN_URL, PAGE_URL, "no-referrer-when-downgrade"), PAGE_URL);
	assert.equal(getReferer(DOWNGRADED_URL, PAGE_URL, "no-referrer-when-downgrade"), "");
});

test("unsafe-url sends the full URL everywhere", () => {
	assert.equal(getReferer(CROSS_ORIGIN_URL, PAGE_URL, "unsafe-url"), PAGE_URL);
	assert.equal(getReferer(DOWNGRADED_URL, PAGE_URL, "unsafe-url"), PAGE_URL);
});

test("strict-origin-when-cross-origin is what an unknown or missing policy falls back to", () => {
	assert.equal(getReferrerPolicy(""), "strict-origin-when-cross-origin");
	assert.equal(getReferrerPolicy(undefined), "strict-origin-when-cross-origin");
	assert.equal(getReferrerPolicy("teapot"), "strict-origin-when-cross-origin");
	assert.equal(getReferer(CROSS_ORIGIN_URL, PAGE_URL, "teapot"), "https://example.com/");
});

test("a policy is matched after trimming and lowercasing", () => {
	assert.equal(getReferrerPolicy("  NO-Referrer "), "no-referrer");
});

// the header takes a list and the last value that is understood wins, which is also how several
// <meta name="referrer"> elements behave, the last one parsed setting the policy
test("the last understood value of a list wins", () => {
	assert.equal(getReferrerPolicy("no-referrer,unsafe-url"), "unsafe-url");
	assert.equal(getReferrerPolicy("unsafe-url,no-referrer"), "no-referrer");
	assert.equal(getReferrerPolicy("unsafe-url,teapot"), "unsafe-url");
	assert.equal(getReferrerPolicy("teapot,no-referrer,another-teapot"), "no-referrer");
});

test("the referrer-policy header is read whatever its case", () => {
	assert.equal(getDocumentHeaderReferrerPolicy([{ name: "Referrer-Policy", value: "no-referrer" }]), "no-referrer");
	assert.equal(getDocumentHeaderReferrerPolicy([{ name: "content-type", value: "text/html" }]), "");
	assert.equal(getDocumentHeaderReferrerPolicy([]), "");
	assert.equal(getDocumentHeaderReferrerPolicy(undefined), "");
});

test("repeated referrer-policy headers are kept in order", () => {
	assert.equal(getDocumentHeaderReferrerPolicy([
		{ name: "referrer-policy", value: "no-referrer" },
		{ name: "referrer-policy", value: "unsafe-url" }
	]), "no-referrer,unsafe-url");
});

// the header belongs to the document it was served with, so a resource fetched from a cross-origin
// frame must not inherit the policy of the top page, and the meta is read from the frame itself
test("the header applies to the document it was served with", () => {
	const documentInfo = { url: PAGE_URL, referrerPolicy: "no-referrer" };
	assert.equal(getDocumentReferrerPolicy(PAGE_URL, documentInfo, ""), "no-referrer");
	assert.equal(getDocumentReferrerPolicy(PAGE_URL + "#section", documentInfo, ""), "no-referrer");
	assert.equal(getDocumentReferrerPolicy("https://frame.example.org/frame.html", documentInfo, ""), "");
});

test("the meta is appended after the header, so it wins", () => {
	const documentInfo = { url: PAGE_URL, referrerPolicy: "no-referrer" };
	assert.equal(getDocumentReferrerPolicy(PAGE_URL, documentInfo, "unsafe-url"), "no-referrer,unsafe-url");
	assert.equal(getReferrerPolicy(getDocumentReferrerPolicy(PAGE_URL, documentInfo, "unsafe-url")), "unsafe-url");
	assert.equal(getDocumentReferrerPolicy("https://frame.example.org/frame.html", documentInfo, "no-referrer"), "no-referrer");
});

test("a document with no captured information falls back to the meta alone", () => {
	assert.equal(getDocumentReferrerPolicy(PAGE_URL, {}, "same-origin"), "same-origin");
	assert.equal(getDocumentReferrerPolicy(PAGE_URL, undefined, "same-origin"), "same-origin");
	assert.equal(getDocumentReferrerPolicy(PAGE_URL, {}, ""), "");
});

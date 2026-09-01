/* global URL */

// The options under "save deferred images" all work by lying to the page: the screen is reported as
// tall as the document, every IntersectionObserver is told its targets are visible, and a resize —
// optionally a scroll — is dispatched so the page reacts. Each lie is useful and each one is also a
// way to capture something the reader never saw, so every fixture here isolates one mechanism and
// asserts both directions: what the option must load, and what it must not invent.
//
// The pages are served rather than opened as file:// so the capture takes the path a real save
// takes, and they are deliberately trivial: a fixture that needs a real site to reproduce is a
// fixture that will start failing for reasons that have nothing to do with SingleFile.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { cliDirectory } from "../target.js";

const execFileAsync = promisify(execFile);

const TIMEOUT = 180000;
const VIEWPORT = ["--browser-width", "1280", "--browser-height", "900"];
// a 1x1 gif, small enough to read as a marker in the saved page
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
const BELOW_THE_FOLD = "min-height:3000px";
// what a lazy-loading library does, reduced to its essentials
const LAZY_IMAGE_SCRIPT = `new IntersectionObserver(entries => entries.forEach(entry => {
	if (entry.isIntersecting) { entry.target.src = entry.target.dataset.src; }
})).observe(document.querySelector("#below"));`;

const PAGES = {
	// the classic lazy image: the URL lives in a data attribute, so it is not in the markup and
	// cannot be inlined unless the page itself decides the image became visible
	"/native-lazy.html": `<html><head><title>native lazy</title></head><body>
		<div style="${BELOW_THE_FOLD}">filler</div>
		<img id="below" data-src="/deferred.gif" width="10" height="10">
		<script>${LAZY_IMAGE_SCRIPT}</script>
	</body></html>`,

	// the shape every modern infinite-scroll library has: a sentinel at the end of the document,
	// watched by an IntersectionObserver. Nothing here reacts to scroll events at all.
	"/observer-append.html": `<html><head><title>Article One</title></head><body>
		<article style="${BELOW_THE_FOLD}">Article One</article>
		<div id="sentinel" style="height:1px"></div>
		<script>
			new IntersectionObserver(entries => {
				if (entries.some(entry => entry.isIntersecting)) {
					document.body.insertAdjacentHTML("beforeend", "<article>ARTICLE TWO</article>");
					document.title = "Article Two";
				}
			}).observe(document.querySelector("#sentinel"));
		</script>
	</body></html>`,

	// content revealed by a scroll listener, which is what the "dispatch scroll event" option exists
	// for: no scroll event, no reveal, whatever the emulated screen size says
	"/scroll-reveal.html": `<html><head><title>scroll reveal</title>
		<style>#hidden{opacity:0}#hidden.revealed{opacity:1}</style></head><body>
		<div style="${BELOW_THE_FOLD}">filler</div>
		<p id="hidden">REVEALED CONTENT</p>
		<script>addEventListener("scroll", () => document.querySelector("#hidden").classList.add("revealed"));</script>
	</body></html>`,

	// a stylesheet the page only injects once it believes the reader arrived, and not immediately:
	// the pass has to still be open when it lands, which is what the idle time buys
	"/late-stylesheet.html": `<html><head><title>late stylesheet</title></head><body>
		<div style="${BELOW_THE_FOLD}">filler</div>
		<p id="styled">styled by a stylesheet that arrives late</p>
		<script>
			addEventListener("scroll", () => setTimeout(() => {
				const link = document.createElement("link");
				link.rel = "stylesheet";
				link.href = "/late.css";
				document.head.appendChild(link);
			}, 1200), { once: true });
		</script>
	</body></html>`,

	// the #1603 shape: a "full screen" block whose height is written as an inline style from
	// innerHeight on every resize. The pass resizes twice, so the value in the saved page must be
	// the real viewport, never the emulated one.
	"/viewport-height.html": `<html><head><title>viewport height</title></head><body>
		<div id="cover">cover</div>
		<div style="${BELOW_THE_FOLD}">filler</div>
		<script>
			function size() { document.querySelector("#cover").style.height = innerHeight + "px"; }
			addEventListener("resize", size);
			size();
		</script>
	</body></html>`,

	// content in a nested scroller, which the emulation does not reach: the document itself does not
	// scroll, so every faked getter is set to the value it already had
	"/nested-scroller.html": `<html><head><title>nested scroller</title></head><body style="margin:0">
		<div id="scroller" style="height:400px;overflow-y:auto">
			<div style="${BELOW_THE_FOLD}">filler</div>
			<img id="below" data-src="/deferred.gif" width="10" height="10">
		</div>
		<script>${LAZY_IMAGE_SCRIPT}</script>
	</body></html>`
};

test("a lazy image below the fold is loaded only when the option is on", { timeout: TIMEOUT }, async () => {
	await withFixture(async capture => {
		const off = await capture("/native-lazy.html", ["--load-deferred-images", "false"]);
		const on = await capture("/native-lazy.html");
		assert.ok(!off.includes(PIXEL), "the deferred image was inlined with the option off");
		assert.ok(on.includes(PIXEL), "the deferred image was not inlined with the option on");
	});
});

test("an IntersectionObserver sentinel does not make the page append the next article", { timeout: TIMEOUT }, async () => {
	await withFixture(async capture => {
		// the pass reports every observed target as intersecting, so a sentinel at the end of the
		// document is exactly the case where that lie captures a page the reader never opened
		const content = await capture("/observer-append.html");
		assert.ok(!content.includes("ARTICLE TWO"), "an article appended by the sentinel was saved");
		assert.match(content, /<title>Article One<\/title>/, "the saved page carries the appended article's title");
	});
});

test("content revealed by a scroll listener needs the dispatch-scroll-event option", { timeout: TIMEOUT }, async () => {
	await withFixture(async capture => {
		const off = await capture("/scroll-reveal.html");
		const on = await capture("/scroll-reveal.html", ["--load-deferred-images-dispatch-scroll-event", "true"]);
		assert.ok(!off.includes("class=revealed"), "the page was revealed without the option");
		assert.ok(on.includes("class=revealed"), "the page was not revealed with the option");
	});
});

test("a stylesheet injected late is captured, and is lost when the idle time is too short", { timeout: TIMEOUT }, async () => {
	await withFixture(async capture => {
		const scrollEvent = ["--load-deferred-images-dispatch-scroll-event", "true"];
		const patient = await capture("/late-stylesheet.html", scrollEvent);
		const impatient = await capture("/late-stylesheet.html", scrollEvent.concat(["--load-deferred-images-max-idle-time", "100"]));
		assert.ok(patient.includes("LATE_RULE"), "the late stylesheet was not captured with the default idle time");
		assert.ok(!impatient.includes("LATE_RULE"), "the late stylesheet was captured despite a 100ms idle time");
	});
});

test("a block sized from innerHeight keeps the real viewport height in the saved page", { timeout: TIMEOUT }, async () => {
	await withFixture(async capture => {
		const content = await capture("/viewport-height.html");
		const height = Number((content.match(/id=cover style="?height:(\d+)px/) || [])[1]);
		assert.ok(height, "the cover carries no inline height");
		// the emulated screen is the whole document, so a leaked value is thousands of pixels
		assert.ok(height < 1000, "the cover kept the emulated screen height: " + height + "px");
	});
});

test("the zoom-out leaves no transform behind in the saved page", { timeout: TIMEOUT }, async () => {
	await withFixture(async capture => {
		for (const options of [[], ["--load-deferred-images-keep-zoom-level", "true"]]) {
			const content = await capture("/native-lazy.html", options);
			assert.ok(!/scale3d/.test(content), "a zoom-out transform was left in the saved page");
			assert.ok(!/-sf-transform/.test(content), "an internal transform property was left in the saved page");
		}
	});
});

test("a lazy image inside a nested scroller is loaded", { timeout: TIMEOUT, todo: "the emulation only measures document.scrollingElement, so a page that scrolls in a nested container is never enlarged" }, async () => {
	await withFixture(async capture => {
		const content = await capture("/nested-scroller.html");
		assert.ok(content.includes(PIXEL), "the deferred image inside the scroller was not inlined");
	});
});

async function withFixture(run) {
	const requestedPaths = [];
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, "http://localhost");
		requestedPaths.push(pathname);
		if (pathname === "/deferred.gif") {
			response.writeHead(200, { "content-type": "image/gif" })
				.end(Buffer.from(PIXEL.slice(PIXEL.indexOf(",") + 1), "base64"));
		} else if (pathname === "/late.css") {
			response.writeHead(200, { "content-type": "text/css" }).end("#styled { color: rgb(1,2,3); --marker: LATE_RULE; }");
		} else if (PAGES[pathname]) {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGES[pathname]);
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-lazy-"));
	let saved = 0;
	try {
		await run(async (path, options = []) => {
			const outputPath = join(directory, "out-" + (saved++) + ".html");
			const url = "http://localhost:" + server.address().port + path;
			await execFileAsync(process.execPath, ["single-file-node.js", url, outputPath].concat(VIEWPORT, options), { cwd: cliDirectory });
			return readFile(outputPath, "utf8");
		});
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
}

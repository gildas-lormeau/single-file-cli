/* global setTimeout, clearTimeout, fetch, createImageBitmap, OffscreenCanvas */

// One browser, driven over CDP, doing two jobs: rendering a page to a PNG, and comparing two of
// those PNGs. The comparison runs *in* the browser on purpose — Node has no image decoder, and
// adding one as a dependency to compare pictures taken by a browser that already decodes PNG
// natively would be paying twice for the same capability.
//
// The rules encoded here were all learned by getting them wrong:
//
//   - a comparison without a noise floor says nothing. Pages that reflow between two shots of the
//     SAME file are common, so every comparison is made against a control taken from the same
//     source, and the floor is a measured output of the run rather than an assumption.
//   - a whole-image verdict is not usable. One line of reflow near the top shifts every pixel
//     below it, so a single number cannot tell a small local difference from a large one. The
//     images are compared in horizontal bands, and the bands are reported separately.
//   - images of different heights are not an error to be normalised away. A saved page that is
//     shorter than its source has lost something; the extra rows count as differing pixels.
import { options as cdpOptions, CDP } from "simple-cdp";
import { importLibModule } from "../target.js";

const LOCALHOST = "http://localhost:";
const EMPTY_PAGE_URL = "about:blank";
const BAND_HEIGHT = 1000;
const VIEWPORT_WIDTH = 1200;
const VIEWPORT_HEIGHT = 900;
const LOAD_TIMEOUT = 60000;
const COMMAND_TIMEOUT = 60000;
const SETTLE_TIMEOUT = 10000;
// Waiting for the fonts and for two frames is waiting on the page, and a page is allowed not to
// answer: a self-extracting archive replaces the document as it opens, and a font that never
// resolves leaves document.fonts.ready pending for good. The race means this expression always
// settles, so the only thing that can hang is the connection, which has its own limit below.
const SETTLE_EXPRESSION = `Promise.race([
	(async () => {
		if (document.fonts) {
			await document.fonts.ready;
		}
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	})(),
	new Promise(resolve => setTimeout(resolve, ${SETTLE_TIMEOUT}))
])`;

export { openBrowser, BAND_HEIGHT };

async function openBrowser({ headless = true } = {}) {
	const { launchChromium, closeChromium } = await importLibModule("chromium.js");
	cdpOptions.apiUrl = LOCALHOST + (await launchChromium({ headless }));
	// A command with no limit waits for its answer for ever, and that is the default. One that never
	// came back took a whole CI run with it: the suite reported nothing but its own test timeout,
	// the connection stayed wedged, and every check after it in the file was never reached. With a
	// limit the failure names the method that did not answer, which is the difference between a
	// diagnosis and a rerun.
	cdpOptions.commandMaxTime = COMMAND_TIMEOUT;
	const comparisonTarget = await createSession();
	return { capture, compare, close };

	async function capture(url, { width = VIEWPORT_WIDTH, height = VIEWPORT_HEIGHT } = {}) {
		const { cdp, targetId } = await createSession();
		const { Page, Emulation, Runtime } = cdp;
		try {
			await Page.enable();
			await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false });
			await Promise.all([waitUntilLoaded(Page), Page.navigate({ url })]);
			await Runtime.evaluate({ expression: SETTLE_EXPRESSION, awaitPromise: true });
			const { data } = await Page.captureScreenshot({ format: "png", captureBeyondViewport: true });
			return data;
		} finally {
			await CDP.closeTarget(targetId);
		}
	}

	// the two screenshots and the band height go in, the count of pixels that differ comes out —
	// per band, so that a caller can say where the pages parted company and not only that they did
	async function compare(firstImage, secondImage, bandHeight = BAND_HEIGHT) {
		const expression = "(" + compareInBrowser.toString() + ")(" +
			JSON.stringify(firstImage) + "," + JSON.stringify(secondImage) + "," + bandHeight + ")";
		const { result, exceptionDetails } = await comparisonTarget.cdp.Runtime.evaluate({
			expression,
			awaitPromise: true,
			returnByValue: true
		});
		if (exceptionDetails) {
			throw new Error("the comparison failed in the browser: " + exceptionDetails.text);
		}
		return result.value;
	}

	async function close() {
		await CDP.closeTarget(comparisonTarget.targetId).catch(() => { });
		await closeChromium();
	}
}

async function createSession(url = EMPTY_PAGE_URL) {
	const targetInfo = await CDP.createTarget(url);
	return { cdp: new CDP(targetInfo), targetId: targetInfo.id };
}

function waitUntilLoaded(Page) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			Page.removeEventListener("loadEventFired", onLoad);
			reject(new Error("the page did not finish loading"));
		}, LOAD_TIMEOUT);
		Page.addEventListener("loadEventFired", onLoad);

		function onLoad() {
			clearTimeout(timeout);
			Page.removeEventListener("loadEventFired", onLoad);
			resolve();
		}
	});
}

// serialised into the browser, so it stands alone: no imports, no closure over anything here
function compareInBrowser(firstImage, secondImage, bandHeight) {
	return (async () => {
		const [first, second] = await Promise.all([decode(firstImage), decode(secondImage)]);
		const width = Math.max(first.width, second.width);
		const height = Math.max(first.height, second.height);
		const [firstPixels, secondPixels] = [draw(first), draw(second)];
		const bands = [];
		let differing = 0;
		for (let top = 0; top < height; top += bandHeight) {
			const bottom = Math.min(top + bandHeight, height);
			let bandDiffering = 0;
			for (let offset = top * width * 4; offset < bottom * width * 4; offset += 4) {
				if (firstPixels[offset] != secondPixels[offset] ||
					firstPixels[offset + 1] != secondPixels[offset + 1] ||
					firstPixels[offset + 2] != secondPixels[offset + 2] ||
					firstPixels[offset + 3] != secondPixels[offset + 3]) {
					bandDiffering++;
				}
			}
			differing += bandDiffering;
			bands.push({ top, bottom, differing: bandDiffering, total: (bottom - top) * width });
		}
		return {
			width,
			height,
			differing,
			total: width * height,
			sizeMatches: first.width == second.width && first.height == second.height,
			bands
		};

		async function decode(data) {
			const response = await fetch("data:image/png;base64," + data);
			return createImageBitmap(await response.blob());
		}

		// both images are drawn on a canvas of the union size, so an image that is shorter than the
		// other leaves transparent rows where the other has content, and those rows count as
		// differing rather than being quietly cropped away
		function draw(image) {
			const canvas = new OffscreenCanvas(width, height);
			const context = canvas.getContext("2d", { willReadFrequently: true });
			context.drawImage(image, 0, 0);
			return context.getImageData(0, 0, width, height).data;
		}
	})();
}

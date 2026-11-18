// The regions of a long screenshot are joined without decoding them to pixels (issue #213): the
// rows of the images are written one after the other in one stream. A row may be encoded from the
// row above it, and the first row of an image had none, so it is the one row that is rewritten. The
// five filter types are tried on that row, with rows of every type after it, and the result is read
// back with the decoder of the tests, which shares no code with the module.

import { test } from "node:test";
import assert from "node:assert/strict";
import { joinImages } from "../../lib/png.js";
import { decodeImage, encodeImage } from "../png.js";

const FILTER_TYPES = [0, 1, 2, 3, 4];
const FILTER_NAMES = ["none", "sub", "up", "average", "Paeth"];
const WIDTH = 7;
const HEIGHT = 6;

for (const channels of [3, 4]) {
	for (const firstRowFilter of FILTER_TYPES) {
		test(`images with ${channels} channels are joined when the first row uses the filter "${FILTER_NAMES[firstRowFilter]}"`, async () => {
			const images = [1, 2, 3].map(seed => getTestImage(channels, seed, firstRowFilter));
			const joinedImage = decodeImage(await joinImages(images.map(encodeImage)));
			assert.equal(joinedImage.width, WIDTH);
			assert.equal(joinedImage.height, HEIGHT * images.length);
			assert.deepEqual(joinedImage.pixels, concatArrays(images.map(image => image.pixels)));
			// the first image is not touched, the first row of the others is the only one rewritten
			assert.deepEqual(joinedImage.filters, images.flatMap((image, indexImage) =>
				indexImage ? [0, ...image.filters.slice(1)] : image.filters));
		});
	}
}

test("a single image is returned with the same pixels", async () => {
	const image = getTestImage(4, 1, 4);
	assert.deepEqual(decodeImage(await joinImages([encodeImage(image)])).pixels, image.pixels);
});

test("images of different widths or pixel formats are refused", async () => {
	const image = encodeImage(getTestImage(4, 1, 0));
	await assert.rejects(joinImages([image, encodeImage(getTestImage(3, 2, 0))]), /same width and pixel format/);
	await assert.rejects(joinImages([image, encodeImage({ ...getTestImage(4, 2, 0), width: WIDTH - 1, pixels: new Uint8Array((WIDTH - 1) * 4 * HEIGHT) })]), /same width and pixel format/);
});

test("data that is not a PNG image is refused", async () => {
	await assert.rejects(joinImages([new Uint8Array([1, 2, 3])]), /Invalid PNG file/);
	const image = encodeImage(getTestImage(4, 1, 0));
	await assert.rejects(joinImages([image.subarray(0, image.length - 20)]), /Invalid PNG file/);
});

// pixels that differ from one row, one column and one image to the next, so that a row decoded from
// the wrong neighbour cannot give the right values
function getTestImage(channels, seed, firstRowFilter) {
	const pixels = new Uint8Array(WIDTH * channels * HEIGHT);
	let value = seed * 7919;
	for (let index = 0; index < pixels.length; index++) {
		value = (value * 1103515245 + 12345) & 0x7fffffff;
		pixels[index] = value >> 16;
	}
	const filters = [firstRowFilter, ...FILTER_TYPES];
	return { width: WIDTH, height: HEIGHT, channels, pixels, filters };
}

function concatArrays(arrays) {
	const result = new Uint8Array(arrays.reduce((length, array) => length + array.length, 0));
	let offset = 0;
	arrays.forEach(array => {
		result.set(array, offset);
		offset += array.length;
	});
	return result;
}

/*
 * Copyright 2010-2026 Gildas Lormeau
 * contact : gildas.lormeau <at> gmail.com
 *
 * This file is part of SingleFile.
 *
 *   The code in this file is free software: you can redistribute it and/or
 *   modify it under the terms of the GNU Affero General Public License
 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
 *   of the License, or (at your option) any later version.
 *
 *   The code in this file is distributed in the hope that it will be useful,
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
 *   General Public License for more details.
 *
 *   As additional permission under GNU AGPL version 3 section 7, you may
 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU
 *   AGPL normally required by section 4, provided you include this license
 *   notice and a URL through which recipients can access the Corresponding
 *   Source.
 */

/* global CompressionStream, DecompressionStream, TextEncoder */

// Chromium returns a screenshot of the right size whose content starts again from the top of the
// page past 16,384 px of height (issue #213). A region of the page is rendered correctly wherever
// it is, as long as it is not taller than that, so a long page is captured in regions and they are
// joined here.
//
// The regions are not decoded to pixels. The image data of a PNG file is one compressed stream of
// rows, each row starting with the type of the filter it was encoded with. Rows of several images
// of the same width can follow each other in one stream, with one exception: a filter may refer to
// the row above, and the first row of an image was encoded with nothing above it. That row is
// decoded and written back with no filter. The rows are streamed from one image to the next, the
// uncompressed image (174 MB for a page of 34,000 px) is never held in memory.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HEADER_CHUNK_TYPE = "IHDR";
const DATA_CHUNK_TYPE = "IDAT";
const END_CHUNK_TYPE = "IEND";
const HEADER_LENGTH = 13;
const CHUNK_LENGTH_SIZE = 4;
const CHUNK_TYPE_SIZE = 4;
const CHUNK_CRC_SIZE = 4;
const MAX_DATA_CHUNK_LENGTH = 1024 * 1024;
const COMPRESSION_FORMAT = "deflate";
const FILTER_NONE = 0;
const FILTER_SUB = 1;
const FILTER_UP = 2;
const FILTER_AVERAGE = 3;
const FILTER_PAETH = 4;
// the number of samples per pixel of each colour type
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const INVALID_FILE_ERROR_MESSAGE = "Invalid PNG file";
const UNSUPPORTED_FILE_ERROR_MESSAGE = "Unsupported PNG file";
const DIFFERENT_FORMAT_ERROR_MESSAGE = "The PNG files do not have the same width and pixel format";
const CRC_TABLE = getCRCTable();
const textEncoder = new TextEncoder();

export { joinImages };

// joins PNG images of the same width and pixel format, from top to bottom, into one PNG image
async function joinImages(images) {
	const parsedImages = images.map(parseImage);
	const [{ header, leadingChunks }] = parsedImages;
	if (parsedImages.some(({ header: { width, bitDepth, colorType } }) =>
		width != header.width || bitDepth != header.bitDepth || colorType != header.colorType)) {
		throw new Error(DIFFERENT_FORMAT_ERROR_MESSAGE);
	}
	const height = parsedImages.reduce((height, image) => height + image.header.height, 0);
	const compressionStream = new CompressionStream(COMPRESSION_FORMAT);
	// read while the rows are written, the stream stops accepting data when nothing reads it
	const compressedData = readStream(compressionStream.readable);
	const writer = compressionStream.writable.getWriter();
	for (const [indexImage, image] of parsedImages.entries()) {
		await writeRows(writer, image, indexImage > 0);
	}
	await writer.close();
	const data = await compressedData;
	const chunks = [new Uint8Array(SIGNATURE), getChunk(HEADER_CHUNK_TYPE, getHeaderData(header, height)), ...leadingChunks];
	for (let offset = 0; offset < data.length; offset += MAX_DATA_CHUNK_LENGTH) {
		chunks.push(getChunk(DATA_CHUNK_TYPE, data.subarray(offset, offset + MAX_DATA_CHUNK_LENGTH)));
	}
	chunks.push(getChunk(END_CHUNK_TYPE, new Uint8Array(0)));
	return concatArrays(chunks);
}

async function writeRows(writer, { header, dataChunks }, resetFirstRow) {
	const rowLength = getRowLength(header);
	const decompressionStream = new DecompressionStream(COMPRESSION_FORMAT);
	const decompressionWriter = decompressionStream.writable.getWriter();
	// not awaited: the data is only accepted as fast as the rows are read below
	const written = (async () => {
		for (const dataChunk of dataChunks) {
			await decompressionWriter.write(dataChunk);
		}
		await decompressionWriter.close();
	})();
	written.catch(() => { /* reported by the reader */ });
	const reader = decompressionStream.readable.getReader();
	let length = 0, firstRow = resetFirstRow ? new Uint8Array(0) : undefined;
	for (; ;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		length += value.length;
		if (firstRow) {
			// the first row may come in several pieces
			firstRow = concatArrays([firstRow, value]);
			if (firstRow.length >= rowLength) {
				removeFirstRowFilter(firstRow, rowLength, getPixelLength(header));
				await writer.write(firstRow);
				firstRow = undefined;
			}
		} else {
			await writer.write(value);
		}
	}
	await written;
	if (length != rowLength * header.height) {
		throw new Error(INVALID_FILE_ERROR_MESSAGE);
	}
}

// decodes a row that has no row above it, the missing row counts as zeros
function removeFirstRowFilter(data, rowLength, pixelLength) {
	const filter = data[0];
	if (filter == FILTER_SUB || filter == FILTER_PAETH) {
		// with zeros above, the Paeth predictor is the pixel on the left as well
		for (let index = 1 + pixelLength; index < rowLength; index++) {
			data[index] = (data[index] + data[index - pixelLength]) & 0xff;
		}
	} else if (filter == FILTER_AVERAGE) {
		for (let index = 1 + pixelLength; index < rowLength; index++) {
			data[index] = (data[index] + (data[index - pixelLength] >> 1)) & 0xff;
		}
	} else if (filter != FILTER_NONE && filter != FILTER_UP) {
		throw new Error(INVALID_FILE_ERROR_MESSAGE);
	}
	data[0] = FILTER_NONE;
}

function parseImage(image) {
	if (image.length < SIGNATURE.length || SIGNATURE.some((value, index) => image[index] != value)) {
		throw new Error(INVALID_FILE_ERROR_MESSAGE);
	}
	const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
	const leadingChunks = [], dataChunks = [];
	let header, ended;
	let offset = SIGNATURE.length;
	while (!ended && offset + CHUNK_LENGTH_SIZE + CHUNK_TYPE_SIZE <= image.length) {
		const length = view.getUint32(offset);
		const dataOffset = offset + CHUNK_LENGTH_SIZE + CHUNK_TYPE_SIZE;
		const type = String.fromCharCode(...image.subarray(offset + CHUNK_LENGTH_SIZE, dataOffset));
		const endOffset = dataOffset + length + CHUNK_CRC_SIZE;
		if (endOffset > image.length) {
			throw new Error(INVALID_FILE_ERROR_MESSAGE);
		}
		if (type == HEADER_CHUNK_TYPE && length == HEADER_LENGTH) {
			header = {
				width: view.getUint32(dataOffset),
				height: view.getUint32(dataOffset + 4),
				bitDepth: image[dataOffset + 8],
				colorType: image[dataOffset + 9],
				interlaced: Boolean(image[dataOffset + 12])
			};
		} else if (type == DATA_CHUNK_TYPE) {
			dataChunks.push(image.subarray(dataOffset, dataOffset + length));
		} else if (type == END_CHUNK_TYPE) {
			ended = true;
		} else if (!dataChunks.length) {
			// the chunks that say how to read the pixels (palette, colour space) come before the data
			leadingChunks.push(image.subarray(offset, endOffset));
		}
		offset = endOffset;
	}
	if (!header || !dataChunks.length || !ended) {
		throw new Error(INVALID_FILE_ERROR_MESSAGE);
	}
	if (header.interlaced || !CHANNELS[header.colorType]) {
		throw new Error(UNSUPPORTED_FILE_ERROR_MESSAGE);
	}
	return { header, leadingChunks, dataChunks };
}

function getHeaderData({ width, bitDepth, colorType }, height) {
	const data = new Uint8Array(HEADER_LENGTH);
	const view = new DataView(data.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	data[8] = bitDepth;
	data[9] = colorType;
	return data;
}

function getPixelLength({ bitDepth, colorType }) {
	return Math.max(1, CHANNELS[colorType] * bitDepth >> 3);
}

function getRowLength({ width, bitDepth, colorType }) {
	return 1 + Math.ceil(width * CHANNELS[colorType] * bitDepth / 8);
}

function getChunk(type, data) {
	const chunk = new Uint8Array(CHUNK_LENGTH_SIZE + CHUNK_TYPE_SIZE + data.length + CHUNK_CRC_SIZE);
	const view = new DataView(chunk.buffer);
	view.setUint32(0, data.length);
	chunk.set(textEncoder.encode(type), CHUNK_LENGTH_SIZE);
	chunk.set(data, CHUNK_LENGTH_SIZE + CHUNK_TYPE_SIZE);
	view.setUint32(chunk.length - CHUNK_CRC_SIZE, getCRC(chunk.subarray(CHUNK_LENGTH_SIZE, chunk.length - CHUNK_CRC_SIZE)));
	return chunk;
}

async function readStream(readable) {
	const chunks = [];
	const reader = readable.getReader();
	for (; ;) {
		const { done, value } = await reader.read();
		if (done) {
			return concatArrays(chunks);
		}
		chunks.push(value);
	}
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

function getCRC(data) {
	let crc = 0xffffffff;
	for (let index = 0; index < data.length; index++) {
		crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function getCRCTable() {
	const table = new Uint32Array(256);
	for (let index = 0; index < table.length; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
}

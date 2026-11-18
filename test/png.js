// A PNG reader and writer for the tests, independent of lib/png.js so that the checks of the joined
// images do not rely on the code they check. Only what the tests need: 8 bits per sample, RGB or
// RGBA, no interlacing.

import { Buffer } from "node:buffer";
import { deflateSync, inflateSync, crc32 } from "node:zlib";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS = { 2: 3, 6: 4 };

export { decodeImage, encodeImage };

// returns the pixels of the image, and the filter type of each of its rows
function decodeImage(image) {
	const data = Buffer.from(image);
	let offset = SIGNATURE.length, width, height, colorType, ended;
	const dataChunks = [];
	while (!ended) {
		const length = data.readUInt32BE(offset);
		const type = data.toString("latin1", offset + 4, offset + 8);
		if (crc32(data.subarray(offset + 4, offset + 8 + length)) != data.readUInt32BE(offset + 8 + length)) {
			throw new Error("Wrong CRC in chunk " + type);
		}
		if (type == "IHDR") {
			width = data.readUInt32BE(offset + 8);
			height = data.readUInt32BE(offset + 12);
			colorType = data[offset + 17];
		} else if (type == "IDAT") {
			dataChunks.push(data.subarray(offset + 8, offset + 8 + length));
		}
		ended = type == "IEND";
		offset += length + 12;
	}
	const channels = CHANNELS[colorType];
	const rowLength = width * channels;
	const rows = inflateSync(Buffer.concat(dataChunks));
	if (rows.length != (rowLength + 1) * height) {
		throw new Error("Wrong length of image data");
	}
	const pixels = new Uint8Array(rowLength * height);
	const filters = [];
	for (let y = 0; y < height; y++) {
		const filter = rows[y * (rowLength + 1)];
		filters.push(filter);
		for (let x = 0; x < rowLength; x++) {
			const left = x >= channels ? pixels[y * rowLength + x - channels] : 0;
			const up = y ? pixels[(y - 1) * rowLength + x] : 0;
			const upLeft = y && x >= channels ? pixels[(y - 1) * rowLength + x - channels] : 0;
			pixels[y * rowLength + x] = rows[y * (rowLength + 1) + 1 + x] + [0, left, up, (left + up) >> 1, getPaethPredictor(left, up, upLeft)][filter];
		}
	}
	return { width, height, channels, pixels, filters };
}

// writes the pixels with the filter type given for each row
function encodeImage({ width, height, channels, pixels, filters }) {
	const rowLength = width * channels;
	const rows = Buffer.alloc((rowLength + 1) * height);
	for (let y = 0; y < height; y++) {
		const filter = filters[y];
		rows[y * (rowLength + 1)] = filter;
		for (let x = 0; x < rowLength; x++) {
			const left = x >= channels ? pixels[y * rowLength + x - channels] : 0;
			const up = y ? pixels[(y - 1) * rowLength + x] : 0;
			const upLeft = y && x >= channels ? pixels[(y - 1) * rowLength + x - channels] : 0;
			rows[y * (rowLength + 1) + 1 + x] = pixels[y * rowLength + x] - [0, left, up, (left + up) >> 1, getPaethPredictor(left, up, upLeft)][filter];
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = channels == 4 ? 6 : 2;
	const compressedRows = deflateSync(rows);
	// two data chunks, as a reader must not expect one
	const splitOffset = compressedRows.length >> 1;
	return new Uint8Array(Buffer.concat([
		Buffer.from(SIGNATURE),
		getChunk("IHDR", header),
		getChunk("IDAT", compressedRows.subarray(0, splitOffset)),
		getChunk("IDAT", compressedRows.subarray(splitOffset)),
		getChunk("IEND", Buffer.alloc(0))
	]));
}

function getChunk(type, data) {
	const chunk = Buffer.alloc(data.length + 12);
	chunk.writeUInt32BE(data.length, 0);
	chunk.write(type, 4, "latin1");
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(chunk.subarray(4, data.length + 8)), data.length + 8);
	return chunk;
}

function getPaethPredictor(left, up, upLeft) {
	const estimate = left + up - upLeft;
	const leftDistance = Math.abs(estimate - left);
	const upDistance = Math.abs(estimate - up);
	const upLeftDistance = Math.abs(estimate - upLeft);
	return leftDistance <= upDistance && leftDistance <= upLeftDistance ? left : upDistance <= upLeftDistance ? up : upLeft;
}

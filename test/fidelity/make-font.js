// Writes a TrueType font in which every printable ASCII character is the same filled rectangle.
// Text set in it is a solid bar, so a page that loses the face does not merely reflow slightly —
// it changes from a black block to readable words, which no pixel comparison can miss.
//
// It is generated rather than borrowed for two reasons. A real font carries a licence and a few
// hundred kilobytes into a fixture directory, and, more importantly, the fonts already lying around
// for probing turned out to map no letters at all: text set in them silently fell back to a system
// family, which made a working fix look broken and cost an afternoon. A font built here maps
// exactly what it claims to map, and the shapes differ per variant so that "the right family was
// kept" is a visible statement and not only "some family was kept".
//
// Not a test. Run it to regenerate the committed .ttf files:
//
//   node test/fidelity/make-font.js
//
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const UNITS_PER_EM = 1000;
const FIRST_CHARACTER_CODE = 0x20;
const LAST_CHARACTER_CODE = 0x7e;
const ASCENT = 800;
const DESCENT = -200;
const ADVANCE_WIDTH = 600;
const MAGIC_NUMBER = 0x5f0f3cf5;
const CHECKSUM_MAGIC = 0xb1b0afba;
const TABLE_RECORD_SIZE = 16;
const HEAD_CHECKSUM_ADJUSTMENT_OFFSET = 8;

// each fixture family is a different shape, so a screenshot says which face was used and not just
// that one was: a full block, a band across the middle, a bar sitting on the baseline
const VARIANTS = {
	"block": { bottom: 0, top: 760, left: 60, right: 540 },
	"band": { bottom: 260, top: 500, left: 40, right: 560 },
	"bar": { bottom: 0, top: 160, left: 40, right: 560 }
};

export { createFont, VARIANTS };

if (import.meta.url === ("file://" + process.argv[1]) || import.meta.filename === process.argv[1]) {
	const directory = join(dirname(fileURLToPath(import.meta.url)), "pages", "fonts");
	await Promise.all(Object.keys(VARIANTS).map(async name => {
		const path = join(directory, name + ".ttf");
		await writeFile(path, createFont(Object.assign({ familyName: "Fidelity " + name }, VARIANTS[name])));
		console.log("wrote " + path); // eslint-disable-line no-console
	}));
}

function createFont({ familyName, top, bottom, left, right }) {
	const glyph = buildGlyph({ top, bottom, left, right });
	const tables = [
		["OS/2", buildOS2({ top, bottom })],
		["cmap", buildCmap()],
		["glyf", glyph],
		["head", buildHead({ top, bottom, left, right })],
		["hhea", buildHhea()],
		["hmtx", buildHmtx()],
		["loca", buildLoca(glyph.length)],
		["maxp", buildMaxp()],
		["name", buildName(familyName)],
		["post", buildPost()]
	];
	return assemble(tables);
}

// the offset table, the table records and the tables themselves, followed by the one value that can
// only be computed once the whole file exists: the checksum adjustment in head
function assemble(tables) {
	const headerSize = 12 + tables.length * TABLE_RECORD_SIZE;
	const size = tables.reduce((total, [, content]) => total + align(content.length), headerSize);
	const font = new Uint8Array(size);
	const view = new DataView(font.buffer);
	const entrySelector = Math.floor(Math.log2(tables.length));
	const searchRange = 16 * (2 ** entrySelector);
	view.setUint32(0, 0x00010000);
	view.setUint16(4, tables.length);
	view.setUint16(6, searchRange);
	view.setUint16(8, entrySelector);
	view.setUint16(10, tables.length * 16 - searchRange);
	let offset = headerSize;
	let headOffset;
	tables.forEach(([tag, content], index) => {
		const record = 12 + index * TABLE_RECORD_SIZE;
		Array.from(tag).forEach((character, position) => view.setUint8(record + position, character.charCodeAt(0)));
		view.setUint32(record + 4, checksum(content));
		view.setUint32(record + 8, offset);
		view.setUint32(record + 12, content.length);
		font.set(content, offset);
		if (tag == "head") {
			headOffset = offset;
		}
		offset += align(content.length);
	});
	view.setUint32(headOffset + HEAD_CHECKSUM_ADJUSTMENT_OFFSET, (CHECKSUM_MAGIC - checksum(font)) >>> 0);
	return font;
}

function checksum(content) {
	const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
	let sum = 0;
	for (let offset = 0; offset + 4 <= content.length; offset += 4) {
		sum = (sum + view.getUint32(offset)) >>> 0;
	}
	// a table is padded to a multiple of four with zeroes, and the checksum is taken over the
	// padded form: the trailing bytes are read as if those zeroes were already there
	if (content.length % 4) {
		let tail = 0;
		for (let offset = content.length - content.length % 4; offset < content.length; offset++) {
			tail = (tail << 8) | content[offset];
		}
		sum = (sum + (tail << (8 * (4 - content.length % 4)))) >>> 0;
	}
	return sum;
}

function align(length) {
	return length + (length % 4 ? 4 - length % 4 : 0);
}

function buildHead({ top, bottom, left, right }) {
	const writer = createWriter(54);
	writer.uint32(0x00010000);
	writer.uint32(0x00010000);
	writer.uint32(0);
	writer.uint32(MAGIC_NUMBER);
	writer.uint16(0x0003);
	writer.uint16(UNITS_PER_EM);
	writer.uint32(0); writer.uint32(0);
	writer.uint32(0); writer.uint32(0);
	writer.int16(left); writer.int16(bottom); writer.int16(right); writer.int16(top);
	writer.uint16(0);
	writer.uint16(8);
	writer.int16(2);
	// the long form of loca, so that the offsets are plain byte counts rather than halves
	writer.int16(1);
	writer.int16(0);
	return writer.content;
}

function buildHhea() {
	const writer = createWriter(36);
	writer.uint32(0x00010000);
	writer.int16(ASCENT); writer.int16(DESCENT); writer.int16(0);
	writer.uint16(ADVANCE_WIDTH);
	writer.int16(0); writer.int16(0); writer.int16(ADVANCE_WIDTH);
	writer.int16(1); writer.int16(0); writer.int16(0);
	writer.int16(0); writer.int16(0); writer.int16(0); writer.int16(0);
	writer.int16(0);
	writer.uint16(2);
	return writer.content;
}

function buildMaxp() {
	const writer = createWriter(32);
	writer.uint32(0x00010000);
	writer.uint16(2);
	writer.uint16(4); writer.uint16(1);
	writer.uint16(0); writer.uint16(0);
	writer.uint16(1); writer.uint16(0);
	writer.uint16(0); writer.uint16(0); writer.uint16(0); writer.uint16(0); writer.uint16(0);
	writer.uint16(0); writer.uint16(0);
	return writer.content;
}

function buildHmtx() {
	const writer = createWriter(8);
	writer.uint16(ADVANCE_WIDTH); writer.int16(0);
	writer.uint16(ADVANCE_WIDTH); writer.int16(0);
	return writer.content;
}

// format 4, one segment covering printable ASCII and the terminator the format requires. Every
// character in the segment maps to the single glyph, including the space: text set in this font is
// one unbroken bar, which is exactly the point.
//
// The segment therefore has to name its glyph per character, through idRangeOffset and an array of
// indices. The shorter-looking route, a single idDelta added to the character code, maps a range
// LINEARLY — a font written that way claims a different glyph for every character, and the browser
// rejects the whole table as soon as one of them is past the last glyph
function buildCmap() {
	const characterCount = LAST_CHARACTER_CODE - FIRST_CHARACTER_CODE + 1;
	const subtableLength = 32 + characterCount * 2;
	const writer = createWriter(12 + subtableLength);
	writer.uint16(0); writer.uint16(1);
	writer.uint16(3); writer.uint16(1); writer.uint32(12);
	writer.uint16(4); writer.uint16(subtableLength); writer.uint16(0);
	writer.uint16(4); writer.uint16(4); writer.uint16(1); writer.uint16(0);
	writer.uint16(LAST_CHARACTER_CODE); writer.uint16(0xffff);
	writer.uint16(0);
	writer.uint16(FIRST_CHARACTER_CODE); writer.uint16(0xffff);
	writer.uint16(0); writer.uint16(1);
	// counted from the position of this very field, which is why the first segment's offset is the
	// four bytes that the second segment's offset occupies
	writer.uint16(4); writer.uint16(0);
	for (let index = 0; index < characterCount; index++) {
		writer.uint16(1);
	}
	return writer.content;
}

// glyph 0 is the empty .notdef, so the whole table is glyph 1: one closed contour of four on-curve
// points, given as deltas from the previous point. It is padded here rather than at assembly time,
// so that the offset loca gives for the end of the glyph stays inside the length glyf declares
function buildGlyph({ top, bottom, left, right }) {
	const writer = createWriter(36);
	writer.int16(1);
	writer.int16(left); writer.int16(bottom); writer.int16(right); writer.int16(top);
	writer.uint16(3);
	writer.uint16(0);
	writer.uint8(1); writer.uint8(1); writer.uint8(1); writer.uint8(1);
	writer.int16(left); writer.int16(right - left); writer.int16(0); writer.int16(left - right);
	writer.int16(bottom); writer.int16(0); writer.int16(top - bottom); writer.int16(0);
	return writer.content;
}

function buildLoca(glyphLength) {
	const writer = createWriter(12);
	writer.uint32(0); writer.uint32(0); writer.uint32(align(glyphLength));
	return writer.content;
}

function buildOS2({ top, bottom }) {
	const writer = createWriter(96);
	writer.uint16(4);
	writer.int16(ADVANCE_WIDTH);
	writer.uint16(400); writer.uint16(5); writer.uint16(0);
	writer.int16(650); writer.int16(600); writer.int16(0); writer.int16(75);
	writer.int16(650); writer.int16(600); writer.int16(0); writer.int16(350);
	writer.int16(50); writer.int16(300);
	writer.int16(0);
	for (let index = 0; index < 10; index++) {
		writer.uint8(0);
	}
	writer.uint32(1); writer.uint32(0); writer.uint32(0); writer.uint32(0);
	Array.from("SFTD").forEach(character => writer.uint8(character.charCodeAt(0)));
	writer.uint16(0x0040);
	writer.uint16(FIRST_CHARACTER_CODE); writer.uint16(LAST_CHARACTER_CODE);
	writer.int16(ASCENT); writer.int16(DESCENT); writer.int16(0);
	writer.uint16(ASCENT); writer.uint16(-DESCENT);
	writer.uint32(1); writer.uint32(0);
	writer.int16(Math.round((top - bottom) / 2)); writer.int16(top);
	writer.uint16(0); writer.uint16(FIRST_CHARACTER_CODE); writer.uint16(1);
	return writer.content;
}

function buildName(familyName) {
	const names = [[1, familyName], [2, "Regular"], [3, familyName + " Regular"], [4, familyName], [5, "Version 1.0"], [6, familyName.replace(/ /g, "")]];
	const strings = names.map(([, value]) => encodeUTF16(value));
	const header = 6 + names.length * 12;
	const writer = createWriter(header + strings.reduce((total, string) => total + string.length, 0));
	writer.uint16(0); writer.uint16(names.length); writer.uint16(header);
	let offset = 0;
	names.forEach(([identifier], index) => {
		writer.uint16(3); writer.uint16(1); writer.uint16(0x0409); writer.uint16(identifier);
		writer.uint16(strings[index].length); writer.uint16(offset);
		offset += strings[index].length;
	});
	strings.forEach(string => string.forEach(byte => writer.uint8(byte)));
	return writer.content;
}

function encodeUTF16(value) {
	const bytes = [];
	Array.from(value).forEach(character => {
		const code = character.charCodeAt(0);
		bytes.push(code >> 8, code & 0xff);
	});
	return bytes;
}

function buildPost() {
	const writer = createWriter(32);
	writer.uint32(0x00030000);
	writer.uint32(0);
	writer.int16(-100); writer.int16(50);
	writer.uint32(1);
	writer.uint32(0); writer.uint32(0); writer.uint32(0); writer.uint32(0);
	return writer.content;
}

function createWriter(size) {
	const content = new Uint8Array(size);
	const view = new DataView(content.buffer);
	let offset = 0;
	return {
		content,
		uint8: value => view.setUint8(offset++, value),
		int16: value => (view.setInt16(offset, value), offset += 2),
		uint16: value => (view.setUint16(offset, value & 0xffff), offset += 2),
		uint32: value => (view.setUint32(offset, value >>> 0), offset += 4)
	};
}

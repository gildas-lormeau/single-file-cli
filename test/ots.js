// A reader of detached timestamp files and a calendar server for the tests of --add-proof. The
// reader shares no code with lib/opentimestamps.js: it executes the operations of the file from
// the digest of the data, as a verifier does, and returns the message each attestation commits
// to. The server answers like a public calendar and keeps what it committed to, so a test can
// check that the file leads from the saved bytes to that commitment.

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";

const HEADER_MAGIC = Buffer.concat([Buffer.from([0x00]), Buffer.from("OpenTimestamps"), Buffer.from([0x00, 0x00]), Buffer.from("Proof"), Buffer.from([0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94])]);
const PENDING_ATTESTATION_TAG = Buffer.from("83dfe30d2ef90c8e", "hex");
const DIGEST_LENGTH = 32;
const SUFFIX_LENGTH = 8;

export { readProof, startCalendar, sha256 };

function sha256(data) {
	return createHash("sha256").update(data).digest();
}

function readProof(proof) {
	proof = Buffer.from(proof);
	if (!proof.subarray(0, HEADER_MAGIC.length).equals(HEADER_MAGIC)) {
		throw new Error("not a detached timestamp file");
	}
	let offset = HEADER_MAGIC.length;
	const readByte = () => {
		if (offset >= proof.length) {
			throw new Error("truncated file");
		}
		return proof[offset++];
	};
	const readBytes = length => {
		if (offset + length > proof.length) {
			throw new Error("truncated file");
		}
		offset += length;
		return proof.subarray(offset - length, offset);
	};
	const readVarBytes = () => {
		let length = 0, shift = 0, byte;
		do {
			byte = readByte();
			length |= (byte & 0x7f) << shift;
			shift += 7;
		} while (byte & 0x80);
		return readBytes(length);
	};
	const attestations = [];
	const readBranch = (tag, message) => {
		if (tag == 0x00) {
			const attestationTag = readBytes(8);
			const payload = readVarBytes();
			if (!attestationTag.equals(PENDING_ATTESTATION_TAG)) {
				throw new Error("unexpected attestation " + attestationTag.toString("hex"));
			}
			attestations.push({ message, url: payload.subarray(1, 1 + payload[0]).toString() });
		} else if (tag == 0xf0) {
			readTimestamp(Buffer.concat([message, readVarBytes()]));
		} else if (tag == 0xf1) {
			readTimestamp(Buffer.concat([readVarBytes(), message]));
		} else if (tag == 0x08) {
			readTimestamp(sha256(message));
		} else {
			throw new Error("unexpected tag " + tag);
		}
	};
	const readTimestamp = message => {
		let tag = readByte();
		while (tag == 0xff) {
			readBranch(readByte(), message);
			tag = readByte();
		}
		readBranch(tag, message);
	};
	const version = readByte();
	const hashTag = readByte();
	const digest = Buffer.from(readBytes(DIGEST_LENGTH));
	readTimestamp(digest);
	if (offset != proof.length) {
		throw new Error("bytes after the timestamp");
	}
	return { version, hashTag, digest, attestations };
}

// getResponse replaces the answer of the server for the cases where it misbehaves
async function startCalendar({ getResponse } = {}) {
	const requests = [];
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", chunk => chunks.push(chunk));
		request.on("end", () => {
			const commitment = Buffer.concat(chunks);
			const suffix = randomBytes(SUFFIX_LENGTH);
			const url = "http://127.0.0.1:" + server.address().port;
			const payload = Buffer.concat([Buffer.from([url.length]), Buffer.from(url)]);
			const timestamp = Buffer.concat([
				Buffer.from([0xf0, SUFFIX_LENGTH]), suffix, Buffer.from([0x08]),
				Buffer.from([0x00]), PENDING_ATTESTATION_TAG, Buffer.from([payload.length]), payload
			]);
			requests.push({ method: request.method, path: request.url, headers: request.headers, commitment, message: sha256(Buffer.concat([commitment, suffix])) });
			const { status = 200, body = timestamp } = getResponse ? getResponse(timestamp) : {};
			response.writeHead(status, { "content-type": "application/vnd.opentimestamps.v1" }).end(body);
		});
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	return {
		url: "http://127.0.0.1:" + server.address().port,
		requests,
		close: () => new Promise(resolve => server.close(resolve))
	};
}

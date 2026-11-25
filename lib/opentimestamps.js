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

/* global URL, TextEncoder, crypto, fetch, AbortSignal */

import { version } from "./version.js";

// the servers the official OpenTimestamps clients submit to by default. They are aggregators:
// each one forwards to a public calendar, run by three different operators
const DEFAULT_CALENDAR_URLS = [
	"https://a.pool.opentimestamps.org",
	"https://b.pool.opentimestamps.org",
	"https://a.pool.eternitywall.com",
	"https://ots.btc.catallaxy.com"
];
const PROOF_FILENAME_SUFFIX = ".ots";
const HEADER_MAGIC = Uint8Array.from([0x00, ...new TextEncoder().encode("OpenTimestamps"), 0x00, 0x00, ...new TextEncoder().encode("Proof"), 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94]);
const FORMAT_VERSION = 0x01;
const TAG_ATTESTATION = 0x00;
const TAG_SHA1 = 0x02;
const TAG_RIPEMD160 = 0x03;
const TAG_SHA256 = 0x08;
const TAG_KECCAK256 = 0x67;
const TAG_APPEND = 0xf0;
const TAG_PREPEND = 0xf1;
const TAG_REVERSE = 0xf2;
const TAG_HEXLIFY = 0xf3;
const TAG_FORK = 0xff;
const UNARY_OPERATION_TAGS = [TAG_SHA1, TAG_RIPEMD160, TAG_SHA256, TAG_KECCAK256, TAG_REVERSE, TAG_HEXLIFY];
const BINARY_OPERATION_TAGS = [TAG_APPEND, TAG_PREPEND];
const ATTESTATION_TAG_LENGTH = 8;
const NONCE_LENGTH = 16;
// the limits of the reference implementation (python-opentimestamps)
const MAX_OPERAND_LENGTH = 4096;
const MAX_ATTESTATION_LENGTH = 8192;
const MAX_RESPONSE_LENGTH = 10000;
const MAX_DEPTH = 256;
const REQUEST_TIMEOUT = 15000;
const DIGEST_ENDPOINT = "digest";
const REQUEST_HEADERS = {
	"accept": "application/vnd.opentimestamps.v1",
	"content-type": "application/x-www-form-urlencoded",
	"user-agent": "single-file-cli/" + version
};

export {
	DEFAULT_CALENDAR_URLS,
	PROOF_FILENAME_SUFFIX,
	createProof
};

// Builds the content of a detached timestamp file (.ots) for the data, in the format read by the
// OpenTimestamps clients. The proof is pending: each server answers at once with its commitment
// to include the digest in a Bitcoin transaction, and the path to the block is fetched later by
// upgrading the file with one of those clients.
//
// A random nonce is hashed with the digest of the data and only the result is sent, as the
// official clients do: the servers publish what they receive, and without the nonce the digest
// of the saved page would be public and could be matched against a known page.
//
// One answer is enough to make a proof. A server that fails is reported in `failures` and the
// proof is made with the others; the call throws when none answers.
async function createProof(data, { calendarUrls = DEFAULT_CALENDAR_URLS, fetchOptions = {} } = {}) {
	const digest = await sha256(data);
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
	const commitment = await sha256(concat([digest, nonce]));
	const urls = Array.from(new Set(calendarUrls));
	const results = await Promise.all(urls.map(async url => {
		try {
			return { url, timestamp: await submit(url, commitment, fetchOptions) };
		} catch (error) {
			return { url, message: error.message || String(error) };
		}
	}));
	const timestamps = results.filter(result => result.timestamp);
	const failures = results.filter(result => !result.timestamp).map(({ url, message }) => ({ url, message }));
	if (!timestamps.length) {
		throw new Error("no OpenTimestamps server gave a timestamp: " + failures.map(({ url, message }) => url + " (" + message + ")").join(", "));
	}
	const parts = [HEADER_MAGIC, Uint8Array.of(FORMAT_VERSION, TAG_SHA256), digest, Uint8Array.of(TAG_APPEND, NONCE_LENGTH), nonce, Uint8Array.of(TAG_SHA256)];
	timestamps.forEach(({ timestamp }, indexTimestamp) => {
		// every branch but the last one is announced by a fork tag
		if (indexTimestamp < timestamps.length - 1) {
			parts.push(Uint8Array.of(TAG_FORK));
		}
		parts.push(timestamp);
	});
	return {
		proof: concat(parts),
		calendarUrls: timestamps.map(({ url }) => url),
		failures
	};
}

async function submit(url, commitment, fetchOptions) {
	const endpoint = new URL(DIGEST_ENDPOINT, url.endsWith("/") ? url : url + "/");
	const response = await fetch(endpoint, Object.assign({}, fetchOptions, {
		method: "POST",
		headers: REQUEST_HEADERS,
		body: commitment,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT)
	}));
	if (!response.ok) {
		throw new Error("HTTP status " + response.status);
	}
	const timestamp = new Uint8Array(await response.arrayBuffer());
	if (timestamp.length > MAX_RESPONSE_LENGTH) {
		throw new Error("the answer is longer than " + MAX_RESPONSE_LENGTH + " bytes");
	}
	checkTimestamp(timestamp);
	return timestamp;
}

// The answers are written one after the other in the file, so an answer that is not a complete
// timestamp (an error page served with a 200, a truncated body) would make the whole file
// unreadable, the valid answers of the other servers included. Each one is walked to its end
// before it is kept.
function checkTimestamp(bytes) {
	const state = { bytes, offset: 0, attestations: 0 };
	readTimestamp(state, 0);
	if (state.offset != bytes.length) {
		throw new Error("the answer has " + (bytes.length - state.offset) + " bytes after the timestamp");
	}
	if (!state.attestations) {
		throw new Error("the answer holds no attestation");
	}
}

function readTimestamp(state, depth) {
	if (depth > MAX_DEPTH) {
		throw new Error("the answer is nested too deep");
	}
	let tag = readByte(state);
	while (tag == TAG_FORK) {
		readBranch(state, readByte(state), depth);
		tag = readByte(state);
	}
	readBranch(state, tag, depth);
}

function readBranch(state, tag, depth) {
	if (tag == TAG_ATTESTATION) {
		skip(state, ATTESTATION_TAG_LENGTH);
		skip(state, readLength(state, MAX_ATTESTATION_LENGTH));
		state.attestations++;
	} else {
		if (BINARY_OPERATION_TAGS.includes(tag)) {
			const length = readLength(state, MAX_OPERAND_LENGTH);
			if (!length) {
				throw new Error("the answer holds an empty operand");
			}
			skip(state, length);
		} else if (!UNARY_OPERATION_TAGS.includes(tag)) {
			throw new Error("the answer is not a timestamp (unknown tag 0x" + tag.toString(16).padStart(2, "0") + ")");
		}
		readTimestamp(state, depth + 1);
	}
}

function readByte(state) {
	if (state.offset >= state.bytes.length) {
		throw new Error("the answer is truncated");
	}
	return state.bytes[state.offset++];
}

// unsigned LEB128, the variable-length integer of the format
function readLength(state, maxLength) {
	let value = 0, shift = 0, byte;
	do {
		byte = readByte(state);
		value += (byte & 0x7f) * 2 ** shift;
		shift += 7;
		if (value > maxLength) {
			throw new Error("the answer holds a field longer than " + maxLength + " bytes");
		}
	} while (byte & 0x80);
	return value;
}

function skip(state, length) {
	if (state.offset + length > state.bytes.length) {
		throw new Error("the answer is truncated");
	}
	state.offset += length;
}

async function sha256(bytes) {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function concat(parts) {
	const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
	let offset = 0;
	parts.forEach(part => {
		result.set(part, offset);
		offset += part.length;
	});
	return result;
}

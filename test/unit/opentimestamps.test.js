// --add-proof writes a detached timestamp file without the OpenTimestamps library. The file is
// read back here with the reader of the tests, which shares no code with the module and executes
// the operations as a verifier does: the checks are on where the file leads from the data, not
// on its bytes. The format was also checked by hand against the official client, which reads,
// upgrades and verifies a file made this way.

/* global TextEncoder */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { importLibModule } from "../target.js";
import { readProof, startCalendar, sha256 } from "../ots.js";

const { createProof, DEFAULT_CALENDAR_URLS } = await importLibModule("opentimestamps.js");
const DATA = new TextEncoder().encode("<html><body>saved page</body></html>");
const CLOSED_PORT_URL = "http://127.0.0.1:1";
// in the answer of the calendar of the tests: an append of 8 bytes and a SHA-256, then the attestation
const OPERATIONS_LENGTH = 11;

async function withCalendars(responses, callback) {
	const calendars = await Promise.all(responses.map(getResponse => startCalendar({ getResponse })));
	try {
		return await callback(calendars);
	} finally {
		await Promise.all(calendars.map(calendar => calendar.close()));
	}
}

test("the proof leads from the digest of the data to what each server committed to", async () => {
	await withCalendars([undefined, undefined], async calendars => {
		const { proof, calendarUrls, failures } = await createProof(DATA, { calendarUrls: calendars.map(calendar => calendar.url) });
		const { version, hashTag, digest, attestations } = readProof(proof);
		assert.equal(version, 1);
		assert.equal(hashTag, 0x08, "the file does not declare a SHA-256 digest");
		assert.deepEqual(digest, sha256(DATA), "the digest of the file is not the digest of the data");
		assert.deepEqual(failures, []);
		assert.deepEqual(calendarUrls, calendars.map(calendar => calendar.url));
		assert.deepEqual(attestations.map(attestation => attestation.url), calendars.map(calendar => calendar.url));
		calendars.forEach((calendar, indexCalendar) => {
			assert.equal(calendar.requests.length, 1);
			const [request] = calendar.requests;
			assert.equal(request.method, "POST");
			assert.equal(request.path, "/digest");
			assert.equal(request.headers.accept, "application/vnd.opentimestamps.v1");
			assert.deepEqual(attestations[indexCalendar].message, request.message, "the file does not lead to the commitment of the server");
		});
	});
});

test("the digest of the data is not what the servers receive", async () => {
	await withCalendars([undefined, undefined], async calendars => {
		const calendarUrls = calendars.map(calendar => calendar.url);
		await createProof(DATA, { calendarUrls });
		await createProof(DATA, { calendarUrls });
		const commitments = calendars[0].requests.map(request => request.commitment);
		assert.equal(commitments[0].length, 32);
		assert.notDeepEqual(commitments[0], sha256(DATA), "the digest of the data was sent as is");
		assert.notDeepEqual(commitments[0], commitments[1], "two proofs of the same data sent the same value");
		assert.deepEqual(calendars[1].requests[0].commitment, commitments[0], "the servers of one proof did not get the same value");
	});
});

test("a proof is made with the servers that answer and the others are reported", async () => {
	await withCalendars([() => ({ status: 503 }), undefined], async calendars => {
		const calendarUrls = [calendars[0].url, CLOSED_PORT_URL, calendars[1].url];
		const { proof, failures } = await createProof(DATA, { calendarUrls });
		const { attestations } = readProof(proof);
		assert.deepEqual(attestations.map(attestation => attestation.url), [calendars[1].url]);
		assert.deepEqual(attestations[0].message, calendars[1].requests[0].message);
		assert.deepEqual(failures.map(failure => failure.url), [calendars[0].url, CLOSED_PORT_URL]);
		assert.match(failures[0].message, /503/);
	});
});

const INVALID_ANSWERS = {
	"an error page served with a 200": () => ({ body: Buffer.from("<html><body>Service unavailable</body></html>") }),
	"an empty body": () => ({ body: Buffer.alloc(0) }),
	"a truncated timestamp": timestamp => ({ body: timestamp.subarray(0, timestamp.length - 5) }),
	"bytes after the timestamp": timestamp => ({ body: Buffer.concat([timestamp, Buffer.from([0x08])]) }),
	"operations with no attestation": () => ({ body: Buffer.from([0x08, 0x08]) }),
	// a well-formed timestamp, made of the attestation of the server repeated in 300 branches
	"a timestamp over the size limit": timestamp => {
		const attestation = timestamp.subarray(OPERATIONS_LENGTH);
		const branch = Buffer.concat([Buffer.from([0xff]), attestation]);
		return { body: Buffer.concat([...new Array(300).fill(branch), attestation]) };
	}
};

for (const [description, getResponse] of Object.entries(INVALID_ANSWERS)) {
	test(`${description} is not written in the proof`, async () => {
		await withCalendars([getResponse, undefined], async calendars => {
			const { proof, failures } = await createProof(DATA, { calendarUrls: calendars.map(calendar => calendar.url) });
			const { attestations } = readProof(proof);
			assert.deepEqual(attestations.map(attestation => attestation.url), [calendars[1].url], "the proof is not made of the valid answer alone");
			assert.deepEqual(failures.map(failure => failure.url), [calendars[0].url]);
		});
	});
}

test("no proof is made when no server gives a timestamp", async () => {
	await withCalendars([() => ({ status: 500 })], async calendars => {
		await assert.rejects(createProof(DATA, { calendarUrls: [calendars[0].url, CLOSED_PORT_URL] }), /no OpenTimestamps server gave a timestamp/);
	});
});

test("the default servers are the aggregators of the official clients", () => {
	assert.deepEqual(DEFAULT_CALENDAR_URLS, ["https://a.pool.opentimestamps.org", "https://b.pool.opentimestamps.org", "https://a.pool.eternitywall.com", "https://ots.btc.catallaxy.com"]);
});

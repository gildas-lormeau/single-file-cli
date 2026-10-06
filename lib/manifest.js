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

/* global URL, setTimeout, clearTimeout, TextEncoder, crypto, atob, btoa */

import tls from "node:tls";
import { version } from "./version.js";

const FORMAT = "singlefile-manifest";
const FORMAT_VERSION = 1;
const PRODUCER_NAME = "single-file-cli";
const HTTPS_PROTOCOL = "https:";
const HTTPS_DEFAULT_PORT = 443;
const HANDSHAKE_TIMEOUT = 10000;
const TLS_SOURCE_CONNECTION = "connection";
const TLS_SOURCE_HANDSHAKE = "handshake";
const COVERAGE_NONE = "none";
const COVERAGE_OBSERVED = "observed";
const COVERAGE_BODIES_DECODED = "decoded";
const COVERAGE_REDIRECTS = "from-first-sent-request";
const BODY_ENCODING_DECODED = "decoded";
const BODY_ENCODING_TEXT = "text";
const MAX_BODY_SIZE = 32 * 1024 * 1024;
const BASE64_CHUNK_SIZE = 8192;

export {
	TLS_SOURCE_CONNECTION,
	BODY_ENCODING_DECODED,
	BODY_ENCODING_TEXT,
	MAX_BODY_SIZE,
	createTransport,
	addCertificateChain,
	sha256,
	base64ToBytes,
	canonicalize,
	collectHandshakes,
	assembleManifest
};

function createTransport() {
	return { requests: new Map(), tls: {}, certificates: {} };
}

async function addCertificateChain(transport, derChain) {
	const fingerprints = await Promise.all(derChain.map(der => sha256(base64ToBytes(der))));
	fingerprints.forEach((fingerprint, index) => {
		if (!transport.certificates[fingerprint]) {
			const certificate = { der: derChain[index] };
			if (index === 0 && fingerprints.length > 1) {
				certificate.chain = fingerprints.slice(1);
			}
			transport.certificates[fingerprint] = certificate;
		}
	});
	return fingerprints[0];
}

async function sha256(data) {
	const bytes = typeof data == "string" ? new TextEncoder().encode(data) : data;
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(value => value.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(base64) {
	const binaryString = atob(base64);
	const bytes = new Uint8Array(binaryString.length);
	for (let index = 0; index < binaryString.length; index++) {
		bytes[index] = binaryString.charCodeAt(index);
	}
	return bytes;
}

function bytesToBase64(bytes) {
	let binaryString = "";
	for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
		binaryString += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
	}
	return btoa(binaryString);
}

function canonicalize(value) {
	if (value === null || typeof value == "boolean" || typeof value == "string") {
		return JSON.stringify(value);
	}
	if (typeof value == "number") {
		if (!Number.isFinite(value)) {
			throw new Error("A manifest cannot carry " + value);
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return "[" + value.map(item => canonicalize(item === undefined ? null : item)).join(",") + "]";
	}
	if (typeof value == "object") {
		return "{" + Object.keys(value)
			.filter(key => value[key] !== undefined)
			.sort()
			.map(key => JSON.stringify(key) + ":" + canonicalize(value[key]))
			.join(",") + "}";
	}
	throw new Error("A manifest cannot carry a " + typeof value);
}

async function collectHandshakes(transport, { ignoreCertificateErrors }) {
	const hosts = new Map();
	transport.requests.forEach(request => {
		const url = request.finalUrl || request.url;
		// a host the browser could not reach is not asked again: the error is its record
		if (url && url.startsWith(HTTPS_PROTOCOL) && !request.fromCache && request.status !== undefined) {
			try {
				const { hostname, port } = new URL(url);
				const record = transport.tls[hostname];
				if ((!record || !record.certificate) && !hosts.has(hostname)) {
					hosts.set(hostname, Number(port) || HTTPS_DEFAULT_PORT);
				}
			} catch {
				// ignored
			}
		}
	});
	await Promise.all(Array.from(hosts.entries()).map(async ([hostname, port]) => {
		const connectionRecord = transport.tls[hostname];
		const record = connectionRecord || { source: TLS_SOURCE_HANDSHAKE };
		record.handshake = new Date().toISOString();
		try {
			const { protocol, cipher, verified, verificationError, derChain, subjectName, validTo } = await handshake(hostname, port, { ignoreCertificateErrors });
			if (connectionRecord) {
				// the handshake is a separate connection, so its leaf is checked against what
				// the browser's own connection reported before it stands in for it
				record.certificateConsistent = subjectName === connectionRecord.subjectName && validTo === connectionRecord.validTo;
				if (!record.certificateConsistent) {
					record.handshakeSubjectName = subjectName;
					record.handshakeValidTo = validTo;
				}
			} else {
				Object.assign(record, { protocol, cipher, subjectName, validTo });
			}
			Object.assign(record, { verified, verificationError });
			record.certificate = await addCertificateChain(transport, derChain);
			record.certificateSource = TLS_SOURCE_HANDSHAKE;
		} catch (error) {
			record.handshakeError = error.message;
		}
		transport.tls[hostname] = record;
	}));
}

function handshake(hostname, port, { ignoreCertificateErrors }) {
	return new Promise((resolve, reject) => {
		const socket = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: !ignoreCertificateErrors });
		const timeoutId = setTimeout(() => {
			socket.destroy();
			reject(new Error("TLS handshake timeout"));
		}, HANDSHAKE_TIMEOUT);
		socket.once("secureConnect", () => {
			clearTimeout(timeoutId);
			try {
				const record = { protocol: socket.getProtocol(), cipher: socket.getCipher().standardName, verified: socket.authorized, derChain: [] };
				if (!socket.authorized && socket.authorizationError) {
					record.verificationError = String(socket.authorizationError.code || socket.authorizationError);
				}
				let certificate = socket.getPeerCertificate(true);
				if (certificate && certificate.subject) {
					record.subjectName = certificate.subject.CN;
					record.validTo = new Date(certificate.valid_to).toISOString();
				}
				while (certificate && certificate.raw) {
					const der = bytesToBase64(certificate.raw);
					if (record.derChain.includes(der)) {
						break;
					}
					record.derChain.push(der);
					certificate = certificate.issuerCertificate;
				}
				resolve(record);
			} catch (error) {
				reject(error);
			} finally {
				socket.end();
			}
		});
		socket.once("error", error => {
			clearTimeout(timeoutId);
			reject(error);
		});
	});
}

function assembleManifest(captureManifest, transport, { engine, engineVersion }) {
	const requests = Array.from(transport.requests.values());
	const tlsSources = new Set(Object.values(transport.tls).map(record => record.source));
	const manifest = Object.assign({
		format: FORMAT,
		version: FORMAT_VERSION,
		producer: { name: PRODUCER_NAME, version, engine, engineVersion }
	}, captureManifest);
	manifest.transport = {
		requests,
		tls: transport.tls,
		certificates: transport.certificates
	};
	manifest.crossChecks = getCrossChecks(captureManifest, requests);
	manifest.coverage = {
		tls: tlsSources.has(TLS_SOURCE_CONNECTION) ? TLS_SOURCE_CONNECTION : tlsSources.has(TLS_SOURCE_HANDSHAKE) ? TLS_SOURCE_HANDSHAKE : COVERAGE_NONE,
		remoteAddress: requests.some(request => request.remote) ? COVERAGE_OBSERVED : COVERAGE_NONE,
		bodies: requests.some(request => request.body) ? COVERAGE_BODIES_DECODED : COVERAGE_NONE,
		redirects: COVERAGE_REDIRECTS
	};
	return manifest;
}

// a URL the browser requested several times can have answered with several bodies, so a
// resource matches when any of them carries its hash, and the check says how many there were.
// A hash taken on text rather than on the bytes can agree with core's, and does for most text,
// but when it does not the two are not comparable and the check says so instead of failing
function getCrossChecks(captureManifest, requests) {
	const bodies = new Map();
	requests.forEach(request => {
		if (request.body && request.body.sha256) {
			const url = request.finalUrl || request.url;
			if (!bodies.has(url)) {
				bodies.set(url, new Map());
			}
			bodies.get(url).set(request.body.sha256, request.body.encoding);
		}
	});
	const crossChecks = [];
	(captureManifest.frames || []).forEach(frame => {
		(frame.resources || []).forEach(resource => {
			const url = resource.finalUrl || resource.url;
			if (resource.sha256 && bodies.has(url)) {
				const hashes = Array.from(bodies.get(url).keys());
				const match = hashes.includes(resource.sha256);
				const transportSha256 = match ? resource.sha256 : hashes[hashes.length - 1];
				const crossCheck = { url, captureSha256: resource.sha256, transportSha256, match };
				if (!match && bodies.get(url).get(transportSha256) != BODY_ENCODING_DECODED) {
					crossCheck.comparable = false;
				}
				if (hashes.length > 1) {
					crossCheck.transportVariants = hashes.length;
				}
				crossChecks.push(crossCheck);
			}
		});
	});
	return crossChecks;
}

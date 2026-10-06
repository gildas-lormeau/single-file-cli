/* global URL, atob */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createHash, X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { cliDirectory, fastCaptureArgs, firefox, importLibModule } from "../target.js";

const execFileAsync = promisify(execFile);
const FIXTURES_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const STYLESHEET = "h2 { background: url(pic.png); color: rgb(1,2,3); }";
const PROTECTED_STYLESHEET = "h3 { color: rgb(4,5,6); }";
const PAGE = "<html><head><link rel=\"stylesheet\" href=\"/cors.css\"><script src=\"/missing.js\"></script></head><body><h2>styled</h2></body></html>";
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), character => character.charCodeAt(0));

function serve(request, response) {
	const { pathname } = new URL(request.url, "http://localhost");
	if (pathname === "/") {
		response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
	} else if (pathname === "/cors.css") {
		response.writeHead(302, { location: "/styles/final.css" }).end();
	} else if (pathname === "/styles/final.css") {
		response.writeHead(200, { "content-type": "text/css", etag: "\"css-1\"" }).end(STYLESHEET);
	} else if (pathname === "/styles/pic.png") {
		response.writeHead(200, { "content-type": "image/png" }).end(PNG);
	} else {
		response.writeHead(404).end();
	}
}

function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

test("--manifest writes a canonical sidecar joining what the page and the network layer saw", { timeout: 120000 }, async () => {
	// served from another host without access-control-allow-origin: the browser loads the
	// sheet, the page cannot read it and the fetch that reads it runs outside the browser
	const protectedServer = createServer((request, response) => response.writeHead(200, { "content-type": "text/css" }).end(PROTECTED_STYLESHEET));
	await new Promise(resolve => protectedServer.listen(0, "127.0.0.1", resolve));
	const protectedUrl = "http://127.0.0.1:" + protectedServer.address().port + "/protected.css";
	const servedPage = PAGE.replace("</head>", "<link rel=\"stylesheet\" href=\"" + protectedUrl + "\"></head>");
	const server = createServer((request, response) => {
		if (new URL(request.url, "http://localhost").pathname === "/") {
			response.writeHead(200, { "content-type": "text/html" }).end(servedPage);
		} else {
			serve(request, response);
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		const url = "http://localhost:" + server.address().port + "/";
		const { stdout } = await execFileAsync(process.execPath, ["single-file-node.js", ...fastCaptureArgs, url, outputPath, "--manifest", "--dump-json"], { cwd: cliDirectory });
		const text = await readFile(outputPath + ".manifest.json", "utf8");
		const manifest = JSON.parse(text);
		const { canonicalize } = await importLibModule("manifest.js");
		assert.equal(canonicalize(manifest), text, "the sidecar is not canonical JSON");
		assert.equal(manifest.format, "singlefile-manifest");
		assert.equal(manifest.version, 1);
		assert.equal(manifest.producer.engine, firefox ? "firefox" : "chromium");
		assert.ok(manifest.producer.engineVersion, "no engine version");
		assert.equal(manifest.subject.url, url);
		const page = await readFile(outputPath);
		assert.equal(manifest.output.sha256, sha256(page), "the output hash is not the hash of the saved file");
		assert.equal(manifest.output.size, page.length);
		assert.equal(manifest.output.filename, outputPath);
		const stylesheetUrl = url + "styles/final.css";
		const stylesheet = manifest.frames[0].resources.find(resource => resource.finalUrl === stylesheetUrl);
		assert.ok(stylesheet, "the stylesheet is not in the page's resources: " + JSON.stringify(manifest.frames[0].resources.map(resource => resource.url)));
		assert.equal(stylesheet.sha256, sha256(STYLESHEET));
		assert.equal(stylesheet.outcome, "embedded");
		const requests = manifest.transport.requests;
		const document = requests.find(request => request.finalUrl === url);
		assert.ok(document, "the document is not in the transport requests");
		assert.equal(document.status, 200);
		assert.equal(document.body.sha256, sha256(servedPage), "the document body hash is not the hash of the served page");
		// Firefox hands a text body back as a string, Chromium as the bytes
		assert.equal(document.body.encoding, firefox ? "text" : "decoded");
		assert.equal(document.redirects.length, 0);
		assert.equal(document.redirectCount, 0);
		const redirected = requests.find(request => request.url === url + "cors.css");
		assert.ok(redirected, "the redirected stylesheet request is not in the transport requests");
		// the count the browser reports and the hops it reported agree for a server redirect;
		// Firefox counts an internal HSTS upgrade without reporting the hop, so the two can differ
		assert.equal(redirected.redirectCount, 1);
		assert.equal(redirected.redirects[0].status, 302);
		assert.equal(redirected.redirects[0].location, "/styles/final.css");
		assert.equal(redirected.finalUrl, stylesheetUrl);
		assert.equal(redirected.headers.etag, "\"css-1\"");
		const missing = requests.find(request => request.url === url + "missing.js");
		assert.equal(missing.status, 404);
		assert.equal(missing.body, undefined, "an error body was hashed");
		const backendFetch = requests.find(request => request.fetchedBy === "cli");
		assert.ok(backendFetch, "the fetch made outside the browser is not in the transport requests");
		assert.equal(backendFetch.url, protectedUrl);
		assert.equal(backendFetch.status, 200);
		assert.equal(backendFetch.body.sha256, sha256(PROTECTED_STYLESHEET));
		assert.equal(backendFetch.redirected, false);
		const protectedStylesheet = manifest.frames[0].resources.find(resource => resource.url === protectedUrl);
		assert.equal(protectedStylesheet.fetchedBy, "cli", "the page's record of the resource does not say the CLI fetched it");
		assert.equal(stylesheet.fetchedBy, "page");
		assert.ok(manifest.crossChecks.length >= 2, "fewer than two cross-checks: " + JSON.stringify(manifest.crossChecks));
		assert.ok(manifest.crossChecks.every(check => check.match), "a cross-check failed: " + JSON.stringify(manifest.crossChecks));
		assert.ok(manifest.crossChecks.some(check => check.url === stylesheetUrl), "the stylesheet was not cross-checked");
		assert.equal(manifest.coverage.bodies, "decoded");
		assert.equal(manifest.coverage.tls, "none");
		if (firefox) {
			assert.equal(manifest.coverage.remoteAddress, "none");
		} else {
			assert.equal(manifest.coverage.remoteAddress, "observed");
			assert.ok(["127.0.0.1", "[::1]"].includes(document.remote.ip), "unexpected server address: " + document.remote.ip);
			assert.equal(document.remote.port, server.address().port);
			assert.equal(document.type, "document");
		}
		assert.equal(manifest.transport.certificates && Object.keys(manifest.transport.certificates).length, 0);
		const metadata = JSON.parse(stdout);
		assert.equal(metadata.manifestFilename, outputPath + ".manifest.json");
		assert.equal(metadata.manifest.output.sha256, manifest.output.sha256, "--dump-json carries another manifest than the sidecar");
	} finally {
		await rm(directory, { recursive: true });
		server.close();
		protectedServer.close();
	}
});

test("--manifest records the TLS certificate of a secure origin", { timeout: 120000 }, async () => {
	const certificatePem = await readFile(join(FIXTURES_DIRECTORY, "localhost-cert.pem"), "utf8");
	const key = await readFile(join(FIXTURES_DIRECTORY, "localhost-key.pem"), "utf8");
	const certificate = new X509Certificate(certificatePem);
	const fingerprint = certificate.fingerprint256.replace(/:/g, "").toLowerCase();
	const server = createSecureServer({ cert: certificatePem, key }, serve);
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		const url = "https://localhost:" + server.address().port + "/";
		await execFileAsync(process.execPath, ["single-file-node.js", ...fastCaptureArgs, url, outputPath, "--manifest", "--browser-ignore-insecure-certs"], { cwd: cliDirectory });
		const manifest = JSON.parse(await readFile(outputPath + ".manifest.json", "utf8"));
		const tls = manifest.transport.tls.localhost;
		assert.ok(tls, "no TLS record for localhost: " + JSON.stringify(Object.keys(manifest.transport.tls)));
		assert.equal(tls.source, firefox ? "handshake" : "connection");
		assert.equal(manifest.coverage.tls, tls.source);
		assert.equal(tls.certificate, fingerprint, "the recorded certificate is not the one the server presented");
		assert.ok(tls.protocol && tls.protocol.startsWith("TLS"), "no TLS protocol: " + JSON.stringify(tls));
		const recorded = manifest.transport.certificates[fingerprint];
		assert.ok(recorded, "the certificate is not in the certificates map");
		assert.equal(recorded.der, certificate.raw.toString("base64"));
		if (firefox) {
			assert.equal(tls.verified, false);
			assert.ok(tls.verificationError, "the self-signed certificate was not reported as unverified");
		} else {
			assert.equal(tls.subjectName, "localhost");
		}
		const document = manifest.transport.requests.find(request => request.finalUrl === url);
		assert.equal(document.body.sha256, sha256(PAGE));
		if (!firefox) {
			assert.equal(document.tls, "localhost");
		}
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
});

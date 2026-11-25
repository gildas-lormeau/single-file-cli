// --add-proof through the command line, against a calendar server of the tests: the suite never
// sends anything to the public servers. The proof is read with the reader of the tests, which
// executes it from the bytes of the saved file as a verifier does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory, fastCaptureArgs } from "../target.js";
import { readProof, startCalendar, sha256 } from "../ots.js";

const execFileAsync = promisify(execFile);
const PAGE = "<html><head><title>proof</title></head><body><p>saved page</p></body></html>";
const CLOSED_PORT_URL = "http://127.0.0.1:1";

async function withPage(callback) {
	const server = createServer((request, response) => response.writeHead(200, { "content-type": "text/html" }).end(PAGE));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		return await callback("http://localhost:" + server.address().port + "/", directory);
	} finally {
		await new Promise(resolve => server.close(resolve));
		await rm(directory, { recursive: true });
	}
}

async function run(args) {
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, ["single-file-node.js", ...fastCaptureArgs, ...args], { cwd: cliDirectory });
		return { exitCode: 0, stdout, stderr };
	} catch (error) {
		return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
	}
}

for (const compressContent of [false, true]) {
	test(`--add-proof writes a proof of the saved file next to it${compressContent ? " with --compress-content" : ""}`, { timeout: 120000 }, async () => {
		const calendars = [await startCalendar(), await startCalendar()];
		try {
			await withPage(async (url, directory) => {
				const outputPath = join(directory, "out.html");
				const args = [url, outputPath, "--add-proof", "--dump-json", "--proof-calendar-url", calendars[0].url, "--proof-calendar-url", calendars[1].url];
				const { exitCode, stdout, stderr } = await run(compressContent ? [...args, "--compress-content"] : args);
				assert.equal(exitCode, 0, stderr);
				const { digest, attestations } = readProof(await readFile(outputPath + ".ots"));
				assert.deepEqual(digest, sha256(await readFile(outputPath)), "the proof is not the proof of the bytes of the saved file");
				assert.deepEqual(attestations.map(attestation => attestation.url), calendars.map(calendar => calendar.url));
				calendars.forEach((calendar, indexCalendar) =>
					assert.deepEqual(attestations[indexCalendar].message, calendar.requests[0].message, "the proof does not lead to the commitment of the server"));
				assert.equal(JSON.parse(stdout).proofFilename, outputPath + ".ots");
				assert.deepEqual((await readdir(directory)).sort(), ["out.html", "out.html.ots"]);
			});
		} finally {
			await Promise.all(calendars.map(calendar => calendar.close()));
		}
	});
}

test("--add-proof warns about a server that fails and makes the proof with the other", { timeout: 120000 }, async () => {
	const calendar = await startCalendar();
	try {
		await withPage(async (url, directory) => {
			const outputPath = join(directory, "out.html");
			const { exitCode, stderr } = await run([url, outputPath, "--add-proof", "--proof-calendar-url", CLOSED_PORT_URL, "--proof-calendar-url", calendar.url]);
			assert.equal(exitCode, 0, stderr);
			assert.match(stderr, /Warning: no timestamp from http:\/\/127\.0\.0\.1:1 /);
			const { attestations } = readProof(await readFile(outputPath + ".ots"));
			assert.deepEqual(attestations.map(attestation => attestation.url), [calendar.url]);
		});
	} finally {
		await calendar.close();
	}
});

test("--add-proof saves the page and reports an error when no server answers", { timeout: 120000 }, async () => {
	await withPage(async (url, directory) => {
		const outputPath = join(directory, "out.html");
		const { exitCode, stderr } = await run([url, outputPath, "--add-proof", "--proof-calendar-url", CLOSED_PORT_URL]);
		assert.equal(exitCode, 1);
		assert.match(stderr, /The page was saved without its proof of existence/);
		assert.deepEqual(await readdir(directory), ["out.html"]);
		assert.ok((await readFile(outputPath, "utf8")).includes("saved page"));
	});
});

test("--add-proof does not overwrite a proof that is already there", { timeout: 120000 }, async () => {
	const calendar = await startCalendar();
	try {
		await withPage(async (url, directory) => {
			const outputPath = join(directory, "out.html");
			await writeFile(outputPath + ".ots", "the proof of a page that was moved");
			const { exitCode, stderr } = await run([url, outputPath, "--add-proof", "--proof-calendar-url", calendar.url]);
			assert.equal(exitCode, 1);
			assert.match(stderr, /The page was saved without its proof of existence/);
			assert.equal(await readFile(outputPath + ".ots", "utf8"), "the proof of a page that was moved");
			const overwriting = await run([url, outputPath, "--add-proof", "--proof-calendar-url", calendar.url, "--filename-conflict-action", "overwrite"]);
			assert.equal(overwriting.exitCode, 0, overwriting.stderr);
			assert.deepEqual(readProof(await readFile(outputPath + ".ots")).digest, sha256(await readFile(outputPath)));
		});
	} finally {
		await calendar.close();
	}
});

test("--add-proof makes the proofs of the pages as --crawl-replace-urls leaves them", { timeout: 120000 }, async () => {
	// the links are rewritten once every page is saved: a proof made when a page is saved would
	// be the proof of a file that is replaced
	const server = createServer((request, response) => {
		const origin = "http://localhost:" + server.address().port;
		const pages = {
			"/": "<html><head><title>first</title></head><body><a href=\"" + origin + "/second\">second</a></body></html>",
			"/second": "<html><head><title>second</title></head><body><a href=\"" + origin + "/\">first</a></body></html>"
		};
		response.writeHead(pages[request.url] ? 200 : 404, { "content-type": "text/html" }).end(pages[request.url] || "");
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const calendar = await startCalendar();
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const url = "http://localhost:" + server.address().port + "/";
		const { exitCode, stderr } = await run([url, "--output-directory", directory, "--crawl-links", "--crawl-replace-urls", "--add-proof", "--proof-calendar-url", calendar.url, "--filename-template", "{page-title}.html"]);
		assert.equal(exitCode, 0, stderr);
		assert.deepEqual((await readdir(directory)).sort(), ["first.html", "first.html.ots", "second.html", "second.html.ots"]);
		for (const [name, linkedName] of [["first.html", "second.html"], ["second.html", "first.html"]]) {
			const page = await readFile(join(directory, name));
			assert.ok(page.toString().includes("href=" + linkedName) || page.toString().includes("href=\"" + linkedName + "\""), "the link of " + name + " was not rewritten: the test does not cover the rewrite");
			const { digest, attestations } = readProof(await readFile(join(directory, name + ".ots")));
			assert.deepEqual(digest, sha256(page), "the proof of " + name + " is not the proof of the file on disk");
			assert.ok(calendar.requests.some(request => request.message.equals(attestations[0].message)), "the proof of " + name + " does not lead to a commitment of the server");
		}
	} finally {
		await calendar.close();
		await new Promise(resolve => server.close(resolve));
		await rm(directory, { recursive: true });
	}
});

const INCOMPATIBLE_OPTIONS = {
	"--dump-content": ["--dump-content"],
	"--crawl-save-archive": ["out.zip", "--crawl-links", "--crawl-save-archive", "--compress-content"]
};

for (const [name, args] of Object.entries(INCOMPATIBLE_OPTIONS)) {
	test(`--add-proof is refused with ${name}`, { timeout: 120000 }, async () => {
		const { exitCode, stderr } = await run(["http://localhost:1/", ...args, "--add-proof", "--proof-calendar-url", CLOSED_PORT_URL]);
		assert.notEqual(exitCode, 0);
		assert.match(stderr, new RegExp("--add-proof is not compatible with " + name));
	});
}

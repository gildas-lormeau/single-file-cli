/* global URL */

// Captures started at the same moment must each drive their own browser.
//
// The CLI draws the debugging port of the browser at random among 256 ports, keeps it when nothing
// answers on it, and launches the browser on it. Two processes started together can draw the same
// port: both find it free and both launch a browser on it. The first browser binds the port on the
// IPv4 loopback address, the second falls back to the IPv6 one, and the CLI addressed the browser as
// "localhost", which reaches either. Either the two captures failed together with a bare "Error"
// thrown from the WebSocket of the CDP client, or they both ended normally with a page captured
// through the browser of the other process, i.e. with its window, its profile and its cookies. In
// the test suite, where the files run in parallel, this showed as pairs of failures at the same
// second, green on the next run.
//
// The CLI now addresses the browser by IP, checks that the browser answering there is the one it
// launched (its command line holds the profile directory made for it), and launches it again on
// another port when it is not.
//
// The collision is forced here instead of awaited: Math.random is replaced in the CLI processes by
// a sequence that is the same in all of them, so that they draw the same ports in the same order. Each capture is
// given its own window width, a property of the browser and not of the page, and the page reports
// the width it sees to the server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory, fastCaptureArgs, firefox } from "../target.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT = 120000;
const ROUNDS = 5;
const CAPTURES = [{ name: "first", width: 700 }, { name: "second", width: 900 }];
const BROWSER_HEIGHT = 600;
const WIDTH_TOLERANCE = 20;
// the same sequence in every process, and not a constant: a port found busy is drawn again;
// NODE_OPTIONS is split on spaces, so the module holds none
const SHARED_RANDOM_OPTION = "--import=data:text/javascript,globalThis.drawCount=0;Math.random=()=>(globalThis.drawCount++*0.37)%1";

test("captures started together each use their own browser", { timeout: TEST_TIMEOUT }, async () => {
	const reports = [];
	const server = createServer((request, response) => {
		const { pathname, searchParams } = new URL(request.url, "http://localhost");
		if (pathname == "/report") {
			reports.push({ name: searchParams.get("name"), width: Number(searchParams.get("width")) });
			response.writeHead(204).end();
		} else {
			response.writeHead(200, { "content-type": "text/html" }).end(
				"<html><body><p>page</p><script>fetch('/report?name=" + pathname.substring(1) + "&width=' + window.outerWidth)</script></body></html>");
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		// several rounds: with a shared port, which browser answers each process is not decided
		for (let indexRound = 0; indexRound < ROUNDS; indexRound++) {
			await Promise.all(CAPTURES.map(({ name, width }) => execFileAsync(process.execPath, [
				"single-file-node.js", ...fastCaptureArgs,
				"http://localhost:" + server.address().port + "/" + name,
				join(directory, name + "-" + indexRound + ".html"),
				"--browser-width=" + width, "--browser-height=" + BROWSER_HEIGHT
			], { cwd: cliDirectory, env: { ...process.env, NODE_OPTIONS: SHARED_RANDOM_OPTION } })));
		}
		CAPTURES.forEach(({ name, width }) => {
			// a window that is not laid out yet reports 0, which says nothing about the browser
			const widths = reports.filter(report => report.name == name && report.width).map(report => report.width);
			assert.notEqual(widths.length, 0, "the page of the " + name + " capture did not report a width: " + JSON.stringify(reports));
			assert.equal(widths.every(reportedWidth => Math.abs(reportedWidth - width) <= WIDTH_TOLERANCE), true,
				"the page of the " + name + " capture was displayed in a window of another width than " + width + ": " + JSON.stringify(widths));
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
		server.close();
	}
});

// the browser arguments given by the user replace the ones of the CLI: the port they set is the one
// the browser listens on, the CLI used to wait for the browser on the port it had drawn
test("a debugging port given in the browser arguments is the one used", { timeout: TEST_TIMEOUT, skip: firefox && "Firefox tells its port in its profile directory" }, async () => {
	const server = createServer((request, response) =>
		response.writeHead(200, { "content-type": "text/html" }).end("<html><body><p>page</p></body></html>"));
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const portServer = createServer();
	await new Promise(resolve => portServer.listen(0, "127.0.0.1", resolve));
	const debugPort = portServer.address().port;
	await new Promise(resolve => portServer.close(resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const { stderr } = await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, "http://localhost:" + server.address().port + "/", join(directory, "out.html"),
			"--browser-args", JSON.stringify(["--remote-debugging-port=" + debugPort])
		], { cwd: cliDirectory });
		assert.equal(stderr, "");
	} finally {
		await rm(directory, { recursive: true, force: true });
		server.close();
	}
});

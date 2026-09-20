/* global URL */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory, fastCaptureArgs, firefox } from "../target.js";

const execFileAsync = promisify(execFile);

// A JavaScript dialog stops the renderer until it is answered, and the CDP client answered none: an
// alert in an inline script ended in "Load timeout" after --browser-load-max-time with no file, and
// one fired after load hung the process for ever, past every timeout the CLI has. The dialog is now
// dismissed as soon as the browser reports it, so the page runs on as if the user had closed it:
// confirm() returns false and prompt() null. Firefox dismisses prompts on its own under BiDi.

// long enough for a capture, short enough that a hang fails the case instead of the runner
const KILL_AFTER = 60000;
const HTML_HEADERS = { "content-type": "text/html" };

async function serve(handler, host) {
	const server = createServer(handler);
	await new Promise(resolve => server.listen(0, host, resolve));
	return {
		url: "http://" + host + ":" + server.address().port + "/",
		close() {
			server.closeAllConnections();
			server.close();
		}
	};
}

function servePage(body) {
	return (_, response) => response.writeHead(200, HTML_HEADERS).end("<html><head><title>Dialogs</title></head><body>" + body + "</body></html>");
}

async function capture(url, args = []) {
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "page.html");
		try {
			await execFileAsync(process.execPath, ["single-file-node.js", ...fastCaptureArgs, ...args, url, outputPath], { cwd: cliDirectory, timeout: KILL_AFTER });
		} catch (error) {
			return { error, content: await readFile(outputPath, "utf8").catch(() => "") };
		}
		return { content: await readFile(outputPath, "utf8") };
	} finally {
		await rm(directory, { recursive: true });
	}
}

function describeFailure(error) {
	return error.killed ? "the CLI hung and was killed after " + KILL_AFTER + " ms" : (error.stderr || error.message);
}

test("an alert in an inline script does not block the capture", { timeout: 120000 }, async () => {
	const server = await serve(servePage("<p>before</p><script>alert('during parsing')</script><p>AFTER_INLINE_ALERT</p>"), "localhost");
	try {
		const { error, content } = await capture(server.url);
		assert.ok(!error, "the capture failed: " + (error && describeFailure(error)));
		assert.ok(content.includes("AFTER_INLINE_ALERT"), "the page was cut at the alert: " + content);
	} finally {
		server.close();
	}
});

test("an alert fired after load does not block the capture", { timeout: 120000 }, async () => {
	// the marker follows the alert, so it is only in the saved page if the script ran on after
	// the dialog; the wait keeps the capture from starting before the timer fires
	const server = await serve(servePage("<p>before</p><script>setTimeout(() => { alert('after load'); document.body.insertAdjacentHTML('beforeend', '<p>AFTER_LATE_ALERT</p>'); }, 300)</script>"), "localhost");
	try {
		const { error, content } = await capture(server.url, ["--browser-wait-until-delay=1500"]);
		assert.ok(!error, "the capture failed: " + (error && describeFailure(error)));
		assert.ok(content.includes("AFTER_LATE_ALERT"), "the script did not run on after the alert: " + content);
	} finally {
		server.close();
	}
});

test("confirm and prompt are dismissed rather than accepted", { timeout: 120000 }, async () => {
	const server = await serve(servePage("<p id=result></p><script>document.getElementById('result').textContent = (confirm('?') ? 'CONFIRM_ACCEPTED' : 'CONFIRM_DISMISSED') + ' ' + (prompt('?', 'x') === null ? 'PROMPT_DISMISSED' : 'PROMPT_ANSWERED')</script>"), "localhost");
	try {
		const { error, content } = await capture(server.url);
		assert.ok(!error, "the capture failed: " + (error && describeFailure(error)));
		assert.ok(content.includes("CONFIRM_DISMISSED"), "confirm() was not answered false: " + (content.match(/<p id=result[^<]*/) || content));
		assert.ok(content.includes("PROMPT_DISMISSED"), "prompt() was not answered null: " + (content.match(/<p id=result[^<]*/) || content));
	} finally {
		server.close();
	}
});

test("an alert in a cross-origin frame does not block the capture", { timeout: 120000 }, async () => {
	// localhost and 127.0.0.1 are different sites, so the frame renders out of process and its
	// dialog is reported on the frame's own session
	const frameServer = await serve(servePage("<script>alert('in the frame')</script><p>AFTER_FRAME_ALERT</p>"), "127.0.0.1");
	const server = await serve(servePage("<iframe src=\"" + frameServer.url + "frame.html\"></iframe>"), "localhost");
	try {
		const { error, content } = await capture(server.url);
		assert.ok(!error, "the capture failed: " + (error && describeFailure(error)));
		assert.ok(content.includes("AFTER_FRAME_ALERT"), "the frame was cut at its alert: " + content);
	} finally {
		server.close();
		frameServer.close();
	}
});

test("a page that stops answering after the load timeout ends in a capture timeout", { timeout: 120000, skip: firefox && "the load fallback is a path of the CDP client" }, async () => {
	// a request the server never answers keeps networkIdle out of reach, and the loop started
	// after load stops the renderer before the load timeout stops the page: the fallback then
	// asked the stopped renderer for the capture context with no bound at all
	const server = await serve((request, response) => {
		if (new URL(request.url, "http://localhost").pathname !== "/pending") {
			servePage("<p>before</p><script>fetch('/pending'); setTimeout(() => { while (true); }, 200)</script>")(request, response);
		}
	}, "localhost");
	try {
		const { error } = await capture(server.url, ["--browser-load-max-time=2000", "--browser-capture-max-time=2000"]);
		assert.ok(error, "expected the capture to fail");
		assert.ok(!error.killed, describeFailure(error));
		assert.ok((error.stderr || "").includes("Capture timeout"), "expected a capture timeout, got: " + describeFailure(error));
	} finally {
		server.close();
	}
});

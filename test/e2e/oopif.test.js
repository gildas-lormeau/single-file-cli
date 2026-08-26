import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const execFileAsync = promisify(execFile);
const cliDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FRAME_MARKER = "OUT_OF_PROCESS_FRAME_CONTENT";

test("cross-origin frames are captured in the saved page", { timeout: 120000 }, async () => {
	// localhost and 127.0.0.1 are different sites, so site isolation renders
	// the frame out of process, in a separate CDP target
	const frameServer = createServer((request, response) => {
		response.writeHead(200, { "content-type": "text/html" }).end("<html><body><p>" + FRAME_MARKER + "</p></body></html>");
	});
	await new Promise(resolve => frameServer.listen(0, "127.0.0.1", resolve));
	const frameUrl = "http://127.0.0.1:" + frameServer.address().port + "/frame.html";
	const server = createServer((request, response) => {
		response.writeHead(200, { "content-type": "text/html" }).end("<html><body><iframe src=\"" + frameUrl + "\"></iframe></body></html>");
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		const url = "http://localhost:" + server.address().port + "/top.html";
		await execFileAsync(process.execPath, ["single-file-node.js", url, outputPath], { cwd: cliDirectory });
		const content = await readFile(outputPath, "utf8");
		assert.ok(content.includes(FRAME_MARKER), "the out-of-process frame was saved empty");
	} finally {
		await rm(directory, { recursive: true });
		server.close();
		frameServer.close();
	}
});

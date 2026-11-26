import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory, fastCaptureArgs } from "../target.js";

const execFileAsync = promisify(execFile);
// values no browser sends on its own: the browser requests the two files as well when it loads the
// page, and Firefox does it with the very string the options have for default, so a check on the
// default values could not tell the request of the capture from the request of the page
const VIDEO_ACCEPT_HEADER = "video/x-single-file-test";
const AUDIO_ACCEPT_HEADER = "audio/x-single-file-test";

// The capture fetches the media files itself to embed them, and a server may pick the format it
// answers with from the accept header. The options for fonts, images, stylesheets, scripts and
// documents existed without their video and audio counterparts, so these two requests went out
// with "*/*" whatever the user asked for.
test("the accept headers for videos and audios are sent with the media requests", { timeout: 120000 }, async () => {
	const requests = [];
	const server = createServer((request, response) => {
		requests.push({ url: request.url, accept: request.headers.accept });
		if (request.url == "/clip.webm") {
			response.writeHead(200, { "content-type": "video/webm" }).end("video");
		} else if (request.url == "/sound.ogg") {
			response.writeHead(200, { "content-type": "audio/ogg" }).end("audio");
		} else {
			response.writeHead(200, { "content-type": "text/html" }).end(
				"<html><body><video src=\"clip.webm\"></video><audio src=\"sound.ogg\"></audio></body></html>");
		}
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		// videos and audios are blocked by default, and a blocked file is not requested at all
		await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, "--block-videos=false", "--block-audios=false",
			"--accept-header-video=" + VIDEO_ACCEPT_HEADER, "--accept-header-audio=" + AUDIO_ACCEPT_HEADER,
			"http://localhost:" + server.address().port + "/", join(directory, "out.html")
		], { cwd: cliDirectory });
		assert.ok(requests.some(({ url, accept }) => url == "/clip.webm" && accept == VIDEO_ACCEPT_HEADER),
			"no request for the video carried the accept header of the option");
		assert.ok(requests.some(({ url, accept }) => url == "/sound.ogg" && accept == AUDIO_ACCEPT_HEADER),
			"no request for the audio carried the accept header of the option");
	} finally {
		await rm(directory, { recursive: true });
		server.close();
	}
});

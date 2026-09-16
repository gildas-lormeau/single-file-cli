import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { cliDirectory, fastCaptureArgs } from "../target.js";

const execFileAsync = promisify(execFile);
const STYLE = "rgb(11,22,33)";

// The fetch lane running outside the browser presents no identity of its own, so it has to send the
// referer the browser would have computed from the referrer policy of the document. Without it,
// servers protecting their resources against hotlinking refuse to serve them and the saved page
// loses them silently: www.apple.com/wss/fonts answers an empty 404, taking every font with it.
//
// The stylesheet below is served without access-control-allow-origin on purpose. The browser loads
// it, but SingleFile cannot read the rules of a cross-origin sheet and the fetch it makes to read
// them is the one CORS blocks, which is precisely what sends the request outside the browser.
async function capture({ responseHeaders = {}, meta = "" } = {}) {
	const requests = [];
	const resourceServer = createServer((request, response) => {
		requests.push(request.headers);
		response.writeHead(200, { "content-type": "text/css" }).end("h2 { color: " + STYLE + "; }");
	});
	await new Promise(resolve => resourceServer.listen(0, "127.0.0.1", resolve));
	// another host, so the stylesheet is cross-origin to the page
	const styleUrl = "http://127.0.0.1:" + resourceServer.address().port + "/hotlink-protected.css";
	const server = createServer((request, response) => {
		response.writeHead(200, Object.assign({ "content-type": "text/html" }, responseHeaders)).end(
			"<html><head>" + meta + "<link rel=\"stylesheet\" href=\"" + styleUrl + "\"></head><body><h2>styled</h2></body></html>");
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const outputPath = join(directory, "out.html");
		const pageOrigin = "http://localhost:" + server.address().port;
		const pageUrl = pageOrigin + "/top.html";
		await execFileAsync(process.execPath, [
			"single-file-node.js", ...fastCaptureArgs, pageUrl, outputPath
		], { cwd: cliDirectory });
		const content = await readFile(outputPath, "utf8");
		// a request made by the browser carries a destination and a site, which a runtime has no
		// notion of. Node sends "sec-fetch-mode" since v26 and telling the two apart by that header
		// alone stopped working, silently, in the direction of a test that proves nothing
		const backendRequests = requests.filter(headers => !headers["sec-fetch-dest"] && !headers["sec-fetch-site"]);
		return { content, backendRequests, pageUrl, pageOrigin };
	} finally {
		await rm(directory, { recursive: true });
		server.close();
		resourceServer.close();
	}
}

test("the fetch outside the browser sends the referer of the document", { timeout: 120000 }, async () => {
	const { content, backendRequests, pageOrigin } = await capture();
	assert.ok(backendRequests.length, "the stylesheet was never fetched outside the browser");
	assert.equal(backendRequests[0].referer, pageOrigin + "/", "the referer of a cross-origin resource is the origin of the document");
	assert.ok(content.includes(STYLE), "the cross-origin stylesheet was not inlined");
});

test("a document asking for no referrer gets none", { timeout: 120000 }, async () => {
	const { backendRequests } = await capture({ responseHeaders: { "referrer-policy": "no-referrer" } });
	assert.ok(backendRequests.length, "the stylesheet was never fetched outside the browser");
	assert.equal(backendRequests[0].referer, undefined, "the referer was sent although the document asked for none");
});

test("a meta asking for the full URL gets it", { timeout: 120000 }, async () => {
	const { backendRequests, pageUrl } = await capture({ meta: "<meta name=\"referrer\" content=\"unsafe-url\">" });
	assert.ok(backendRequests.length, "the stylesheet was never fetched outside the browser");
	assert.equal(backendRequests[0].referer, pageUrl, "the meta asking for unsafe-url did not widen the referer");
});

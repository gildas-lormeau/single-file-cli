/* global URL */

// A fixture is a directory, not a string of HTML: the interesting cases need a stylesheet the page
// links to, a font it loads, a frame it embeds. Serving them over http rather than opening them as
// file:// keeps the capture on the path a real save takes — same-origin frames, ordinary requests,
// no local-file exceptions.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const CONTENT_TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ttf": "font/ttf",
	".woff2": "font/woff2"
};

// Chrome asks for a favicon on every navigation and its absence says nothing about the fixture.
// Nothing else is excused: the archive writer used to ask the captured site for a zip worker that
// site had never heard of, three times per save, and this list is where that would have been
// quietly tolerated. It is a real request to a real server, so it is a failure here.
const IGNORED_MISS_PATTERNS = [/^\/favicon\.ico$/];

export { startServer };

async function startServer(rootDirectory) {
	// A page that failed to load renders identically to itself, so the noise floor is zero and the
	// save of that same failure matches it: a fixture with a broken path passes every check while
	// testing nothing. It has already happened here — a directory served as a file gave two
	// beautifully identical 404 pages. Every miss is recorded so a check can refuse to conclude.
	const misses = [];
	const server = createServer((request, response) => {
		// a fixture directory holds only what the fixture needs, and the path still gets normalised
		// before it is joined: a test server that walks out of its root is a test server that can
		// silently serve the file it was meant to prove absent
		const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
		const relativePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
		const path = join(rootDirectory, relativePath || "index.html", pathname.endsWith("/") ? "index.html" : "");
		readFile(path)
			.then(content => response
				.writeHead(200, {
					"content-type": CONTENT_TYPES[extname(path)] || "application/octet-stream",
					// a sandboxed frame has an opaque origin, so the font it declares is fetched
					// cross-origin and fonts are CORS-restricted. Without this the frame fixture
					// would be measuring the headers of this server rather than the save
					"access-control-allow-origin": "*"
				})
				.end(content))
			.catch(() => {
				if (!IGNORED_MISS_PATTERNS.some(pattern => pattern.test(pathname))) {
					misses.push(pathname);
				}
				response.writeHead(404).end();
			});
	});
	await new Promise(resolve => server.listen(0, "localhost", resolve));
	return {
		url: "http://localhost:" + server.address().port + "/",
		misses,
		close: () => new Promise(resolve => server.close(resolve))
	};
}

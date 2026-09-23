#!/usr/bin/env -S deno run --allow-net

/* global Deno, URL, Response */

// A stand-in for a Chromium-based browser that answers every CDP command except
// Emulation.setUserAgentOverride, which it leaves pending for ever. Vivaldi 8.2 does exactly this
// in headless mode on Windows: the CLI sends the override to remove the "Headless" token from the
// user agent, gets no response, and used to wait with no limit (gildas-lormeau/tmp run 35904197334).

const PORT_ARGUMENT_PREFIX = "--remote-debugging-port=";
const TARGET_ID = "unresponsive";

const port = Number(Deno.args.find(arg => arg.startsWith(PORT_ARGUMENT_PREFIX)).substring(PORT_ARGUMENT_PREFIX.length));
const origin = "127.0.0.1:" + port;

Deno.serve({ hostname: "127.0.0.1", port, onListen() { } }, request => {
	const { pathname } = new URL(request.url);
	if (request.headers.get("upgrade") == "websocket") {
		const { socket, response } = Deno.upgradeWebSocket(request);
		socket.onmessage = ({ data }) => {
			const { id, method, sessionId } = JSON.parse(data);
			if (method == "Emulation.setUserAgentOverride") {
				return;
			}
			const result = method == "Browser.getVersion" ?
				{ product: "HeadlessChrome/150.0.0.0", userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/537.36" } :
				{};
			socket.send(JSON.stringify({ id, result, sessionId }));
		};
		return response;
	} else if (pathname == "/json/version") {
		return Response.json({ Browser: "HeadlessChrome/150.0.0.0", webSocketDebuggerUrl: "ws://" + origin + "/devtools/browser/" + TARGET_ID });
	} else if (pathname == "/json/new") {
		return Response.json({ id: TARGET_ID, type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://" + origin + "/devtools/page/" + TARGET_ID });
	} else if (pathname == "/json/list") {
		return Response.json([]);
	} else {
		return new Response("");
	}
});

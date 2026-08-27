import { spawn } from "node:child_process";
import process from "node:process";
import { CDP, options } from "simple-cdp";

const PORT = 9447;
const PROFILE = "/Users/gildas/Desktop/Dev/project-single-file/tmp/multi-site-profile";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const URL_PAGE = process.argv[2];
const PATCH_ENABLED = process.argv[3] != "off";
const HEIGHT = Number(process.argv[4] || 0);

const child = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
	"--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + PROFILE,
	"--user-agent=" + UA, "--password-store=basic", "--use-mock-keychain",
	"--no-first-run", "--no-default-browser-check", "--window-size=1280,720", "about:blank"
], { stdio: "ignore" });

options.apiUrl = "http://localhost:" + PORT;
const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));

const PATCH = `
(() => {
	const ITEM_SELECTOR = "article, [data-testid=cellInnerDiv]";
	globalThis.__keep = { removeChild: 0, remove: 0, replaceChild: 0, serial: 0, recycled: 0 };
	const ALL = "__MODE__" === "all";
	const isProtected = node => node && node.nodeType === 1 &&
		(ALL || node.matches(ITEM_SELECTOR) || node.querySelector(ITEM_SELECTOR));
	const originalRemoveChild = Node.prototype.removeChild;
	const originalRemove = Element.prototype.remove;
	const originalReplaceChild = Node.prototype.replaceChild;
	Node.prototype.removeChild = function (child) {
		if (isProtected(child)) { globalThis.__keep.removeChild++; return child; }
		return originalRemoveChild.call(this, child);
	};
	Element.prototype.remove = function () {
		if (isProtected(this)) { globalThis.__keep.remove++; return; }
		return originalRemove.call(this);
	};
	Node.prototype.replaceChild = function (newChild, oldChild) {
		if (isProtected(oldChild)) { globalThis.__keep.replaceChild++; return oldChild; }
		return originalReplaceChild.call(this, newChild, oldChild);
	};
})();
`;

const SCROLL = `(async () => {
	const wait = delay => new Promise(resolve => setTimeout(resolve, delay));
	const count = () => document.querySelectorAll("article").length;
	const trace = [];
	scrollTo(0, 0);
	await wait(1000);
	let stable = 0, previous = -1;
	for (let step = 0; step < 600 && stable < 15; step++) {
		scrollBy(0, innerHeight * 0.8);
		await wait(800);
		const current = count();
		stable = current === previous ? stable + 1 : 0;
		previous = current;
		if (step % 20 === 0) { trace.push(current); }
	}
	return JSON.stringify({
		articles: count(),
		trace,
		keep: globalThis.__keep || null,
		scrollHeight: document.scrollingElement.scrollHeight
	});
})()`;

try {
	const targetInfo = await CDP.createTarget("about:blank");
	const cdp = new CDP(targetInfo);
	await cdp.Page.enable();
	await cdp.Runtime.enable();
	if (PATCH_ENABLED) {
		await cdp.Page.addScriptToEvaluateOnNewDocument({ source: PATCH.replace("__MODE__", process.argv[5] || "scoped") });
	}
	if (HEIGHT) {
		await cdp.Emulation.setDeviceMetricsOverride({ width: 1280, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
	}
	await cdp.Page.navigate({ url: URL_PAGE });
	await sleep(12000);
	const { result } = await cdp.Runtime.evaluate({ expression: SCROLL, returnByValue: true, awaitPromise: true });
	console.log((PATCH_ENABLED ? "PATCHED" : "CONTROL") + " height=" + (HEIGHT || 720) + " " + result.value);
} catch (error) {
	console.log("ERROR " + error.message);
} finally {
	child.kill("SIGKILL");
	process.exit(0);
}

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { CDP, options } from "simple-cdp";

const PORT = 9448;
const PROFILE = "/Users/gildas/Desktop/Dev/project-single-file/tmp/multi-site-profile";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const URL_PAGE = process.argv[2];
const SCRIPT_PATH = process.argv[3];

const child = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
	"--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + PROFILE,
	"--user-agent=" + UA, "--password-store=basic", "--use-mock-keychain",
	"--no-first-run", "--no-default-browser-check", "--window-size=1280,720", "about:blank"
], { stdio: "ignore" });

options.apiUrl = "http://localhost:" + PORT;
const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));

const DRIVE = `(async () => {
	const originalMethods = {
		removeChild: Node.prototype.removeChild,
		remove: Element.prototype.remove,
		replaceChild: Node.prototype.replaceChild
	};
	const before = document.querySelectorAll("article").length;
	const response = new Promise(resolve => addEventListener("single-file-on-before-capture-response", resolve, { once: true }));
	const event = new CustomEvent("single-file-on-before-capture-request", { cancelable: true });
	dispatchEvent(event);
	if (!event.defaultPrevented) { return JSON.stringify({ error: "listener did not call preventDefault" }); }
	await response;
	const after = document.querySelectorAll("article").length;
	const patchedDuringCapture = Node.prototype.removeChild !== originalMethods.removeChild;
	dispatchEvent(new CustomEvent("single-file-on-after-capture-request"));
	await new Promise(resolve => setTimeout(resolve, 500));
	return JSON.stringify({
		before, after, patchedDuringCapture,
		restoredExactly: Node.prototype.removeChild === originalMethods.removeChild &&
			Element.prototype.remove === originalMethods.remove &&
			Node.prototype.replaceChild === originalMethods.replaceChild
	});
})()`;

try {
	const source = await readFile(SCRIPT_PATH, "utf8");
	const targetInfo = await CDP.createTarget("about:blank");
	const cdp = new CDP(targetInfo);
	await cdp.Page.enable();
	await cdp.Runtime.enable();
	await cdp.Page.addScriptToEvaluateOnNewDocument({ source });
	await cdp.Page.navigate({ url: URL_PAGE });
	await sleep(12000);
	const { result } = await cdp.Runtime.evaluate({ expression: DRIVE, returnByValue: true, awaitPromise: true, timeout: 300000 });
	console.log("RESULT " + result.value);
} catch (error) {
	console.log("ERROR " + error.message);
} finally {
	child.kill("SIGKILL");
	process.exit(0);
}

import { spawn } from "node:child_process";
import process from "node:process";
import { CDP, options } from "simple-cdp";

const PORT = 9449;
const PROFILE = "/Users/gildas/Desktop/Dev/project-single-file/tmp/multi-site-profile";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

const child = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
	"--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + PROFILE,
	"--user-agent=" + UA, "--password-store=basic", "--use-mock-keychain",
	"--no-first-run", "--no-default-browser-check", "--window-size=1280,720", "about:blank"
], { stdio: "ignore" });

options.apiUrl = "http://localhost:" + PORT;
const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));

const CHECK = `(() => {
	const targets = {
		"Node.removeChild": Node.prototype.removeChild,
		"Node.insertBefore": Node.prototype.insertBefore,
		"Node.appendChild": Node.prototype.appendChild,
		"Node.replaceChild": Node.prototype.replaceChild,
		"Element.remove": Element.prototype.remove,
		"Element.attachShadow": Element.prototype.attachShadow,
		"Element.querySelector": Element.prototype.querySelector,
		"document.createElement": document.createElement,
		"JSON.stringify": JSON.stringify,
		"Function.toString": Function.prototype.toString,
		"navigator.webdriver": Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver") ? "descriptor present" : "absent"
	};
	const report = {};
	Object.keys(targets).forEach(name => {
		const value = targets[name];
		report[name] = typeof value == "function"
			? (value.toString().includes("[native code]") ? "native" : value.toString().slice(0, 120))
			: value;
	});
	return JSON.stringify(report, null, 1);
})()`;

try {
	const targetInfo = await CDP.createTarget("about:blank");
	const cdp = new CDP(targetInfo);
	await cdp.Page.enable();
	await cdp.Runtime.enable();
	await cdp.Page.navigate({ url: process.argv[2] });
	await sleep(12000);
	const { result } = await cdp.Runtime.evaluate({ expression: CHECK, returnByValue: true });
	console.log(result.value);
} catch (error) {
	console.log("ERROR " + error.message);
} finally {
	child.kill("SIGKILL");
	process.exit(0);
}

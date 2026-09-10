/*
 * Copyright 2010-2026 Gildas Lormeau
 * contact : gildas.lormeau <at> gmail.com
 *
 * This file is part of SingleFile.
 *
 *   The code in this file is free software: you can redistribute it and/or
 *   modify it under the terms of the GNU Affero General Public License
 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
 *   of the License, or (at your option) any later version.
 *
 *   The code in this file is distributed in the hope that it will be useful,
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
 *   General Public License for more details.
 *
 *   As additional permission under GNU AGPL version 3 section 7, you may
 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU
 *   AGPL normally required by section 4, provided you include this license
 *   notice and a URL through which recipients can access the Corresponding
 *   Source.
 */

/* global setTimeout, TextEncoder, atob */

import { CDP, options as cdpOptions } from "simple-cdp";
import { launchChromium, closeChromium } from "./../lib/chromium.js";
import { Deno } from "./../lib/deno-polyfill.js";

const { args, writeTextFile, writeFile, stdout, exit } = Deno;

const LOCALHOST = "http://localhost:";
const EMPTY_PAGE_URL = "about:blank";
const OUTER_HTML_EXPRESSION = "document.documentElement.outerHTML";
const DEFAULT_MAX_DELAY = 30000;
const DEFAULT_STABLE_DELAY = 1000;
const POLL_DELAY = 100;
const USAGE = `Usage: node tools/dump-dom.js <url> [options]

  --wait-for <expression>          dump when this JavaScript expression is truthy
  --stable-for <ms>                otherwise, dump when the DOM has not changed for this long (default ${DEFAULT_STABLE_DELAY})
  --timeout <ms>                   give up after this long (default ${DEFAULT_MAX_DELAY})
  --output <file>                  write the DOM to this file instead of stdout
  --screenshot <file>              also write a PNG, and leave the DOM out of stdout
  --full-page                      capture the whole page instead of the viewport
  --browser-width <px>             viewport width
  --browser-height <px>            viewport height
  --browser-executable-path <path> browser to run
  --show-browser                   run with a window instead of headless`;

const OPTION_NAMES = {
	"--wait-for": "waitFor",
	"--stable-for": "stableDelay",
	"--timeout": "maxDelay",
	"--output": "output",
	"--screenshot": "screenshot",
	"--browser-width": "browserWidth",
	"--browser-height": "browserHeight",
	"--browser-executable-path": "browserExecutablePath"
};
const FLAG_NAMES = {
	"--show-browser": "showBrowser",
	"--full-page": "fullPage"
};
const NUMBER_OPTION_NAMES = ["stableDelay", "maxDelay", "browserWidth", "browserHeight"];

let options;
try {
	options = parseArguments(args);
} catch (error) {
	console.error(error.message); // eslint-disable-line no-console
	console.error(USAGE); // eslint-disable-line no-console
	exit(1);
}
let exitCode = 0;
try {
	const { content, screenshot } = await capture(options);
	if (options.output) {
		await writeTextFile(options.output, content);
	} else if (!options.screenshot) {
		await stdout.write(new TextEncoder().encode(content + "\n"));
	}
	if (screenshot) {
		await writeFile(options.screenshot, screenshot);
	}
} catch (error) {
	console.error(error.message || error); // eslint-disable-line no-console
	exitCode = 1;
} finally {
	await closeChromium();
}
exit(exitCode);

async function capture(options) {
	cdpOptions.apiUrl = LOCALHOST + (await launchChromium({
		headless: !options.showBrowser,
		executablePath: options.browserExecutablePath,
		width: options.browserWidth,
		height: options.browserHeight
	}));
	const targetInfo = await CDP.createTarget(EMPTY_PAGE_URL);
	const cdp = new CDP(targetInfo);
	const { Page, Runtime } = cdp;
	await Runtime.enable();
	await Page.enable();
	await Page.navigate({ url: options.url });
	try {
		const content = await waitForContent(Runtime, options);
		const screenshot = options.screenshot ? await captureScreenshot(Page, options) : undefined;
		return { content, screenshot };
	} finally {
		try {
			await CDP.closeTarget(targetInfo.id);
		} catch {
			// ignored
		}
	}
}

async function captureScreenshot(Page, options) {
	let clip;
	if (options.fullPage) {
		const metrics = await Page.getLayoutMetrics();
		const { width, height } = metrics.cssContentSize || metrics.contentSize;
		clip = { x: 0, y: 0, width, height, scale: 1 };
	}
	const { data } = await Page.captureScreenshot({ captureBeyondViewport: Boolean(clip), clip });
	return decodeBase64(data);
}

function decodeBase64(data) {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let indexByte = 0; indexByte < binary.length; indexByte++) {
		bytes[indexByte] = binary.charCodeAt(indexByte);
	}
	return bytes;
}

async function waitForContent(Runtime, options) {
	const deadline = Date.now() + options.maxDelay;
	let content, previousContent, stableSince, lastException;
	do {
		if (options.waitFor) {
			const { value, exceptionText } = await evaluate(Runtime, options.waitFor);
			lastException = exceptionText;
			if (value) {
				return (await evaluate(Runtime, OUTER_HTML_EXPRESSION)).value;
			}
		} else {
			({ value: content } = await evaluate(Runtime, OUTER_HTML_EXPRESSION));
			if (content !== undefined && content === previousContent) {
				if (Date.now() - stableSince >= options.stableDelay) {
					return content;
				}
			} else {
				previousContent = content;
				stableSince = Date.now();
			}
		}
		await delay(POLL_DELAY);
	} while (Date.now() < deadline);
	throw new Error(options.waitFor ?
		`Timed out after ${options.maxDelay}ms waiting for ${JSON.stringify(options.waitFor)}` +
		(lastException ? `, last evaluated as: ${lastException}` : "") :
		`Timed out after ${options.maxDelay}ms waiting for the DOM to stop changing`);
}

async function evaluate(Runtime, expression) {
	const { result, exceptionDetails } = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
	if (exceptionDetails) {
		return { exceptionText: exceptionDetails.exception ? exceptionDetails.exception.description : exceptionDetails.text };
	}
	return { value: result.value };
}

function parseArguments(args) {
	const options = { maxDelay: DEFAULT_MAX_DELAY, stableDelay: DEFAULT_STABLE_DELAY };
	for (let indexArgument = 0; indexArgument < args.length; indexArgument++) {
		const argument = args[indexArgument];
		const indexEqual = argument.indexOf("=");
		const name = argument.startsWith("--") && indexEqual != -1 ? argument.substring(0, indexEqual) : argument;
		if (FLAG_NAMES[name]) {
			options[FLAG_NAMES[name]] = true;
		} else if (OPTION_NAMES[name]) {
			const value = indexEqual == -1 ? args[++indexArgument] : argument.substring(indexEqual + 1);
			if (value === undefined) {
				throw new Error(`Missing value for ${name}`);
			}
			options[OPTION_NAMES[name]] = value;
		} else if (argument.startsWith("--")) {
			throw new Error(`Unknown option ${name}`);
		} else if (options.url === undefined) {
			options.url = argument;
		} else {
			throw new Error(`Unexpected argument ${argument}`);
		}
	}
	if (options.url === undefined) {
		throw new Error("Missing url");
	}
	NUMBER_OPTION_NAMES.filter(name => options[name] !== undefined).forEach(name => {
		const value = Number(options[name]);
		if (!Number.isFinite(value) || value < 0) {
			throw new Error(`Invalid value for ${name}`);
		}
		options[name] = value;
	});
	return options;
}

function delay(duration) {
	return new Promise(resolve => setTimeout(resolve, duration));
}

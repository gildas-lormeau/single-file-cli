/*
 * Copyright 2010-2024 Gildas Lormeau
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

import { version } from "./lib/version.js";
import { Deno } from "./lib/deno-polyfill.js";

const USAGE_TEXT = `single-file [url] [output]

Positionals:
  url     URL or path on the filesystem of the page to save  [string]
  output  Output filename  [string]`;

const OPTIONS_INFO = {
	"accept-header-font": { description: "Accept header for fonts", type: "string", defaultValue: "application/font-woff2;q=1.0,application/font-woff;q=0.9,*/*;q=0.8" },
	"accept-header-image": { description: "Accept header for images", type: "string", defaultValue: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" },
	"accept-header-stylesheet": { description: "Accept header for stylesheets", type: "string", defaultValue: "text/css,*/*;q=0.1" },
	"accept-header-script": { description: "Accept header for scripts", type: "string", defaultValue: "*/*" },
	"accept-header-document": { description: "Accept header for documents", type: "string", defaultValue: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
	"block-audios": { description: "Block audios", type: "boolean", defaultValue: true },
	"block-fonts": { description: "Block fonts", type: "boolean" },
	"block-images": { description: "Block images", type: "boolean" },
	"block-scripts": { description: "Block scripts", type: "boolean", defaultValue: true },
	"block-videos": { description: "Block videos", type: "boolean", defaultValue: true },
	"block-mixed-content": { description: "Block mixed contents", type: "boolean" },
	"browser-server": { description: "Server to connect to", type: "string" },
	"browser-headless": { description: "Run the browser in headless mode", type: "boolean", defaultValue: true },
	"browser-executable-path": { description: "Path to chrome/chromium executable", type: "string" },
	"browser-width": { description: "Width of the browser viewport in pixels", type: "number", defaultValue: 1280 },
	"browser-height": { description: "Height of the browser viewport in pixels", type: "number", defaultValue: 720 },
	"browser-load-max-time": { description: "Maximum delay of time to wait for page loading in ms", type: "number", defaultValue: 60000 },
	"browser-wait-delay": { description: "Time to wait before capturing the page in ms", type: "number" },
	"browser-wait-until": { description: "When to consider the page is loaded (InteractiveTime, networkIdle, networkAlmostIdle, load, domContentLoaded)", type: "string", defaultValue: "networkIdle" },
	"browser-wait-until-fallback": { description: "Retry with the next value of --browser-wait-until when a timeout error is thrown", type: "boolean", defaultValue: true },
	"browser-debug": { description: "Enable debug mode", type: "boolean" },
	"browser-script": { description: "Path of a script executed in the page (and all the frames) before it is loaded", type: "string[]" },
	"browser-stylesheet": { description: "Path of a stylesheet file inserted into the page (and all the frames) after it is loaded", type: "string[]" },
	"browser-arg": { description: "Argument passed to the browser", type: "string[]", alias: "browser-argument" },
	"browser-args": { description: "Arguments provided as a JSON array and passed to the browser", type: "string" },
	"browser-start-minimized": { description: "Minimize the browser", type: "boolean" },
	"browser-cookie": { description: "Ordered list of cookie parameters separated by a comma (name,value,domain,path,expires,httpOnly,secure,sameSite,url)", type: "string[]" },
	"browser-cookies-file": { description: "Path of the cookies file formatted as a JSON file or a Netscape text file", type: "string" },
	"browser-ignore-insecure-certs": { description: "Ignore HTTPs errors", type: "boolean" },
	"browser-remote-debugging-URL": { description: "Remote debugging URL", type: "string" },
	"browser-mobile-emulation": { description: "Emulate a mobile device", type: "boolean" },
	"browser-device-width": { description: "Width of the device viewport in pixels (default value is 360 when using --browser-mobile-emulation)", type: "number" },
	"browser-device-height": { description: "Height of the device viewport in pixels (default value is 800 when using --browser-mobile-emulation)", type: "number" },
	"browser-device-scale-factor": { description: "Scale factor of the device viewport (default value is 2 when using --browser-mobile-emulation)", type: "number" },
	"console-messages-file": { description: "Path of the file where to save the console messages in JSON format", type: "string" },
	"compress-CSS": { description: "Compress CSS stylesheets", type: "boolean" },
	"compress-HTML": { description: "Compress HTML content", type: "boolean", defaultValue: true },
	"crawl-links": { description: "Crawl and save pages found via inner links", type: "boolean" },
	"crawl-inner-links-only": { description: "Crawl pages found via inner links only if they are hosted on the same domain", type: "boolean", defaultValue: true },
	"crawl-no-parent": { description: "Crawl pages found via inner links only if their URLs are not parent of the URL to crawl", type: "boolean" },
	"crawl-load-session": { description: "Name of the file of the session to load (previously saved with --crawl-save-session or --crawl-sync-session)", type: "string" },
	"crawl-remove-URL-fragment": { description: "Remove URL fragments found in links", type: "boolean", defaultValue: true },
	"crawl-save-session": { description: "Name of the file where to save the state of the session", type: "string" },
	"crawl-sync-session": { description: "Name of the file where to load and save the state of the session", type: "string" },
	"crawl-max-depth": { description: "Max depth when crawling pages found in internal and external links (0: infinite)", type: "number", defaultValue: 1 },
	"crawl-external-links-max-depth": { description: "Max depth when crawling pages found in external links (0: infinite)", type: "number", defaultValue: 1 },
	"crawl-replace-URLs": { description: "Replace URLs of saved pages with relative paths of saved pages on the filesystem", type: "boolean" },
	"crawl-rewrite-rule": { description: "Rewrite rule used to rewrite URLs of crawled pages", type: "string[]" },
	"dump-content": { description: "Dump the content of the processed page in the console ('true' when running in Docker)", type: "boolean" },
	"emulate-media-feature": { description: "Emulate a media feature. The syntax is <name>:<value>, e.g. \"prefers-color-scheme:dark\"", type: "string[]" },
	"errors-file": { description: "Path of the file where to save the error messages", type: "string", alias: "error-file" },
	"errors-traces-disabled": { description: "Remove error stack traces in the error messages", type: "boolean", defaultValue: true, alias: "error-traces-disabled" },
	"filename-template": { description: "Template used to generate the output filename (see help page of the extension for more info)", type: "string", defaultValue: "%if-empty<{page-title}|No title> ({date-locale} {time-locale}).{filename-extension}" },
	"filename-conflict-action": { description: "Action when the filename is conflicting with existing one on the filesystem. The possible values are \"uniquify\" (default), \"overwrite\" and \"skip\"", type: "string", defaultValue: "uniquify" },
	"filename-replacement-character": { description: "The character used for replacing invalid characters in filenames", type: "string", defaultValue: "_" },
	"filename-max-length": { description: "Specify the maximum length of the filename", type: "number", defaultValue: 192 },
	"filename-max-length-unit": { description: "Specify the unit of the maximum length of the filename ('bytes' or 'chars')", type: "string", defaultValue: "bytes" },
	"replace-emojis-in-filename": { description: "Replace emojis in the filename with their unicode text representation", type: "boolean" },
	"group-duplicate-images": { description: "Group duplicate images into CSS custom properties", type: "boolean", defaultValue: true },
	"max-size-duplicate-images": { description: "Maximum size in bytes of duplicate images stored as CSS custom properties", type: "number", defaultValue: 512 * 1024 },
	"help": { description: "Show help", type: "boolean" },
	"http-header": { description: "Extra HTTP header", type: "string[]" },
	"http-proxy-server": { description: "Proxy address", type: "string" },
	"http-proxy-username": { description: "HTTP username", type: "string" },
	"http-proxy-password": { description: "HTTP password", type: "string" },
	"include-BOM": { description: "Include the UTF-8 BOM into the HTML page", type: "boolean" },
	"include-infobar": { description: "Include the infobar", type: "boolean" },
	"infobar-template": { description: "Template used to generate the infobar content (see help page of the extension for more info)", type: "string" },
	"open-infobar": { description: "Keep the infobar open when using --include-infobar", type: "boolean" },
	"insert-meta-CSP": { description: "Include a <meta> tag with a CSP to avoid potential requests to internet when viewing a page", type: "boolean", defaultValue: true },
	"load-deferred-images": { description: "Load deferred (a.k.a. lazy-loaded) images", type: "boolean", defaultValue: true },
	"load-deferred-images-dispatch-scroll-event": { description: "Dispatch 'scroll' event when loading deferred images", type: "boolean" },
	"load-deferred-images-max-idle-time": { description: "Maximum delay of time to wait for deferred images in ms", type: "number", defaultValue: 1500 },
	"load-deferred-images-keep-zoom-level": { description: "Load deferred images by keeping zoomed out the page", type: "boolean" },
	"load-deferred-images-before-frames": { description: "Load deferred frames before before saving fame contents", type: "boolean" },
	"max-parallel-workers": { description: "Maximum number of browsers launched in parallel when processing a list of URLs (cf --urls-file)", type: "number", defaultValue: 8 },
	"max-resource-size-enabled": { description: "Enable removal of embedded resources exceeding a given size", type: "boolean" },
	"max-resource-size": { description: "Maximum size of embedded resources in MB (i.e. images, stylesheets, scripts and iframes)", type: "number", defaultValue: 10 },
	"move-styles-in-head": { description: "Move style elements outside the head element into the head element", type: "boolean" },
	"password": { description: "Password of the zip file when using --compress-content or --self-extracting-archive", type: "string" },
	"remove-frames": { description: "Remove frames", type: "boolean" },
	"remove-hidden-elements": { description: "Remove HTML elements which are not displayed", type: "boolean", defaultValue: true },
	"remove-unused-styles": { description: "Remove unused CSS rules and unneeded declarations", type: "boolean", defaultValue: true },
	"remove-unused-fonts": { description: "Remove unused CSS font rules", type: "boolean", defaultValue: true },
	"remove-saved-date": { description: "Remove saved date metadata in HTML header", type: "boolean" },
	"remove-alternative-fonts": { description: "Remove alternative fonts to the ones displayed", type: "boolean", defaultValue: true },
	"remove-alternative-medias": { description: "Remove alternative CSS stylesheets", type: "boolean", defaultValue: true },
	"remove-alternative-images": { description: "Remove images for alternative sizes of screen", type: "boolean", defaultValue: true },
	"save-original-URLs": { description: "Save the original URLS in the embedded contents", type: "boolean" },
	"save-raw-page": { description: "Save the original page without interpreting it into the browser", type: "boolean" },
	"urls-file": { description: "Path to a text file containing a list of URLs (separated by a newline) to save", type: "string" },
	"user-agent": { description: "User-agent of the browser", type: "string" },
	"accept-language": { description: "Accept language of the browser", type: "string" },
	"platform": { description: "Platform of the browser (default value is \"Android\" when using --browser-mobile-emulation)", type: "string" },
	"user-script-enabled": { description: "Enable the event API allowing to execute scripts before the page is saved", type: "boolean", defaultValue: true },
	"compress-content": { description: "Create a ZIP file instead of an HTML file", type: "boolean" },
	"self-extracting-archive": { description: "Create a self-extracting (ZIP) HTML file", type: "boolean", defaultValue: true },
	"insert-text-body": { description: "Insert the text of the page into the self-extracting HTML file", type: "boolean" },
	"create-root-directory": { description: "Create a root directory based on the timestamp", type: "boolean" },
	"extract-data-from-page": { description: "Extract compressed data from the page instead of fetching the page in order to create universal self-extracting HTML files", type: "boolean", defaultValue: true },
	"prevent-appended-data": { description: "Prevent appending data after the compressed data when creating self-extracting HTML files", type: "boolean" },
	"embed-screenshot": { description: "Embed a screenshot of the page as a PNG file in the compressed file (self-extracting HTML or ZIP file). When enabled, the resulting file can be read as a ZIP file or a PNG image.", type: "boolean" },
	"embed-screenshot-options": { description: "Options passed to the CDP method `Page.captureScreenshot()` given as a JSON string (e.g. { \"captureBeyondViewport\": false })", type: "string" },
	"embedded-image": { description: "Path to a PNG image to embed in the compressed file.", type: "string" },
	"embed-pdf": { description: "Embed a PDF file in the ZIP or self-extracting file. When enabled, the resulting file can be read as a ZIP file or a PDF file.", type: "boolean" },
	"embed-pdf-options": { description: "Options passed to the CDP method `Page.printToPDF()` given as a JSON string (e.g. { \"pageRanges\": \"1-1\", \"paperWidth\": 11, \"paperHeight\": 8.5 })", type: "string" },
	"embedded-pdf": { description: "Path to a PDF file to embed in the compressed file.", type: "string" },
	"output-directory": { description: "Path to where to save files, this path must exist.", type: "string" },
	"version": { description: "Print the version number and exit.", type: "boolean" },
	"output-json": { description: "Output the result as a JSON string containing the page and network info", type: "boolean" },
	"insert-single-file-comment": { description: "Insert a comment in the HTML header with the URL of the page", type: "boolean", defaultValue: true },
	"resolve-links": { description: "Resolve link URLs to absolute URLs", type: "boolean", defaultValue: true },
	"settings-file": { description: "Path to a JSON file containing the settings exported from the web extension", type: "string" },
	"settings-file-profile": { description: "Name of the profile to use when using --settings-file", type: "string", defaultValue: "default" },
	"group-duplicate-stylesheets": { description: "Group duplicate inline stylesheets into a single stylesheet in order to reduce the size of the page", type: "boolean", defaultValue: true }
};

const { args, exit } = Deno;
const options = await getOptions();
export default options;

async function getOptions() {
	const { positionals, options } = parseArgs(Array.from(args));
	const unknownOptions = [];
	positionals.forEach(positional => {
		if (positional.startsWith("--")) {
			unknownOptions.push(positional);
			positionals.splice(positionals.indexOf(positional), 1);
		}
	});
	if ((!positionals.length && !Object.keys(options).length) || positionals.length > 2 || options.help || unknownOptions.length) {
		console.log(USAGE_TEXT + "\n"); // eslint-disable-line no-console
		console.log("Options:"); // eslint-disable-line no-console
		Object.keys(OPTIONS_INFO).forEach(optionName => {
			const optionInfo = getOptionInfo(optionName);
			let optionType = optionInfo.type;
			if (isArray(optionType)) {
				optionType = optionType.replace("[]", "*");
			}
			const optionDescription = optionInfo.description;
			const optionDefaultValue = optionInfo.defaultValue === undefined ? "" : `(default: ${JSON.stringify(optionInfo.defaultValue)})`;
			console.log(`  --${optionName}: ${optionDescription} <${optionType}> ${optionDefaultValue}`); // eslint-disable-line no-console
		});
		if (unknownOptions.length) {
			console.log(""); // eslint-disable-line no-console
			console.log(`Error: Unknown option${unknownOptions.length > 1 ? "s" : ""} ${unknownOptions.join(", ")}`); // eslint-disable-line no-console
		}
		console.log(""); // eslint-disable-line no-console
		exit(0);
	}
	if (options.version) {
		console.log(version); // eslint-disable-line no-console
		exit(0);
	}
	Object.keys(OPTIONS_INFO).forEach(optionName => {
		const optionInfo = getOptionInfo(optionName);
		const optionKey = getOptionKey(optionName, optionInfo);
		if (options[optionKey] === undefined && optionInfo.defaultValue !== undefined) {
			options[optionKey] = OPTIONS_INFO[optionName].defaultValue;
		}
	});
	options.acceptHeaders = {
		font: options.acceptHeaderFont,
		image: options.acceptHeaderImage,
		stylesheet: options.acceptHeaderStylesheet,
		script: options.acceptHeaderScript,
		document: options.acceptHeaderDocument
	};
	if (options.browserArgs) {
		const browserArguments = options.browserArguments || [];
		browserArguments.push(...JSON.parse(options.browserArgs));
		options.browserArgs = browserArguments;
		delete options.browserArguments;
	}
	if (options.browserArguments) {
		options.browserArgs = options.browserArguments;
		delete options.browserArguments;
	}
	if (options.errorFile) {
		options.errorsFile = options.errorFile;
		delete options.errorFile;
	}
	if (options.errorTracesDisabled) {
		options.errorsTracesDisabled = options.errorTracesDisabled;
		delete options.errorTracesDisabled;
	}
	delete options.acceptHeaderFont;
	delete options.acceptHeaderImage;
	delete options.acceptHeaderStylesheet;
	delete options.acceptHeaderScript;
	delete options.acceptHeaderDocument;
	return { ...options, url: positionals[0], output: positionals[1] };
}

function parseArgs(args) {
	const positionals = [];
	const options = {};
	const result = { positionals, options: {} };
	let argIndex = 0;
	while (argIndex < args.length) {
		const arg = args[argIndex];
		const { argName, argValue, optionInfo } = parseArg(arg);
		if (optionInfo) {
			if (options[argName] === undefined) {
				options[argName] = [];
			}
			let nextArgName;
			if (argValue === undefined) {
				if (
					argIndex + 1 < args.length &&
					({ argName: nextArgName } = parseArg(args[argIndex + 1])) &&
					(nextArgName === undefined || !getOptionInfo(nextArgName)) &&
					isValid(optionInfo.type, args[argIndex + 1]) &&
					(isArray(optionInfo.type) || !options[argName].length)) {
					options[argName].push(args[argIndex + 1]);
					argIndex++;
				}
			} else if (isValid(optionInfo.type, argValue) && (isArray(optionInfo.type) || !options[argName].length)) {
				options[argName].push(argValue);
			} else {
				positionals.push(arg);
			}
		} else {
			positionals.push(arg);
		}
		argIndex++;
	}
	Object.keys(options).forEach(optionName => {
		const optionInfo = getOptionInfo(optionName);
		const optionKey = getOptionKey(optionName, optionInfo);
		let optionValue = options[optionName];
		const isArrayType = isArray(optionInfo.type);
		if (optionInfo.type.startsWith("boolean")) {
			optionValue = optionValue.map(value => value == "true");
			optionValue = isArrayType ?
				optionValue.length ? optionValue : true :
				optionValue.length ? optionValue[0] : true;
		} else if (optionInfo.type.startsWith("number")) {
			optionValue = optionValue.map(value => Number(value));
			optionValue = isArrayType ?
				optionValue.length ? optionValue : optionInfo.defaultValue || 0 :
				optionValue.length ? optionValue[0] : optionInfo.defaultValue || 0;
		} else {
			optionValue = isArrayType ?
				optionValue.length ? optionValue : optionInfo.defaultValue || "" :
				optionValue.length ? optionValue[0] : optionInfo.defaultValue || "";
		}
		result.options[optionKey] = optionValue;
	});
	return result;
}

function getOptionKey(optionKeyName, optionInfo) {
	if (optionInfo) {
		const optionName = optionInfo.alias || optionKeyName;
		if (isArray(optionInfo.type)) {
			return kebabToCamelCase(optionName + "s");
		} else {
			return kebabToCamelCase(optionName);
		}
	}
}

function parseArg(arg) {
	const ARGS_REGEX = /^--([^=]+)(?:=(.*))?$/;
	const parsedArg = arg.match(ARGS_REGEX);
	if (parsedArg && parsedArg.length) {
		let [_, argName, argValue] = parsedArg; // eslint-disable-line no-unused-vars
		const optionInfo = getOptionInfo(argName);
		if (argValue !== undefined &&
			((argValue.startsWith("\"") && argValue.endsWith("\"")) ||
				(argValue.startsWith("'") && argValue.endsWith("'")))) {
			argValue = argValue.substring(1, argValue.length - 1);
		}
		return { argName, argValue, optionInfo };
	} else {
		return {};
	}
}

function getOptionInfo(optionName) {
	for (const keyName in OPTIONS_INFO) {
		if (keyName.toLowerCase() == optionName.toLowerCase() || OPTIONS_INFO[keyName].alias == optionName.toLowerCase()) {
			return OPTIONS_INFO[keyName];
		}
	}
}

function kebabToCamelCase(optionName) {
	return optionName.replace(/-([a-zA-Z])/g, g => g[1].toUpperCase());
}

function isValid(type, value) {
	if (type.startsWith("boolean")) {
		return value == "true" || value == "false";
	} else if (type.startsWith("number")) {
		return !isNaN(value);
	} else {
		return true;
	}
}

function isArray(type) {
	return type.endsWith("[]");
}

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

/* global URL, Blob, FileReader, console */

import * as backend from "./lib/cdp-client.js";
import { getZipScriptSource } from "./lib/single-file-script.js";
import { Deno, path } from "./lib/deno-polyfill.js";

const VALID_URL_TEST = /^(https?|file):\/\//;

const DEFAULT_OPTIONS = {
	removeHiddenElements: true,
	removeUnusedStyles: true,
	removeUnusedFonts: true,
	compressHTML: true,
	loadDeferredImages: true,
	loadDeferredImagesMaxIdleTime: 1500,
	filenameTemplate: "{page-title} ({date-locale} {time-locale}).html",
	filenameMaxLength: 192,
	filenameMaxLengthUnit: "bytes",
	filenameReplacedCharacters: ["~", "+", "?", "%", "*", ":", "|", "\"", "<", ">", "\\\\", "\x00-\x1f", "\x7F"],
	filenameReplacementCharacter: "_",
	filenameReplacementCharacters: ["～", "＋", "？", "％", "＊", "：", "｜", "＂", "＜", "＞", "＼"],
	maxResourceSize: 10,
	backgroundSave: true,
	removeAlternativeFonts: true,
	removeAlternativeMedias: true,
	removeAlternativeImages: true,
	groupDuplicateImages: true,
	saveFavicon: true,
	insertMetaCSP: true,
	insertSingleFileComment: true,
	blockScripts: true,
	blockVideos: true,
	blockAudios: true,
	// New screenshot options
	outputFormat: "html", // 'html', 'jpeg', 'png'
	screenshotQuality: 90, // For 'jpeg' format
	screenshotFullPage: true,
	screenshotClip: null // e.g. { x: 0, y: 0, width: 800, height: 600 }
};
const STATE_PROCESSING = "processing";
const STATE_PROCESSED = "processed";

const { readTextFile, writeTextFile, writeFile, stdout, mkdir, stat, errors } = Deno;
let tasks = [], maxParallelWorkers, sessionFilename;

export { initialize };

async function initialize(options) {
	options = Object.assign({}, DEFAULT_OPTIONS, options);
	maxParallelWorkers = options.maxParallelWorkers || 8;
	try {
		await backend.initialize(options);
	} catch (error) {
		if (error instanceof errors.NotFound) {
			let message = "Chromium executable not found. ";
			if (options.browserExecutablePath) {
				message += "Make sure --browser-executable-path is correct.";
			} else {
				message += "Set the path using the --browser-executable-path option.";
			}
			throw new Error(message);
		} else {
			throw error;
		}
	}
	if (options.crawlSyncSession || options.crawlLoadSession) {
		try {
			tasks = JSON.parse(await readTextFile(options.crawlSyncSession || options.crawlLoadSession));
		} catch (error) {
			if (options.crawlLoadSession) {
				throw error;
			}
		}
	}
	if (options.crawlSyncSession || options.crawlSaveSession) {
		sessionFilename = options.crawlSyncSession || options.crawlSaveSession;
	}
	return {
		capture: urls => capture(urls, options),
		finish: () => finish(options)
	};
}

async function capture(urls, options) {
	let newTasks;
	const taskUrls = tasks.map(task => task.url);
	newTasks = await Promise.all(urls.map(value => {
		let url, taskOptions;
		if (Array.isArray(value)) {
			url = value[0];
			taskOptions = Object.assign({}, options, value[1]);
		} else {
			url = value;
			taskOptions = options;
		}
		return createTask(url, taskOptions);
	}));
	newTasks = newTasks.filter(task => task && !taskUrls.includes(task.url));
	if (newTasks.length) {
		tasks = tasks.concat(newTasks);
		await saveTasks();
	}
	await runTasks();
}

async function finish(options) {
	const promiseTasks = tasks.map(task => task.promise);
	await Promise.all(promiseTasks);
	if (options.crawlReplaceURLs && !options.compressContent) {
		for (const task of tasks) {
			try {
				let pageContent = await readTextFile(task.filename);
				tasks.forEach(otherTask => {
					if (otherTask.filename) {
						pageContent = pageContent.replace(new RegExp(escapeRegExp("\"" + otherTask.originalUrl + "\""), "gi"), "\"" + otherTask.filename + "\"");
						pageContent = pageContent.replace(new RegExp(escapeRegExp("'" + otherTask.originalUrl + "'"), "gi"), "'" + otherTask.filename + "'");
						const filename = otherTask.filename.replace(/ /g, "%20");
						pageContent = pageContent.replace(new RegExp(escapeRegExp("=" + otherTask.originalUrl + " "), "gi"), "=" + filename + " ");
						pageContent = pageContent.replace(new RegExp(escapeRegExp("=" + otherTask.originalUrl + ">"), "gi"), "=" + filename + ">");
					}
				});
				await writeTextFile(task.filename, pageContent);
			} catch {
				// ignored
			}
		}
	}
	if (!options.browserDebug && !options.browserServer) {
		return backend.closeBrowser();
	}
}

function runTasks() {
	const availableTasks = tasks.filter(task => !task.status).length;
	const processingTasks = tasks.filter(task => task.status == STATE_PROCESSING).length;
	const promisesTasks = [];
	for (let workerIndex = 0; workerIndex < Math.min(availableTasks, maxParallelWorkers - processingTasks); workerIndex++) {
		promisesTasks.push(runNextTask());
	}
	return Promise.all(promisesTasks);
}

async function runNextTask() {
	const task = tasks.find(task => !task.status);
	if (task) {
		const options = task.options;
		const taskOptions = JSON.parse(JSON.stringify(options));
		taskOptions.url = task.url;
		task.status = STATE_PROCESSING;
		await saveTasks();
		task.promise = capturePage(taskOptions);
		const pageData = await task.promise;
		task.status = STATE_PROCESSED;
		if (pageData) {
			task.filename = pageData.filename;
			if (options.crawlLinks && testMaxDepth(task)) {
				const urls = pageData.links;
				let newTasks = await Promise.all(urls.map(url => createTask(url, options, task, task.rootTaskURL || task.url)));
				newTasks = newTasks.filter(task => task &&
					testMaxDepth(task) &&
					!tasks.find(otherTask => otherTask.url == task.url) &&
					!newTasks.find(otherTask => otherTask != task && otherTask.url == task.url) &&
					(!options.crawlInnerLinksOnly || task.isInnerLink) &&
					(!options.crawlNoParent || (task.isChild || !task.isInnerLink)));
				tasks.splice(tasks.length, 0, ...newTasks);
			}
		}
		await saveTasks();
		await runTasks();
	}
}

function testMaxDepth(task) {
	const options = task.options;
	return (options.crawlMaxDepth == 0 || task.depth <= options.crawlMaxDepth) &&
		(options.crawlExternalLinksMaxDepth == 0 || task.externalLinkDepth < options.crawlExternalLinksMaxDepth);
}

async function createTask(url, options, parentTask, rootTaskURL) {
	options.originalUrl = url;
	url = parentTask ? rewriteURL(url, options.crawlRemoveURLFragment, options.crawlRewriteRules) : url;
	if (url) {
		if (!VALID_URL_TEST.test(url)) {
			try {
				url = url.replace(/\\/g, "/");
				url = url.replace(/#/g, "%23");
				const baseURL = await path.toFileUrl((await Deno.cwd()) + path.SEPARATOR);
				url = new URL(url, baseURL).href;
			} catch (error) {
				throw new Error("Invalid URL or file path: " + url, { cause: error });
			}
		}
		const isInnerLink = rootTaskURL && url.startsWith(getHostURL(rootTaskURL));
		const rootBaseURIMatch = rootTaskURL && rootTaskURL.match(/(.*?)[^/]*$/);
		const isChild = isInnerLink && rootBaseURIMatch && rootBaseURIMatch[1] && url.startsWith(rootBaseURIMatch[1]);
		return {
			url,
			isInnerLink,
			isChild,
			originalUrl: url,
			rootTaskURL,
			depth: parentTask ? parentTask.depth + 1 : 0,
			externalLinkDepth: isInnerLink ? -1 : parentTask ? parentTask.externalLinkDepth + 1 : -1,
			options
		};
	}
}

async function saveTasks() {
	if (sessionFilename) {
		await writeTextFile(sessionFilename, JSON.stringify(
			tasks.map(task => Object.assign({}, task, {
				status: task.status == STATE_PROCESSING ? undefined : task.status,
				promise: undefined,
				options: task.status && task.status == STATE_PROCESSED ? undefined : task.options
			}))
		));
	}
}

function rewriteURL(url, crawlRemoveURLFragment, crawlRewriteRules = []) {
	url = url.trim();
	if (crawlRemoveURLFragment) {
		url = url.replace(/^(.*?)#.*$/, "$1");
	}
	crawlRewriteRules.forEach(rewriteRule => {
		const parts = rewriteRule.trim().split(/ +/);
		if (parts.length) {
			url = url.replace(new RegExp(parts[0]), parts[1] || "").trim();
		}
	});
	return url;
}

function getHostURL(url) {
	url = new URL(url);
	return url.protocol + "//" + (url.username ? url.username + (url.password || "") + "@" : "") + url.hostname;
}

async function capturePage(options) {
	try {
		if (options.outputFormat === "jpeg" || options.outputFormat === "png") {
			const screenshotOptions = {
				url: options.url,
				format: options.outputFormat,
				quality: options.screenshotQuality,
				fullPage: options.screenshotFullPage,
				clip: options.screenshotClip,
				// Pass through relevant browser/network options
				browserExecutablePath: options.browserExecutablePath,
				browserArgs: options.browserArgs,
				browserHeadless: options.browserHeadless,
				browserWidth: options.browserWidth,
				browserHeight: options.browserHeight,
				browserLoadMaxTime: options.browserLoadMaxTime,
				browserWaitUntil: options.browserWaitUntil,
				browserWaitUntilDelay: options.browserWaitUntilDelay,
				browserDebug: options.browserDebug,
				browserDisableWebSecurity: options.browserDisableWebSecurity,
				browserIgnoreHTTPSErrors: options.browserIgnoreHTTPSErrors,
				browserStartMinimized: options.browserStartMinimized,
				browserMobileEmulation: options.browserMobileEmulation,
				browserDeviceWidth: options.browserDeviceWidth,
				browserDeviceHeight: options.browserDeviceHeight,
				browserDeviceScaleFactor: options.browserDeviceScaleFactor,
				userAgent: options.userAgent,
				acceptLanguage: options.acceptLanguage,
				platform: options.platform,
				httpProxyServer: options.httpProxyServer,
				httpProxyUsername: options.httpProxyUsername,
				httpProxyPassword: options.httpProxyPassword,
				httpHeaders: options.httpHeaders,
				debugMessagesFile: options.debugMessagesFile, // For captureScreenshot internal logging
				// Note: Some options like 'crawl*' or 'filename*' are not directly relevant to captureScreenshot's CDP call
				// but are used by single-file-cli-api for task management or file naming.
			};
			const imageBuffer = await backend.captureScreenshot(screenshotOptions);
			let filename;
			if (options.output) {
				// If options.output is provided, use it directly but ensure correct extension
				const baseOutput = options.output.replace(/\.(jpeg|jpg|png|html)$/i, "");
				filename = await getFilename(`${baseOutput}.${options.outputFormat}`, options);
			} else {
				// Generate a filename using filenameTemplate if options.output is not set
				let baseFilename = options.filenameTemplate || DEFAULT_OPTIONS.filenameTemplate;
				// Replace placeholders in template (simplified: only {page-title}, {date-locale}, {time-locale} for now)
				// More robust placeholder replacement would be needed for full compatibility.
				// For screenshots, "page-title" might be less relevant or could be derived from URL.
				// Let's use a simplified title from URL if pageData isn't available for screenshots.
				const urlObject = new URL(options.url);
				const pageTitleFromURL = (urlObject.hostname + urlObject.pathname.replace(/\//g, '_')).replace(/[^a-zA-Z0-9_.-]/g, '_').substring(0, 100);
				baseFilename = baseFilename.replace(/\{page-title\}/g, pageTitleFromURL);
				const now = new Date();
				baseFilename = baseFilename.replace(/\{date-locale\}/g, now.toLocaleDateString());
				baseFilename = baseFilename.replace(/\{time-locale\}/g, now.toLocaleTimeString());
				
				// Ensure correct extension
				const desiredExtension = options.outputFormat === "jpeg" ? "jpg" : options.outputFormat;
				baseFilename = baseFilename.replace(/\.html$/i, "." + desiredExtension);
				if (!baseFilename.toLowerCase().endsWith("." + desiredExtension)) {
					baseFilename += "." + desiredExtension;
				}
				filename = await getFilename(baseFilename, options);
			}

			if (filename) {
				const directoryName = path.dirname(filename);
				if (directoryName !== "." && directoryName !== "") {
					await mkdir(directoryName, { recursive: true });
				}
				await writeFile(filename, imageBuffer);
				return { filename, content: imageBuffer, links: [] }; // links is usually for HTML crawling
			}
			// If no filename (e.g. dumpContent for image? Or skip conflict)
			// This path needs clarification if images are to be dumped to stdout.
			// For now, assuming images are always saved to a file if not skipped.
			return { content: imageBuffer, links: [] };


		} else { // Default to HTML or other formats
			options.zipScript = getZipScriptSource();
			const pageData = await backend.getPageData(options);
			let content = pageData.content;
			if (options.consoleMessagesFile && pageData.consoleMessages) {
				await writeTextFile(options.consoleMessagesFile, JSON.stringify(pageData.consoleMessages, null, 2));
			}
			if (options.debugMessagesFile && pageData.debugMessages) {
				await writeTextFile(options.debugMessagesFile, pageData.debugMessages.map(([timestamp, message]) =>
					`[${new Date(timestamp).toISOString()}] ${message.join(" ")}`).join("\n"));
			}
			if (options.outputJson) {
				if (content instanceof Uint8Array) {
					const fileReader = new FileReader();
					fileReader.readAsDataURL(new Blob([content]));
					content = await new Promise(resolve => {
						fileReader.onload = () => resolve(fileReader.result);
					});
					content = content.replace(/^data:.*?;base64,/, "");
					pageData.content = undefined;
					pageData.binaryContent = content;
				}
				pageData.doctype = undefined;
				pageData.viewport = undefined;
				pageData.comment = undefined;
				content = JSON.stringify(pageData, null, 2);
			}
			let filename;
			if (options.output) {
				filename = await getFilename(options.output, options);
			} else if (options.dumpContent) {
				if (options.compressContent && content instanceof Uint8Array) { // Ensure content is Uint8Array for stdout.write
					await stdout.write(content);
				} else if (options.compressContent && typeof content === 'string') { // If it's a string (e.g. after JSON stringify)
					await stdout.write(new TextEncoder().encode(content));
				}
				 else {
					console.log(content || ""); 
				}
			} else {
				filename = await getFilename(pageData.filename, options);
			}
			if (filename) {
				if (options.outputJson) {
					filename += filename.endsWith(".json") ? "" : ".json";
				}
				const directoryName = path.dirname(filename);
				if (directoryName !== "." && directoryName !== "") {
					await mkdir(directoryName, { recursive: true });
				}
				if (content instanceof Uint8Array) {
					await writeFile(filename, content);
				} else {
					await writeTextFile(filename, content);
				}
			}
			return pageData;
		}
	} catch (error) {
		const date = new Date();
		let message = `[${date.toISOString()}] URL: ${options.url}`;
		if (!options.errorsTracesDisabled) {
			message += "\nStack: " + error.stack;
		}
		message += "\n";
		if (options.errorsFile) {
			await writeTextFile(options.errorsFile, message, { append: true });
		} else {
			console.error(error.message || error, message); // eslint-disable-line no-console
		}
		if (options.consoleMessagesFile && error.consoleMessages) {
			await writeTextFile(options.consoleMessagesFile, JSON.stringify(error.consoleMessages, null, 2));
		}
		if (options.debugMessagesFile && error.debugMessages) {
			await writeTextFile(options.debugMessagesFile, error.debugMessages.map(([timestamp, message]) =>
				`[${new Date(timestamp).toISOString()}] ${message.join(" ")}`).join("\n"));
		}
	}
}

async function getFilename(baseFilename, options, index = 1) {
	// Ensure baseFilename has the correct extension based on outputFormat
	const currentExtensionMatch = baseFilename.match(/\.([^.]+)$/);
	const currentExtension = currentExtensionMatch ? currentExtensionMatch[1].toLowerCase() : "";
	const desiredExtension = options.outputFormat === "jpeg" ? "jpg" : options.outputFormat; // Use jpg for jpeg

	if (options.outputFormat === "jpeg" || options.outputFormat === "png") {
		if (currentExtension !== desiredExtension && desiredExtension !== "html" /* ensure not to change .html if that was intended for some reason */) {
			baseFilename = baseFilename.replace(/\.[^.]+$/, "") + "." + desiredExtension;
		} else if (!currentExtension && desiredExtension !== "html") {
			baseFilename += "." + desiredExtension;
		}
	}


	if (Array.isArray(options.outputDirectory)) {
		const outputDirectoryConfig = options.outputDirectory.pop(); // This logic seems complex, assuming it's for specific use cases.
		if (outputDirectoryConfig.startsWith("/")) {
			options.outputDirectory = outputDirectoryConfig;
		} else {
			// This assumes options.outputDirectory was an array with a base path at [0]
			// For safety, ensure options.outputDirectory[0] is a string.
			const basePath = Array.isArray(options.outputDirectory) && typeof options.outputDirectory[0] === 'string' ? options.outputDirectory[0] : "";
			options.outputDirectory = basePath + outputDirectoryConfig;
		}
	}
	let outputDirectory = options.outputDirectory || "";
	if (outputDirectory && !outputDirectory.endsWith("/") && outputDirectory !== ".") {
		outputDirectory += "/";
	}
	if (outputDirectory === "./") outputDirectory = "";


	let newFilename = outputDirectory + baseFilename;

	if (options.filenameConflictAction == "overwrite") {
		// For "overwrite", we return the path including the directory.
		// The original code returned just `filename` (which was `baseFilename` here),
		// but to be consistent with other branches, it should be the full path.
		return newFilename;
	} else if (options.filenameConflictAction == "uniquify" && index > 1) {
		const regExpMatchExtension = /(\.[^.]+)$/;
		const matchExtension = baseFilename.match(regExpMatchExtension); // Use baseFilename for adding index
		if (matchExtension && matchExtension[1]) {
			newFilename = outputDirectory + baseFilename.replace(regExpMatchExtension, " (" + index + ")" + matchExtension[1]);
		} else {
			newFilename = outputDirectory + baseFilename + " (" + index + ")";
		}
	}
	try {
		await stat(newFilename);
		if (options.filenameConflictAction != "skip") {
			// Pass baseFilename, not newFilename, to the recursive call
			return getFilename(baseFilename, options, index + 1);
		} else {
			// If skip and file exists, return undefined or signal to skip
			return undefined; 
		}
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			return newFilename;
		}
		throw error; // Re-throw other errors
	}
}

function escapeRegExp(string) {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
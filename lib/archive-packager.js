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

/* global URL */

import {
	configure,
	createArchive,
	TextReader,
	Uint8ArrayReader,
	Uint8ArrayWriter,
	ZipReader
} from "./single-file-archive.js";

const PAGES_PREFIX = "pages/";
const PAGES_FILENAME = "sfz-pages.json";
const TOC_FILENAME = "sfz-toc.html";
const TOC_TITLE = "Table of contents";
const TOC_STYLE = "body{font-family:system-ui,sans-serif;margin:2em auto;max-width:40em;padding:0 1em;background-color:#fff;color:#000}" +
	"a{color:#0000ee}a:visited{color:#551a8b}" +
	"summary{cursor:pointer;font-weight:bold;margin:.5em 0}" +
	"details{padding-left:1em}ul{margin:.25em 0;padding-left:1.5em}" +
	"@media(prefers-color-scheme:dark){body{background-color:#111;color:#eee}a{color:#8ab4f8}a:visited{color:#c58af9}}";
const COMMENT_HEADER = "Page saved with SingleFile";
const SYMLINK_UNIX_MODE = 0o120777;

export { createPagesArchive };

async function createPagesArchive(pages, options) {
	configure({ useWebWorkers: false });
	const manifest = {
		pages: pages.map((page, pageIndex) => ({
			path: getPagePath(pageIndex),
			url: page.url,
			originalUrls: page.originalUrls,
			title: page.title
		}))
	};
	if (options.markUnarchivedLinks) {
		manifest.markUnarchivedLinks = true;
	}
	if (options.pageTransitions && options.pageTransitions != "auto") {
		manifest.pageTransitions = options.pageTransitions;
	}
	const pageData = {
		doctype: "<!DOCTYPE html>",
		content: "",
		title: pages[0].title || "",
		comment: options.insertSingleFileComment ? getComment(pages[0].url, options) : undefined,
		tocContent: getTOCContent(pages)
	};
	const archiveOptions = {
		url: pages[0].url,
		multiPageArchive: true,
		selfExtractingArchive: options.selfExtractingArchive,
		extractDataFromPage: options.extractDataFromPage,
		preventAppendedData: options.preventAppendedData,
		includeBOM: options.includeBOM,
		insertMetaCSP: options.insertMetaCSP,
		insertCanonicalLink: options.insertCanonicalLink,
		insertMetaNoIndex: options.insertMetaNoIndex
	};
	const writtenEntries = options.dedupPages ? new Map() : undefined;
	const aliases = {};
	const blob = await createArchive(pageData, archiveOptions, options.zipScript, async zipWriter => {
		for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
			const pagePath = getPagePath(pageIndex);
			const zipReader = new ZipReader(new Uint8ArrayReader(await pages[pageIndex].getData()));
			for (const entry of await zipReader.getEntries()) {
				const filename = pagePath + entry.filename;
				const rawData = await entry.getData(new Uint8ArrayWriter(), { passThrough: true, checkSignature: false });
				const canonicalFilename = writtenEntries && findDuplicate(writtenEntries, filename, entry, rawData);
				if (canonicalFilename === undefined) {
					await zipWriter.add(filename, new Uint8ArrayReader(rawData), {
						passThrough: true,
						compressionMethod: entry.compressionMethod,
						uncompressedSize: entry.uncompressedSize,
						signature: entry.signature,
						comment: entry.comment,
						lastModDate: entry.lastModDate
					});
				} else {
					// the duplicate becomes a symlink entry so that external
					// extractors still produce complete page folders, the router
					// resolves it from the manifest alias map instead
					aliases[filename] = canonicalFilename;
					await zipWriter.add(filename, new TextReader(getRelativePath(filename, canonicalFilename)), {
						msDosCompatible: false,
						unixMode: SYMLINK_UNIX_MODE,
						level: 0,
						comment: entry.comment,
						lastModDate: entry.lastModDate
					});
				}
			}
			await zipReader.close();
		}
		if (Object.keys(aliases).length) {
			manifest.aliases = aliases;
		}
		if (options.tocPage) {
			await zipWriter.add(TOC_FILENAME, new TextReader(getTOCPageContent(manifest.pages)));
		}
		await zipWriter.add(PAGES_FILENAME, new TextReader(JSON.stringify(manifest, null, 2)));
	});
	return new Uint8Array(await blob.arrayBuffer());
}

function findDuplicate(writtenEntries, filename, entry, rawData) {
	if (entry.directory || !entry.uncompressedSize) {
		return;
	}
	const key = [entry.compressionMethod, entry.uncompressedSize, entry.signature, rawData.length].join(":");
	const candidates = writtenEntries.get(key);
	if (candidates) {
		const match = candidates.find(candidate => equalData(candidate.rawData, rawData));
		if (match) {
			return match.filename;
		}
		candidates.push({ filename, rawData });
	} else {
		writtenEntries.set(key, [{ filename, rawData }]);
	}
}

function equalData(dataLeft, dataRight) {
	return dataLeft.length == dataRight.length && dataLeft.every((value, index) => value == dataRight[index]);
}

function getRelativePath(filename, targetFilename) {
	const baseSegments = filename.split("/").slice(0, -1);
	const targetSegments = targetFilename.split("/");
	while (baseSegments.length && targetSegments.length > 1 && baseSegments[0] == targetSegments[0]) {
		baseSegments.shift();
		targetSegments.shift();
	}
	return "../".repeat(baseSegments.length) + targetSegments.join("/");
}

function getPagePath(pageIndex) {
	return pageIndex == 0 ? "" : PAGES_PREFIX + (pageIndex + 1) + "/";
}

function getComment(url, options) {
	return "\n " + COMMENT_HEADER +
		" \n url: " + url +
		(options.removeSavedDate ? " " : " \n saved date: " + new Date()) + "\n";
}

function getTOCPageContent(pages) {
	const origins = new Set(pages.map(page => new URL(page.url).origin));
	const rootGroup = { groups: new Map(), pages: [] };
	pages.forEach(page => {
		const url = new URL(page.url);
		const segments = url.pathname.split("/").slice(1, -1);
		if (origins.size > 1) {
			segments.unshift(url.origin);
		}
		let group = rootGroup;
		segments.forEach(segment => {
			if (!group.groups.has(segment)) {
				group.groups.set(segment, { groups: new Map(), pages: [] });
			}
			group = group.groups.get(segment);
		});
		group.pages.push(page);
	});
	const title = pages[0].title ? TOC_TITLE + " - " + pages[0].title : TOC_TITLE;
	return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
		"<title>" + escapeUnicodeHTML(title) + "</title><style>" + TOC_STYLE + "</style></head><body><main><h1>" +
		escapeUnicodeHTML(TOC_TITLE) + "</h1>" + getTOCGroupContent(rootGroup) + "</main></body></html>";
}

// nested details/summary groups stay collapsible without scripts on purpose,
// the page must remain usable after a plain unzip
function getTOCGroupContent(group) {
	let content = "";
	if (group.pages.length) {
		content += "<ul>" + group.pages.map(page =>
			"<li><a href=\"" + escapeUnicodeHTML(page.path + "index.html") + "\">" + escapeUnicodeHTML(page.title || page.url) + "</a></li>").join("") + "</ul>";
	}
	group.groups.forEach((childGroup, segment) => {
		content += "<details open><summary>" + escapeUnicodeHTML(segment) + "</summary>" + getTOCGroupContent(childGroup) + "</details>";
	});
	return content;
}

// unlike the prelude TOC below, the stored page is a UTF-8 entry: only the
// markup delimiters need escaping, but crawled titles remain untrusted
function escapeUnicodeHTML(value) {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getTOCContent(pages) {
	return "<nav><ul>" +
		pages.map(page => "<li><a href=\"" + escapeHTML(page.url) + "\">" + escapeHTML(page.title || page.url) + "</a></li>").join("") +
		"</ul></nav>";
}

// the prelude declares the windows-1252 charset, non-ASCII characters must be
// encoded as HTML entities to survive it
function escapeHTML(value) {
	return Array.from(value).map(character => {
		const codePoint = character.codePointAt(0);
		return codePoint < 32 || codePoint > 126 || character == "&" || character == "<" || character == ">" || character == "\"" ?
			"&#" + codePoint + ";" : character;
	}).join("");
}

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
const COMMENT_HEADER = "Page saved with SingleFile";

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
	const pageData = {
		doctype: "<!DOCTYPE html>",
		content: "",
		title: pages[0].title || "",
		comment: options.insertSingleFileComment ? getComment(pages[0].url, options) : undefined
	};
	const archiveOptions = {
		url: pages[0].url,
		selfExtractingArchive: options.selfExtractingArchive,
		extractDataFromPage: options.extractDataFromPage,
		preventAppendedData: options.preventAppendedData,
		includeBOM: options.includeBOM,
		insertMetaCSP: options.insertMetaCSP,
		insertCanonicalLink: options.insertCanonicalLink,
		insertMetaNoIndex: options.insertMetaNoIndex
	};
	const blob = await createArchive(pageData, archiveOptions, options.zipScript, async zipWriter => {
		for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
			const pagePath = getPagePath(pageIndex);
			const zipReader = new ZipReader(new Uint8ArrayReader(await pages[pageIndex].getData()));
			for (const entry of await zipReader.getEntries()) {
				const rawData = await entry.getData(new Uint8ArrayWriter(), { passThrough: true, checkSignature: false });
				await zipWriter.add(pagePath + entry.filename, new Uint8ArrayReader(rawData), {
					passThrough: true,
					compressionMethod: entry.compressionMethod,
					uncompressedSize: entry.uncompressedSize,
					signature: entry.signature,
					comment: entry.comment,
					lastModDate: entry.lastModDate
				});
			}
			await zipReader.close();
		}
		await zipWriter.add(PAGES_FILENAME, new TextReader(JSON.stringify(manifest, null, 2)));
	});
	return new Uint8Array(await blob.arrayBuffer());
}

function getPagePath(pageIndex) {
	return pageIndex == 0 ? "" : PAGES_PREFIX + (pageIndex + 1) + "/";
}

function getComment(url, options) {
	return "\n " + COMMENT_HEADER +
		" \n url: " + url +
		(options.removeSavedDate ? " " : " \n saved date: " + new Date()) + "\n";
}

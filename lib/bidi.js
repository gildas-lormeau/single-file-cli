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

/* global WebSocket, setTimeout, clearTimeout */

const SUCCESS_TYPE = "success";
const EVENT_TYPE = "event";
const OPEN_ATTEMPT_TIMEOUT = 500;
const OPEN_RETRY_DELAY = 200;
const DEFAULT_COMMAND_TIMEOUT = 30000;

export { connect };

async function connect(url, { timeout, commandTimeout = DEFAULT_COMMAND_TIMEOUT, isClosed = () => false } = {}) {
	const socket = await openSocket(url, timeout, isClosed);
	const pendingCommands = new Map();
	const listeners = new Map();
	let nextId = 1, closeError;
	socket.addEventListener("close", () => {
		closeError = new Error("The BiDi connection was closed");
		pendingCommands.forEach(({ reject }) => reject(closeError));
		pendingCommands.clear();
	});
	socket.addEventListener("message", event => {
		const message = JSON.parse(event.data);
		if (message.id !== undefined && pendingCommands.has(message.id)) {
			const { resolve, reject } = pendingCommands.get(message.id);
			pendingCommands.delete(message.id);
			if (message.type == SUCCESS_TYPE) {
				resolve(message.result);
			} else {
				const error = new Error(message.message);
				error.code = message.error;
				reject(error);
			}
		} else if (message.type == EVENT_TYPE) {
			const eventListeners = listeners.get(message.method);
			if (eventListeners) {
				Array.from(eventListeners).forEach(listener => listener(message.params));
			}
		}
	});
	return { send, addEventListener, removeEventListener, close };

	function send(method, params = {}, { timeout = commandTimeout } = {}) {
		if (closeError) {
			return Promise.reject(closeError);
		}
		const id = nextId++;
		socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => {
			let timeoutId;
			if (timeout) {
				timeoutId = setTimeout(() => {
					pendingCommands.delete(id);
					reject(new Error(method + " timed out after " + timeout + " ms"));
				}, timeout);
			}
			pendingCommands.set(id, {
				resolve: value => {
					clearTimeout(timeoutId);
					resolve(value);
				},
				reject: error => {
					clearTimeout(timeoutId);
					reject(error);
				}
			});
		});
	}

	function addEventListener(eventName, listener) {
		if (!listeners.has(eventName)) {
			listeners.set(eventName, new Set());
		}
		listeners.get(eventName).add(listener);
	}

	function removeEventListener(eventName, listener) {
		const eventListeners = listeners.get(eventName);
		if (eventListeners) {
			eventListeners.delete(listener);
		}
	}

	function close() {
		try {
			socket.close();
		} catch {
			// ignored
		}
	}
}

async function openSocket(url, timeout, isClosed) {
	const timeoutTime = Date.now() + timeout;
	while (Date.now() < timeoutTime && !isClosed()) {
		const socket = new WebSocket(url);
		const opened = await new Promise(resolve => {
			const timeoutId = setTimeout(() => resolve(false), OPEN_ATTEMPT_TIMEOUT);
			socket.addEventListener("open", () => {
				clearTimeout(timeoutId);
				resolve(true);
			});
			socket.addEventListener("error", () => {
				clearTimeout(timeoutId);
				resolve(false);
			});
		});
		if (opened) {
			return socket;
		}
		try {
			socket.close();
		} catch {
			// ignored
		}
		await new Promise(resolve => setTimeout(resolve, OPEN_RETRY_DELAY));
	}
	throw new Error(isClosed() ? "The browser exited unexpectedly" : "The browser is not responding");
}

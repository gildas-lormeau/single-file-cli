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

const BROWSER_ARGS = [
	"--disable-field-trial-config",
	"--disable-background-networking",
	"--enable-features=NetworkService,NetworkServiceInProcess",
	"--disable-background-timer-throttling",
	"--disable-backgrounding-occluded-windows",
	"--disable-back-forward-cache",
	"--disable-breakpad",
	"--disable-client-side-phishing-detection",
	"--disable-component-extensions-with-background-pages",
	"--disable-component-update",
	"--no-default-browser-check",
	"--disable-default-apps",
	"--disable-dev-shm-usage",
	"--disable-extensions",
	"--disable-features=ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,DestroyProfileOnBrowserClose,MediaRouter,DialMediaRouteProvider,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,AvoidUnnecessaryBeforeUnloadCheckSync,Translate,HttpsUpgrades,PaintHolding",
	"--allow-pre-commit-input",
	"--disable-hang-monitor",
	"--disable-ipc-flooding-protection",
	"--disable-popup-blocking",
	"--disable-prompt-on-repost",
	"--disable-renderer-backgrounding",
	"--force-color-profile=srgb",
	"--metrics-recording-only",
	"--no-first-run",
	"--enable-automation",
	"--password-store=basic",
	"--use-mock-keychain",
	"--no-service-autorun",
	"--export-tagged-pdf",
	"--disable-search-engine-choice-screen",
	"--enable-use-zoom-for-dsf=false",
	"--no-sandbox",
	"--no-startup-window",
	"--remote-debugging-port=9222",
	"--bwsi"
];
const BROWSER_PATHS = {
	linux: [
		"/usr/bin/chromium",
		"/usr/bin/chromium-beta",
		"/usr/bin/chromium-unstable",
		"/usr/bin/chromium-dev",
		"/usr/bin/chromium-browser",
		"/usr/bin/chromium-browser-beta",
		"/usr/bin/chromium-browser-unstable",
		"/usr/bin/chromium-browser-dev",
		"/opt/google/chrome/google-chrome",
		"/opt/google/chrome-beta/google-chrome",
		"/opt/google/chrome-unstable/google-chrome",
		"/opt/google/chrome-dev/google-chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-beta",
		"/usr/bin/google-chrome-unstable",
		"/usr/bin/google-chrome-dev",
		"/usr/bin/brave-browser",
		"/usr/bin/brave-browser-beta",
		"/usr/bin/brave-browser-dev",
		"/usr/bin/brave-browser-nightly",
		"/usr/bin/brave",
		"/usr/bin/brave-beta",
		"/usr/bin/brave-dev",
		"/usr/bin/brave-nightly",
		"/usr/bin/microsoft-edge",
		"/usr/bin/microsoft-edge-beta",
		"/usr/bin/microsoft-edge-dev",
		"/usr/bin/microsoft-edge-insider",
		"/usr/bin/microsoft-edge-beta",
		"/usr/bin/microsoft-edge-dev",
		"/usr/bin/microsoft-edge-canary",
		"/usr/bin/vivaldi",
		"/usr/bin/vivaldi-stable",
		"/usr/bin/vivaldi-snapshot",
		"/usr/bin/vivaldi-beta",
		"/usr/bin/opera",
		"/usr/bin/opera-beta",
		"/usr/bin/opera-developer",
		"/usr/bin/opera-snapshot",
		"/usr/bin/yandex-browser-beta",
		"/usr/bin/yandex-browser-alpha",
		"/usr/bin/yandex-browser",
		"/usr/bin/yandex",
		"/usr/bin/yandex-beta",
		"/usr/bin/yandex-alpha"
	],
	darwin: [
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
		"/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
		"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev",
		"/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
		"/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary",
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		"/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
		"/Applications/Opera.app/Contents/MacOS/Opera",
		"/Applications/Yandex.app/Contents/MacOS/Yandex"
	],
	windows: [
		"C:\\Program Files\\Chromium\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe",
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files\\Google\\Chrome Dev\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome Dev\\Application\\chrome.exe",
		"C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome Beta\\Application\\chrome.exe",
		"C:\\Program Files\\Google\\Chrome SxS\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome SxS\\Application\\chrome.exe",
		"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
		"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
		"C:\\Program Files\\Microsoft\\Edge Dev\\Application\\msedge.exe",
		"C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe",
		"C:\\Program Files\\Microsoft\\Edge Beta\\Application\\msedge.exe",
		"C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe",
		"C:\\Program Files\\Microsoft\\Edge SxS\\Application\\msedge.exe",
		"C:\\Program Files (x86)\\Microsoft\\Edge SxS\\Application\\msedge.exe",
		"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
		"C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
		"C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe",
		"C:\\Program Files (x86)\\Vivaldi\\Application\\vivaldi.exe",
		"C:\\Program Files\\Opera\\launcher.exe",
		"C:\\Program Files (x86)\\Opera\\launcher.exe",
		"C:\\Program Files\\Yandex\\YandexBrowser\\Application\\browser.exe",
		"C:\\Program Files (x86)\\Yandex\\YandexBrowser\\Application\\browser.exe"
	]
};

export {
	BROWSER_ARGS,
	BROWSER_PATHS
};
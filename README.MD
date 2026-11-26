# SingleFile CLI (Command Line Interface)

## Introduction

[SingleFile](https://www.getsinglefile.com) can be launched from the command line by running it into a (headless) browser. 

It runs through Deno as a standalone script injected into the web page via the Chrome DevTools Protocol, or via WebDriver BiDi when using Firefox, instead of being embedded into a WebExtension.

## Installation

SingleFile can be run without installing it, just download the executable file and save it in the directory of your choice here: https://github.com/gildas-lormeau/single-file-cli/releases

Make sure Chrome or a Chromium-based browser is installed in the default folder. Installations for the current user are also found (`%LOCALAPPDATA%` on Windows, `~/Applications` on macOS, snap and the `PATH` on Linux). Otherwise you might need to set the `--browser-executable-path` option to help SingleFile locating the path of the executable file. Firefox can be used instead by setting the `--browser-engine firefox` option, with some limitations described in the help. The Flatpak version of Firefox needs access to `/tmp`, where the temporary profile is created. Allow it with `flatpak override --user --filesystem=/tmp org.mozilla.firefox` and set `--browser-executable-path` to `/var/lib/flatpak/exports/bin/org.mozilla.firefox`, or to `~/.local/share/flatpak/exports/bin/org.mozilla.firefox` for a per-user installation.

## Installation with Docker

- Installation from Docker Hub

  `docker pull capsulecode/singlefile`

  `docker tag capsulecode/singlefile singlefile`

- Manual installation

  `git clone --depth 1 --recursive https://github.com/gildas-lormeau/single-file-cli.git`

  `cd single-file-cli`

  `docker build --no-cache -t singlefile .`

- Run

  `docker run singlefile "https://www.wikipedia.org"`

- Run with Firefox

  `docker run singlefile "https://www.wikipedia.org" --browser-engine firefox`

- Run and redirect the result into a file

  `docker run singlefile "https://www.wikipedia.org" > wikipedia.html`

- Run and mount a volume to get the saved file in the current directory

  - Save one page

    `docker run -v %cd%:/usr/src/app/out singlefile "https://www.wikipedia.org" wikipedia.html`
    (Windows)

    `docker run -v $(pwd):/usr/src/app/out singlefile "https://www.wikipedia.org" wikipedia.html`
    (Linux/UNIX)

  - Save one or multiple pages by using the filename template (see
    `--filename-template` option)

    `docker run -v %cd%:/usr/src/app/out singlefile "https://www.wikipedia.org" --dump-content=false`
    (Windows)

    `docker run -v $(pwd):/usr/src/app/out singlefile "https://www.wikipedia.org" --dump-content=false`
    (Linux/UNIX)

- An alternative docker file can be found here
  https://github.com/screenbreak/SingleFile-dockerized. It allows you to save
  pages from the command line interface or through an HTTP server.

## Manual installation

- Install [Deno](https://deno.com/)

- There are 3 ways to download the code of SingleFile, choose the one you prefer:
  
  - Install with `npm` and run `single-file` via `npx` (`npm` and `npx` are installed with Node.js)
  
    ```sh
    npm install "single-file-cli"
    npx single-file ...
    ```

    You can also install SingleFile globally with `-g` when running `npm install`.

  - Download and unzip manually the
    [main archive](https://github.com/gildas-lormeau/single-file-cli/archive/main.zip)
    provided by Github

    ```sh
    unzip main.zip .
    cd single-file-cli-main
    ```

  - Download with `git`

    ```sh
    git clone --depth 1 --recursive https://github.com/gildas-lormeau/single-file-cli.git
    cd single-file-cli
    ```

- Make `single-file` executable (Linux/Unix/BSD etc.).

  ```sh
  chmod +x single-file
  ```

## Run

- Syntax

  ```sh
  single-file <url> [output] [options ...]
  ```

- Display help

  ```sh
  single-file --help
  ```

- Record what was observed while saving, for later verification: see [MANIFEST.md](MANIFEST.md)

  ```sh
  single-file https://www.wikipedia.org wikipedia.html --manifest
  ```

- Create a proof that the saved page existed at the time of the capture: see [Proof of existence](#proof-of-existence)

  ```sh
  single-file https://www.wikipedia.org wikipedia.html --add-proof
  ```

- Examples

  - Dump the HTML content of https://www.wikipedia.org into the console

  ```sh
  single-file https://www.wikipedia.org --dump-content
  ```

  - Save https://www.wikipedia.org into `wikipedia.html` in the current folder

  ```sh
  single-file https://www.wikipedia.org wikipedia.html
  ```

  - Save a page needing a logged-in session. Create the profile first, log in
    to the website in the browser window, and quit the browser to save it. Then
    reuse the profile as many times as needed, it is copied and left unmodified.

  ```sh
  single-file --create-browser-profile ./profiles/example https://www.example.com/login
  single-file https://www.example.com/account account.html --browser-profile=./profiles/example
  ```

  - Save https://www.wikipedia.org with Firefox

  ```sh
  single-file https://www.wikipedia.org wikipedia.html --browser-engine firefox
  ```

  - Save a list of URLs stored into `list-urls.txt` in the current folder

  ```sh
  single-file --urls-file=list-urls.txt
  ```

  - Save a page whose content is split into tabs, with the rules of `tabs.css`
    keeping the hidden tabs in the page and the code of `tabs.js` switching
    them in the saved file (the page's own scripts are not kept)

  ```sh
  single-file https://www.example.com/scorecard scorecard.html --custom-stylesheet-file=tabs.css --embedded-script-file=tabs.js
  ```

  - Save https://www.wikipedia.org and crawl its internal links with the query
    parameters removed from the URL

  ```sh
  single-file https://www.wikipedia.org --crawl-links=true --crawl-inner-links-only=true --crawl-max-depth=1 --crawl-rewrite-rule="^(.*)\\?.*$ $1"
  ```

  - Save https://www.wikipedia.org and external links only

  ```sh
  single-file https://www.wikipedia.org --crawl-links=true --crawl-inner-links-only=false --crawl-external-links-max-depth=1 --crawl-rewrite-rule="^.*wikipedia.*$"
  ```

  - Save http://info.cern.ch (i.e. the first website) and its internal links into a single self-extracting ZIP file, and mark the links to pages missing from the archive

  ```sh
  single-file http://info.cern.ch first-website.html --crawl-links=true --crawl-max-depth=2 --crawl-save-archive=true --crawl-save-archive-mark-unarchived-links=true --compress-content=true
  ```

- Exit code

  The exit code is 0 when all the pages have been saved, 1 when at least one capture failed (the other pages of the batch or the crawl are still saved), and 255 when an error prevented the process from running.

## Proof of existence

The option `--add-proof` writes an [OpenTimestamps](https://opentimestamps.org) proof next to the saved page. With the proof, anyone can check later that the saved file existed at the time of the capture, with the Bitcoin blockchain as the only reference.

1. Save the page.

   ```sh
   single-file https://www.wikipedia.org wikipedia.html --add-proof
   ```

   Two files are written: `wikipedia.html` and `wikipedia.html.ots`, which is the proof. Only the SHA-256 hash of the saved file, mixed with a random value, is sent to the public OpenTimestamps servers. The page itself is not sent.

2. Upgrade the proof, a few hours later. When it is written the proof is pending: it relies on the servers that received the hash. Once the hash is in a Bitcoin block, upgrading the proof makes it complete and independent of these servers. This needs [Node.js](https://nodejs.org).

   ```sh
   npx opentimestamps upgrade wikipedia.html.ots
   ```

   The command answers "Success! Timestamp complete" and keeps the previous file as `wikipedia.html.ots.bak`. If it answers that the timestamp is not complete, it is too early: run it again later.

3. Verify the proof, at any time after that. The page must be next to its proof.

   ```sh
   npx opentimestamps verify wikipedia.html.ots
   ```

   The command answers with the Bitcoin block and the date that attest the existence of the file. You can also verify without installing anything on [opentimestamps.org](https://opentimestamps.org): drop the `.ots` file on the page, then the saved page.

Keep the two files together and do not modify the saved page: the proof is only valid for the exact file that was saved, and a lost proof cannot be created again for the same date.

The commands above use the JavaScript client of OpenTimestamps, which reads the Bitcoin blockchain through public block explorers. The Python client (`pip3 install opentimestamps-client`, then `ots upgrade` and `ots verify`) reads the same files, but it needs a local Bitcoin Core node to verify.

The public OpenTimestamps servers are free to use and rely on donations. If you rely on this option, consider supporting them: see the [calendars](https://opentimestamps.org/#calendars) listed on opentimestamps.org, each one shows its donation address.

## Browser sandbox

On macOS and Windows, a Chromium-based browser is launched with its sandbox, which confines the
processes that render the pages: a page that exploits a flaw of the browser cannot read your files.
If the browser exits at startup, `single-file` launches it again with `--no-sandbox` and displays a
warning. Pass `--browser-arg=--no-sandbox` to launch it without its sandbox from the start.

On Linux, the browser is launched with `--no-sandbox`. Its sandbox cannot be set up when the tool
is run as root, in a Docker container with the default security profile, or on Ubuntu with a
browser that was not installed from a package, and where it can, a page that runs out of memory is
no longer reported as crashed.

## Compile executables

 - Compile executables into `/dist`

  ```sh
  ./compile.sh
  ```


## License

SingleFile and SingleFile CLI are licensed under AGPL. Code derived from third-party projects is licensed under MIT. Please contact me at gildas.lormeau &lt;at&gt; gmail.com if you are interested in licensing the SingleFile code for a commercial service or product.

# SingleFile CLI (Command Line Interface)

## Introduction

[SingleFile](https://www.getsinglefile.com) can be launched from the command line by running it into a (headless) browser. 

It runs through Deno as a standalone script injected into the web page via the Chrome DevTools Protocol instead of being embedded into a WebExtension.

## Installation

SingleFile can be run without installing it, just download the executable file and save it in the directory of your choice here: https://github.com/gildas-lormeau/single-file-cli/releases

Make sure Chrome or a Chromium-based browser is installed in the default folder. Otherwise you might need to set the `--browser-executable-path` option to help SingleFile locating the path of the executable file.

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
    [master archive](https://github.com/gildas-lormeau/single-file-cli/archive/master.zip)
    provided by Github

    ```sh
    unzip master.zip .
    cd single-file-cli-master
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

- Examples

  - Dump the HTML content of https://www.wikipedia.org into the console

  ```sh
  single-file https://www.wikipedia.org --dump-content
  ```

  - Save https://www.wikipedia.org into `wikipedia.html` in the current folder

  ```sh
  single-file https://www.wikipedia.org wikipedia.html
  ```

  - Save a list of URLs stored into `list-urls.txt` in the current folder

  ```sh
  single-file --urls-file=list-urls.txt
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

## Compile executables

 - Compile executables into `/dist`

  ```sh
  ./compile.sh
  ```


## License

SingleFile and SingleFile CLI are licensed under AGPL. Code derived from third-party projects is licensed under MIT. Please contact me at gildas.lormeau &lt;at&gt; gmail.com if you are interested in licensing the SingleFile code for a commercial service or product.

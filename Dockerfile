FROM zenika/alpine-chrome:with-deno

RUN git clone --depth 1 --recursive https://github.com/gildas-lormeau/single-file-cli.git

WORKDIR /usr/src/app/single-file-cli

ENTRYPOINT [ \
    "./single-file", \
    "--browser-executable-path", "/usr/bin/chromium-browser", \
    "--output-directory", "./../../out/", \
    "--dump-content" ]

FROM zenika/alpine-chrome:with-deno

RUN wget -qO- "https://github.com/gildas-lormeau/single-file-cli/archive/master.zip" | unzip -d /usr/src/app -q -

WORKDIR /usr/src/app/single-file-cli-master

ENTRYPOINT [ \
    "./single-file", \
    "--browser-executable-path", "/usr/bin/chromium-browser", \
    "--output-directory", "./../../out/", \
    "--dump-content" ]

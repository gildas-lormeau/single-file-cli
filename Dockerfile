FROM zenika/alpine-chrome:with-deno

RUN wget -q -O source.zip https://github.com/gildas-lormeau/single-file-cli/archive/master.zip && unzip -q source.zip && rm source.zip

WORKDIR /usr/src/app/single-file-cli-master

ENTRYPOINT [ \
    "deno", \
    "-q", \
    "run", \
    "--allow-read", \
    "--allow-write", \
    "--allow-net", \
    "--allow-env", \
    "--allow-run", \
    "./single-file", \
    "--browser-executable-path", "/usr/bin/chromium-browser", \
    "--output-directory", "./../../out/", \
    "--dump-content" ]

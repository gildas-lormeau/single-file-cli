FROM zenika/alpine-chrome:with-deno

RUN wget -q -O source.zip https://github.com/gildas-lormeau/single-file-cli/archive/master.zip && unzip -q source.zip && rm source.zip

WORKDIR /usr/src/app/single-file-cli-master

ENTRYPOINT [ \
    "./single-file", \
    "--browser-executable-path", "/usr/bin/chromium-browser", \
    "--output-directory", "./../../out/", \
    "--dump-content" ]

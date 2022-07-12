FROM zenika/alpine-chrome:with-node

USER root

COPY . /opt

WORKDIR /opt

RUN npm install

ENTRYPOINT [ "node", "single-file", \
    "--browser-executable-path", "/usr/bin/chromium-browser", \
    "--output-directory", "./../../out/", \
    "--browser-args", "[\"--no-sandbox\"]", \
    "--dump-content" ]

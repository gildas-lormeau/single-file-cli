FROM docker.io/zenika/alpine-chrome:with-node

ARG BUILD_DATE
ARG GIT_COMMIT
LABEL vendor="VoerEir AB"
LABEL authors="VoerEir Development Team <contact@voereir.com>"
LABEL name="voereir/singlefile"
LABEL version="2.0.75"
LABEL org.opencontainers.image.authors="VoerEir Development Team <contact@voereir.com>"
LABEL org.opencontainers.image.base.name="docker.io/zenika/alpine-chrome:with-node"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.description="VoerEir's singlefile-cli container image."
LABEL org.opencontainers.image.revision="${GIT_COMMIT}"
LABEL org.opencontainers.image.title="singlefile-cli"
LABEL org.opencontainers.image.url="https://github.com/VoerEirAB/single-file-cli"
LABEL org.opencontainers.image.vendor="VoerEir AB"
LABEL org.opencontainers.image.version="2.0.75"

RUN npm install --omit=dev single-file-cli@2.0.75

WORKDIR /usr/src/app

ENTRYPOINT [ \
    "npx", \
    "single-file", \
    "--browser-executable-path", "/usr/bin/chromium-browser", \
    "--output-directory", "./out/", \
    "--dump-content" ]

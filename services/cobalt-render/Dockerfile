FROM ghcr.io/imputnet/cobalt:11

LABEL org.opencontainers.image.source="https://github.com/jackshaw0317-debug/chaipian-ai"

USER root
RUN apk add --no-cache \
    chromium \
    ffmpeg \
    ca-certificates \
    freetype \
    harfbuzz \
    nss \
    ttf-freefont

RUN mkdir -p /usr/local/lib/chaipian
COPY proxy.mjs /usr/local/lib/chaipian/proxy.mjs
COPY start-render.sh /usr/local/bin/start-render
RUN chmod 755 /usr/local/bin/start-render

USER node
ENTRYPOINT ["/usr/local/bin/start-render"]

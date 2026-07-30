FROM ghcr.io/imputnet/cobalt:11

USER root
COPY start-render.sh /usr/local/bin/start-render
RUN chmod 755 /usr/local/bin/start-render

USER node
ENTRYPOINT ["/usr/local/bin/start-render"]

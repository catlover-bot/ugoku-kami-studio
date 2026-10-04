FROM node:24.20.0-bookworm-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa
LABEL org.opencontainers.image.title="ugoku-kami Ollama CPU sidecar" \
      org.opencontainers.image.version="0.33.3-gemma4-e2b-it-qat" \
      org.opencontainers.image.licenses="MIT AND Apache-2.0"
WORKDIR /opt/bundle
# This Dockerfile is copied into an allowlisted staging context, never the source tree.
COPY runtime ./runtime
COPY models ./models
COPY bundle-lock.json verify-bundle.mjs start.sh LICENSE.ollama ./
RUN node verify-bundle.mjs /opt/bundle && chmod -R a-w runtime models && \
    chmod 555 start.sh && mkdir -p /home/node/.ollama && chown node:node /home/node/.ollama
USER node
# No public port declaration. Cloud Run exposes only the app's port 8080.
ENTRYPOINT ["/opt/bundle/start.sh"]

#!/bin/sh
set -eu
# Images contain verified weights. Startup never pulls or calls a hosted service.
node /opt/bundle/verify-bundle.mjs /opt/bundle
export OLLAMA_MODELS=/opt/bundle/models
export OLLAMA_NO_CLOUD=1
export OLLAMA_HOST=0.0.0.0:11434
export OLLAMA_NUM_PARALLEL=1
export OLLAMA_MAX_LOADED_MODELS=1
export OLLAMA_MAX_QUEUE=1
export OLLAMA_CONTEXT_LENGTH=16384
export OLLAMA_KEEP_ALIVE=5m
exec /opt/bundle/runtime/bin/ollama serve

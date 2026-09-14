FROM docker.io/cloudflare/sandbox:0.7.0

# Slice 1: git + jq for RESULT.json
# Slice 1.2: node/npm to run package.json tests after clone
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    jq \
    ca-certificates \
    nodejs \
    npm \
  && rm -rf /var/lib/apt/lists/*

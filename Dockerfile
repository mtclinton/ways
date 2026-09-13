FROM docker.io/cloudflare/sandbox:0.7.0

# Slice 1 needs git + jq so a run can write a machine-readable RESULT.json.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    jq \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

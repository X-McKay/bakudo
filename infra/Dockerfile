# Control-plane image for the bakudo worker and API.
# The worker plane (agent-runner) is shipped into abox microVMs separately.
FROM python:3.11-slim

WORKDIR /app

# System deps: git is needed by the worker tools and the local sandbox.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md LICENSE ./
COPY src ./src
COPY schemas ./schemas
COPY skills ./skills
COPY agents ./agents

RUN pip install --no-cache-dir ".[temporal,db,api,runtime]"

# Default to the worker; compose overrides command for the API service.
CMD ["bakudo-worker"]

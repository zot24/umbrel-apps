# Hermes Agent Docker Image for Umbrel
# Self-hosted AI agent with messaging platform integrations

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM python:3.11-slim-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl gcc g++ libffi-dev python3-dev build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install uv (fast Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# Install Node.js 22 LTS (needed for WhatsApp bridge + agent-browser)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Clone hermes-agent at pinned version
ARG HERMES_VERSION=v2026.3.23
RUN git clone --depth 1 --branch "${HERMES_VERSION}" \
    https://github.com/NousResearch/hermes-agent.git /build/hermes

WORKDIR /build/hermes

# Create venv and install hermes with messaging extras
RUN uv venv /build/hermes/venv --python 3.11
ENV VIRTUAL_ENV=/build/hermes/venv
ENV PATH="/build/hermes/venv/bin:${PATH}"
RUN uv pip install -e ".[telegram,discord,slack,matrix,mcp,cron,pty]"

# Install Node.js dependencies (agent-browser, WhatsApp bridge)
RUN npm ci --omit=dev 2>/dev/null || true
RUN if [ -d scripts/whatsapp-bridge ]; then cd scripts/whatsapp-bridge && npm ci --omit=dev; fi

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM python:3.11-slim-bookworm

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    sudo ca-certificates curl git procps file nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# Create hermes user
RUN useradd -m -u 1000 -s /bin/bash hermes \
    && echo "hermes ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Copy hermes from builder
COPY --from=builder /build/hermes /app
RUN chown -R hermes:hermes /app

# Set up home directory
ENV HOME=/home/hermes
WORKDIR /home/hermes

# Switch to hermes user for brew install
USER hermes

# Install Homebrew (persistent package manager for the agent)
RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# ── Security shims ────────────────────────────────────────────────────────────
# Shim systemctl for Docker — no systemd in container.
# Hermes agent may call systemctl to manage the gateway service.
# This intercepts those calls and uses pkill instead.
RUN printf '#!/bin/bash\n# Skip flags (e.g. --user) to find the actual subcommand\ncmd=""\nfor arg in "$@"; do\n  case "$arg" in\n    -*) ;;\n    *) cmd="$arg"; break ;;\n  esac\ndone\ncase "$cmd" in\n  restart|stop) pkill -f "hermes.*gateway" 2>/dev/null || true ;;\n  start) echo "hermes-gateway is managed by the container" ;;\n  *) exit 0 ;;\nesac\n' | sudo tee /usr/local/bin/systemctl \
    && sudo chmod +x /usr/local/bin/systemctl

# Replace apt/apt-get with script telling the agent to use brew
RUN printf '#!/bin/bash\necho "Error: apt is not available. Please use brew instead." >&2\necho "Example: brew install <package>" >&2\nexit 1\n' | sudo tee /usr/local/bin/use-brew \
    && sudo chmod +x /usr/local/bin/use-brew \
    && sudo ln -sf /usr/local/bin/use-brew /usr/local/bin/apt \
    && sudo ln -sf /usr/local/bin/use-brew /usr/local/bin/apt-get

# Copy entrypoint
COPY --chown=hermes:hermes entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Move home to skeleton for first-run init
RUN sudo mv /home/hermes /home-skeleton \
    && sudo mv /home/linuxbrew /home-skeleton/linuxbrew

# Set up PATH
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/app/venv/bin:${PATH}"
ENV VIRTUAL_ENV=/app/venv
ENV HERMES_HOME=/home/hermes/.hermes

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=120s \
    CMD python3 -c "import json,sys,os; p=os.path.join(os.getenv('HERMES_HOME','/home/hermes/.hermes'),'gateway_state.json'); d=json.load(open(p)); sys.exit(0 if d.get('gateway_state')=='running' else 1)" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["gateway"]

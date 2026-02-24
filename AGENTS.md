# AGENTS.md

## Cursor Cloud specific instructions

### Overview

CAIPE (Community AI Platform Engineering) is a Python 3.13+ monorepo managed with `uv` workspaces. It implements a Multi-Agent AI System (MAS) for Platform Engineering/SRE/DevOps using the A2A (Agent-to-Agent) and MCP (Model Context Protocol) protocols.

### Project structure

- `ai_platform_engineering/agents/` -- Individual sub-agents (argocd, aws, github, jira, slack, weather, etc.)
- `ai_platform_engineering/multi_agents/` -- Orchestrator personas (platform-engineer, incident-engineer, product-owner)
- `ai_platform_engineering/knowledge_bases/` -- RAG and GraphRAG components
- `docs/` -- Docusaurus documentation site (Node.js)
- `helm/` -- Kubernetes Helm chart
- Root `pyproject.toml` manages the uv workspace with `agent-argocd` and `agent-komodor` as workspace members.

### Lint / Test / Build / Run

Standard commands are in the root `Makefile`. Key commands:

- **Lint:** `uv run python -m ruff check . --select E,F --ignore F403 --ignore E402 --line-length 320`
- **Test:** `uv run pytest --ignore=integration --ignore=ai_platform_engineering/knowledge_bases/rag/tests`
- **Run orchestrator:** `uv run python -m ai_platform_engineering.multi_agents platform-engineer` (requires LLM credentials in `.env`)
- **Run individual agent (e.g. weather):** `cd ai_platform_engineering/agents/weather && uv sync --no-dev && uv run python -m agent_weather --host 0.0.0.0 --port 8009`

Each agent also has its own `Makefile` with targets like `run-a2a`, `test`, `lint` -- see `ai_platform_engineering/agents/common.mk` for the shared target definitions.

### Non-obvious caveats

- **Python 3.13+ is required.** The system `python3` may be older; use `python3.13` explicitly or ensure `uv` resolves to the correct interpreter. The venv at `.venv` is created with `uv venv --python python3.13`.
- **All agents require LLM provider credentials** (`LLM_PROVIDER`, plus provider-specific keys like `OPENAI_API_KEY`) to fully initialize. Without credentials, the HTTP server framework starts but the agent graph cannot process queries. Copy `.env.example` to `.env` and configure at minimum an LLM provider section.
- **The weather agent is the simplest demo agent** with no external service dependencies (no ArgoCD token, GitHub PAT, etc.). Use it for smoke-testing the A2A protocol.
- **Each agent has its own `uv.lock` and venv.** When working on a specific agent, `cd` into its directory and run `uv sync` there. The root workspace only includes `agent-argocd` and `agent-komodor` as members.
- **`SKIP_AGENT_CONNECTIVITY_CHECK=true`** is set in `.env.example` to skip connectivity checks to sub-agents during orchestrator startup. This is helpful when running only the orchestrator locally without all sub-agents.
- **Docker Compose profiles** control which services start: `p2p` (direct A2A), `slim` (SLIM gateway), `*-tracing` (adds Langfuse), `kb-rag` (adds RAG stack), `graph_rag` (adds Neo4j/Nexigraph). See `docker-compose.yaml` and `docker-compose.dev.yaml`.

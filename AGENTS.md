# FreeLLMAPI Agent Guidelines & Architecture

This repository implements **FreeLLMAPI**, a high-throughput proxy that aggregates free-tier LLM providers behind unified API endpoints with encrypted key storage, automatic failover, per-key rate-limit tracking, and health checks.

---

## 1. Architecture & Repository Structure

FreeLLMAPI is an npm workspace monorepo consisting of:

* **`server/`**: Express backend (TypeScript, Node 22+)
  * `src/app.ts`: Express application setup, security middleware, and route mounting.
  * `src/routes/proxy.ts`: Core `/v1/chat/completions` proxy and authentication.
  * `src/routes/responses.ts`: Codex CLI `/v1/responses` translation shim.
  * `src/routes/typesafe.ts`: Jevgrep (`jg`) `/typesafe/v1/systemone` evaluation shim.
  * `src/services/router.ts`: Multi-provider fallback chain, dynamic penalty scoring, and model selection.
  * `src/services/ratelimit.ts`: Sliding-window RPM/RPD/TPM/TPD tracking and cooldown management.
  * `src/db/`: Better-SQLite3 database (`server/data/freeapi.db`), schema migrations, and encrypted key storage.
  * `src/providers/`: Provider adapters (Google, Mistral, Cloudflare, Cohere, Memos, OpenAI-compatible).
* **`client/`**: React + Vite admin dashboard for key management, fallback ordering, and playground.
* **`shared/`**: Shared TypeScript types (`ChatMessage`, `Platform`, `RouteResult`, etc.).

---

## 2. API Endpoints & Wire Protocols

FreeLLMAPI provides three primary AI consumption interfaces:

1. **OpenAI Chat API (`/v1/chat/completions`)**:
   Standard OpenAI-compatible chat endpoint supporting streaming (SSE) and non-streaming responses, tool/function calling, and multimodal vision inputs.

2. **OpenAI Responses API (`/v1/responses`)**:
   Wire protocol shim designed for Codex CLI, translating responses-style message streams into the internal chat representation.

3. **TypeSafe SystemOne API (`/typesafe/v1/systemone`)**:
   Wire protocol shim designed for **jevgrep (`jg`)**, accepting boolean/noul relevance questions against repository state and returning scored candidate rankings.

---

## 3. Code Navigation & Discovery Rules

When developing or debugging inside this repository, follow the standard tool-selection contract:

### A. Use Native AGY Tools (`view_file`, `grep`, regex/glob) when:
* Exact symbol, function, class, or type name is known (e.g., `typesafeRouter`, `routeRequest`, `OpenAICompatProvider`).
* Inspecting known route handlers, config files, or unit tests.
* Checking git history, branch status, or diffs.
* The required context has already been discovered in earlier steps.

### B. Use jevgrep (`jg`) when:
* Discovering where unfamiliar cross-service logic is implemented (e.g., *"How is daily token quota cooldown persisted across server restarts?"*).
* Tracing execution flow across multiple provider adapters and middleware.
* Unfamiliar code navigation where exact symbol names are unknown.

> **Crucial for `jg`**: When running `jg` against FreeLLMAPI, always specify low concurrency (`--concurrency 1` or `--concurrency 2`) to respect upstream free-tier RPM limits:
> ```sh
> jg "<question>" [root] --concurrency 1
> ```

### C. Fallback Handling:
* If `jg` returns an error or reports rate-limiting (`HTTP 429`), immediately fall back to native file exploration (`grep`, `view_file`) rather than stalling or repeating failed searches.

---

## 4. Development, Testing & Quality Standards

* **Build Server**:
  ```sh
  npm run build:server
  ```
  Ensures TypeScript compiles cleanly to `server/dist/`. Always build before running production processes.
* **Run Tests**:
  ```sh
  npm test -w server
  ```
  Uses Vitest with isolated fork pooling. Route tests should mock `routeRequest` to prevent making live external network calls or exhausting provider quotas.
* **Targeted Test Execution**:
  ```sh
  npm test -w server -- src/__tests__/routes/typesafe.test.ts
  ```
* **Security & Key Handling**:
  - Never log decrypted API keys.
  - Never commit `freeapi.db`, `.env`, or credential tokens.
  - Keys are stored encrypted with AES-256-GCM.

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**This project has a knowledge graph. Start with the code-review-graph
MCP tools to narrow scope, then read the source.** The graph is cheaper than scanning files and
gives you structural context (callers, dependents, test coverage) that file search cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes_tool` or `query_graph_tool` instead of Grep
- **Understanding impact**: `get_impact_radius_tool` instead of manually tracing imports
- **Code review**: `detect_changes_tool` + `get_review_context_tool` instead of reading entire files
- **Finding relationships**: `query_graph_tool` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview_tool` + `list_communities_tool`

### Verify in the source

- Narrow scope with the graph, then read the source. Do not change code from graph output alone.
- For any non-trivial change, read the implementation and the relevant tests before concluding.
- Verify the exact source when touching behavior, database logic, migrations, retries, fallbacks,
  recovery, or compatibility code.
- When the graph and the source disagree, the source wins. The graph may be stale or may not
  model that relationship.
- An empty graph result can mean "not indexed" or "not statically visible", not "does not exist".

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes_tool` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context_tool` | Need source snippets for review — token-efficient |
| `get_impact_radius_tool` | Understanding blast radius of a change |
| `get_affected_flows_tool` | Finding which execution paths are impacted |
| `query_graph_tool` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes_tool` | Finding functions/classes by name or keyword |
| `get_architecture_overview_tool` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes_tool` for code review.
3. Use `get_affected_flows_tool` to understand impact.
4. Use `query_graph_tool` pattern="tests_for" to check coverage.
<!-- /code-review-graph MCP tools -->

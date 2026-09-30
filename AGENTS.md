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

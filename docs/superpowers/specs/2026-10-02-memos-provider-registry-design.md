# MemOS Provider Registry Design

## Goal

Make the existing native MemOS adapter usable from the dashboard without
misrepresenting MemOS as an OpenAI-compatible custom endpoint.

## Scope

- Add MemOS to the dashboard's built-in provider registry.
- Expose the three models supported by the native adapter:
  `qwen3-32b`, `deepseek-r1`, and `qwen2.5-72b-instruct`.
- Keep the existing custom endpoint flow unchanged for OpenAI-compatible
  services such as Ollama.
- Preserve native MemOS authentication using `Authorization: Token <key>`.

## Data flow

1. The user selects **MemOS** in the provider-key dialog and submits a token.
2. The existing `/api/keys` route stores and validates the token as platform
   `memos`.
3. The MemOS model rows are available to the dashboard fallback/model queries.
4. Routing sends selected requests through `MemosProvider`, which translates
   the OpenAI-style request into MemOS's native request format.

## Error handling

- Invalid MemOS tokens remain disabled by the existing health/key validation
  flow and must not be shown as routable healthy capacity.
- The custom endpoint form must not be changed to accept the MemOS URL because
  that form assumes OpenAI-compatible `/models` and chat protocols.
- Existing provider and catalog errors remain surfaced through the current
  dashboard notifications.

## Validation

- Add or update focused tests for provider registry visibility and MemOS model
  availability.
- Run the relevant client/server tests and a production build.
- Confirm the running dashboard can display MemOS without requiring a custom
  endpoint.

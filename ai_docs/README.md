<!-- agentify:managed -->
# AI Docs

Agentify-generated always-on context from the validated codebase map.

## Module Boundaries

- `src/cli.ts` -> `src/core/agentify-app.ts` (import)
- `src/core/agentify-app.ts` -> `src/core/run-agentify.ts` (import)
- `src/core/run-agentify.ts` -> `src/core/runs/brownfield-run.ts` (import)
- `src/core/runs/brownfield-run.ts` -> `src/core/audit/` (import)
- `src/core/audit/spawn-explorer-tool.ts` -> `src/core/pi-sdk-runtime.ts` (rpc)
- `src/core/webhook/worker.ts` -> `src/core/webhook/queue.ts` (state)
- `src/core/aiw/worker.ts` -> `src/core/aiw/state.ts` (state)

## Security Notes

- Reject compound shell before command matching
- Never expose zero-access secret/config paths
- Domain locks may narrow but never widen execution-policy roots
- Audit and review sessions deny shell mutation
- User-owned protected files cannot be overwritten
- Script contents are re-scanned for blocked operations
- Externally triggered sessions remain read-only

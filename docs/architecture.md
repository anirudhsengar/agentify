# Generation architecture and trust boundary

```mermaid
flowchart TD
    A[Repository] --> B[Evidence collection and audit]
    B --> C[Structured codebase map]
    C --> D[CodebaseMapSchema and coverage validation]
    D --> E[Brownfield artifact renderers]
    E --> F[Managed-marker ownership and apply policy]
    F --> G[Staged bundle and required-conflict preflight]
    G --> H[Agents, experts, skills and workflows]
    H --> I[GitHub issue-to-PR runtime]
```

Repository understanding is the probabilistic boundary: a model may collect and
synthesize evidence, but its output is only an input proposal. The codebase-map
schema and coverage-quality gate are deterministic and reject malformed or
incomplete proposals before repository-facing artifacts are rendered.

Rendering is deterministic for a given validated map. The apply layer enforces
ownership using Agentify's managed markers and the configured conflict policy;
it never relies on the model to identify user-owned files. Required conflicts
are preflighted before bundle writes, and the manifest records sorted paths and
content hashes. Each successful run retains its own run ID and timestamp, so
tests treat those two manifest fields as intentionally volatile. Repository safety therefore remains enforced in code even when
model-assisted understanding is incomplete or wrong.

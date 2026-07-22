---
name: Adapter proposal
about: Propose support for a new queue technology
labels: adapter
---

**Queue technology + version** (e.g. Graphile Worker 0.17, Celery 5, Sidekiq…)

**How to read state** — API/queries for: counts per state, workers, recent failures.

**Push events available?** (yes/no — polling-only adapters are fine)

**Willing to implement it?** The contract is ~100 lines: `packages/core/src/adapter.ts`.

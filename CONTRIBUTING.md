# Contributing to Queuecraft

Thanks for wanting to make queues weirder. Here's how to help without friction.

## Ground rules

1. Read [`docs/ADR-001`](docs/ADR-001-fondations-queuecraft.md) first. Architectural decisions live in ADRs; PRs that contradict an ADR need a superseding ADR, not a debate in comments.
2. **Vanilla-stable commands only** in anything that renders (ADR D4). Every Minecraft command must exist unchanged on Paper 1.21.11 *and* 26.2.
3. **Respect the command budget** (ADR D7): ≤ 40 RCON commands/second sustained. If your feature renders per-job, it's wrong (except failures, capped at 50).
4. Runtime target is **Node ≥ 22.12** (pg-boss v12 requirement). No Bun-specific APIs in shipped code.

## Dev setup

```bash
pnpm install
pnpm -r typecheck          # must be green before any PR
cd spikes/rcon-benchmark && docker compose up -d   # disposable test server
```

## Writing an adapter (the most wanted contribution)

An adapter translates one queue technology into the pivot model. The whole contract is in
[`packages/core/src/adapter.ts`](packages/core/src/adapter.ts) — `start`, `stop`, `snapshot()`,
`recentFailures(limit)`, optional `onEvent` and `actions`. Target: 100–150 lines.

Rules that will come up in review:

- `snapshot()` is polled every ~500 ms → no heavy work inside; cache internally.
- Network errors from the underlying tech must never crash the daemon: catch, log, return the last known snapshot.
- Truncate failure `error` strings to 200 chars adapter-side.
- `packages/core` never imports an adapter. Ever.

⚠️ The `Adapter` interface is **not frozen** until the BullMQ adapter ships (ADR D6). Until then, interface changes are possible and every existing adapter is updated in the same commit.

## PR checklist

- [ ] `pnpm -r typecheck` green
- [ ] No new Minecraft command outside the ADR D4 whitelist (or: a new ADR justifying it)
- [ ] Measured numbers (cmd/s, latency) in the PR description for anything touching the renderer
- [ ] Docs updated if public behavior changed

## Commit style

Conventional-ish and honest: `feat(adapter-pgboss): …`, `fix(renderer): …`, `docs: …`, `chore: …`.

## Not a code contribution?

Bug reports, world-design ideas, and screenshots of your queues melting down in-game are all welcome — open an issue.

# Architecture

*Companion to the ADRs (`docs/ADR-*.md`), which hold the "why". This file holds the "what".*

## Data flow

```
queue tech (pg-boss, BullMQ, …)
        │  polled ~500 ms  +  optional push events
        ▼
   Adapter  ────────────────►  Pivot model (QueueSnapshot / QueueEvent / FailedJobDetail)
                                        │
                                        ▼
                              Renderer: mirror + diff
                    (in-memory copy of everything drawn in the world;
                     each tick emits ONLY the mutations, aggregated)
                                        │  ≤ 40 cmd/s
                                        ▼
                                 RCON (rcon-client)
                                        │
                                        ▼
                               Minecraft server (Paper 1.21.11 / 26.2)
```

## Packages

| Path | Role | Depends on |
|---|---|---|
| `packages/core` | Pivot model + `Adapter` contract. Types only for now. | nothing |
| `packages/adapter-pgboss` | pg-boss v12 → pivot | core, pg-boss |
| `packages/adapter-bullmq` | BullMQ v5 → pivot | core, bullmq |
| `packages/renderer` | mirror, diff engine, layout, RCON sink (data→world mapping: [world-design.md](world-design.md)) | core, rcon-client |
| `apps/demo-traffic` | fake job generator (PGlite, tunable failure rate) | pg-boss |
| `apps/demo` | all-in-one docker compose showcase | everything |
| `spikes/*` | throwaway code answering one question each | — |

Dependency rule: arrows point **inward to core only**. Core imports nothing from this list.

## Key invariants

1. The world is a *display*. All state lives in the daemon; a wipe (`kill @e[tag=qc]` + fill air)
   followed by a redraw must always reconstruct it.
2. Everything drawn carries the `qc` entity tag / known coordinates from `layout.ts`.
3. Events are decoration; polling is truth. Losing every event changes nothing but sparkle.
4. Per-job rendering is forbidden except failures (≤ 50 gravestones).

## Version compatibility strategy

No plugin API, no protocol bots — only vanilla commands stable for years (ADR D4).
CI runs a weekly smoke test against the two reference targets (1.21.11, 26.2) executing one
command of each family from the whitelist. If Mojang breaks one, we learn it from a red build,
not from a user.

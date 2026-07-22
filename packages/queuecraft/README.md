# queuecraft

> Your job queues, rendered as a living Minecraft world.

**This package is a name reservation.** It ships no code yet. The Queuecraft daemon — the
program that reads your job queues and draws them into a Minecraft server over RCON — will
be published here once the renderer lands.

## What exists today

| Package | Status |
|---|---|
| [`@queuecraft/core`](https://www.npmjs.com/package/@queuecraft/core) | Published — pivot model + `Adapter` contract, types only |
| `queuecraft` (this one) | Reserved — the daemon will live here |

Everything is being built in the open: **https://github.com/zinackes/queuecraft**

Start with [ADR-001](https://github.com/zinackes/queuecraft/blob/main/docs/ADR-001-fondations-queuecraft.md),
which records every structural decision — RCON-only transport, vanilla-stable commands so it
runs on Minecraft 1.21.x *and* 26.x, and a ≤ 40 commands/second render budget.

MIT

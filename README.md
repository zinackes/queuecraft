# ⛏ Queuecraft

> Your job queues, rendered as a living Minecraft world.
>
> **Bull Board shows you your queues. Queuecraft makes you live in them.**

Queuecraft turns a Minecraft server into a live dashboard for your background job queues (pg-boss, BullMQ). Each queue is a train station: pending jobs pile up as minecarts on the sidings, workers are villagers at their posts, failed jobs become gravestones in a graveyard — the error message engraved on the tomb — and a redstone lamp wall charts your throughput history. When your error rate spikes, a thunderstorm rolls in.

This is a **functional art project**: it genuinely works, but its purpose is joy, demos, and teaching how queues behave — not replacing Grafana. It says so on the tin.

**Status: early WIP.** The [foundation ADR](docs/ADR-001-fondations-queuecraft.md) is written and the RCON throughput spike has been run on both compatibility targets — it proved one of the ADR's premises wrong ([ADR-002](docs/ADR-002-debit-rcon-reel.md)). The [visual spec & layout contract](docs/world-design.md) is the reference for the renderer, which is next. Star/watch to follow along.

## How it works

```
┌────────────┐   ┌────────────┐   ┌───────────────┐   ┌──────┐   ┌─────────────┐
│  pg-boss   │──►│  Adapter   │──►│  Pivot model  │──►│ Diff │──►│ RCON ──► MC │
│  BullMQ    │   │ (~100 loc) │   │ QueueSnapshot │   │engine│   │   server    │
└────────────┘   └────────────┘   └───────────────┘   └──────┘   └─────────────┘
```

One tiny normalized model, one adapter per queue technology, and a render loop that mirrors world state in memory and only sends the mutations. No plugin, no mod, no bot — just RCON, the remote console protocol every Minecraft server has shipped since 2011.

## Design constraints (the interesting part)

- **RCON only.** Zero server-side installation: three lines in `server.properties` and you're in.
- **Vanilla-stable commands only** (`setblock`, `fill`, `summon`, `data`, `bossbar`…). Works unchanged on Minecraft 1.21.x **and** the new 26.x line, and probably on whatever comes next.
- **≤ 40 commands/second budget.** Not because RCON is slow — [we measured 2,300+ sustained](spikes/rcon-benchmark#résultats--mesurés-le-22072026) — but because every command costs main-thread time on the server you're watching. So the renderer diffs against an in-memory mirror and aggregates (1 rendered minecart = N real jobs, log-scale lamp walls). Only failures are rendered 1:1 — capped at 50 gravestones, because that's where detail matters.
- **One command at a time per connection.** RCON pipelining doesn't just fail to help — the server closes the connection on the 2nd or 3rd in-flight command. Parallelism, if ever needed, means more connections.
- **Read-only v1.** Retry-from-the-graveyard is phase 2.

## What exists today

```bash
git clone https://github.com/zinackes/queuecraft && cd queuecraft
pnpm install && pnpm -r typecheck        # pivot model, renderer, pg-boss adapter
cd spikes/rcon-benchmark
docker compose up -d                     # disposable Paper server (flat world, RCON on localhost)
pnpm bench                               # measure real RCON throughput yourself
cd ../..
pnpm --filter @queuecraft/adapter-pgboss test   # adapter vs a real pg-boss (PGlite, no infra)
pnpm --filter @queuecraft/adapter-pgboss demo   # a live pg-boss queue rendered in the world
pnpm demo:traffic                               # three live queues + a text dashboard, no Minecraft
pnpm demo:traffic --render                      # ... the same traffic, rendered in the world
```

The last one is the whole thing end to end: jobs are really inserted, really consumed, really
failing, and the station on screen is drawn from those counters — at **1.6 commands/second** against
the 40/s budget.

## Roadmap

Bootstrap → RCON spike → renderer v0 ("one station") → pg-boss adapter → demo traffic generator → graveyard → lamp wall → BullMQ adapter (interface freeze) → all-in-one `docker compose up` demo → launch. Then phase 2: clicking a gravestone to retry the job.

## Prior art & inspiration

[mineSQL](https://github.com/swapnil404/mineSQL) (a relational DB using a Minecraft world as storage) and [KubeCraftAdmin](https://github.com/erjadi/kubecraftadmin) (managing Kubernetes from inside Minecraft) proved that "real protocol, absurd backend" is a genre. Queuecraft is our entry.

## Contributing

Adapters are ~100 lines and the contract is tiny — see [CONTRIBUTING.md](CONTRIBUTING.md). Note: the `Adapter` interface is **not frozen** until the BullMQ adapter ships.

## Security

Never expose the RCON port to the internet. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) — © 2026 Mathys

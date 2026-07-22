# @queuecraft/renderer

Turns `QueueSnapshot[]` into a living Minecraft world over RCON.
One queue = one **train station**: a `text_display` panel, a siding where minecarts stand for the
backlog (aggregated, log scale), and a workers area of static villagers.

Depends on `@queuecraft/core` (types only) and `rcon-client`. It never imports a queue technology —
adapters translate to the pivot model, the renderer only knows the pivot model.

## Scope of v0

| Rendered | Not yet |
|---|---|
| Station panel (name + animated counters) | Graveyard (failed jobs) |
| Siding: 0–12 minecarts, log scale | Lamp wall (backlog history) |
| Workers area: 0–16 static villagers | Bossbar, thunderstorm |

## Run the demo

```bash
cd spikes/rcon-benchmark && docker compose up -d   # throwaway server, wait for "RCON running"
pnpm --filter @queuecraft/renderer probe           # command-syntax check (do this first)
pnpm --filter @queuecraft/renderer demo            # ~85 s scripted scenario + budget report
pnpm --filter @queuecraft/renderer demo --keep     # same, but leave the station standing
pnpm --filter @queuecraft/renderer check           # pure-module assertions, no server needed
```

Watch it in game: join `localhost:25565`, then `/tp @s 8 -50 -14`.

Configuration is environment-only (`RCON_HOST`, `RCON_PORT`, `RCON_PASSWORD`). The library itself
has **no default password** — only `demo.ts` and `probe.ts` fall back to the spike server's.

The `inspect` helpers are exported so a demo can read the world back with no player connected
(`inspect.cartAtSlot`, `inspect.statsText`) and assert that what is drawn matches the snapshot it
was drawn from. Every demo — this one and the adapters' — ends on that check.

## How it works

```
QueueSnapshot[] ─► scene.ts ─► Scene (what the world SHOULD look like)
                                  │
                    mirror.ts (what the world DOES look like)
                                  │
                    diff.ts ─► Mutation[]  (typed, never strings)
                                  │
                  commands.ts ─► Minecraft commands
                                  │
                 rcon-sink.ts ─► RCON, maxPending 1, ≤ 40 cmd/s
```

| File | Role |
|---|---|
| `layout.ts` | Every coordinate in the world. Pure. |
| `scale.ts` | Log scale + number formatting (`12.4k`). Pure. |
| `scene.ts` | Snapshot → desired visual state. Pure. |
| `mirror.ts` | What the daemon believes is drawn + `Mutation` type. Pure. |
| `diff.ts` | mirror vs scene → the minimal mutation list. Pure. |
| `commands.ts` | The **only** file that knows Minecraft syntax. |
| `rcon-sink.ts` | Connection, serialisation, token bucket, metrics. |
| `renderer.ts` | The 500 ms loop and the startup sequence. |

Design choices that are not obvious:

- **Pool + park, never summon/kill per tick.** All entities are summoned once at startup with
  `NoGravity` and parked underground (y −63, inside the flat world's dirt). Showing or hiding one
  costs a single `tp`. Killing minecarts would drop minecart *items*, which carry no `qc` tag and
  would therefore survive every wipe.
- **One `text_display` for the whole counter block.** SNBT `\n` is stored as a real newline
  (verified by `probe.ts`), so the entire panel updates in one `data merge entity` per tick.
- **The mirror is updated only after a command succeeds.** An RCON drop mid-tick leaves the mirror
  truthful, and the next tick catches up — no world re-reading needed.
- **Startup is raze + redraw** (ADR D7 §4): `forceload` → `kill @e[tag=qc]` → `fill air` → rebuild.
  ~45 commands, once. ADR-002 explicitly allows an expensive first draw.

## Measured RCON budget

Paper 1.21.11-132, one queue, tick 500 ms, `demo` scenario, 2026-07-22:

| Phase | Duration | Commands | Average | 1 s peak |
|---|---|---|---|---|
| startup (raze + build + pool) | 1.0 s | 45 | — | — |
| ramp (backlog 0 → 1 200) | 14 s | 37 | 2.6/s | 8/s |
| **steady (measurement window)** | **30 s** | **56** | **1.9/s** | **2/s** |
| surge (→ 20 000, siding saturated) | 12 s | 26 | 2.1/s | 7/s |
| drain (→ 0) | 18 s | 48 | 2.7/s | 11/s |

**1.9 cmd/s sustained, 2 cmd/s peak against a 40 cmd/s budget (ADR-001 D7 / ADR-002).** Counters
change every tick, so the floor is 2 cmd/s; everything above that is carts and villagers moving.
The demo exits non-zero if the steady-phase peak ever exceeds the budget.

Paper 26.2, same scenario: identical steady phase (56 commands over 30 s, 1.9/s average, 2/s peak),
0 commands refused, 9 carts on the siding as expected.

## Version compatibility (ADR D4)

`probe.ts` asks the server itself, rather than trusting the wiki. Verified on Paper 1.21.11-132 and
Paper 26.2: text components stored as NBT (`{text:"…"}`, not the pre-1.21.5 JSON string), SNBT `\n`,
`data merge entity`, `interpolation_duration`/`start_interpolation`, `NoGravity` minecarts, static
villagers, `execute if entity`, `fill`, `time set`.

One finding worth keeping: **`gamerule` is refused by Paper 1.21.11-132** — `Incorrect argument for
command` for every rule name, while `time` and `difficulty` work fine on the same server. The
renderer therefore emits no `gamerule` at all; `freezeScene` only sends `time set noon`. The probe
keeps testing it so the day a target accepts it, we find out there and not in production.

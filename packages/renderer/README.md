# @queuecraft/renderer

Turns `QueueSnapshot[]` into a living Minecraft world over RCON.
One queue = one **train station**: a `text_display` panel, a siding where minecarts stand for the
backlog (aggregated, log scale), a workers area of static villagers, and a terraced **graveyard**
where every failed job gets its own headstone.

Depends on `@queuecraft/core` (types only) and `rcon-client`. It never imports a queue technology —
adapters translate to the pivot model, the renderer only knows the pivot model.

## Scope of v0

| Rendered | Not yet |
|---|---|
| Station panel (name + animated counters) | Lamp wall (backlog history) |
| Siding: 0–12 minecarts, log scale | Bossbar, thunderstorm |
| Workers area: 0–16 static villagers | |
| Graveyard: 1 headstone per failed job, global cap 50 | |

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
(`inspect.cartAtSlot`, `inspect.statsText`, `inspect.gravePresent`) and assert that what is drawn
matches the snapshot it was drawn from. Every demo — this one and the adapters' — ends on that
check. `apps/demo-traffic` walks all 50 grave slots of every station, including the ones it
believes empty: that is the only way to prove the global cap rather than trust the mirror.

## How it works

```
QueueSnapshot[]    ─┐
FailedJobDetail[]  ─┴► scene.ts ─► Scene (what the world SHOULD look like)
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
  ~50 commands, once. ADR-002 explicitly allows an expensive first draw.
- **Graves diff by identity, never by position.** The mirror maps `jobId → slot`. A new failure
  does not shift the 49 others, so it costs one command instead of fifty. Departures are *paired*
  with arrivals: the incoming grave takes over the outgoing one's slot and only the text is
  rewritten (`data merge entity`), so a saturated graveyard — the normal state — costs exactly one
  command per failure.
- **Effects are capped at one per station per tick** ([ADR-003](../../docs/ADR-003-son-et-particules.md)).
  Ten failures in one 500 ms tick produce one bell and one soul burst, not ten. And they go through
  `execute … as @a[…] run`: bare `particle`/`playsound` *fail* with no player connected, which is
  Queuecraft's normal case.

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

## Measured graveyard budget

`apps/demo-traffic`, three queues on real pg-boss (PGlite), `FAIL_RATE=25 SEED=4242 DURATION_S=180`,
Paper 1.21.11-132, 2026-07-23 — 1 567 jobs injected, 377 failures, 50 graves standing at the end
(21 emails + 4 reports + 25 scraping):

| failure → grave | median | p95 | worst |
|---|---|---|---|
| **end to end** | 0.58 s | 0.92 s | 2.51 s |
| ↳ *observation* (pg-boss row → adapter cache) | 0.26 s | 0.49 s | 0.51 s |
| ↳ *rendering* (adapter cache → grave in world) | 0.31 s | 0.57 s | 2.33 s |

**Under a second at p95, both halves.** The tail is not the renderer's own work: the worst sample's
tick placed its grave and took 9 ms of actual work — the other 1.9 s was spent waiting on the
**token bucket**. During a surge the three stations churn carts and counters, a 1 s window fills to
the 40 cmd/s budget, and a grave that lands mid-surge queues behind the throttle. A grave drawn in a
tick that was *not* budget-throttled is in the world in under 100 ms. So the tail is the ADR-D7
budget asserting itself over the cosmetic <2 s target — the budget is non-negotiable and wins.
Node's event loop was never blocked more than 107 ms, so this is not PGlite stalling the process.

RCON over the same run: the **startup burst** (raze + build 3 stations + entity pool, ~150 commands)
is throttled to the 40 cmd/s ceiling — ADR-002 explicitly allows an expensive first draw. In steady
state it drops to **~10–18 cmd/s sustained, ~30 cmd/s during surges, 1 s peaks touching the 40
budget cap, 0 commands refused**. In-world verification walks all 50 slots of every station: **50
graves for 50 expected**, and the split proves the cap is global, not per queue.

## Version compatibility (ADR D4)

`probe.ts` asks the server itself, rather than trusting the wiki. Verified on Paper 1.21.11-132 and
Paper 26.2: text components stored as NBT (`{text:"…"}`, not the pre-1.21.5 JSON string), SNBT `\n`,
`data merge entity`, `interpolation_duration`/`start_interpolation`, `NoGravity` minecarts, static
villagers, `execute if entity`, `fill`, `time set`, `setblock`, text components with `extra`
(the two-tone epitaph), and the `execute … as @a[…] run particle|playsound` envelope.

Two findings from the graveyard work worth keeping. **`data get` truncates its reply at ~140
characters**, so reading a whole `text` component proves nothing — probe the nested path
(`text.extra[0].text`) instead. And **an empty RCON reply is a success**: that is what
`execute … as @a[…] run` returns when nobody is connected, and both `RconSink` and the probe treat
it as such.

One finding worth keeping: **`gamerule` is refused by Paper 1.21.11-132** — `Incorrect argument for
command` for every rule name, while `time` and `difficulty` work fine on the same server. The
renderer therefore emits no `gamerule` at all; `freezeScene` only sends `time set noon`. The probe
keeps testing it so the day a target accepts it, we find out there and not in production.

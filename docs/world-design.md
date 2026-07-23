# World design — visual specification (v2)

Single source of truth for the "data → world" mapping **and** the layout contract the
renderer must obey. If code and this file disagree, one of them is a bug — and this file
leads. Exact coordinates live in `packages/renderer/src/layout.ts`; this document is the
contract `layout.ts` has to satisfy.

> **This is v2 and it supersedes the v0 vocabulary.** v0 rendered waiting jobs as real
> `minecart` entities on a siding and workers as `NoAI` `villager`s. Both are **forbidden**
> by CLAUDE.md rule 8 / the `qc-renderer` skill "Règle Zéro": no mobile or AI-driven entity.
> The current `layout.ts` / `commands.ts` still summon those entities (v1) and still anchor
> the dashboard at `x = 0`; they **must be reparented onto this contract** when the renderer
> v2 is written. Until then, code and this file disagree by design.
>
> This is a mapping/vocabulary change, **not** an ADR reversal. [ADR-001 D7](ADR-001-fondations-queuecraft.md)
> decided "display entities, 2 Hz loop, aggregation"; it used "1 minecart = N jobs" only as
> an *example* of aggregation. v2 keeps the aggregation principle (a gauge is a log-scaled
> aggregate) and keeps everything a display entity — it just drops the two entity types D7's
> example implied, exactly as rule 8 requires.

---

## 1. Guiding principle — zero mobile or AI-driven entity

The renderer draws with **inert primitives only**: display entities (`text_display`,
`block_display`, `item_display`), blocks (`setblock` / `fill`), and non-spatial overlays
(`bossbar`, `particle`, `playsound`, `weather`). Nothing that ticks an AI, moves on its own,
or obeys gravity.

Why this is not a stylistic preference but a load-bearing decision:

- **Display entities do not tick game logic.** No pathfinding, no physics, no collision
  resolution, no entity-cramming push-out. Their server cost is near zero — the client
  renders them, the server just stores NBT.
- **A `villager` runs pathfinding and AI every tick**, the single most expensive per-entity
  cost in the game. `NoAI:1b` mutes it but the entity is still a mob the server ticks, and it
  still occupies an AI-capable slot. Sixteen per station × N stations is a self-inflicted MSPT
  tax for zero visual gain over a `block_display`.
- **A `minecart` obeys physics.** It slides, it derails, it participates in entity cramming,
  and its position is **non-deterministic** — which breaks the diff engine, whose entire
  premise is that the mirror in memory equals the world. `NoGravity:1b` parks it but a killed
  minecart drops a `minecart` *item* that carries no `qc` tag and survives every wipe.
- A `block_display` scaled in place is deterministic, tag-clean, wipe-safe, and animatable by
  interpolation at zero server tick cost. It wins on every axis.

Perf claims here are asserted, not measured; per CLAUDE.md rule 9 no optimization ships
without a spark profile first. This principle is about *correctness and determinism* (the diff
engine and the wipe/redraw invariant), which hold regardless of MSPT.

---

## 2. Visual vocabulary v2 (master mapping)

Every row of the pivot model maps to exactly one primitive, one **named bounding box**
(§4), and one **budget** (§8). This table *is* the audit: no element without a box and a cost.

| Data (pivot) | Rendered as | Primitive | Bounding box (§4) | Budget / cycle | Whitelist status |
|---|---|---|---|---|---|
| Queue exists | **Station** name sign | `text_display` (set once) | `TITLE_PANEL` | 0 (built once) | `summon` display — D4 ✅ |
| `counts.waiting` | **WAITING gauge** — vertical bar, log height | `block_display`, scale-`+Y`, interpolated | `INSTRUMENT_GAUGES` | ≤1 `data merge` | D4 ✅ |
| `counts.active` | **ACTIVE gauge** — vertical bar, log height | `block_display`, scale-`+Y`, interpolated | `INSTRUMENT_GAUGES` | ≤1 `data merge` | D4 ✅ |
| `counts.failed` (live count) | **FAILED gauge** — vertical bar, log height | `block_display`, scale-`+Y`, interpolated | `INSTRUMENT_GAUGES` | ≤1 `data merge` | D4 ✅ |
| `throughputPerMin` (instant) | **THROUGHPUT gauge** — vertical bar, log height | `block_display`, scale-`+Y`, interpolated | `INSTRUMENT_GAUGES` | ≤1 `data merge` | D4 ✅ |
| all four counters (numbers) | **Counters panel** — one billboard line | `text_display`, `data merge` per tick | `COUNTERS_PANEL` | 1 `data merge` | D4 ✅ |
| `workers` (consumer count) | **Workers row** — 1 block = 1 worker | `block_display` × ≤16, static | `WORKERS_ROW` | ≤ Δworkers (scale toggle) | D4 ✅ |
| `throughput` **history** (30 min) | **Lamp wall** — log-scaled bar chart | `redstone_lamp` via `setblock` | `LAMP_WALL` | ≤ changed cells | D4 ✅ |
| `job_failed` **detail** (≤50) | **Graveyard** — 1 tomb = 1 job | `setblock` stone + `text_display` epitaph | `GRAVEYARD` | ≤1 write + ≤2 effect | D4 ✅ + [ADR-003](ADR-003-son-et-particules.md) |
| global failure ratio | **Health bossbar** | `bossbar` | — (HUD, not spatial) | ≤1 on tier change | D4 ✅ |
| incident (>20 % / 60 s) | **Thunderstorm** | `weather thunder` | — (world-global) | ≤1 / 2-min anti-flap | ⚠️ **pending ADR** |

**FAILED / THROUGHPUT gauges vs their detail zones.** The instrument gauges are the
*instantaneous* readout on the platform front: glance and read the live value. The
`GRAVEYARD` is the *per-job detail* behind the FAILED gauge (the gauge says "3 failed", the
tombs say *which three and why*); the `LAMP_WALL` is the *history* behind the THROUGHPUT gauge
(the gauge says "540/min now", the wall shows the last 30 minutes). Instrument = now, spatial
zone = detail/history.

**⚠️ Weather is designed, not approved.** [ADR-003](ADR-003-son-et-particules.md) explicitly
states `weather` is **not** in the D4 whitelist and has **not** been verified on the 26.2
target; the thunderstorm "reste à instruire par son propre ADR". It stays in this vocabulary as
the intended incident signal, but the renderer must not emit `weather` until that ADR lands —
and that ADR has to settle the fact that a thunderstorm is world-global (it changes the
*user's* overworld weather, see §5), so it needs an opt-out.

---

## 3. Station sketch

One station, in its **local frame** (offsets from the station origin; the viewer stands on the
`−Z` side and looks toward `+Z`). Ground is the superflat top at `y = −60`; build level is
`y = −59`.

**Top-down** (`X` →, `Z` ↓, `+X` neighbour station is 64 blocks away):

```
 dz
 +12   ███████████████████████████████            ······················   LAMP_WALL  (30×7 redstone_lamp, log)
        throughput history, log rows                CONTROL_ROOM (reserved)  ← future, renderer draws NOTHING here yet
 +6.5  ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪            (empty, dx 34..58)        WORKERS_ROW  (≤16 block_display, 1/worker)
 0..5  ┌───────────────┐
       │ ▐  ▐  ▐  ▐  ← W A F T gauges rise +Y                                PLATFORM  (smooth_stone, 16×6)
   −3  ░░░░░░░░░░░░░░░░░  row0  (nearest, lowest)                            GRAVEYARD  (terraced, 10 cols × 5 rows,
   −5  ░░░░░░░░░░░░░░░░░  row1                                                rises AWAY so no row occludes the next)
   −7  ░░░░░░░░░░░░░░░░░  row2
   −9  ░░░░░░░░░░░░░░░░░  row3
  −11  ░░░░░░░░░░░░░░░░░  row4  (farthest, highest)
       dx 0            15  19        29      34            58
                        ▲ viewer looks +Z from the −Z side
```

**Front elevation** (`X` →, `Y` ↑, seen from the `−Z` side):

```
  y
 −27 ┆                 ▓ ← WAITING gauge grows +Y, capped at 32 blocks (§6)
     ┆                 ▓ ▓
     ┆   QUEUE-NAME     ▓ ▓ ▓         ← TITLE_PANEL text_display (set once)
 −56 ┆   w 12.4k · a 88 · f 3 · t 540/m   ← COUNTERS_PANEL text_display (per-tick data merge)
     ┆                 ▓ ▓ ▓ ▓
 −59 │▪▪▪▪▪▪▪ smooth_stone platform ▪▪▪▪▪▪▪│   gauges:  W   A   F   T
 −60 └──────────────────────────────────────── GROUND_Y  (superflat top)

        ┌───────────────────────────────────┐
        │  ⬤  0 / 5 % failed — HEALTHY       │  ← health bossbar: HUD overlay, no world anchor
        └───────────────────────────────────┘
```

---

## 4. Layout contract (absolute coordinate system)

The renderer places **nothing outside its bounding box**. This section defines those boxes
absolutely so a reviewer can check emplacement without running the server.

### 4.1 Origins

```
DASHBOARD_ORIGIN = ( 100000, -60, 0 )        # see §5 for why 100000, and why the overworld
STATION_SPACING  = 64                         # blocks between adjacent station origins, along +X
station(s) origin = ( 100000 + 64*s, -60, 0 ) # s = 0, 1, 2, …
GROUND_Y = -60   BUILD_Y = -59   DEPOT_Y = -63   (superflat reference; GROUND_Y is a parameter
                                                  for non-flat render worlds, see §5)
```

Relocating the whole dashboard is changing **one constant** (`DASHBOARD_ORIGIN`). The demo's
camera / GIF-capture position and any `spreadplayers`/`tp` used to film must derive from it,
never hard-code a second copy.

### 4.2 Lanes — "no gap between stations"

The dashboard is a **contiguous strip of 64-wide lanes**, one per station, tiled along `+X`
with no undocumented gap: lane `s` owns `dx ∈ [−4, +59]` (63 blocks + a 1-block seam before
lane `s+1` starts at `+60`). Every reserved box below lives strictly inside its lane, so no
two stations can ever touch. The sweep invariant (§4.4) enforces this at runtime.

### 4.3 Named reserved boxes (local `Δ` from the station origin)

`GROUND_Y = −60`, `BUILD_Y = −59`. All ranges inclusive.

| Box | Δx | Δy | Δz | Primitive | Notes |
|---|---|---|---|---|---|
| `PLATFORM` | 0 … 15 | −60 | 0 … 5 | `fill smooth_stone` | the stone slab (16×6) |
| `TITLE_PANEL` | 8.5 | −56 | 2.5 | `text_display` (once) | queue name, never rewritten |
| `COUNTERS_PANEL` | 8.5 | −56.6 | 2.5 | `text_display` (per tick) | the only per-tick text write |
| `INSTRUMENT_GAUGES` | 1 … 14 | −59 … **−27** | 0 … 1 | `block_display` ×4 | W/A/F/T columns; **−27 = ceiling**, see §6 |
| `WORKERS_ROW` | 0.5 … 15.5 | −59 | 6.5 | `block_display` ×≤16 | 1 block per worker, one file |
| `GRAVEYARD` | 1 … 19 | −60 … −54 | −11 … −3 | terraces `fill` + stones `setblock` + epitaphs `text_display` | terraced: `y = −60 + row`, `z = −3 − 2·row` |
| `LAMP_WALL` | 0 … 29 | −59 … −53 | 12 | `setblock redstone_lamp` | vertical plane, 30 cols × 7 rows |
| `CONTROL_ROOM` | 34 … 58 | −60 … −54 | 0 … 12 | — | **reserved, empty**; future interactivity (phase 2). Renderer draws nothing here until its own geometry pass. |

Non-spatial elements have **no box on purpose**: the `bossbar` is a HUD overlay, the incident
`weather` is world-global. Both are called out as exceptions in the cross-check (§10).

### 4.4 Sweep invariant (how "nothing outside its box" is enforced)

- `STATION_SWEEP_RADIUS = 40`, measured from a station anchor at local `(Δx 10, Δy −59, Δz 0)`.
- Every rendered element sits within **~32 blocks** of that anchor (the worst case is a gauge
  grown to its 32-block ceiling). `32 < 40 < 64`, so a station's zone-`kill` /
  zone-`forceload` covers **all** of its own primitives and **never** reaches the neighbour
  (nearest neighbour primitive is 50 blocks away). `check-pure.ts` verifies both bounds — it is
  what makes a station physically unable to erase its neighbour.
- `CONTROL_ROOM`'s far corner is >40 from the anchor. That is fine while it is empty; when it
  is built it will need its own anchor / geometry pass (flagged, not solved here).

---

## 5. Dimension decision — overworld at far coordinates, never a custom dimension

**Decision.** The dashboard lives in the **overworld**, at `x = 100000`. We do **not** create a
custom dimension.

**Why not a custom dimension.** A custom dimension requires a **datapack** — a *file installed
on the server*. RCON cannot create a dimension at runtime; only a datapack (or a plugin) can.
Installing a file is exactly the friction ADR-001 D3/D9 exists to forbid: Queuecraft's promise
is *zero server-side installation* — RCON plus three lines in `server.properties`, nothing else.
A custom dimension would break that promise on line one. So it is off the table by construction,
not by taste.

**Why the overworld, far away.** The overworld is guaranteed to exist on every server, and
`forceload add` keeps our chunks loaded with no player present (the renderer already relies on
this). Far coordinates give us the *isolation* a separate dimension would have given — no player
base, no spawn structures, no terrain a user cares about — with no file at all.

**Why 100000 specifically.**

- **Far enough:** virtually all player activity and spawn structures sit within a few thousand
  blocks of `(0,0)`. 100k blocks out, a collision with someone's base is effectively impossible.
- **Precise enough:** block and display-entity coordinates stay bit-exact below `2^24 ≈ 16.7M`.
  At 100k we are 167× under that, so sub-block positions (`x.5`) and interpolation stay
  pixel-exact. Precision loss and the "Far Lands" pathologies only appear near the world border.
- **Legal:** the overworld border is `±29,999,984`; 100k is nowhere near it.

**Cost we accept (and defer).** We share the overworld's globals. **Weather:** the incident
thunderstorm is world-wide — it would change the *user's* weather, not just our region. That is
half the charm ("your world storms when the error rate spikes") and half the reason `weather`
needs its own ADR with an opt-out (§2). **Mobs:** our forceloaded far region can spawn hostile
mobs; we cannot fix that with `gamerule` (Paper 1.21.11-132 refuses it, measured — see
`commands.ts`). Mitigation (a light layer, or building the platform bright) is a renderer
concern, noted here so it is not forgotten.

**Non-flat worlds.** `GROUND_Y = −60` is the superflat top used by the demo world, where any
coordinate is buildable. On a user's normal overworld, `x = 100000` has real terrain and a
different ground height. `GROUND_Y` is therefore a **parameter**, and the recommended target is
a superflat or void render world (or a cleared region). The far-X choice is about *isolation
from players*, not about terrain.

---

## 6. Generative extension — vertical growth within the box (B3)

Each gauge (and, by extension, the station's silhouette) **grows vertically with the backlog**,
so a station under load literally towers over a calm one — a legible, at-a-glance signal — while
**never leaving its bounding box**.

- A gauge is a unit `block_display` anchored at `BUILD_Y` on the platform front, scaled in `+Y`.
  Height is `clamp(round(k · log10(1 + count)), 0, GAUGE_H_MAX)` with `k = 6` blocks per decade.
- **`GAUGE_H_MAX = 32` blocks.** Five decades (`count ≈ 100k`) reach ~30 blocks; past that the
  gauge saturates instead of growing without bound. This ceiling is why `INSTRUMENT_GAUGES` in
  §4.3 reserves `Δy` up to `−27` (`−59 + 32`). The growth is *provisioned in the contract*: the
  box already contains the tallest a gauge can ever be, so "grows generatively" and "never
  leaves its box" are both true simultaneously.
- Growth is animated by `interpolation_duration`, not by re-summon (§7): the gauge *slides*
  taller/shorter. Log scale keeps the motion meaningful — a jump from 100 to 1,000 is one decade
  of height whether the queue holds 100 or 100k.

Under the overworld build ceiling (`y ≤ 319`), 32 blocks above `−59` is `−27`, with ~350 blocks
of headroom to spare — the cap is a *design* limit (stay in frame), not an engine limit.

---

## 7. Rendering rules (per-primitive, contract-level)

- **Culling box: `width = 0`, `height = 0` on every display entity.** Zero means the client
  never culls the entity on its bounding box — always rendered, stable under Sodium. **Never
  large values** (e.g. `width = 64`): under Sodium a big culling box inflates and causes
  artifacts / FPS drops. Small or zero, never giant — including a gauge grown to 32 blocks,
  which still carries `width = 0 / height = 0`.
- **Animate by `data merge`, never by re-summon.** Kill+summon is a client-side flash and wasted
  RCON. Gauges and counters mutate in place; the client interpolates.
- **`interpolation_duration` for scale, `teleport_duration` for repositioning — both ≤ 59
  ticks.** A hard reposition uses `teleport_duration` so the display *glides* instead of
  jumping. Keep it `≤ 59` ticks (< 3 s): the server posts target + duration once, the client
  interpolates for free.
- **Everything drawn carries the `qc` tag** (`qc`, `qc-s<station>`, and a unique per-entity
  tag). A full reset is `kill @e[tag=qc]` + `fill air` + `fill grass_block`; a station reset is
  the same scoped by `distance ≤ 40`. Blocks carry no tag but live at known `layout.ts`
  coordinates, so the wipe volumes reclaim them.
- **All formatting happens in the daemon** (`12.4k`, `540/m`, log heights). Zero business logic
  in the world; the world is a display (ARCHITECTURE.md invariant 1).

---

## 8. Budget (quantified, per station)

Cycle = one 500 ms render tick (2 Hz). The global sustained ceiling is **≤ 40 cmd/s**
([ADR-001 D7](ADR-001-fondations-queuecraft.md), confirmed by
[ADR-002](ADR-002-debit-rcon-reel.md)), held by a daemon-side throttle with `maxPending = 1`.

**Display entities per station (hard maximum):**

| Kind | Count | Where |
|---|---|---|
| `text_display` | 2 + epitaphs | title, counters, + ≤ grave epitaphs |
| `block_display` | ≤ 20 | 4 gauges + ≤16 workers |
| epitaph `text_display` | ≤ 50 **global** | graveyard cap is 50 *across all stations* (ADR D7) |

**Non-entity blocks per station (max):** `PLATFORM` fill, `GRAVEYARD` terraces fill, ≤ 50 grave
stones (`setblock`), ≤ 210 lamp cells (`setblock`, 30×7).

**Commands per cycle per station:**

| Source | Steady | Worst tick |
|---|---|---|
| Counters | 1 | 1 |
| Gauges (W/A/F/T) | 0–2 (only changed) | 4 |
| Workers row | 0 | Δworkers |
| Graveyard | 0 | 1 write + 2 effect (ADR-003 caps 1 effect/station/tick) |
| Lamp wall | 0 | ≤7 (a 1-min bucket rolls over) |
| **Per-station total** | **~1–2** | **~14** |

**Global (not per station):** health `bossbar` ≤1 on tier change; incident `weather` ≤1 per
state change with a 2-min anti-flap.

**Bootstrap** ("wipe + redraw", ADR D7 §4) is a bounded one-time burst — forceload + wipe +
decor + gauge/worker pool per station, throttled to the 40 cmd/s ceiling. ADR-002 explicitly
permits an expensive first render.

Reality check: the README run measured **1.6 cmd/s** for three quiet stations; ADR-003 measured
**~10–18 cmd/s sustained** (peaks touching 40, 0 rejected) at `FAIL_RATE=25` across three
stations. The per-station steady figure above is consistent with both.

---

## 9. To probe before implementing v2

Same discipline as ADR-003: verify on the server, on both D4 targets, before writing render code.

- `block_display` **scale interpolation** (`transformation` + `interpolation_duration`) on 1.21.11 **and** 26.2.
- `redstone_lamp` **lit-state persistence** via `setblock redstone_lamp[lit=true]` with no power source and no block updates — does it stay lit, or do we need a lit/unlit *block pair* (e.g. `sea_lantern` vs a dark block)? Choose whichever survives on both targets.
- `weather thunder` on **26.2** (untested per ADR-003) — gate behind its own ADR.
- `teleport_duration` behaviour on a `block_display` on both targets.
- Mob spawning inside the forceloaded far region with `gamerule` unavailable.

---

## 10. Cross-check — every element has a box and a budget

| Element | Bounding box | Budget | OK |
|---|---|---|---|
| Station title | `TITLE_PANEL` | 0/cycle (once) | ✅ |
| WAITING gauge | `INSTRUMENT_GAUGES` | ≤1/cycle | ✅ |
| ACTIVE gauge | `INSTRUMENT_GAUGES` | ≤1/cycle | ✅ |
| FAILED gauge | `INSTRUMENT_GAUGES` | ≤1/cycle | ✅ |
| THROUGHPUT gauge | `INSTRUMENT_GAUGES` | ≤1/cycle | ✅ |
| Counters | `COUNTERS_PANEL` | 1/cycle | ✅ |
| Workers row | `WORKERS_ROW` | ≤Δworkers/cycle | ✅ |
| Lamp wall | `LAMP_WALL` | ≤7/cycle | ✅ |
| Graveyard | `GRAVEYARD` | ≤3/cycle | ✅ |
| Health | — (HUD overlay, by design) | ≤1 on tier change | ✅ |
| Incident | — (world-global, by design) | ≤1 / 2-min | ⚠️ pending ADR |
| (reserved) | `CONTROL_ROOM` | 0 (empty) | ✅ |

Two elements have no box **on purpose** (bossbar HUD, world weather); every spatial element has
a named box in §4 and a cost in §8. One element (weather) is gated behind its own ADR.

---

## Golden rules (ADR D7 recap)

1. Everything drawn carries the `qc` tag — full reset is `kill @e[tag=qc]` + fill air/grass.
2. Sustained budget ≤ 40 cmd/s, `maxPending = 1` (ADR-002: pipelining is broken, not slow).
3. Never render jobs 1:1 except failures (≤ 50 gravestones, global cap).
4. The world is a display: zero business state stored in-game.
5. No mobile or AI-driven entity, ever (rule 8). Animate by `data merge`, never by re-summon.

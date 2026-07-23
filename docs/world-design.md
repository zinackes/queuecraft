# World design — visual specification

Single source of truth for the "data → world" mapping. If code and this file disagree,
one of them is a bug. (Exact coordinates live in `packages/renderer/src/layout.ts`.)

## Visual vocabulary

| Data | Rendered as | Detail |
|---|---|---|
| A queue | A **train station** | Stone platform, `text_display` title sign (name + animated counters) |
| Waiting jobs | **Minecarts** on the siding | Aggregated: 1 cart = N jobs, adaptive log scale |
| Active jobs | **Workers area** | 1 static villager = 1 worker, particles while processing |
| Failed jobs | **Graveyard** | 1 gravestone = 1 job (global cap 50), `text_display`: short jobId + error ≤ 120 chars. A soul particle burst and a bell on each new grave ([ADR-003](ADR-003-son-et-particules.md)) |
| Backlog history | **Lamp wall** | redstone_lamp, 30-min window, each row = ×10 (log) |
| Global health | **Bossbar** | green < 5 % failed, yellow < 15 %, red above |
| Incident (> 20 % failed over 60 s) | **Thunderstorm** | `weather thunder`, 2-min anti-flap |

## Spatial layout (v0)

Force-loaded area at origin (0, -60, 0). One station per queue along the X axis, 64 blocks
apart. Per station: platform 16×6, siding toward Z+ (34 blocks, 12 cart slots every 3), workers
area at X+ of the platform (4×4 villager grid), graveyard at Z− (50 slots: 10 columns × 5 rows),
lamp wall behind the platform.

The graveyard is **terraced**: each row sits one block higher than the one in front of it. Flat,
the front row's `text_display` panels would hide the four rows behind — you would read 10 failures
out of 50. Rows fill front to back, so the closest graves are the ones you see first.

The 50-grave cap is **global**, the 5×10 grid is **per station**: one queue drowning in failures
can take every slot while its neighbours show none. That is the honest picture, and it is why a
single station's grid must be able to hold the whole cap.

Entities not currently shown are *parked*, not killed: they wait at y −63, inside the flat world's
dirt, one slot each. Killing a minecart drops a minecart item, and that item carries no `qc` tag —
it would survive every wipe. Parking also makes a change cost one `tp` instead of a kill + summon.

Graves are the exception: a grave slot is **recycled**, not parked. When a failure drops out of the
50 most recent, the arriving failure takes over its slot and only the text is rewritten — one
command instead of a kill plus a summon. Slots are matched by `jobId`, never by position, so a new
failure never shifts the 49 others.

## Golden rules (ADR D7 recap)

1. Everything drawn carries the `qc` tag — full reset is `kill @e[tag=qc]` + fill air.
2. Sustained budget ≤ 40 cmd/s (to be confirmed/amended by the RCON spike).
3. Never render jobs 1:1 except failures.
4. The world is a display: zero business state stored in-game.

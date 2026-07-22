# World design — visual specification

Single source of truth for the "data → world" mapping. If code and this file disagree,
one of them is a bug. (Exact coordinates live in `packages/renderer/src/layout.ts`.)

## Visual vocabulary

| Data | Rendered as | Detail |
|---|---|---|
| A queue | A **train station** | Stone platform, `text_display` title sign (name + animated counters) |
| Waiting jobs | **Minecarts** on the siding | Aggregated: 1 cart = N jobs, adaptive log scale |
| Active jobs | **Workers area** | 1 static villager = 1 worker, particles while processing |
| Failed jobs | **Graveyard** | 1 gravestone = 1 job (global cap 50), `text_display`: short jobId + error ≤ 120 chars |
| Backlog history | **Lamp wall** | redstone_lamp, 30-min window, each row = ×10 (log) |
| Global health | **Bossbar** | green < 5 % failed, yellow < 15 %, red above |
| Incident (> 20 % failed over 60 s) | **Thunderstorm** | `weather thunder`, 2-min anti-flap |

## Spatial layout (v0)

Force-loaded area at origin (0, -60, 0). One station per queue along the X axis, 64 blocks
apart. Per station: platform 16×6, siding toward Z+ (34 blocks, 12 cart slots every 3), workers
area at X+ of the platform (4×4 villager grid), graveyard at Z− (5×10 grid), lamp wall behind the
platform.

Entities not currently shown are *parked*, not killed: they wait at y −63, inside the flat world's
dirt, one slot each. Killing a minecart drops a minecart item, and that item carries no `qc` tag —
it would survive every wipe. Parking also makes a change cost one `tp` instead of a kill + summon.

## Golden rules (ADR D7 recap)

1. Everything drawn carries the `qc` tag — full reset is `kill @e[tag=qc]` + fill air.
2. Sustained budget ≤ 40 cmd/s (to be confirmed/amended by the RCON spike).
3. Never render jobs 1:1 except failures.
4. The world is a display: zero business state stored in-game.

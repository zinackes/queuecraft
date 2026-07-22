/**
 * CONTRÔLES DES MODULES PURS — sans serveur, sans dépendance de test.
 * ===================================================================
 * Le repo n'a pas encore de runner de tests ; ces assertions valent
 * mieux que rien et couvrent ce qui casserait silencieusement :
 * l'échelle log, l'idempotence du diff (la garantie du budget RCON),
 * les limites dures de `fill`, et la liste blanche de commandes (D4).
 *
 * Lancement :  pnpm check
 */
import type { QueueSnapshot } from '@queuecraft/core'
import {
  bootstrapCommands,
  buildStationCommands,
  mutationToCommands,
  stationPrepareCommands,
} from './commands.js'
import { diff } from './diff.js'
import {
  FILL_BLOCK_LIMIT,
  MAX_CARTS,
  boxVolume,
  cartSlot,
  depotSlot,
  sidingRail,
  wipeAirVolume,
  wipeGroundVolume,
  DEPOT_Y,
} from './layout.js'
import { Mirror } from './mirror.js'
import { cartsForBacklog, formatCount, healthOf, jobsPerCart } from './scale.js'
import { project } from './scene.js'

let failures = 0

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  OK    │ ${label}`)
  } else {
    failures++
    console.log(`  ÉCHEC │ ${label}${detail ? `\n        │   ${detail}` : ''}`)
  }
}

function snapshot(over: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return {
    name: 'scraping',
    counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
    workers: 4,
    throughputPerMin: 120,
    capturedAt: new Date(0),
    ...over,
  }
}

console.log('\nContrôles des modules purs\n──────────────────────────')

// ---- Échelle logarithmique (règle non négociable n°2)
check('0 job = 0 cart', cartsForBacklog(0) === 0)
check('1 job = 1 cart', cartsForBacklog(1) === 1)
check('l\'échelle est monotone et bornée', (() => {
  let previous = -1
  for (let waiting = 0; waiting <= 100_000; waiting += 7) {
    const carts = cartsForBacklog(waiting)
    if (carts < previous || carts > MAX_CARTS) return false
    previous = carts
  }
  return true
})())
check(
  'une décade = 3 carts (10 → 3, 1 000 → 9, 10 000 → saturé)',
  cartsForBacklog(10) === 3 && cartsForBacklog(1_000) === 9 && cartsForBacklog(10_000) === MAX_CARTS,
  `${cartsForBacklog(10)} / ${cartsForBacklog(1_000)} / ${cartsForBacklog(10_000)}`,
)
check('jobsPerCart couvre tout le backlog', jobsPerCart(1_000, 9) * 9 >= 1_000)
check('formatCount compacte', formatCount(942) === '942' && formatCount(12_431) === '12.4k' && formatCount(3_200_000) === '3.2M')
check('santé : 0 échec = sain, 20 % = critique', healthOf(100, 0) === 'healthy' && healthOf(80, 20) === 'critical')

// ---- Diff : le cœur du budget RCON
const mirror = new Mirror()
const first = diff(mirror.get(0), project(snapshot({ counts: { waiting: 100, active: 3, completed: 10, failed: 0, delayed: 0 } }), 0))
check('premier tick : construction + compteurs + 6 carts + 4 workers', first.length === 1 + 1 + 6 + 4, `${first.length} mutations`)
for (const mutation of first) mirror.apply(mutation)

const same = diff(mirror.get(0), project(snapshot({ counts: { waiting: 100, active: 3, completed: 10, failed: 0, delayed: 0 } }), 0))
check('état identique = ZÉRO commande (ADR D7 §2)', same.length === 0, `${same.length} mutations parasites`)

const grown = diff(mirror.get(0), project(snapshot({ counts: { waiting: 1_000, active: 3, completed: 10, failed: 0, delayed: 0 } }), 0))
check('100 → 1 000 jobs = 1 compteur + 3 carts', grown.length === 4, `${grown.length} mutations`)
for (const mutation of grown) mirror.apply(mutation)

const drained = diff(mirror.get(0), project(snapshot({ counts: { waiting: 0, active: 0, completed: 1_010, failed: 0, delayed: 0 } }), 0))
check('drain complet = tous les carts rentrent au dépôt', drained.filter((m) => m.kind === 'cart').length === 9)
for (const mutation of drained) mirror.apply(mutation)
check('après drain, le miroir ne montre plus de cart', mirror.get(0).cartCount === 0)

const burst = diff(mirror.get(0), project(snapshot({ counts: { waiting: 50_000, active: 8, completed: 1_010, failed: 300, delayed: 0 } }), 0))
check(
  'un burst reste borné par MAX_CARTS',
  burst.filter((m) => m.kind === 'cart').length === MAX_CARTS,
  `${burst.filter((m) => m.kind === 'cart').length} carts`,
)

// ---- Géométrie
check(`wipe air tient dans un fill (< ${FILL_BLOCK_LIMIT})`, boxVolume(wipeAirVolume(0)) < FILL_BLOCK_LIMIT, `${boxVolume(wipeAirVolume(0))} blocs`)
check('wipe sol tient dans un fill', boxVolume(wipeGroundVolume(0)) < FILL_BLOCK_LIMIT, `${boxVolume(wipeGroundVolume(0))} blocs`)
check('la voie couvre tous les emplacements de cart', sidingRail(0).z2 >= cartSlot(0, MAX_CARTS - 1).z - 1)
check('le dépôt reste au-dessus du fond du monde (-64)', DEPOT_Y > -64 && depotSlot(0, 'cart', 0).y > -64)
check(
  'deux gares ne se marchent pas dessus',
  cartSlot(1, 0).x - cartSlot(0, 0).x === 64 && wipeAirVolume(0).x2 < wipeAirVolume(1).x1 + 64,
)

// ---- Liste blanche ADR D4
const WHITELIST = /^(setblock|fill|summon|data|kill|tp|bossbar|scoreboard|tellraw|particle|forceload|time|gamerule|execute)\b/
const everyCommand = [
  ...bootstrapCommands([0, 1], { freezeScene: true }),
  ...stationPrepareCommands(2),
  ...buildStationCommands(0, 'scraping'),
  ...first.flatMap(mutationToCommands),
  ...grown.flatMap(mutationToCommands),
]
const offenders = everyCommand.filter((command) => !WHITELIST.test(command))
check('toutes les commandes sont dans la liste blanche', offenders.length === 0, offenders.join(' | '))
check('aucune commande ne contient de retour à la ligne réel', everyCommand.every((c) => !c.includes('\n')))

const statsCommand = grown.flatMap(mutationToCommands).find((c) => c.startsWith('data merge'))
check('le panneau tient en UNE commande multi-ligne', statsCommand !== undefined && statsCommand.includes('\\n'))

// ---- Coût d'un tick en régime établi
const busy = new Mirror()
for (const mutation of diff(busy.get(0), project(snapshot({ counts: { waiting: 800, active: 5, completed: 40_000, failed: 12, delayed: 0 } }), 0))) {
  busy.apply(mutation)
}
const steady = diff(
  busy.get(0),
  project(snapshot({ counts: { waiting: 810, active: 6, completed: 40_050, failed: 12, delayed: 0 } }), 0),
)
const steadyCommands = steady.flatMap(mutationToCommands).length
check(
  `un tick de croisière coûte ≤ 2 commandes (soit ≤ 4 cmd/s à 2 Hz)`,
  steadyCommands <= 2,
  `${steadyCommands} commandes`,
)

console.log(
  failures === 0
    ? '\nTous les contrôles passent.\n'
    : `\n${failures} contrôle(s) en échec.\n`,
)
process.exitCode = failures === 0 ? 0 : 1

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
import type { FailedJobDetail, QueueSnapshot } from '@queuecraft/core'
import {
  bootstrapCommands,
  buildStationCommands,
  mutationToCommands,
  stationPrepareCommands,
} from './commands.js'
import { diff } from './diff.js'
import {
  FILL_BLOCK_LIMIT,
  GRAVE_COLUMNS,
  GRAVE_ROWS,
  GRAVE_SLOTS,
  MAX_CARTS,
  MAX_GRAVES,
  STATION_SWEEP_RADIUS,
  boxVolume,
  cartSlot,
  depotSlot,
  distanceFromCenter,
  graveLabel,
  graveSlot,
  graveyardBounds,
  graveyardTerraces,
  platformFloor,
  sidingRail,
  stationFootprint,
  wipeAirVolume,
  wipeGroundVolume,
  workerSlot,
  workersFloor,
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

/** `n` échecs de la queue `scraping`, du plus récent au plus ancien. */
function failedJobs(count: number, from = 0, queue = 'scraping'): FailedJobDetail[] {
  return Array.from({ length: count }, (_, index) => ({
    queue,
    jobId: `job-${from + index}-0123456789abcdef`,
    error: `HTTP 429 Too Many Requests — retry-after: ${from + index}s`,
    failedAt: new Date(1_000_000 - (from + index) * 1_000),
  }))
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

// ---- Le cimetière : identité, plafond, coût (ADR D7)
const yard = new Mirror()
const counts = { waiting: 0, active: 0, completed: 100, failed: 3, delayed: 0 }

const arrivals = diff(yard.get(0), project(snapshot({ counts }), 0, failedJobs(3)))
check(
  'trois échecs = construction + compteurs + trois tombes',
  arrivals.filter((m) => m.kind === 'grave').length === 3,
  `${arrivals.filter((m) => m.kind === 'grave').length} tombes`,
)
check(
  'les tombes se posent sur les emplacements 0, 1, 2',
  arrivals.filter((m) => m.kind === 'grave').map((m) => (m.kind === 'grave' ? m.slot : -1)).join() === '0,1,2',
)
check(
  'la première tombe d\'un tick porte l\'effet, les suivantes non',
  arrivals.filter((m) => m.kind === 'grave' && m.effect).length === 1,
)
for (const mutation of arrivals) yard.apply(mutation)

const stable = diff(yard.get(0), project(snapshot({ counts }), 0, failedJobs(3)))
check(
  'mêmes échecs = ZÉRO commande (diffing par identité)',
  stable.length === 0,
  `${stable.length} mutations parasites`,
)

// Un échec de plus, les trois autres inchangés : c'est le cas de tous les
// ticks. Il ne doit coûter qu'une tombe, pas un redessin du cimetière.
const oneMore = diff(yard.get(0), project(snapshot({ counts }), 0, [...failedJobs(1, 99), ...failedJobs(3)]))
check(
  'un échec de plus = UNE tombe, les autres ne bougent pas',
  oneMore.filter((m) => m.kind === 'grave').length === 1 && oneMore.filter((m) => m.kind === 'grave-clear').length === 0,
  `${oneMore.length} mutations`,
)
for (const mutation of oneMore) yard.apply(mutation)

// Cimetière saturé : on remplit les 50 emplacements, puis on fait entrer
// un nouvel échec. L'emplacement de celui qui sort doit être REPRIS.
const full = new Mirror()
for (const mutation of diff(full.get(0), project(snapshot({ counts }), 0, failedJobs(GRAVE_SLOTS)))) {
  full.apply(mutation)
}
check(
  `un cimetière plein contient ${GRAVE_SLOTS} tombes`,
  full.graveTotal() === GRAVE_SLOTS,
  `${full.graveTotal()}`,
)
const rotated = diff(
  full.get(0),
  project(snapshot({ counts }), 0, [...failedJobs(1, 500), ...failedJobs(GRAVE_SLOTS - 1)]),
)
const reused = rotated.filter((m) => m.kind === 'grave')
check(
  'sur un cimetière plein, un échec RECYCLE un emplacement (pas de kill + summon)',
  rotated.length === 1 && reused.length === 1 && reused[0]?.kind === 'grave' && !reused[0].fresh,
  rotated.map((m) => m.kind).join(' + '),
)
check(
  'et il ne coûte qu\'une réécriture + l\'effet',
  rotated.flatMap(mutationToCommands).length === 3,
  `${rotated.flatMap(mutationToCommands).length} commandes`,
)
for (const mutation of rotated) full.apply(mutation)
check(`après rotation, toujours ${GRAVE_SLOTS} tombes`, full.graveTotal() === GRAVE_SLOTS)

// Un déluge : la source déborde, la grille non.
const flooded = new Mirror()
const deluge = diff(flooded.get(0), project(snapshot({ counts }), 0, failedJobs(500)))
check(
  `${GRAVE_SLOTS} emplacements, pas un de plus, même avec 500 échecs`,
  deluge.filter((m) => m.kind === 'grave').length === GRAVE_SLOTS,
  `${deluge.filter((m) => m.kind === 'grave').length} tombes`,
)

// Les échecs des autres queues ne finissent pas dans ce cimetière.
const mixed = project(snapshot({ counts }), 0, [...failedJobs(2, 0, 'emails'), ...failedJobs(3)])
check('une gare ne rend que les échecs de SA queue', mixed.graves.length === 3, `${mixed.graves.length}`)

// Une reconstruction (nouvelle queue sur la même gare) repart à zéro.
const rebuilt = diff(full.get(0), project(snapshot({ name: 'emails', counts }), 0, failedJobs(2, 0, 'emails')))
check(
  'reconstruire une gare vide son cimetière (le monde a été rasé)',
  rebuilt.filter((m) => m.kind === 'grave').length === 2 &&
    rebuilt.filter((m) => m.kind === 'grave-clear').length === 0,
)

// ---- Le texte gravé
const epitaph = project(
  snapshot({ counts }),
  0,
  [{ queue: 'scraping', jobId: 'abcdefgh-1234-5678', error: `x${'é—'.repeat(200)}`, failedAt: new Date(0) }],
)['graves'][0]
check('le jobId est coupé à 8 caractères', epitaph?.label.length === 8, epitaph?.label)
check('l\'épitaphe est coupée à 120 caractères', (epitaph?.error.length ?? 0) === 120, `${epitaph?.error.length}`)
check(
  'l\'épitaphe reste en Latin-1 (pas de carré vide en jeu)',
  epitaph !== undefined && ![...epitaph.error].some((c) => c.codePointAt(0)! > 0xff),
)

// ---- Géométrie
check(`wipe air tient dans un fill (< ${FILL_BLOCK_LIMIT})`, boxVolume(wipeAirVolume(0)) < FILL_BLOCK_LIMIT, `${boxVolume(wipeAirVolume(0))} blocs`)
check('wipe sol tient dans un fill', boxVolume(wipeGroundVolume(0)) < FILL_BLOCK_LIMIT, `${boxVolume(wipeGroundVolume(0))} blocs`)
check('la voie couvre tous les emplacements de cart', sidingRail(0).z2 >= cartSlot(0, MAX_CARTS - 1).z - 1)
check('le dépôt reste au-dessus du fond du monde (-64)', DEPOT_Y > -64 && depotSlot(0, 'cart', 0).y > -64)
check(
  'deux gares ne se marchent pas dessus',
  cartSlot(1, 0).x - cartSlot(0, 0).x === 64 && wipeAirVolume(0).x2 < wipeAirVolume(1).x1,
)

// ---- Géométrie du cimetière
check(`la grille fait ${GRAVE_COLUMNS} × ${GRAVE_ROWS} = ${GRAVE_SLOTS} emplacements`, GRAVE_SLOTS === 50)
check(
  'une seule gare peut absorber le plafond global',
  MAX_GRAVES <= GRAVE_SLOTS,
  `${MAX_GRAVES} > ${GRAVE_SLOTS}`,
)
check(
  'les emplacements sont tous distincts',
  new Set(Array.from({ length: GRAVE_SLOTS }, (_, i) => JSON.stringify(graveSlot(0, i)))).size === GRAVE_SLOTS,
)
check(
  'chaque rangée monte d\'un cran (les tombes du fond restent visibles)',
  graveSlot(0, GRAVE_COLUMNS).y === graveSlot(0, 0).y + 1 &&
    graveSlot(0, GRAVE_COLUMNS).z < graveSlot(0, 0).z,
)
check('les terrasses tiennent chacune dans un fill', graveyardTerraces(0).every((t) => boxVolume(t) < FILL_BLOCK_LIMIT))
check(
  'le cimetière est devant la gare, sans mordre sur le quai, la voie ni les workers',
  graveyardBounds(0).z2 < platformFloor(0).z1 &&
    graveyardBounds(0).z2 < workersFloor(0).z1 &&
    graveyardBounds(0).z2 < sidingRail(0).z1,
  `cimetière jusqu'à z=${graveyardBounds(0).z2}, quai à partir de z=${platformFloor(0).z1}`,
)

const footprint = stationFootprint(0)
const yardBox = graveyardBounds(0)
check(
  'le cimetière tient dans l\'emprise rasée au démarrage',
  yardBox.x1 >= footprint.x1 && yardBox.x2 <= footprint.x2 &&
    yardBox.z1 >= footprint.z1 && yardBox.z2 <= footprint.z2,
  `cimetière z ${yardBox.z1}..${yardBox.z2} vs emprise z ${footprint.z1}..${footprint.z2}`,
)
check(
  'les terrasses restent sous le plafond du rasage (BUILD_Y + 9)',
  graveyardTerraces(0).every((t) => t.y2 <= wipeAirVolume(0).y2),
)

// Le rayon des sélecteurs : il doit couvrir tout ce qu'on dessine...
const drawn = [
  ...Array.from({ length: GRAVE_SLOTS }, (_, i) => graveLabel(0, i)),
  ...Array.from({ length: MAX_CARTS }, (_, i) => cartSlot(0, i)),
  ...Array.from({ length: 16 }, (_, i) => workerSlot(0, i)),
]
const reach = Math.max(...drawn.map((p) => distanceFromCenter(0, p)))
check(
  `le rayon de balayage (${STATION_SWEEP_RADIUS}) couvre toute la gare, cimetière compris`,
  reach <= STATION_SWEEP_RADIUS,
  `point le plus lointain à ${reach.toFixed(1)} blocs`,
)
// ...sans jamais atteindre la gare voisine : sinon préparer une gare
// effacerait le cimetière de sa voisine, tombe par tombe.
const neighbour = Math.min(
  ...Array.from({ length: GRAVE_SLOTS }, (_, i) => distanceFromCenter(0, graveLabel(1, i))),
  ...Array.from({ length: MAX_CARTS }, (_, i) => distanceFromCenter(0, cartSlot(1, i))),
)
check(
  'et n\'atteint jamais ce que dessine la gare voisine',
  neighbour > STATION_SWEEP_RADIUS,
  `voisine à ${neighbour.toFixed(1)} blocs`,
)

// ---- Liste blanche ADR D4, étendue à `playsound` par l'ADR-003
const WHITELIST = /^(setblock|fill|summon|data|kill|tp|bossbar|scoreboard|tellraw|particle|playsound|forceload|time|gamerule|execute)\b/
const everyCommand = [
  ...bootstrapCommands([0, 1], { freezeScene: true }),
  ...stationPrepareCommands(2),
  ...buildStationCommands(0, 'scraping'),
  ...first.flatMap(mutationToCommands),
  ...grown.flatMap(mutationToCommands),
  ...arrivals.flatMap(mutationToCommands),
  ...rotated.flatMap(mutationToCommands),
  ...mutationToCommands({ kind: 'grave-clear', station: 0, slot: 7 }),
]
// Un `execute … run <cmd>` n'est acceptable que si la commande PORTÉE est
// elle aussi dans la liste : sans ce contrôle, l'enveloppe des effets
// serait un trou béant dans la discipline D4.
const carried = everyCommand
  .filter((command) => command.startsWith('execute '))
  .map((command) => command.slice(command.indexOf(' run ') + 5))
  .filter((command) => command.length > 0)
check(
  'les commandes portées par `execute … run` sont elles aussi dans la liste',
  carried.every((command) => WHITELIST.test(command)),
  carried.filter((c) => !WHITELIST.test(c)).join(' | '),
)
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

// Le pire cas réaliste : une gare dont le cimetière est plein encaisse
// une rafale d'échecs dans le même tick. L'effet étant plafonné à un par
// gare, le coût est « 1 commande par échec + 2 » et rien d'autre.
const burstYard = new Mirror()
for (const mutation of diff(burstYard.get(0), project(snapshot({ counts }), 0, failedJobs(GRAVE_SLOTS)))) {
  burstYard.apply(mutation)
}
const rafale = diff(
  burstYard.get(0),
  project(snapshot({ counts }), 0, [...failedJobs(5, 900), ...failedJobs(GRAVE_SLOTS - 5)]),
)
const rafaleCommands = rafale.flatMap(mutationToCommands).length
check(
  'cinq échecs d\'un coup sur un cimetière plein = 5 réécritures + 1 effet',
  rafaleCommands === 7,
  `${rafaleCommands} commandes`,
)
check(
  'un pire tick tient largement dans le budget d\'un tick (40 cmd/s à 2 Hz = 20)',
  rafaleCommands <= 20,
  `${rafaleCommands} commandes`,
)

console.log(
  failures === 0
    ? '\nTous les contrôles passent.\n'
    : `\n${failures} contrôle(s) en échec.\n`,
)
process.exitCode = failures === 0 ? 0 : 1

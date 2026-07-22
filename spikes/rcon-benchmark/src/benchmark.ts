/**
 * SPIKE : quelle est la VRAIE limite de débit RCON ?
 * ==================================================
 * L'ADR-001 (D7) budgète le renderer à ~40 commandes/seconde.
 * Ce script vérifie ce chiffre sur un vrai serveur, en testant
 * plusieurs stratégies d'envoi. Un "spike", c'est ça : du code
 * jetable écrit uniquement pour répondre à une question.
 *
 * Hypothèse initiale : le serveur exécute les commandes RCON sur
 * son fil principal, qui bat 20 fois par seconde (les "ticks").
 * Si on attend chaque réponse avant d'envoyer la suivante, on
 * devrait plafonner vers ~20 cmd/s. Envoyer plusieurs commandes
 * sans attendre (le "pipelining") devrait faire beaucoup mieux.
 *
 * MESURE DU 22/07/2026 : les DEUX moitiés de l'hypothèse sont fausses.
 * Le séquentiel fait ~330 cmd/s (les commandes s'exécutent au fil du
 * tick, pas une par tick), et le pipelining ne marche PAS DU TOUT :
 * dès 2 commandes en vol, le serveur ferme la connexion (vérifié de
 * 2 à 16 via src/pending-sweep.ts). Le seul levier de parallélisme
 * est donc d'ouvrir plusieurs connexions, chacune séquentielle.
 *
 * Les scénarios qui échouent sont rapportés comme tels au lieu de
 * faire planter le run : un échec est un résultat.
 *
 * Lancement :  pnpm bench   (serveur démarré, voir README)
 */
import { Rcon } from 'rcon-client'

const HOST = process.env.RCON_HOST ?? '127.0.0.1'
const PORT = Number(process.env.RCON_PORT ?? 25575)
const PASSWORD = process.env.RCON_PASSWORD ?? 'queuecraft-spike'

// Zone de test : une bande de blocs posée au-dessus du sol du monde
// plat (le sol en superflat est vers y=-60). Si tu te connectes au
// serveur, tu VERRAS le benchmark dessiner.
const Y = -59
const Z = 0
const COLORS = [
  'red_concrete', 'orange_concrete', 'yellow_concrete', 'lime_concrete',
  'light_blue_concrete', 'blue_concrete', 'purple_concrete', 'magenta_concrete',
]

/** Petite aide : connexion avec un nombre de commandes "en vol" donné. */
async function connect(maxPending: number): Promise<Rcon> {
  const rcon = await Rcon.connect({
    host: HOST,
    port: PORT,
    password: PASSWORD,
    maxPending, // combien de commandes peuvent partir sans attendre la réponse
    timeout: 15_000, // on rallonge le délai d'attente : les rafales font patienter
  })
  // Quand le serveur coupe la connexion (cas du pipelining), l'écriture
  // suivante émet un 'error' ASYNCHRONE (EPIPE) qu'aucun try/catch ne
  // rattrape : sans ce listener, Node tue le process et on perd tous les
  // scénarios suivants. La promesse du send rejette de toute façon.
  rcon.on('error', () => {})
  return rcon
}

function setblockCmd(x: number, i: number): string {
  const color = COLORS[i % COLORS.length]
  return `setblock ${x} ${Y} ${Z} minecraft:${color}`
}

/** Moyenne et 95e percentile (la latence "des mauvais jours"). */
function stats(durationsMs: number[]) {
  const sorted = [...durationsMs].sort((a, b) => a - b)
  const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
  return { avg, p95 }
}

/** Scénario A : séquentiel strict (1 commande en vol). */
async function benchSequential(count: number) {
  const rcon = await connect(1)
  const durations: number[] = []
  const start = performance.now()
  for (let i = 0; i < count; i++) {
    const t0 = performance.now()
    await rcon.send(setblockCmd(i, i))
    durations.push(performance.now() - t0)
  }
  const totalS = (performance.now() - start) / 1000
  await rcon.end()
  const { avg, p95 } = stats(durations)
  return { opsPerSec: count / totalS, avgMs: avg, p95Ms: p95 }
}

/** Scénario B : pipeliné (jusqu'à `pending` commandes en vol sur 1 connexion). */
async function benchPipelined(count: number, pending: number) {
  const rcon = await connect(pending)
  const start = performance.now()
  // On envoie par vagues de `pending` : la lib file les paquets,
  // le serveur peut en traiter plusieurs pendant un même tick.
  for (let i = 0; i < count; i += pending) {
    const wave = []
    for (let j = i; j < Math.min(i + pending, count); j++) {
      wave.push(rcon.send(setblockCmd(j, j)))
    }
    await Promise.all(wave)
  }
  const totalS = (performance.now() - start) / 1000
  await rcon.end()
  return { opsPerSec: count / totalS }
}

/**
 * Scénario C : plusieurs connexions RCON en parallèle, CHACUNE séquentielle.
 * (Le pipelining étant impossible, c'est le seul moyen de paralléliser.)
 */
async function benchMultiConnection(count: number, connections: number) {
  const rcons = await Promise.all(Array.from({ length: connections }, () => connect(1)))
  const perConn = Math.ceil(count / connections)
  const start = performance.now()
  await Promise.all(
    rcons.map(async (rcon, c) => {
      for (let j = 0; j < perConn; j++) {
        const x = c * perConn + j
        await rcon.send(setblockCmd(x, x))
      }
    }),
  )
  const totalS = (performance.now() - start) / 1000
  await Promise.all(rcons.map((r) => r.end()))
  return { opsPerSec: (perConn * connections) / totalS }
}

/**
 * Scénario D : débit soutenu pendant N secondes (le régime de croisière).
 * `connections` connexions séquentielles tournant en parallèle.
 */
async function benchSustained(seconds: number, connections: number) {
  const rcons = await Promise.all(Array.from({ length: connections }, () => connect(1)))
  const deadline = performance.now() + seconds * 1000
  let sent = 0
  await Promise.all(
    rcons.map(async (rcon) => {
      while (performance.now() < deadline) {
        const i = sent++
        await rcon.send(setblockCmd(i % 512, i))
      }
    }),
  )
  await Promise.all(rcons.map((r) => r.end()))
  return { opsPerSec: sent / seconds }
}

/** Scénario E : la leçon d'agrégation — 1 commande /fill = 512 blocs. */
async function benchFill() {
  const rcon = await connect(1)
  const t0 = performance.now()
  await rcon.send(`fill 0 ${Y + 2} ${Z} 511 ${Y + 2} ${Z} minecraft:lime_concrete`)
  const ms = performance.now() - t0
  await rcon.end()
  return { ms }
}

async function main() {
  console.log(`\nQueuecraft — spike RCON  →  ${HOST}:${PORT}\n`)

  // Préparation : garder la zone chargée même sans joueur, puis la nettoyer.
  const setup = await connect(1)
  try {
    await setup.send('forceload add 0 0 511 0')
    await setup.send(`fill 0 ${Y} ${Z} 511 ${Y + 2} ${Z} minecraft:air`)
    const version = await setup.send('version').catch(() => '(commande version indisponible)')
    console.log(`Serveur : ${version.slice(0, 100)}\n`)
  } finally {
    await setup.end()
  }

  // Un scénario qui casse est une mesure, pas un crash : on note et on continue.
  const throughputs: number[] = []
  async function run<T>(label: string, fn: () => Promise<T>, fmt: (r: T) => string) {
    console.log(label)
    try {
      const r = await fn()
      console.log(`   → ${fmt(r)}\n`)
      return r
    } catch (err) {
      console.log(`   → ÉCHEC : ${(err as Error)?.message ?? err}\n`)
      return undefined
    }
  }
  const keep = <T extends { opsPerSec: number }>(r: T | undefined) => {
    if (r) throughputs.push(r.opsPerSec)
    return r
  }

  keep(
    await run(
      'A) Séquentiel (1 en vol) — 100 commandes...',
      () => benchSequential(100),
      (r) => `${r.opsPerSec.toFixed(1)} cmd/s  (latence moy ${r.avgMs.toFixed(1)} ms, p95 ${r.p95Ms.toFixed(1)} ms)`,
    ),
  )

  keep(
    await run(
      'B) Pipeliné ×8 (1 connexion) — 200 commandes...  [attendu : ÉCHEC]',
      () => benchPipelined(200, 8),
      (r) => `${r.opsPerSec.toFixed(1)} cmd/s`,
    ),
  )

  keep(
    await run(
      'C) 2 connexions séquentielles — 200 commandes...',
      () => benchMultiConnection(200, 2),
      (r) => `${r.opsPerSec.toFixed(1)} cmd/s`,
    ),
  )

  keep(
    await run(
      'D) Débit soutenu 10 s (1 connexion séquentielle)...',
      () => benchSustained(10, 1),
      (r) => `${r.opsPerSec.toFixed(1)} cmd/s en régime continu`,
    ),
  )

  keep(
    await run(
      "D') Débit soutenu 10 s (4 connexions séquentielles)...",
      () => benchSustained(10, 4),
      (r) => `${r.opsPerSec.toFixed(1)} cmd/s en régime continu`,
    ),
  )

  await run(
    'E) Agrégation : 1 seul /fill de 512 blocs...',
    () => benchFill(),
    (r) => `512 blocs en ${r.ms.toFixed(0)} ms avec UNE commande`,
  )

  const budget = 40
  const best = throughputs.length ? Math.max(...throughputs) : 0
  console.log('────────────────────────────────────────')
  console.log(`Budget ADR-001 (D7) : ${budget} cmd/s`)
  console.log(
    best >= budget
      ? `VERDICT : OK — le canal tient ${best.toFixed(0)} cmd/s au mieux, le budget est réaliste.`
      : `VERDICT : ATTENTION — max mesuré ${best.toFixed(0)} cmd/s < budget. Revoir D7 (baisser la fréquence de rendu ou agréger plus).`,
  )
  console.log('Leçon E : préférer /fill et les commandes groupées à chaque fois que possible.\n')
}

main().catch((err) => {
  console.error('\nÉchec du benchmark :', err?.message ?? err)
  console.error('Le serveur est-il démarré ?  →  docker compose up -d  puis attendre "RCON running" dans les logs.')
  process.exit(1)
})

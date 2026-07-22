/**
 * SPIKE : quelle est la VRAIE limite de débit RCON ?
 * ==================================================
 * L'ADR-001 (D7) budgète le renderer à ~40 commandes/seconde.
 * Ce script vérifie ce chiffre sur un vrai serveur, en testant
 * plusieurs stratégies d'envoi. Un "spike", c'est ça : du code
 * jetable écrit uniquement pour répondre à une question.
 *
 * Hypothèse à vérifier : le serveur exécute les commandes RCON sur
 * son fil principal, qui bat 20 fois par seconde (les "ticks").
 * Si on attend chaque réponse avant d'envoyer la suivante, on
 * devrait plafonner vers ~20 cmd/s. Envoyer plusieurs commandes
 * sans attendre (le "pipelining") devrait faire beaucoup mieux.
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
  return Rcon.connect({
    host: HOST,
    port: PORT,
    password: PASSWORD,
    maxPending, // combien de commandes peuvent partir sans attendre la réponse
    timeout: 15_000, // on rallonge le délai d'attente : les rafales font patienter
  })
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

/** Scénario C : plusieurs connexions RCON en parallèle. */
async function benchMultiConnection(count: number, connections: number, pending: number) {
  const rcons = await Promise.all(
    Array.from({ length: connections }, () => connect(pending)),
  )
  const perConn = Math.ceil(count / connections)
  const start = performance.now()
  await Promise.all(
    rcons.map(async (rcon, c) => {
      for (let i = 0; i < perConn; i += pending) {
        const wave = []
        for (let j = i; j < Math.min(i + pending, perConn); j++) {
          const x = c * perConn + j
          wave.push(rcon.send(setblockCmd(x, x)))
        }
        await Promise.all(wave)
      }
    }),
  )
  const totalS = (performance.now() - start) / 1000
  await Promise.all(rcons.map((r) => r.end()))
  return { opsPerSec: count / totalS }
}

/** Scénario D : débit soutenu pendant N secondes (le régime de croisière). */
async function benchSustained(seconds: number, pending: number) {
  const rcon = await connect(pending)
  const deadline = performance.now() + seconds * 1000
  let sent = 0
  while (performance.now() < deadline) {
    const wave = []
    for (let j = 0; j < pending; j++) {
      wave.push(rcon.send(setblockCmd(sent % 512, sent)))
      sent++
    }
    await Promise.all(wave)
  }
  await rcon.end()
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

  console.log('A) Séquentiel (1 en vol) — 100 commandes...')
  const a = await benchSequential(100)
  console.log(`   → ${a.opsPerSec.toFixed(1)} cmd/s  (latence moy ${a.avgMs.toFixed(1)} ms, p95 ${a.p95Ms.toFixed(1)} ms)\n`)

  console.log('B) Pipeliné ×8 (1 connexion) — 200 commandes...')
  const b = await benchPipelined(200, 8)
  console.log(`   → ${b.opsPerSec.toFixed(1)} cmd/s\n`)

  console.log('C) 2 connexions ×8 — 200 commandes...')
  const c = await benchMultiConnection(200, 2, 8)
  console.log(`   → ${c.opsPerSec.toFixed(1)} cmd/s\n`)

  console.log('D) Débit soutenu 10 s (pipeliné ×8)...')
  const d = await benchSustained(10, 8)
  console.log(`   → ${d.opsPerSec.toFixed(1)} cmd/s en régime continu\n`)

  console.log('E) Agrégation : 1 seul /fill de 512 blocs...')
  const e = await benchFill()
  console.log(`   → 512 blocs en ${e.ms.toFixed(0)} ms avec UNE commande\n`)

  const budget = 40
  const best = Math.max(a.opsPerSec, b.opsPerSec, c.opsPerSec, d.opsPerSec)
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

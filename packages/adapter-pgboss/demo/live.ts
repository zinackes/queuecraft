/**
 * DÉMO BOUT EN BOUT — une VRAIE queue pg-boss dans le monde Minecraft.
 * ====================================================================
 * Même gare que la démo P1, mais plus aucun chiffre inventé : les carts,
 * le panneau et le cimetière viennent de jobs pg-boss réellement insérés,
 * réellement consommés, réellement en échec.
 *
 *      pg-boss (PGlite) → PgBossAdapter → renderer P1 → RCON → monde
 *
 * La base est un PGlite in-process : pas de conteneur Postgres à lancer.
 * `DATABASE_URL` bascule sur un vrai Postgres si tu en as un.
 *
 * Lancement :  pnpm --filter @queuecraft/adapter-pgboss demo
 *              ... --keep     (ne pas raser la gare en sortant)
 *
 * En jeu : se connecter sur localhost:25565, puis  /tp @s 8 -50 -14
 */
import { PGlite } from '@electric-sql/pglite'
import { PgBoss, fromPglite } from 'pg-boss'
import {
  cartsForBacklog,
  createRenderer,
  inspect,
  layout,
  RconSink,
  teardownCommands,
} from '@queuecraft/renderer'
import { PgBossAdapter } from '../src/index.js'

const HOST = process.env.RCON_HOST ?? '127.0.0.1'
const PORT = Number(process.env.RCON_PORT ?? 25575)
// Fichier de démo : le mot de passe du serveur jetable peut servir de
// défaut ici, et NULLE PART ailleurs (CLAUDE.md, règle de sécurité n°6).
const PASSWORD = process.env.RCON_PASSWORD ?? 'queuecraft-spike'
const DATABASE_URL = process.env.DATABASE_URL

const QUEUE = 'scraping'
const BUDGET = 40
const KEEP = process.argv.includes('--keep')

/** Une phase du scénario : un régime de production et de consommation. */
interface Phase {
  name: string
  seconds: number
  /** Jobs insérés par seconde. */
  inputPerSec: number
  /** Part des jobs consommés qui échouent. */
  failureRate: number
  /** Arrête les workers au début de la phase (fige la queue). */
  stopWorkers?: boolean
  note: string
}

const SCENARIO: Phase[] = [
  { name: 'ramp', seconds: 15, inputPerSec: 90, failureRate: 0.01, note: 'on injecte plus vite que les workers ne consomment' },
  { name: 'steady', seconds: 25, inputPerSec: 45, failureRate: 0.01, note: 'RÉGIME STABLE — fenêtre de mesure du budget' },
  { name: 'surge', seconds: 15, inputPerSec: 240, failureRate: 0.3, note: 'burst : le backlog explose, les tombes s’alignent' },
  { name: 'drain', seconds: 25, inputPerSec: 0, failureRate: 0.01, note: 'plus rien n’entre, les workers rattrapent' },
  // Les workers s'en vont : la queue gèle sur un backlog connu, et le monde
  // doit converger dessus — c'est ce qu'on vérifie ensuite sans joueur.
  { name: 'hold', seconds: 10, inputPerSec: 0, failureRate: 0, stopWorkers: true, note: 'les workers partent, la queue reste en plan' },
]

const WORKERS = 3
const WORKER_BATCH = 25

async function main(): Promise<void> {
  // --- La base et pg-boss
  const pglite = DATABASE_URL ? null : await PGlite.create()
  const boss = new PgBoss(
    pglite
      ? {
          db: fromPglite(pglite),
          backend: 'pglite',
          supervise: true,
          // Les compteurs de pg-boss sont rafraîchis par SON moniteur :
          // à 2 Hz de rendu, il doit tourner à la seconde.
          monitorIntervalSeconds: 1,
          superviseIntervalSeconds: 1,
        }
      : {
          connectionString: DATABASE_URL,
          supervise: true,
          monitorIntervalSeconds: 1,
          superviseIntervalSeconds: 1,
        },
  )
  boss.on('error', (error) => console.error('  pg-boss :', error.message))
  await boss.start()
  await boss.deleteQueue(QUEUE).catch(() => {})
  await boss.createQueue(QUEUE, { retryLimit: 0 })

  console.log(`\nQueuecraft — démo pg-boss  →  ${HOST}:${PORT}`)
  console.log(`Base : ${DATABASE_URL ? 'Postgres (DATABASE_URL)' : 'PGlite in-process'}`)
  console.log(`Budget ADR D7 : ${BUDGET} cmd/s · tick 500 ms · en jeu : /tp @s 8 -50 -14\n`)

  // --- Les workers : de vrais consommateurs, avec de vrais échecs.
  let failureRate = SCENARIO[0]?.failureRate ?? 0
  for (let w = 0; w < WORKERS; w++) {
    await boss.work(
      QUEUE,
      { batchSize: WORKER_BATCH, pollingIntervalSeconds: 1, perJobResults: true },
      async (jobs) =>
        jobs.map((job) =>
          Math.random() < failureRate
            ? { id: job.id, status: 'failed' as const, output: { message: `502 sur ${(job.data as { url: string }).url}` } }
            : { id: job.id, status: 'completed' as const },
        ),
    )
  }

  // --- L'adapter et le renderer : le renderer ne sait pas que pg-boss existe.
  const adapter = new PgBossAdapter({ boss, refreshMs: 500, onError: (e) => console.error('  adapter :', e.message) })
  await adapter.start()

  const sink = new RconSink({
    host: HOST,
    port: PORT,
    password: PASSWORD,
    maxCommandsPerSecond: BUDGET,
    onRejected: (command, reply) => console.error(`\n  COMMANDE REFUSÉE : ${reply}\n  → ${command}\n`),
  })
  await sink.connect()

  const renderer = createRenderer({
    sink,
    source: () => adapter.snapshot(),
    tickMs: 500,
    freezeScene: true,
    onError: (error) => console.error('  ERREUR DE RENDU :', error.message),
  })

  const bootStart = Date.now()
  await renderer.start()
  console.log(
    `  démarrage : ${sink.total} commandes en ${((Date.now() - bootStart) / 1_000).toFixed(1)} s\n`,
  )

  // --- Le scénario : on ne pilote QUE la queue, jamais l'affichage.
  const reports: PhaseReport[] = []
  let injected = 0
  for (const phase of SCENARIO) {
    failureRate = phase.failureRate
    if (phase.stopWorkers) await boss.offWork(QUEUE)
    console.log(`  ── ${phase.name} : ${phase.note}`)
    const startedAt = Date.now()
    const commandsBefore = sink.total

    while (Date.now() - startedAt < phase.seconds * 1_000) {
      if (phase.inputPerSec > 0) {
        const batch = Math.round(phase.inputPerSec / 2)
        await boss.insert(
          QUEUE,
          Array.from({ length: batch }, () => ({
            name: QUEUE,
            data: { url: `https://example.test/${injected++}` },
          })),
        )
      }
      await sleep(500)
    }

    const seconds = (Date.now() - startedAt) / 1_000
    const commands = sink.total - commandsBefore
    reports.push({
      name: phase.name,
      seconds,
      commands,
      avgPerSec: seconds > 0 ? commands / seconds : 0,
      peakPerSec: sink.peakRate(startedAt),
    })

    const [snapshot] = await adapter.snapshot()
    console.log(
      `     queue : ${snapshot?.counts.waiting} en attente · ${snapshot?.counts.active} actifs · ` +
        `${snapshot?.counts.completed} terminés · ${snapshot?.counts.failed} échoués · ` +
        `${snapshot?.workers} workers · ${snapshot?.throughputPerMin}/min`,
    )
  }

  // Un dernier passage sur la queue gelée : le monde et l'adapter parlent
  // alors du même instant, sinon la vérification comparerait deux états.
  await renderer.tick()
  renderer.stop()

  // --- Le monde dit-il la vérité sur la queue ?
  const [last] = await adapter.snapshot()
  const waiting = last?.counts.waiting ?? 0
  const expectedCarts = cartsForBacklog(waiting)
  let placed = 0
  for (let slot = 0; slot < layout.MAX_CARTS; slot++) {
    const reply = await sink.send(inspect.cartAtSlot(0, slot))
    const z = Number(/(-?\d+(?:\.\d+)?)d?\s*$/.exec(reply.trim())?.[1] ?? NaN)
    if (Math.abs(z - inspect.expectedCartZ(0, slot)) < 0.51) placed++
  }
  const failures = await adapter.recentFailures(50)
  const statsReply = await sink.send(inspect.statsText(0))

  console.log(`\nVérification dans le monde (queue réelle : ${waiting} en attente)`)
  console.log(`  carts sur la voie   : ${placed} (attendu ${expectedCarts})`)
  console.log(`  panneau             : ${statsReply.replace(/^[^:]*:\s*/, '').slice(0, 160)}`)
  console.log(`  échecs remontés     : ${failures.length}  ex. « ${failures[0]?.error ?? '—'} »`)

  console.log('\nBudget RCON par phase')
  console.log('  phase     durée    commandes   moyenne     pic 1 s')
  for (const report of reports) {
    console.log(
      `  ${report.name.padEnd(9)} ${`${report.seconds.toFixed(0)}s`.padStart(5)}  ` +
        `${String(report.commands).padStart(9)}   ${`${report.avgPerSec.toFixed(1)}/s`.padStart(8)}   ` +
        `${`${report.peakPerSec}/s`.padStart(8)}`,
    )
  }

  const steady = reports.find((r) => r.name === 'steady')
  const verdict = steady !== undefined && steady.peakPerSec <= BUDGET && placed === expectedCarts
  console.log(
    `\n${
      verdict
        ? `VERDICT : OK — régime stable à ${steady?.avgPerSec.toFixed(1)} cmd/s de moyenne, ` +
          `pic ${steady?.peakPerSec}/s (budget ${BUDGET}/s), et la gare montre bien ${placed} carts ` +
          `pour ${waiting} jobs réellement en attente.`
        : `VERDICT : ÉCHEC — ${
            steady === undefined
              ? 'phase stable non mesurée'
              : steady.peakPerSec > BUDGET
                ? `pic à ${steady.peakPerSec} cmd/s > budget ${BUDGET}`
                : `${placed} carts dans le monde au lieu de ${expectedCarts}`
          }`
    }`,
  )
  console.log(`Commandes refusées par le serveur : ${sink.rejectedCount}\n`)

  if (!KEEP) {
    console.log('Nettoyage (--keep pour garder la gare en place).')
    await sink.sendAll(teardownCommands([0]))
  }
  await sink.close()
  await adapter.stop()
  await boss.stop({ graceful: false })
  await pglite?.close()
  process.exitCode = verdict && sink.rejectedCount === 0 ? 0 : 1
}

interface PhaseReport {
  name: string
  seconds: number
  commands: number
  avgPerSec: number
  peakPerSec: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((error) => {
  console.error('\nÉchec de la démo :', (error as Error)?.message ?? error)
  console.error('Le serveur est-il démarré ?  →  cd spikes/rcon-benchmark && docker compose up -d')
  process.exit(1)
})

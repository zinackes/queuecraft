/**
 * LA DÉMO — un scénario mocké, filmable, et une mesure de budget.
 * ==============================================================
 * Aucun adapter réel ici : des `QueueSnapshot` fabriqués, qui suivent
 * une histoire (montée du backlog → régime stable → surcharge et échecs
 * → drain). C'est ce qu'on filme, et c'est aussi le banc de mesure du
 * budget ADR D7 : le débit est relevé PAR PHASE, et la phase stable
 * décide du verdict.
 *
 * Lancement :  pnpm demo            (serveur du spike démarré)
 *              pnpm demo --keep     (ne pas raser la gare en sortant)
 *
 * En jeu : se connecter sur localhost:25565, puis  /tp @s 8 -50 -14
 */
import type { QueueSnapshot } from '@queuecraft/core'
import { inspect, teardownCommands } from './commands.js'
import { MAX_CARTS } from './layout.js'
import { RconSink } from './rcon-sink.js'
import { createRenderer } from './renderer.js'
import { cartsForBacklog } from './scale.js'

const HOST = process.env.RCON_HOST ?? '127.0.0.1'
const PORT = Number(process.env.RCON_PORT ?? 25575)
// Fichier de démo : le mot de passe du serveur jetable peut servir de
// défaut ici, et NULLE PART ailleurs (CLAUDE.md, règle de sécurité n°6).
const PASSWORD = process.env.RCON_PASSWORD ?? 'queuecraft-spike'

const BUDGET = 40
const KEEP = process.argv.includes('--keep')

/** Une phase du scénario : une intention visuelle, une durée. */
interface Phase {
  name: string
  seconds: number
  /** Backlog visé en fin de phase (interpolé depuis celui du début). */
  waiting: number
  workers: number
  /** Part des jobs terminés qui échouent pendant la phase. */
  failureRate: number
  /** Jobs terminés par seconde (anime les compteurs en continu). */
  throughputPerSec: number
  /** Amplitude du bruit sur le backlog, en part du backlog visé. */
  jitterRate: number
  note: string
}

const SCENARIO: Phase[] = [
  { name: 'ramp', seconds: 15, waiting: 1_200, workers: 4, failureRate: 0.01, throughputPerSec: 6, jitterRate: 0.04, note: 'le backlog monte, les carts arrivent un par un' },
  { name: 'steady', seconds: 30, waiting: 1_200, workers: 4, failureRate: 0.01, throughputPerSec: 8, jitterRate: 0.04, note: 'RÉGIME STABLE — fenêtre de mesure du budget' },
  { name: 'surge', seconds: 12, waiting: 20_000, workers: 8, failureRate: 0.35, throughputPerSec: 20, jitterRate: 0.04, note: 'burst : voie saturée, panneau au rouge' },
  { name: 'drain', seconds: 18, waiting: 0, workers: 8, failureRate: 0.02, throughputPerSec: 40, jitterRate: 0.04, note: 'les workers rattrapent, les carts repartent' },
  // Sans bruit : l'état final doit être exactement reproductible pour que
  // la vérification dans le monde ait une valeur attendue, pas une plage.
  { name: 'hold', seconds: 6, waiting: 1_000, workers: 5, failureRate: 0.0, throughputPerSec: 4, jitterRate: 0, note: 'état connu, vérifié dans le monde juste après' },
]

/**
 * Le simulateur. Il ne fait qu'une chose : donner un `QueueSnapshot`
 * plausible pour l'instant présent. Le renderer, lui, ne sait pas que
 * ces chiffres sont faux — c'est tout l'intérêt du modèle pivot.
 */
class Simulation {
  private phaseIndex = 0
  private phaseStart = Date.now()
  private startWaiting = 0
  private waiting = 0
  private completed = 0
  private failed = 0
  private lastStep = Date.now()
  finished = false
  /** Dernier snapshot servi au renderer : la référence de la vérification. */
  lastEmitted: QueueSnapshot | null = null

  get phase(): Phase {
    return SCENARIO[this.phaseIndex] ?? (SCENARIO[SCENARIO.length - 1] as Phase)
  }

  /** Bornes de la phase courante, pour attribuer les mesures. */
  phaseElapsed(): number {
    return (Date.now() - this.phaseStart) / 1_000
  }

  read(): QueueSnapshot[] {
    const now = Date.now()
    const phase = this.phase
    const progress = Math.min(1, this.phaseElapsed() / phase.seconds)

    // Backlog : interpolation douce entre le début et la cible de la phase,
    // plus un léger bruit — sans bruit, un régime « stable » serait figé et
    // ne prouverait rien du diffing.
    const target = this.startWaiting + (phase.waiting - this.startWaiting) * progress
    const jitter =
      phase.jitterRate === 0 ? 0 : Math.sin(now / 700) * Math.max(2, target * phase.jitterRate)
    this.waiting = Math.max(0, Math.round(target + jitter))

    // Compteurs cumulés : ils avancent à chaque lecture, donc le panneau
    // change à CHAQUE tick — c'est ce qui rend les compteurs « animés ».
    const deltaS = (now - this.lastStep) / 1_000
    this.lastStep = now
    const done = phase.throughputPerSec * deltaS
    this.completed += done * (1 - phase.failureRate)
    this.failed += done * phase.failureRate

    if (progress >= 1) this.nextPhase()

    const snapshot: QueueSnapshot = {
      name: 'scraping',
      counts: {
        waiting: this.waiting,
        active: Math.min(phase.workers, Math.ceil(this.waiting / 50)),
        completed: Math.round(this.completed),
        failed: Math.round(this.failed),
        delayed: 0,
      },
      workers: phase.workers,
      throughputPerMin: Math.round(phase.throughputPerSec * 60),
      capturedAt: new Date(now),
    }
    this.lastEmitted = snapshot
    return [snapshot]
  }

  private nextPhase(): void {
    if (this.phaseIndex >= SCENARIO.length - 1) {
      this.finished = true
      return
    }
    this.phaseIndex++
    this.phaseStart = Date.now()
    this.startWaiting = this.waiting
  }
}

interface PhaseReport {
  name: string
  seconds: number
  commands: number
  avgPerSec: number
  peakPerSec: number
}

async function main(): Promise<void> {
  const sink = new RconSink({
    host: HOST,
    port: PORT,
    password: PASSWORD,
    maxCommandsPerSecond: BUDGET,
    onRejected: (command, reply) => {
      console.error(`\n  COMMANDE REFUSÉE : ${reply}\n  → ${command}\n`)
    },
  })
  await sink.connect()

  const simulation = new Simulation()
  const renderer = createRenderer({
    sink,
    source: () => simulation.read(),
    tickMs: 500,
    freezeScene: true, // midi permanent, pas de mobs : c'est une démo filmée
    onError: (error) => console.error('  ERREUR DE RENDU :', error.message),
  })

  console.log(`\nQueuecraft — démo de rendu  →  ${HOST}:${PORT}`)
  console.log(`Budget ADR D7 : ${BUDGET} cmd/s · tick 500 ms · en jeu : /tp @s 8 -50 -14\n`)

  const bootStart = Date.now()
  await renderer.start()
  const bootCommands = sink.total
  console.log(
    `  démarrage : ${bootCommands} commandes en ${((Date.now() - bootStart) / 1_000).toFixed(1)} s ` +
      `(rasage + décor + pool d'entités)\n`,
  )

  const reports: PhaseReport[] = []
  let currentPhase = simulation.phase.name
  let phaseStart = Date.now()
  let phaseCommands = sink.total
  console.log(`  ── ${currentPhase} : ${simulation.phase.note}`)

  await until(() => {
    const phase = simulation.phase
    if (phase.name !== currentPhase) {
      reports.push(closePhase(currentPhase, phaseStart, sink.total - phaseCommands, sink))
      currentPhase = phase.name
      phaseStart = Date.now()
      phaseCommands = sink.total
      console.log(`  ── ${currentPhase} : ${phase.note}`)
    }
    return simulation.finished
  }, 250)

  reports.push(closePhase(currentPhase, phaseStart, sink.total - phaseCommands, sink))
  renderer.stop()

  // --- Vérification dans le monde, sans joueur connecté.
  // La dernière phase tient un état sans bruit : on relit donc le monde
  // et on compare aux emplacements attendus pour CE backlog précis.
  const finalWaiting = simulation.lastEmitted?.counts.waiting ?? 0
  console.log(`\nVérification dans le monde (dernier état : ${finalWaiting} en attente)`)
  const expectedCarts = cartsForBacklog(finalWaiting)
  let placed = 0
  for (let slot = 0; slot < MAX_CARTS; slot++) {
    const reply = await sink.send(inspect.cartAtSlot(0, slot))
    const z = Number(/(-?\d+(?:\.\d+)?)d?\s*$/.exec(reply.trim())?.[1] ?? NaN)
    const onSiding = Math.abs(z - inspect.expectedCartZ(0, slot)) < 0.51
    if (onSiding) placed++
  }
  const statsReply = await sink.send(inspect.statsText(0))
  console.log(`  carts sur la voie   : ${placed} (attendu ${expectedCarts})`)
  console.log(`  panneau             : ${statsReply.replace(/^[^:]*:\s*/, '').slice(0, 160)}`)

  // --- Rapport de budget
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
    `\n${verdict
      ? `VERDICT : OK — régime stable à ${steady?.avgPerSec.toFixed(1)} cmd/s de moyenne, ` +
        `pic ${steady?.peakPerSec}/s sur ${steady?.seconds.toFixed(0)} s (budget ${BUDGET}/s), ` +
        `et le monde contient bien ${placed} carts.`
      : `VERDICT : ÉCHEC — ${steady === undefined
          ? 'phase stable non mesurée'
          : steady.peakPerSec > BUDGET
            ? `pic à ${steady.peakPerSec} cmd/s > budget ${BUDGET}`
            : `${placed} carts dans le monde au lieu de ${expectedCarts}`}`}`,
  )
  console.log(`Commandes refusées par le serveur : ${sink.rejectedCount}\n`)

  if (!KEEP) {
    console.log('Nettoyage (--keep pour garder la gare en place).')
    await sink.sendAll(teardownCommands([0]))
  }
  await sink.close()
  process.exitCode = verdict && sink.rejectedCount === 0 ? 0 : 1
}

function closePhase(name: string, startedAt: number, commands: number, sink: RconSink): PhaseReport {
  const seconds = (Date.now() - startedAt) / 1_000
  return {
    name,
    seconds,
    commands,
    avgPerSec: seconds > 0 ? commands / seconds : 0,
    peakPerSec: sink.peakRate(startedAt),
  }
}

/** Attend que `done()` soit vrai, en le testant toutes les `everyMs`. */
function until(done: () => boolean, everyMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (done()) {
        clearInterval(timer)
        resolve()
      }
    }, everyMs)
  })
}

main().catch((error) => {
  console.error('\nÉchec de la démo :', (error as Error)?.message ?? error)
  console.error('Le serveur est-il démarré ?  →  cd spikes/rcon-benchmark && docker compose up -d')
  process.exit(1)
})

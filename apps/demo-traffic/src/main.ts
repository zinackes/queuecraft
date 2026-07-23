/**
 * DÉMO « TRAFIC » — de quoi filmer, sans une seule ligne d'infra.
 * ===============================================================
 * Un vrai pg-boss, sur un vrai Postgres (PGlite compilé en WASM, dans le
 * processus), avec trois queues qui respirent : `scraping`, `emails`,
 * `reports`. Producteur sinusoïdal + bursts, workers lents, échecs
 * réalistes. Rien n'est simulé côté données : les compteurs affichés — et
 * ceux envoyés dans le monde — sortent de la base.
 *
 *      TrafficGenerator → pg-boss (PGlite) → PgBossAdapter → tableau de bord
 *                                                         └→ renderer → RCON → monde
 *
 * Lancement :
 *      pnpm demo:traffic                  tableau de bord texte seul
 *      pnpm demo:traffic --render         + le monde Minecraft (serveur requis)
 *      pnpm demo:traffic --render --keep  ... sans raser les gares en sortant
 *
 * Réglages (variables d'env) :
 *      FAIL_RATE=8      part des jobs qui échouent — « 0.08 », « 8 » ou « 8% »
 *      RATE_SCALE=1     multiplie tous les débits
 *      JOB_MIN_MS=200   durée d'un job, borne basse
 *      JOB_MAX_MS=3000  durée d'un job, borne haute
 *      SEED=123         rejoue exactement les mêmes vagues
 *      DURATION_S=300   arrêt automatique (0 = jusqu'à Ctrl-C)
 *      DATABASE_URL=... un vrai Postgres au lieu de PGlite
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { PGlite } from '@electric-sql/pglite'
import { PgBoss, fromPglite } from 'pg-boss'
import { PgBossAdapter } from '@queuecraft/adapter-pgboss'
import {
  cartsForBacklog,
  createRenderer,
  inspect,
  layout,
  RconSink,
  teardownCommands,
} from '@queuecraft/renderer'
import { PROFILES, readConfig, seededRandom } from './config.js'
import { Dashboard, type Frame } from './dashboard.js'
import { TrafficGenerator } from './traffic.js'

const REFRESH_MS = 1_000
/** Budget RCON de l'ADR D7 — jamais relevé sans nouvel ADR. */
const BUDGET = 40
/**
 * Fenêtre de démarrage exclue des mesures de latence. Le rasage + le décor
 * + le pool d'entités des trois gares coûtent ~150 commandes, donc ~4 s de
 * throttle à 40 cmd/s (ADR-002 autorise explicitement un premier rendu
 * cher). Une tombe née pendant cette fenêtre attend derrière la pelleteuse.
 */
const BOOTSTRAP_WINDOW_MS = 10_000

/** Un délai « échec → tombe », décomposé pour savoir qui est lent. */
interface GraveDelay {
  /** Instant de la mesure, depuis le début du run. */
  atMs: number
  /** Total : de `completed_on` en base à la fin du tick qui a dessiné. */
  delayMs: number
  /** Part passée à ce que l'ADAPTER voie l'échec (`null` si non observé). */
  observeMs: number | null
  /** Contexte du tick qui a posé la pierre — pour lire les à-coups. */
  tickCommands: number
  tickMs: number
  tickGraves: number
}

const RENDER = process.argv.includes('--render')
const KEEP = process.argv.includes('--keep')

async function main(): Promise<void> {
  const config = readConfig(process.env)
  const rand = seededRandom(config.seed)
  const log = new Ring(20, process.stdout.isTTY !== true)

  // --- La base. PGlite est un Postgres complet en WASM : zéro conteneur.
  const url = process.env.DATABASE_URL
  const pglite = url ? null : await PGlite.create()
  const boss = new PgBoss(
    pglite
      ? { db: fromPglite(pglite), backend: 'pglite', ...MONITORING }
      : { connectionString: url, ...MONITORING },
  )
  boss.on('error', (error) => log.push(`pg-boss : ${error.message}`))
  await boss.start()

  // --- Le trafic : c'est lui, et lui seul, qui touche à la queue.
  const traffic = new TrafficGenerator({
    boss,
    profiles: PROFILES,
    failRate: config.failRate,
    jobMinMs: config.jobMinMs,
    jobMaxMs: config.jobMaxMs,
    rateScale: config.rateScale,
    rand,
    onLog: (line) => log.push(line),
  })
  await traffic.start()

  // --- L'observation : le même adapter que le daemon, sans exception.
  const adapter = new PgBossAdapter({
    boss,
    refreshMs: 500,
    queues: PROFILES.map((profile) => profile.name),
    onError: (error) => log.push(`adapter : ${error.message}`),
  })
  await adapter.start()

  // --- Le monde, en option. Sans lui la démo reste utile (c'est le but).
  let sink: RconSink | null = null
  let renderer: ReturnType<typeof createRenderer> | null = null
  // Déclaré AVANT `renderer.start()` : son premier tick appelle `onTick`,
  // et si un échec est déjà présent, le callback lit `startedAt`. Le laisser
  // plus bas le mettrait dans sa zone morte temporelle (planté au 1er tick
  // qui pose une tombe, ce qui n'arrive qu'à FAIL_RATE élevé).
  const startedAt = Date.now()
  /**
   * Délais « échec → tombe ». On garde l'instant de la mesure : le rasage
   * et la construction du décor coûtent ~150 commandes, soit près de 4 s de
   * throttle au démarrage, pendant lesquelles un échec attend son tour. Ce
   * n'est pas le régime de croisière, et mélanger les deux mentirait.
   */
  const graveDelays: GraveDelay[] = []

  /**
   * Pour chaque échec : quand il a raté (`failedAt`, horloge de la base) et
   * quand l'ADAPTER l'a vu (horloge locale). Renseigné par l'événement
   * `job_failed` — qui porte déjà `failedAt` —, ce qui permet à `onTick` de
   * calculer le délai SANS relire la base : une seconde lecture async y
   * serait retardée par les à-coups de PGlite et gonflerait la part « rendu »
   * d'un temps qui n'a rien à voir avec le rendu.
   */
  interface FailureClock {
    failedAt: number | null
    seenAt: number
  }
  const failureClock = new Map<string, FailureClock>()
  adapter.onEvent((event) => {
    if (event.type !== 'job_failed') return
    failureClock.set(event.jobId, { failedAt: event.at?.getTime() ?? null, seenAt: Date.now() })
    // La carte ne sert qu'à apparier les ticks suivants : elle reste bornée.
    if (failureClock.size > 4 * layout.MAX_GRAVES) {
      const oldest = failureClock.keys().next().value
      if (oldest !== undefined) failureClock.delete(oldest)
    }
  })
  if (RENDER) {
    sink = new RconSink({
      host: process.env.RCON_HOST ?? '127.0.0.1',
      port: Number(process.env.RCON_PORT ?? 25575),
      // Le mot de passe du serveur jetable ne sert de défaut QUE dans les
      // fichiers de démo (CLAUDE.md, règle de sécurité n°6).
      password: process.env.RCON_PASSWORD ?? 'queuecraft-spike',
      maxCommandsPerSecond: BUDGET,
      onRejected: (command, reply) => log.push(`RCON refuse « ${command.slice(0, 40)} » : ${reply}`),
      // Cycle de vie de la connexion : coupures, tentatives, reconnexions.
      // C'est ce journal que le script de torture relit pour prouver que le
      // daemon survit et se resynchronise à chaque redémarrage du serveur.
      onLog: (line) => log.push(`RCON : ${line}`),
    })
    await sink.connect()
    // Un serveur qui redémarre a pu perdre le monde : le renderer le redessine
    // seul (il s'abonne dans start()). On double d'un log lisible pour l'humain.
    sink.onReconnect(() => log.push('monde : RCON de retour → resync complet'))
    renderer = createRenderer({
      sink,
      source: () => adapter.snapshot(),
      // Le cimetière : la seule chose rendue job par job (ADR D7). Le
      // renderer re-plafonne à 50 quoi qu'on lui donne.
      failures: () => adapter.recentFailures(layout.MAX_GRAVES),
      tickMs: 500,
      freezeScene: true,
      // Délai « le job échoue » → « la tombe est dans le monde ». On part de
      // `failedAt` (l'horloge de la base) et on s'arrête MAINTENANT, à la fin
      // du tick qui a posé la pierre : borne haute, throttle RCON compris.
      // Tout est synchrone — pas de relecture de base qui parasiterait la
      // mesure (voir `failureClock`).
      onTick: (info) => {
        if (info.gravesDrawn.length === 0) return
        const at = Date.now()
        for (const jobId of info.gravesDrawn) {
          const clock = failureClock.get(jobId)
          failureClock.delete(jobId)
          if (!clock || clock.failedAt == null) continue
          graveDelays.push({
            atMs: at - startedAt,
            delayMs: at - clock.failedAt,
            observeMs: clock.seenAt - clock.failedAt,
            tickCommands: info.commands,
            tickMs: info.durationMs,
            tickGraves: info.gravesDrawn.length,
          })
        }
      },
      onError: (error) => log.push(`rendu : ${error.message}`),
    })
    await renderer.start()
  }

  // --- Le tableau de bord.
  const dashboard = new Dashboard()
  /**
   * Retard de la boucle d'événements. PGlite est un Postgres compilé en
   * WASM qui tourne DANS ce process : une requête lourde bloque tout, y
   * compris le tick du renderer et les E/S RCON. Sans cette mesure, on
   * mettrait ces à-coups sur le dos du cimetière.
   */
  const loopDelay = monitorEventLoopDelay({ resolution: 10 })
  loopDelay.enable()
  /** Une mesure par rafraîchissement — bornée, donc elle-même sans fuite. */
  const rssSamples: { at: number; rss: number }[] = []
  let rssPeak = process.memoryUsage.rss()

  const paint = async (): Promise<void> => {
    const memory = process.memoryUsage()
    rssPeak = Math.max(rssPeak, memory.rss)
    rssSamples.push({ at: Date.now(), rss: memory.rss })
    if (rssSamples.length > 7_200) rssSamples.shift()
    const frame: Frame = {
      elapsedMs: Date.now() - startedAt,
      backend: pglite ? 'PGlite in-process' : 'Postgres (DATABASE_URL)',
      seed: config.seed,
      failRate: config.failRate,
      snapshots: await adapter.snapshot(),
      traffic: traffic.stats(),
      failures: await adapter.recentFailures(3),
      render: sink
        ? `monde : ${sink.total} commandes · ${sink.rate(5_000).toFixed(1)} cmd/s ` +
          `(budget ${BUDGET}) · pic 1 s ${sink.peakRate(startedAt)} · refusées ${sink.rejectedCount} · ` +
          `${renderer?.graveCount ?? 0}/${layout.MAX_GRAVES} tombes`
        : null,
      log: log.items,
      memory: { rss: memory.rss, heapUsed: memory.heapUsed, rssPeak },
    }
    dashboard.render(frame)
  }

  const timer = setInterval(() => void paint(), REFRESH_MS)
  await paint()

  // --- Sortie propre : Ctrl-C, arrêt programmé, ou plantage.
  let stopping = false
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return
    stopping = true
    clearInterval(timer)
    dashboard.close()
    console.log(`\nArrêt (${reason}) — on rend la main proprement.`)

    await traffic.stop()
    if (renderer && sink) {
      // La vérification finale interroge le monde : impossible si le serveur
      // est justement hors ligne au moment de l'arrêt. On la saute alors —
      // on ferme quand même la session proprement (stoppe le superviseur).
      if (sink.connected) {
        // Production et workers arrêtés : la queue se fige. Le temps que le
        // moniteur pg-boss (période 1 s) publie ce dernier état, puis un
        // ultime tick — le monde et l'adapter parlent alors du même instant,
        // sinon la vérification comparerait deux photos différentes.
        await sleep(1_500)
        await renderer.tick()
        renderer.stop()
        await checkWorld(sink, adapter)
        if (!KEEP) await sink.sendAll(teardownCommands(PROFILES.map((_, index) => index)))
      } else {
        renderer.stop()
        console.log('  (serveur hors ligne à l’arrêt — vérification du monde sautée)')
      }
      await sink.close()
    }
    await adapter.stop()
    await boss.stop({ graceful: false })
    await pglite?.close()

    loopDelay.disable()
    summary(traffic, startedAt, rssSamples, rssPeak, config.seed, graveDelays, loopDelay)
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      // Un second Ctrl-C pendant l'arrêt : on ne discute plus.
      if (stopping) process.exit(1)
      void shutdown(signal)
    })
  }
  if (config.durationSeconds > 0) {
    setTimeout(() => void shutdown(`${config.durationSeconds} s écoulées`), config.durationSeconds * 1_000)
  }
}

/**
 * Les compteurs de `getQueues()` sont rafraîchis par le moniteur pg-boss :
 * à 2 Hz de rendu, il doit tourner à la seconde, sinon le monde affiche
 * l'état d'il y a une minute.
 */
const MONITORING = {
  supervise: true,
  monitorIntervalSeconds: 1,
  superviseIntervalSeconds: 1,
} as const

/**
 * Journal borné : un tableau qui ne grandit pas est un tableau qui ne fuit pas.
 * Hors terminal (sortie redirigée, CI), le tableau de bord ne l'affiche pas —
 * on double donc chaque ligne sur la sortie standard, sinon un incident
 * passerait inaperçu.
 */
class Ring {
  readonly #items: string[] = []
  readonly #echo: boolean
  constructor(
    private readonly max: number,
    echo: boolean,
  ) {
    this.#echo = echo
  }
  push(line: string): void {
    const stamped = `${new Date().toLocaleTimeString('fr-FR')} ${line}`
    this.#items.push(stamped)
    while (this.#items.length > this.max) this.#items.shift()
    if (this.#echo) console.log(`  ! ${stamped}`)
  }
  get items(): readonly string[] {
    return this.#items
  }
}

/**
 * Le monde dit-il la vérité sur la queue ? On relit la position de chaque
 * emplacement de cart : garé au dépôt (sous la terre) ou posé sur la voie.
 * C'est la seule vérification qui ne se fie pas au miroir du renderer —
 * elle interroge le serveur.
 */
async function checkWorld(sink: RconSink, adapter: PgBossAdapter): Promise<void> {
  const snapshots = await adapter.snapshot()
  console.log('\nVérification dans le monde (carts réellement posés sur la voie)')
  for (const [station, snapshot] of snapshots.entries()) {
    let placed = 0
    for (let slot = 0; slot < layout.MAX_CARTS; slot++) {
      const reply = await sink.send(inspect.cartAtSlot(station, slot))
      const z = Number(/(-?\d+(?:\.\d+)?)d?\s*$/.exec(reply.trim())?.[1] ?? NaN)
      if (Math.abs(z - inspect.expectedCartZ(station, slot)) < 0.51) placed++
    }
    const expected = cartsForBacklog(snapshot.counts.waiting)
    console.log(
      `  ${snapshot.name.padEnd(10)} ${placed} carts (attendu ${expected}) ` +
        `pour ${snapshot.counts.waiting} jobs en attente ${placed === expected ? '·  OK' : '·  ÉCART'}`,
    )
  }

  // Le cimetière. On ne fait pas confiance au miroir : on interroge CHAQUE
  // emplacement de CHAQUE gare, y compris ceux qu'on croit vides. C'est la
  // seule façon de prouver le plafond global de l'ADR D7 — une tombe oubliée
  // par le diff se verrait ici, et nulle part ailleurs.
  const failures = await adapter.recentFailures(layout.MAX_GRAVES)
  console.log('\nVérification dans le monde (tombes réellement posées)')
  let total = 0
  for (const [station, snapshot] of snapshots.entries()) {
    let standing = 0
    for (let slot = 0; slot < layout.GRAVE_SLOTS; slot++) {
      const reply = await sink.send(inspect.gravePresent(station, slot))
      if (/passed/i.test(reply)) standing++
    }
    total += standing
    const expected = failures.filter((failure) => failure.queue === snapshot.name).length
    console.log(
      `  ${snapshot.name.padEnd(10)} ${String(standing).padStart(2)} tombes (attendu ${expected}) ` +
        `${standing === expected ? '·  OK' : '·  ÉCART'}`,
    )
  }
  console.log(
    `  ${'total'.padEnd(10)} ${String(total).padStart(2)} tombes / plafond ${layout.MAX_GRAVES} ` +
      `${total <= layout.MAX_GRAVES ? '·  OK' : '·  PLAFOND DÉPASSÉ'}`,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Le verdict de fin. La dérive mémoire est mesurée sur la SECONDE MOITIÉ du
 * run : PGlite réserve son arène WASM au démarrage puis la rend, donc les
 * premières dizaines de secondes montrent une pente forte qui n'est pas une
 * fuite. Ce qu'on veut savoir, c'est si le régime de croisière monte.
 */
function summary(
  traffic: TrafficGenerator,
  startedAt: number,
  rssSamples: readonly { at: number; rss: number }[],
  rssPeak: number,
  seed: number,
  graveDelays: readonly GraveDelay[],
  loopDelay: ReturnType<typeof monitorEventLoopDelay>,
): void {
  const minutes = (Date.now() - startedAt) / 60_000
  const stats = traffic.stats()
  const inserted = stats.reduce((sum, queue) => sum + queue.inserted, 0)
  const settled = stats.reduce((sum, queue) => sum + queue.settled, 0)
  const failed = stats.reduce((sum, queue) => sum + queue.failed, 0)
  const rss = process.memoryUsage.rss()
  const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(0)} Mo`

  console.log(`\nRun de ${minutes.toFixed(1)} min · seed ${seed} (SEED=${seed} pour le rejouer)`)
  for (const queue of stats) {
    console.log(
      `  ${queue.name.padEnd(10)} ${String(queue.inserted).padStart(6)} insérés · ` +
        `${String(queue.settled).padStart(6)} réglés · ${String(queue.failed).padStart(5)} ratés ` +
        `(${((queue.failed / Math.max(1, queue.settled)) * 100).toFixed(1)} %)`,
    )
  }
  console.log(
    `  ${'total'.padEnd(10)} ${String(inserted).padStart(6)} insérés · ${String(settled).padStart(6)} réglés · ` +
      `${String(failed).padStart(5)} ratés (${((failed / Math.max(1, settled)) * 100).toFixed(1)} %)`,
  )
  const half = rssSamples.slice(Math.floor(rssSamples.length / 2))
  const first = half[0]
  const last = half[half.length - 1]
  const span = first && last ? (last.at - first.at) / 60_000 : 0
  const drift = first && last && span > 0 ? (last.rss - first.rss) / (1024 * 1024) / span : 0

  console.log(
    `\nMémoire : rss ${mb(rss)} à l'arrêt, pic ${mb(rssPeak)} · ` +
      `dérive ${drift >= 0 ? '+' : ''}${drift.toFixed(1)} Mo/min sur la seconde moitié du run` +
      `${Math.abs(drift) < 5 ? ' — plat' : ' — À REGARDER'}`,
  )

  // Le contrat du cimetière : une tombe est dans le monde moins de 2 s après
  // l'échec. On publie le PIRE délai, pas la moyenne — c'est le seul chiffre
  // qui dise quelque chose sur une rafale.
  if (graveDelays.length > 0) {
    const line = (label: string, sample: readonly { delayMs: number }[]): string => {
      const sorted = sample.map((s) => s.delayMs).sort((a, b) => a - b)
      const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
      const worst = sorted[sorted.length - 1] ?? 0
      return (
        `  ${label.padEnd(22)} ${String(sorted.length).padStart(4)} tombes · ` +
        `médian ${(at(0.5) / 1_000).toFixed(2)} s · p95 ${(at(0.95) / 1_000).toFixed(2)} s · ` +
        `pire ${(worst / 1_000).toFixed(2)} s ${worst < 2_000 ? '·  OK' : '·  AU-DESSUS DES 2 s'}`
      )
    }
    const steady = graveDelays.filter((d) => d.atMs >= BOOTSTRAP_WINDOW_MS)
    console.log('\nCimetière : délai « échec → tombe »')
    console.log(line('régime de croisière', steady.length > 0 ? steady : graveDelays))
    console.log(line('démarrage compris', graveDelays))

    // Où passe le temps : à voir l'échec, ou à le dessiner ?
    const observed = graveDelays.filter((d) => d.observeMs !== null)
    if (observed.length > 0) {
      console.log(
        line(
          '  dont observation',
          observed.map((d) => ({ delayMs: d.observeMs as number })),
        ),
      )
      console.log(
        line(
          '  dont rendu',
          observed.map((d) => ({ delayMs: d.delayMs - (d.observeMs as number) })),
        ),
      )
    }

    // Les pires échantillons, décomposés : c'est là que se lit la cause.
    const slowest = [...graveDelays].sort((a, b) => b.delayMs - a.delayMs).slice(0, 5)
    console.log('  les 5 pires, décomposés')
    for (const sample of slowest) {
      console.log(
        `    t+${(sample.atMs / 1_000).toFixed(0).padStart(3)}s  ${(sample.delayMs / 1_000).toFixed(2)} s ` +
          `= observation ${((sample.observeMs ?? 0) / 1_000).toFixed(2)} s ` +
          `+ rendu ${((sample.delayMs - (sample.observeMs ?? 0)) / 1_000).toFixed(2)} s` +
          `   (son tick : ${sample.tickGraves} tombes, ${sample.tickCommands} commandes, ${sample.tickMs} ms)`,
      )
    }
  }

  console.log(
    `\nBoucle d'événements bloquée : médiane ${(loopDelay.percentile(50) / 1e6).toFixed(0)} ms · ` +
      `p99 ${(loopDelay.percentile(99) / 1e6).toFixed(0)} ms · pire ${(loopDelay.max / 1e6).toFixed(0)} ms\n` +
      `  PGlite est un Postgres WASM mono-thread DANS ce process : quand il calcule, plus rien\n` +
      `  ne tourne — ni le tick du renderer, ni les E/S RCON. C'est le plafond de latence de la\n` +
      `  démo, pas celui du cimetière.\n`,
  )
}

main().catch((error) => {
  console.error('\nÉchec de la démo :', (error as Error)?.message ?? error)
  if (RENDER) {
    console.error('Serveur Minecraft démarré ?  →  cd spikes/rcon-benchmark && docker compose up -d')
  }
  process.exit(1)
})

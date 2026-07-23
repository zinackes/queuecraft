/**
 * TORTURE DE RÉSILIENCE RCON — sans serveur, déterministe.
 * ========================================================
 * Prouve la dette levée par ADR-002 : un daemon 24/7 survit aux coupures et
 * resynchronise le monde tout seul. On coupe/relance un FAUX serveur 10 fois
 * d'affilée pendant que le renderer tourne sous trafic, et on vérifie :
 *
 *   1. 0 crash Node — la connexion factice émet un `error` EPIPE sur un VRAI
 *      EventEmitter à chaque mort : sans le listener obligatoire (ADR-002),
 *      Node lèverait « Unhandled error » et ce script planterait. Qu'il aille
 *      au bout EST la preuve que le listener est là.
 *   2. Pendant la coupure, la boucle continue de calculer diffs SANS émettre :
 *      `sink.total` ne bouge pas d'une commande tant que le serveur est absent.
 *   3. À chaque retour, resync complet automatique : le monde est razé
 *      (`kill @e[tag=qc]`) puis les 3 gares redessinées, sans relire le serveur.
 *
 * Le vrai serveur Minecraft est torturé par `spikes/rcon-benchmark/torture.sh`
 * (Docker). Ce script-ci est le pendant rapide et déterministe, exécutable en
 * CI sans conteneur :  pnpm --filter @queuecraft/renderer torture
 */
import { EventEmitter } from 'node:events'
import type { FailedJobDetail, QueueSnapshot } from '@queuecraft/core'
import { createRenderer } from './renderer.js'
import type { RconConnection, RconConnector } from './rcon-session.js'
import { RconSink } from './rcon-sink.js'

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  OK    │ ${label}`)
  } else {
    failures++
    console.log(`  ÉCHEC │ ${label}${detail ? `\n        │   ${detail}` : ''}`)
  }
}

/**
 * Un faux serveur RCON qu'on peut tuer et relancer à volonté. Il compte ce
 * qui prouve le resync : les rasages globaux (`kill @e[tag=qc]`) et les gares
 * reconstruites (un `text_display` de titre par gare).
 *
 * Il reproduit AUSSI le piège qui a fait crasher la première version du daemon
 * contre le vrai serveur : un Paper qui redémarre ouvre son port RCON avant
 * d'être prêt, accepte le socket, puis le RESET en plein handshake. D'où
 * `pendingResets` : la première tentative après chaque `revive()` se connecte
 * puis émet un ECONNRESET *asynchrone*. Le listener DOIT donc être posé avant
 * le connect — sinon ce script planterait ici, exactement comme le daemon.
 */
class FakeServer {
  private up = true
  private live: FakeConnection | null = null
  private pendingResets = 0
  razes = 0
  titles = 0
  commands = 0

  readonly connector: RconConnector = async (opts) => {
    if (!this.up) throw new Error('ECONNREFUSED — serveur éteint')
    const conn = new FakeConnection(this)
    // Le contrat : le connecteur pose les listeners AVANT de « connecter ».
    conn.wire(opts.onError, opts.onEnd)
    if (this.pendingResets > 0) {
      this.pendingResets--
      conn.resetDuringHandshake() // émet 'error' sur un VRAI EventEmitter
      throw new Error('ECONNRESET — handshake interrompu (serveur pas prêt)')
    }
    this.live = conn
    return conn
  }

  /** Le serveur est tué : la connexion vivante émet EPIPE + close, comme le vrai. */
  kill(): void {
    this.up = false
    this.live?.die()
    this.live = null
  }

  /**
   * Le serveur revient — mais pas d'un coup : la première tentative de
   * connexion tombera sur un reset de handshake (port ouvert, serveur pas prêt).
   */
  revive(): void {
    this.up = true
    this.pendingResets = 1
  }

  handle(command: string): string {
    this.commands++
    if (command === 'kill @e[tag=qc]') this.razes++
    if (/^summon minecraft:text_display .*qc-s\d+-title/.test(command)) this.titles++
    // Aucune réponse ne doit ressembler à un refus de syntaxe (REJECTION).
    return 'ok'
  }
}

/**
 * Une connexion factice. Les listeners `error`/`end` passent par un VRAI
 * EventEmitter : c'est ce qui fait de ce test un garde-fou du listener
 * obligatoire — un `emit('error')` sans écouteur tuerait le process, que
 * l'erreur survienne en pleine vie (`die`) ou en plein handshake
 * (`resetDuringHandshake`).
 */
class FakeConnection implements RconConnection {
  private dead = false
  private readonly emitter = new EventEmitter()

  constructor(private readonly server: FakeServer) {}

  /** Posé par le connecteur AVANT le connect — le cœur du fix. */
  wire(onError: (error: unknown) => void, onEnd: () => void): void {
    this.emitter.on('error', (error) => onError(error))
    this.emitter.on('end', () => onEnd())
  }

  async send(command: string): Promise<string> {
    if (this.dead) throw new Error('EPIPE — write after end')
    return this.server.handle(command)
  }

  async end(): Promise<void> {
    this.dead = true
  }

  /** Mort brutale : EPIPE asynchrone (le tueur de process de l'ADR) puis close. */
  die(): void {
    this.dead = true
    this.emitter.emit('error', new Error('EPIPE — connexion coupée par le serveur'))
    this.emitter.emit('end')
  }

  /** Reset pendant le handshake : le socket s'est connecté, puis le serveur coupe. */
  resetDuringHandshake(): void {
    this.dead = true
    this.emitter.emit('error', new Error('ECONNRESET — reset en plein handshake'))
  }
}

// --- Le trafic : 3 gares qui respirent + quelques échecs pour peupler le cimetière.
const QUEUES = ['scraping', 'emails', 'reports'] as const
function snapshots(tick: number): QueueSnapshot[] {
  return QUEUES.map((name, station) => ({
    name,
    // Un backlog qui bouge d'un tick à l'autre : la boucle a toujours du diff
    // à calculer, y compris hors ligne (où il ne partira simplement pas).
    counts: {
      waiting: 40 + station * 100 + (tick % 7) * 13,
      active: 2 + (tick % 3),
      completed: 500 + tick * 10,
      failed: 3 + station,
      delayed: 0,
    },
    workers: 4,
    throughputPerMin: 120,
    capturedAt: new Date(1_700_000_000_000 + tick * 500),
  }))
}
function recentFailures(tick: number): FailedJobDetail[] {
  return Array.from({ length: 4 }, (_, i) => ({
    queue: QUEUES[i % QUEUES.length] as string,
    jobId: `job-${i}-${tick}-0123456789abcdef`,
    error: `HTTP 503 — upstream indisponible (${i})`,
    failedAt: new Date(1_700_000_000_000 + tick * 500 - i * 1_000),
  }))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(5)
  }
  return predicate()
}

async function main(): Promise<void> {
  console.log('\nTorture de résilience RCON (faux serveur, 10 coupures)')
  console.log('──────────────────────────────────────────────────────')

  const server = new FakeServer()
  const rendererErrors: Error[] = []

  const sink = new RconSink({
    host: 'fake',
    port: 0,
    password: 'x',
    // Large : on ne veut pas que le throttle ralentisse la torture elle-même.
    maxCommandsPerSecond: 10_000,
    timeoutMs: 200,
    // Backoff accéléré : l'ADR impose 1 s → 30 s en prod ; ici 15 ms → 60 ms
    // pour que 10 cycles tiennent en une poignée de secondes. La LOGIQUE de
    // reconnexion est la même, seuls les délais changent.
    transport: { connector: server.connector, baseBackoffMs: 15, maxBackoffMs: 60 },
  })

  await sink.connect()
  check('connexion initiale établie', sink.connected)

  let tickN = 0
  const renderer = createRenderer({
    sink,
    source: () => snapshots(tickN++),
    failures: () => recentFailures(tickN),
    tickMs: 3_600_000, // on pilote les ticks à la main : le timer ne doit pas s'en mêler
    freezeScene: true,
    onError: (error) => rendererErrors.push(error),
  })

  await renderer.start()
  renderer.stop() // start() a posé un timer ; on le coupe pour tout piloter à la main
  check(
    'bootstrap initial : monde razé + 3 gares construites',
    server.razes === 1 && server.titles === 3,
    `razes=${server.razes} titles=${server.titles}`,
  )

  for (let cycle = 1; cycle <= 10; cycle++) {
    const totalBeforeOutage = sink.total
    const razesBeforeCycle = server.razes
    const titlesBeforeCycle = server.titles

    // ---- Le serveur meurt (EPIPE async + close). Doit être absorbé.
    server.kill()
    check(`cycle ${cycle} · coupure détectée, session hors ligne`, !sink.connected)

    // ---- La boucle tourne SOUS trafic pendant la coupure : calcule, n'émet pas.
    let emittedWhileDown = 0
    for (let t = 0; t < 3; t++) {
      const info = await renderer.tick()
      emittedWhileDown += info.commands
    }
    check(
      `cycle ${cycle} · 0 commande émise pendant la coupure (boucle vivante)`,
      sink.total === totalBeforeOutage && emittedWhileDown === 0,
      `total ${totalBeforeOutage} → ${sink.total}, commandes ${emittedWhileDown}`,
    )

    // ---- Le serveur revient : reconnexion automatique (backoff), sans nous.
    server.revive()
    const back = await waitUntil(() => sink.connected, 3_000)
    check(`cycle ${cycle} · reconnexion automatique`, back)

    // ---- Premier tick en ligne = resync complet, sans relire le serveur.
    const info = await renderer.tick()
    check(
      `cycle ${cycle} · resync complet (monde razé + redessiné)`,
      server.razes === razesBeforeCycle + 1 &&
        server.titles === titlesBeforeCycle + 3 &&
        info.commands > 0,
      `razes +${server.razes - razesBeforeCycle}, titres +${server.titles - titlesBeforeCycle}, ` +
        `${info.commands} commandes`,
    )
  }

  // ---- Un tick de croisière après tout ça : le régime normal a bien repris.
  const cruise = await renderer.tick()
  check('après 10 cycles, régime de croisière normal (diff incrémental)', cruise.tick > 0)

  check('aucune erreur de rendu propagée (RconOfflineError absorbée)', rendererErrors.length === 0,
    rendererErrors.map((e) => e.message).join(' | '))
  check('0 commande refusée par le serveur', sink.rejectedCount === 0, `${sink.rejectedCount} refus`)

  await sink.close()
  check('fermeture propre (superviseur arrêté)', !sink.connected)

  console.log('──────────────────────────────────────────────────────')
  console.log(
    `Bilan : ${server.commands} commandes servies · ${server.razes} rasages · ` +
      `${server.titles} gares construites · ${sink.total} envois comptés\n`,
  )
  if (failures === 0) {
    console.log('VERDICT : OK — 0 crash, 0 émission hors ligne, resync à chaque retour.\n')
  } else {
    console.log(`VERDICT : ÉCHEC — ${failures} contrôle(s) en échec.\n`)
  }
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('\nLa torture elle-même a planté :', (error as Error)?.stack ?? error)
  process.exit(1)
})

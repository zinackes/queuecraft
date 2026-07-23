/**
 * LA SESSION RCON — une connexion qui survit à son serveur.
 * =========================================================
 * `RconSink` sait envoyer une commande ; il ne sait pas quoi faire quand le
 * serveur disparaît. C'est le travail de cette session, et c'est le seul
 * endroit du daemon qui touche au socket vivant.
 *
 * Trois faits mesurés (ADR-002) sont câblés ici, et il ne faut pas les défaire :
 *
 *   1. `maxPending: 1`. Le serveur FERME la connexion dès 2 commandes en vol
 *      sur 1.21.11 (3 sur 26.2). Une session = une commande à la fois.
 *   2. Un listener `error` est OBLIGATOIRE, et posé AVANT le `connect()`. Un
 *      serveur qui redémarre ouvre son port RCON avant d'être prêt : le socket
 *      se connecte, puis le serveur le RESET en plein handshake d'auth — un
 *      `error` asynchrone qu'aucun try/catch n'attrape. Posé après connect (via
 *      le `Rcon.connect()` statique), il arrive trop tard et Node meurt. Posé
 *      avant (via `new Rcon()` puis `.on()` puis `.connect()`), il l'absorbe.
 *   3. Une commande qui ne revient pas au bout de `commandTimeoutMs` déclare la
 *      connexion morte (moitié-ouverte : serveur tué sans FIN TCP). C'est la
 *      détection de connexion morte par timeout.
 *
 * Cycle de vie :
 *
 *      connect()  ──succès──▶ connected ──erreur/end/timeout──▶ disconnected
 *          │                      ▲                                  │
 *       échec initial             └────── open() du superviseur ◀────┘
 *      (throw, fail-fast)               (backoff exponentiel + jitter, ∞)
 *
 * À chaque retour en ligne, les écouteurs `onReconnect` sont appelés : c'est
 * eux qui déclenchent le resync complet du monde (le renderer s'y abonne).
 */
import { Rcon } from 'rcon-client'

/**
 * Le minimum qu'une session attend d'une connexion vivante : envoyer et
 * fermer. Les listeners d'erreur/fermeture sont posés par le CONNECTEUR, avant
 * même que la connexion existe — d'où leur absence ici.
 */
export interface RconConnection {
  send(command: string): Promise<string>
  end(): Promise<void>
}

/**
 * Ouvre une connexion (déjà authentifiée, listeners déjà posés) ou rejette.
 * Reçoit `onError`/`onEnd` : le connecteur DOIT les attacher AVANT de se
 * connecter (voir la leçon n°2 en tête de fichier). Injectable pour les tests.
 */
export type RconConnector = (opts: {
  host: string
  port: number
  password: string
  timeout: number
  onError: (error: unknown) => void
  onEnd: () => void
}) => Promise<RconConnection>

export interface RconSessionOptions {
  host: string
  port: number
  /** Jamais de défaut ici : le mot de passe vient de l'appelant (règle sécurité n°6). */
  password: string
  /**
   * Délai au-delà duquel une commande sans réponse déclare la connexion morte.
   * C'est aussi le timeout du paquet d'auth. 5 s : très au-dessus des ~150 ms
   * mesurés par commande sous charge (ADR-002), très en-dessous d'un blocage.
   */
  commandTimeoutMs?: number
  /** Premier délai de reconnexion. Double à chaque échec (1 s → 2 s → 4 s…). */
  baseBackoffMs?: number
  /** Plafond du backoff (ADR : 30 s). */
  maxBackoffMs?: number
  /** Amplitude du jitter, en fraction du délai (±). 0,2 = ±20 %. */
  jitterRatio?: number
  /** Le connecteur réel par défaut ; un faux en test. */
  connector?: RconConnector
  /** Journal du cycle de vie (tentatives, reconnexions). Sans effet si absent. */
  onLog?: (line: string) => void
  /** Appelé à chaque bascule connecté/déconnecté. */
  onStateChange?: (connected: boolean) => void
}

/**
 * Levée par `send()` quand la session est hors ligne (ou vient de le devenir).
 * Typée pour que l'appelant la distingue d'un vrai bug : le renderer l'absorbe
 * en silence (une coupure n'est pas une erreur de rendu), là où toute autre
 * exception remonte.
 */
export class RconOfflineError extends Error {
  constructor(message = 'RCON hors ligne', options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RconOfflineError'
  }
}

type State = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'closed'

/**
 * Connecteur réel. `new Rcon()` puis `.on('error')` AVANT `.connect()` : c'est
 * la seule façon d'attraper un reset survenu pendant le handshake (leçon n°2).
 * `maxPending: 1` vit ici aussi (leçon n°1).
 */
const defaultConnector: RconConnector = async (opts) => {
  const rcon = new Rcon({
    host: opts.host,
    port: opts.port,
    password: opts.password,
    maxPending: 1, // ADR-002 §3 — ne jamais augmenter.
    timeout: opts.timeout,
  })
  // `rcon-client` cale `maxListeners` sur `maxPending` (= 1). Nos deux listeners
  // persistants (`error` + `end`) plus le listener `end` transitoire que la lib
  // ajoute le temps d'un `send` franchissent cette limite et déclenchent un
  // `MaxListenersExceededWarning` — bénin (aucune fuite : chaque reconnexion
  // crée un nouvel `Rcon`, l'ancien est GC), mais on relève le plafond pour ne
  // pas noyer le journal du daemon sous l'avertissement.
  rcon.emitter.setMaxListeners(16)
  rcon.on('error', (error) => opts.onError(error))
  rcon.on('end', () => opts.onEnd())
  await rcon.connect()
  // On adapte plutôt que d'exposer `Rcon` tel quel : la session ne connaît que
  // `RconConnection`, jamais l'API complète de la lib.
  return {
    send: (command) => rcon.send(command),
    end: () => rcon.end(),
  }
}

export class RconSession {
  private conn: RconConnection | null = null
  private state: State = 'idle'
  /** Vrai tant qu'une boucle de reconnexion tourne (jamais deux en parallèle). */
  private supervising = false
  private readonly reconnectListeners: Array<() => void> = []
  private readonly connector: RconConnector
  private readonly commandTimeoutMs: number
  private readonly baseBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly jitterRatio: number

  constructor(private readonly options: RconSessionOptions) {
    this.connector = options.connector ?? defaultConnector
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5_000
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000
    this.jitterRatio = options.jitterRatio ?? 0.2
  }

  /** Vrai seulement quand une commande peut réellement partir. */
  get connected(): boolean {
    return this.state === 'connected'
  }

  /**
   * Abonne un écouteur au retour en ligne. Appelé APRÈS que la connexion est
   * vivante, à chaque reconnexion — c'est le crochet du resync complet.
   */
  onReconnect(listener: () => void): void {
    this.reconnectListeners.push(listener)
  }

  /**
   * Connexion initiale, fail-fast : si le serveur est absent au démarrage, on
   * lève (l'appelant affiche « serveur démarré ? »). Le superviseur ne prend
   * le relais qu'après une PREMIÈRE connexion réussie qui tombe ensuite —
   * c'est le régime d'un daemon 24/7, pas d'un lancement à vide.
   */
  async connect(): Promise<void> {
    if (this.state === 'closed') throw new Error('RconSession : déjà fermée')
    this.state = 'connecting'
    try {
      await this.open()
    } catch (error) {
      this.state = 'disconnected'
      throw error
    }
    this.options.onStateChange?.(true)
  }

  /** Envoie une commande. Lève `RconOfflineError` si hors ligne (jamais bloquant). */
  async send(command: string): Promise<string> {
    const conn = this.conn
    if (this.state !== 'connected' || !conn) throw new RconOfflineError()
    try {
      return await conn.send(command)
    } catch (error) {
      // Réponse jamais arrivée (timeout de la lib), connexion fermée en cours
      // de vol, socket mort : dans tous les cas la connexion n'est plus fiable.
      this.markDisconnected('envoi échoué', error)
      throw new RconOfflineError('RCON : envoi échoué', { cause: error })
    }
  }

  /** Ferme définitivement : arrête le superviseur, ne reconnecte plus. */
  async close(): Promise<void> {
    this.state = 'closed'
    const conn = this.conn
    this.conn = null
    await conn?.end().catch(() => {})
  }

  /**
   * Ouvre une connexion. Les listeners `error`/`end` sont posés par le
   * connecteur AVANT le connect (leçon n°2) et pointent sur `markDisconnected`.
   */
  private async open(): Promise<void> {
    const conn = await this.connector({
      host: this.options.host,
      port: this.options.port,
      password: this.options.password,
      timeout: this.commandTimeoutMs,
      onError: (error) => this.markDisconnected('erreur socket', error),
      onEnd: () => this.markDisconnected('connexion fermée'),
    })
    this.conn = conn
    this.state = 'connected'
  }

  /**
   * Bascule en déconnecté et arme la reconnexion. N'agit que sur une connexion
   * VIVANTE (`connected`) : un `error` reçu pendant un `connect()` initial ou
   * une tentative du superviseur est ignoré ici — c'est la logique de connexion
   * qui le gère (throw / retry), pas une seconde boucle de reconnexion. Ne lève
   * jamais : appelé depuis des handlers d'événement synchrones.
   */
  private markDisconnected(reason: string, error?: unknown): void {
    if (this.state !== 'connected') return
    this.state = 'disconnected'
    const old = this.conn
    this.conn = null
    // Fermeture au mieux : rejet ignoré, mais la promesse EST catchée (aucune
    // promesse RCON non gérée — audit ADR-002).
    old?.end().catch(() => {})
    this.log(`déconnecté (${reason})${error ? ` : ${messageOf(error)}` : ''}`)
    this.options.onStateChange?.(false)
    this.startSupervisor()
  }

  private startSupervisor(): void {
    if (this.supervising) return
    this.supervising = true
    // La boucle ne rejette jamais (tout est catché dedans) ; le `.catch` final
    // n'est là que par principe — aucune promesse ne fuit.
    this.superviseLoop().catch((error) => this.log(`superviseur : ${messageOf(error)}`))
  }

  /** Reconnexion à backoff exponentiel + jitter, en boucle, jusqu'au retour. */
  private async superviseLoop(): Promise<void> {
    let attempt = 0
    while (this.state === 'disconnected') {
      const wait = this.backoff(attempt)
      this.log(`reconnexion dans ${(wait / 1_000).toFixed(1)} s (tentative ${attempt + 1})`)
      await sleep(wait)
      if (this.state !== 'disconnected') break // fermée pendant l'attente
      try {
        await this.open()
        this.log('reconnecté')
        this.options.onStateChange?.(true)
        attempt = 0
        // Le monde a pu disparaître (redémarrage serveur) : on redessine tout.
        for (const listener of this.reconnectListeners) {
          try {
            listener()
          } catch (error) {
            this.log(`crochet reconnexion : ${messageOf(error)}`)
          }
        }
      } catch (error) {
        attempt++
        this.log(`échec reconnexion : ${messageOf(error)}`)
      }
    }
    this.supervising = false
  }

  /**
   * `min(cap, base·2^n)` avec un jitter de ±`jitterRatio`, borné à `[base, cap]`.
   * Le clamp final est ce qui fait du plafond un VRAI plafond : sans lui, le
   * jitter ajouté au-dessus du cap pouvait pousser l'attente à ~36 s alors que
   * l'ADR fixe 30 s. Au plafond, le jitter ne fait donc que réduire (24–30 s).
   */
  private backoff(attempt: number): number {
    const capped = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** attempt)
    const jitter = capped * this.jitterRatio * (Math.random() * 2 - 1)
    const jittered = Math.round(capped + jitter)
    return Math.max(this.baseBackoffMs, Math.min(this.maxBackoffMs, jittered))
  }

  private log(line: string): void {
    this.options.onLog?.(line)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

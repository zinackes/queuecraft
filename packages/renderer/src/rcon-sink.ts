/**
 * LA SORTIE RCON — la seule frontière impure du renderer.
 * =======================================================
 * Deux couches, une responsabilité chacune :
 *
 *   • `RconSession` (rcon-session.ts) tient le socket vivant : `maxPending: 1`,
 *     le listener `error` obligatoire, et la reconnexion à backoff quand le
 *     serveur coupe. Le sink ne touche jamais au socket directement.
 *   • `RconSink` (ici) sérialise, throttle et mesure. Ses compteurs vivent au
 *     rythme du DAEMON, pas d'une connexion : ils survivent aux reconnexions.
 *
 * Deux leçons du spike (ADR-002) sont câblées dans cette couche-ci :
 *
 *   1. Une seule commande en vol : la chaîne de promesses `queue` garantit
 *      qu'aucun `send` ne parte avant que le précédent soit revenu.
 *   2. Le canal encaisse ~2 300 cmd/s ; on s'interdit d'en utiliser plus de 40
 *      (ADR-002 §2 : discipline choisie). Le token bucket rend cette limite
 *      structurelle — on ne peut pas la dépasser par accident.
 *
 * Quand la session est hors ligne, `send()` lève `RconOfflineError` sans
 * attendre : la commande ne part pas, ne compte pas dans le budget, et
 * n'occupe pas la connexion morte. Le renderer teste `connected` avant
 * d'émettre ; ce garde-fou n'existe que pour la coupure en plein tick.
 */
import {
  RconOfflineError,
  RconSession,
  type RconConnector,
  type RconSessionOptions,
} from './rcon-session.js'

export interface RconSinkOptions {
  host: string
  port: number
  /** Jamais de valeur par défaut ici : le mot de passe vient de l'appelant. */
  password: string
  /** Budget ADR D7. Ne pas monter sans nouvel ADR. */
  maxCommandsPerSecond?: number
  /** Timeout par commande = détection de connexion morte (défaut 5 s). */
  timeoutMs?: number
  /** Appelé quand le serveur répond « commande inconnue / invalide ». */
  onRejected?: (command: string, reply: string) => void
  /** Journal du cycle de vie de la connexion (tentatives, reconnexions). */
  onLog?: (line: string) => void
  /**
   * @internal Réglages de reconnexion + connecteur injectable. Réservé aux
   * tests de torture (faux serveur, backoff accéléré). En production, on n'y
   * touche pas : le connecteur réel et le backoff de l'ADR s'appliquent.
   */
  transport?: {
    connector?: RconConnector
    baseBackoffMs?: number
    maxBackoffMs?: number
    jitterRatio?: number
  }
}

/**
 * Une commande refusée ne lève pas d'exception : le serveur répond en texte.
 * On ne compte QUE les refus de syntaxe — « No entity was found » est une
 * réponse normale (un sélecteur qui ne matche rien, par exemple le
 * `kill @e[tag=qc]` du tout premier démarrage sur un monde vierge).
 */
const REJECTION = /^(unknown or incomplete|expected|invalid|incorrect argument|failed to)/i

export class RconSink {
  private readonly session: RconSession
  /** Chaîne de promesses : garantit un seul envoi en vol à la fois. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Horodatage des commandes envoyées (fenêtre glissante, pour les mesures). */
  private readonly sentAt: number[] = []
  private sent = 0
  private rejected = 0

  constructor(private readonly options: RconSinkOptions) {
    const sessionOptions: RconSessionOptions = {
      host: options.host,
      port: options.port,
      password: options.password,
      commandTimeoutMs: options.timeoutMs,
      onLog: options.onLog,
      connector: options.transport?.connector,
      baseBackoffMs: options.transport?.baseBackoffMs,
      maxBackoffMs: options.transport?.maxBackoffMs,
      jitterRatio: options.transport?.jitterRatio,
    }
    this.session = new RconSession(sessionOptions)
  }

  get limit(): number {
    return this.options.maxCommandsPerSecond ?? 40
  }

  /** Vrai quand une commande peut réellement partir. Faux pendant une coupure. */
  get connected(): boolean {
    return this.session.connected
  }

  /** Nombre total de commandes envoyées depuis le démarrage (traverse les reconnexions). */
  get total(): number {
    return this.sent
  }

  /** Nombre de commandes refusées par le serveur (doit rester à 0). */
  get rejectedCount(): number {
    return this.rejected
  }

  /**
   * Abonne un écouteur au retour en ligne. Le renderer s'en sert pour armer un
   * resync complet ; on peut en poser plusieurs (le daemon y ajoute un log).
   */
  onReconnect(listener: () => void): void {
    this.session.onReconnect(listener)
  }

  async connect(): Promise<void> {
    await this.session.connect()
  }

  async close(): Promise<void> {
    await this.session.close()
  }

  /** Envoie une commande : sérialisée, throttlée, mesurée. */
  send(command: string): Promise<string> {
    const run = this.queue.then(() => this.sendNow(command))
    // La file ne doit jamais mourir sur un échec : on isole le rejet.
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Envoie une séquence dans l'ordre. Le premier échec interrompt la suite. */
  async sendAll(commands: readonly string[]): Promise<void> {
    for (const command of commands) await this.send(command)
  }

  private async sendNow(command: string): Promise<string> {
    // Hors ligne : on ne consomme ni token ni connexion morte. Le renderer
    // teste `connected` avant, donc ce chemin ne sert qu'à la coupure en
    // plein tick — d'où l'échec immédiat plutôt que l'attente d'un token.
    if (!this.session.connected) throw new RconOfflineError()

    await this.waitForToken()
    const reply = await this.session.send(command)

    this.sent++
    this.sentAt.push(Date.now())
    this.trim()

    if (REJECTION.test(reply.trim())) {
      this.rejected++
      this.options.onRejected?.(command, reply.trim())
    }
    return reply
  }

  /**
   * Token bucket : bloque tant que la seconde écoulée contient déjà `limit`
   * commandes. C'est ce qui rend le budget ADR D7 impossible à dépasser, y
   * compris pendant une rafale de démarrage.
   */
  private async waitForToken(): Promise<void> {
    for (;;) {
      const now = Date.now()
      const windowStart = now - 1_000
      const inWindow = this.sentAt.filter((t) => t > windowStart)
      if (inWindow.length < this.limit) return
      const oldest = inWindow[0] ?? now
      await sleep(Math.max(1, oldest + 1_000 - now))
    }
  }

  private trim(): void {
    const cutoff = Date.now() - 120_000
    while (this.sentAt.length > 0 && (this.sentAt[0] ?? 0) < cutoff) this.sentAt.shift()
  }

  /** Débit moyen sur les `windowMs` dernières millisecondes. */
  rate(windowMs = 1_000): number {
    const since = Date.now() - windowMs
    const count = this.sentAt.filter((t) => t > since).length
    return count / (windowMs / 1_000)
  }

  /**
   * Pic de débit depuis `since` : le maximum de commandes observé dans une
   * fenêtre glissante d'une seconde. C'est LE chiffre à consigner — une
   * moyenne sur 30 s masquerait une rafale à 200 cmd/s.
   */
  peakRate(since: number): number {
    const stamps = this.sentAt.filter((t) => t >= since)
    let peak = 0
    for (let i = 0; i < stamps.length; i++) {
      const start = stamps[i] ?? 0
      let count = 0
      for (let j = i; j < stamps.length && (stamps[j] ?? 0) < start + 1_000; j++) count++
      if (count > peak) peak = count
    }
    return peak
  }

  /** Nombre de commandes envoyées depuis un instant donné. */
  countSince(since: number): number {
    return this.sentAt.filter((t) => t >= since).length
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

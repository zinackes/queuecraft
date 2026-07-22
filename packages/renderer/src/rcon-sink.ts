/**
 * LA SORTIE RCON — la seule frontière impure du renderer.
 * =======================================================
 * Trois leçons du spike (ADR-002) sont câblées ici, et il ne faut pas
 * les défaire :
 *
 *   1. `maxPending: 1`. Le serveur FERME la connexion dès 2 commandes en
 *      vol sur 1.21.11 (3 sur 26.2). Le pipelining n'est pas lent, il est
 *      cassé. Toute commande attend la réponse de la précédente.
 *   2. Un listener `error` est obligatoire : quand le serveur coupe,
 *      l'écriture suivante émet un EPIPE *asynchrone* qu'aucun try/catch
 *      ne rattrape, et qui tue le process Node.
 *   3. Le canal encaisse ~2 300 cmd/s ; on s'interdit d'en utiliser plus
 *      de 40 (ADR-002 §2 : discipline choisie, pas limite subie). Le
 *      token bucket ci-dessous rend cette limite structurelle plutôt que
 *      déclarative — on ne peut pas la dépasser par accident.
 */
import { Rcon } from 'rcon-client'

export interface RconSinkOptions {
  host: string
  port: number
  /** Jamais de valeur par défaut ici : le mot de passe vient de l'appelant. */
  password: string
  /** Budget ADR D7. Ne pas monter sans nouvel ADR. */
  maxCommandsPerSecond?: number
  timeoutMs?: number
  /** Appelé quand le serveur répond « commande inconnue / invalide ». */
  onRejected?: (command: string, reply: string) => void
}

/**
 * Une commande refusée ne lève pas d'exception : le serveur répond en
 * texte. On ne compte QUE les refus de syntaxe — « No entity was found »
 * est une réponse normale (un sélecteur qui ne matche rien, par exemple
 * le `kill @e[tag=qc]` du tout premier démarrage sur un monde vierge).
 */
const REJECTION = /^(unknown or incomplete|expected|invalid|incorrect argument|failed to)/i

export class RconSink {
  private rcon: Rcon | null = null
  /** Chaîne de promesses : garantit un seul envoi en vol à la fois. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Horodatage des commandes envoyées (fenêtre glissante, pour les mesures). */
  private readonly sentAt: number[] = []
  private sent = 0
  private rejected = 0

  constructor(private readonly options: RconSinkOptions) {}

  get limit(): number {
    return this.options.maxCommandsPerSecond ?? 40
  }

  /** Nombre total de commandes envoyées depuis la connexion. */
  get total(): number {
    return this.sent
  }

  /** Nombre de commandes refusées par le serveur (doit rester à 0). */
  get rejectedCount(): number {
    return this.rejected
  }

  async connect(): Promise<void> {
    const rcon = await Rcon.connect({
      host: this.options.host,
      port: this.options.port,
      password: this.options.password,
      maxPending: 1, // ADR-002 §3 — ne jamais augmenter.
      timeout: this.options.timeoutMs ?? 15_000,
    })
    rcon.on('error', () => {
      // Absorbé volontairement : la promesse du `send` en cours rejette
      // de toute façon, et c'est elle qui doit porter l'erreur.
    })
    this.rcon = rcon
  }

  async close(): Promise<void> {
    const rcon = this.rcon
    this.rcon = null
    await rcon?.end().catch(() => {})
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
    const rcon = this.rcon
    if (!rcon) throw new Error('RconSink: send() appelé sans connexion active')

    await this.waitForToken()
    const reply = await rcon.send(command)

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
   * Token bucket : bloque tant que la seconde écoulée contient déjà
   * `limit` commandes. C'est ce qui rend le budget ADR D7 impossible à
   * dépasser, y compris pendant une rafale de démarrage.
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
   * Pic de débit depuis `since` : le maximum de commandes observé dans
   * une fenêtre glissante d'une seconde. C'est LE chiffre à consigner —
   * une moyenne sur 30 s masquerait une rafale à 200 cmd/s.
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

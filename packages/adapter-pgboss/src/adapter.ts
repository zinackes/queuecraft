/**
 * L'ADAPTER pg-boss — première implémentation réelle du contrat.
 * ==============================================================
 * Traduit pg-boss v12 vers le modèle pivot, et rien d'autre. Trois choix
 * structurent ce fichier :
 *
 * 1. `snapshot()` ne parle JAMAIS à Postgres. Une boucle de fond rafraîchit
 *    un cache, `snapshot()` le rend tel quel — donc < 1 ms, quoi qu'il
 *    arrive au réseau. Si le rafraîchissement échoue, le cache n'est pas
 *    touché : le monde continue d'afficher le dernier état connu, avec son
 *    `capturedAt` d'origine (règle 3 de la skill).
 *
 * 2. On lit les compteurs via `getQueues()`, pas via une agrégation maison.
 *    pg-boss maintient déjà ces compteurs en cache sur sa table `queue` et
 *    les rafraîchit toutes les `monitorIntervalSeconds`. Un `getQueues()`
 *    est donc UNE lecture d'une poignée de lignes (~0,5 ms en local),
 *    quelle que soit la taille de la table des jobs.
 *
 *    ⚠️ Corollaire : la fraîcheur des compteurs est celle du moniteur
 *    pg-boss, pas celle de notre boucle. Pour un rendu à 2 Hz il faut une
 *    instance configurée avec `supervise: true` et un
 *    `monitorIntervalSeconds` bas (1 ou 2). C'est ce que fait l'adapter
 *    quand il possède l'instance.
 *
 * 3. Le débit est calculé ici, pas lu : pg-boss ne compte pas les jobs
 *    terminés. Voir `#throughput()`.
 *
 * Actions (retry/cancel) : pg-boss les fournit nativement
 * (`boss.retry()` / `boss.cancel()`), elles sont réservées à la phase 2 —
 * volontairement non câblées ici.
 */
import type {
  Adapter,
  FailedJobDetail,
  JobState,
  QueueEvent,
  QueueSnapshot,
} from '@queuecraft/core'
import { PgBoss } from 'pg-boss'
import type { QueueResult, WipData } from 'pg-boss'

/** Préfixe des queues internes de pg-boss (cron) : jamais affichées. */
const INTERNAL_PREFIX = '__pgboss__'

/** Longueur maximale d'un message d'erreur (règle 4 de la skill). */
const ERROR_MAX = 200

/** Plafond d'échecs remontés, quel que soit `limit` (ADR D7). */
const FAILURE_CAP = 50

/** Fenêtre glissante du calcul de débit. */
const THROUGHPUT_WINDOW_MS = 60_000

/** En dessous, l'échantillon est trop court pour un débit honnête. */
const THROUGHPUT_MIN_SPAN_MS = 5_000

export interface PgBossAdapterOptions {
  /**
   * Instance pg-boss déjà démarrée. Son cycle de vie reste à toi :
   * l'adapter se contente de lire. C'est le mode à utiliser quand le
   * daemon tourne DANS le processus qui héberge les workers — c'est le
   * seul cas où le nombre de workers est observable (voir `workers`).
   */
  boss?: PgBoss

  /**
   * ...ou une chaîne de connexion Postgres : l'adapter construit alors
   * l'instance, la démarre et l'arrête avec lui. Mode observateur pur —
   * aucun worker local, donc `workers` vaut `null`.
   */
  connectionString?: string

  /** Schéma pg-boss. Défaut : `pgboss`, comme pg-boss lui-même. */
  schema?: string

  /** Période de la boucle de fond. Défaut : 500 ms, comme le renderer. */
  refreshMs?: number

  /**
   * Fraîcheur des compteurs quand l'adapter possède l'instance.
   * Défaut : 1 s. Ignoré si `boss` est fourni.
   */
  monitorIntervalSeconds?: number

  /** Restreint l'affichage à ces queues. Défaut : toutes. */
  queues?: string[]

  /** Appelé quand un rafraîchissement échoue. Le rendu, lui, continue. */
  onError?: (error: Error) => void
}

/** Ce qu'on retient d'un rafraîchissement à l'autre pour calculer le débit. */
interface Throughput {
  /** Dernier « terminés » brut lu, pour détecter les reculs (purge). */
  observed: number
  /** Compteur monotone reconstruit par l'adapter. */
  total: number
  /** Fenêtre glissante des mesures. */
  samples: { at: number; total: number }[]
}

export class PgBossAdapter implements Adapter {
  readonly name = 'pg-boss'

  readonly #options: PgBossAdapterOptions
  readonly #schema: string
  readonly #listeners = new Set<(event: QueueEvent) => void>()
  readonly #throughput = new Map<string, Throughput>()

  #boss: PgBoss | null = null
  #owned = false
  #timer: NodeJS.Timeout | null = null
  #refreshing = false
  /** Le cache servi par `snapshot()`. Jamais écrasé par un échec réseau. */
  #snapshots: QueueSnapshot[] = []
  #failures: FailedJobDetail[] = []
  #knownFailures = new Set<string>()
  /** Faux jusqu'au premier rafraîchissement : évite d'émettre l'historique. */
  #primed = false

  constructor(options: PgBossAdapterOptions) {
    if (!options.boss && !options.connectionString) {
      throw new Error('PgBossAdapter : fournir soit `boss`, soit `connectionString`')
    }
    this.#options = options
    this.#schema = identifier(options.schema ?? 'pgboss')
  }

  async start(): Promise<void> {
    if (this.#boss) return

    if (this.#options.boss) {
      this.#boss = this.#options.boss
    } else {
      this.#boss = new PgBoss({
        connectionString: this.#options.connectionString,
        schema: this.#schema,
        // Sans moniteur, les compteurs de `getQueues()` restent figés.
        supervise: true,
        monitorIntervalSeconds: this.#options.monitorIntervalSeconds ?? 1,
      })
      this.#boss.on('error', (error) => this.#options.onError?.(error))
      await this.#boss.start()
      this.#owned = true
    }

    // Un premier passage AVANT de rendre la main : le renderer appelle
    // `source()` dès son démarrage pour savoir combien de gares construire.
    await this.#refresh()
    this.#primed = true
    this.#schedule()
  }

  async stop(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#listeners.clear()
    this.#primed = false
    const boss = this.#boss
    this.#boss = null
    if (boss && this.#owned) await boss.stop()
    this.#owned = false
  }

  /** Lecture du cache, sans I/O. C'est ce qui garantit les < 50 ms. */
  async snapshot(): Promise<QueueSnapshot[]> {
    return [...this.#snapshots]
  }

  async recentFailures(limit: number): Promise<FailedJobDetail[]> {
    return this.#failures.slice(0, Math.max(0, Math.min(limit, FAILURE_CAP)))
  }

  onEvent(listener: (event: QueueEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #schedule(): void {
    if (!this.#boss) return
    this.#timer = setTimeout(() => {
      void this.#refresh().finally(() => this.#schedule())
    }, this.#options.refreshMs ?? 500)
  }

  /**
   * Le seul endroit qui parle à Postgres. Tout échec est avalé : les
   * caches gardent leur contenu, `capturedAt` compris.
   */
  async #refresh(): Promise<void> {
    const boss = this.#boss
    if (!boss || this.#refreshing) return
    this.#refreshing = true
    try {
      const queues = (await boss.getQueues(this.#options.queues))
        .filter((queue) => !queue.name.startsWith(INTERNAL_PREFIX))
        .sort((a, b) => a.name.localeCompare(b.name))

      const at = Date.now()
      const wip = boss.getWipData()
      this.#snapshots = queues.map((queue) => this.#toSnapshot(queue, wip, at))
      this.#publishFailures(await this.#readFailures(boss, queues))
    } catch (error) {
      this.#options.onError?.(error as Error)
    } finally {
      this.#refreshing = false
    }
  }

  #toSnapshot(queue: QueueResult, wip: WipData[], at: number): QueueSnapshot {
    // Mapping (contraint par la sémantique v12, cf. README) :
    //   `queuedCount` CONTIENT les différés, et `readyCount = queued - deferred`.
    //   waiting = ready (exécutables maintenant), delayed = deferred,
    //   donc waiting + delayed = queued, sans double comptage.
    const counts: Record<JobState, number> = {
      waiting: queue.readyCount,
      active: queue.activeCount,
      // pg-boss ne stocke pas de compteur « terminés » : c'est le reste
      // des lignes encore retenues dans la table (terminés + annulés).
      completed: Math.max(
        0,
        queue.totalCount - queue.queuedCount - queue.activeCount - queue.failedCount,
      ),
      failed: queue.failedCount,
      delayed: queue.deferredCount,
    }

    return {
      name: queue.name,
      counts,
      // `wip` ne décrit que les workers de CE processus. Aucun worker local
      // du tout = on observe une base distante : on ne sait pas, donc null.
      workers: wip.length === 0 ? null : wip.filter((w) => w.name === queue.name && w.state === 'active').length,
      throughputPerMin: this.#rate(queue.name, counts.completed, at),
      capturedAt: new Date(at),
    }
  }

  /**
   * Débit = pente du nombre de jobs terminés sur une fenêtre glissante.
   * Le compteur brut n'est pas monotone (la maintenance pg-boss supprime
   * les vieux terminés), donc on en reconstruit un qui l'est : seules les
   * hausses sont cumulées, une purge se lit comme « rien de neuf ».
   */
  #rate(queue: string, completed: number, at: number): number | null {
    const state = this.#throughput.get(queue) ?? { observed: completed, total: 0, samples: [] }
    state.total += Math.max(0, completed - state.observed)
    state.observed = completed
    state.samples.push({ at, total: state.total })
    while (state.samples.length > 1) {
      const oldest = state.samples[0]
      if (!oldest || at - oldest.at <= THROUGHPUT_WINDOW_MS) break
      state.samples.shift()
    }
    this.#throughput.set(queue, state)

    const oldest = state.samples[0]
    if (!oldest) return null
    const span = at - oldest.at
    if (span < THROUGHPUT_MIN_SPAN_MS) return null
    return Math.round(((state.total - oldest.total) / span) * 60_000)
  }

  /**
   * pg-boss n'expose pas « les N derniers échecs » (`findJobs` ne filtre
   * pas par état et ne borne pas), donc une lecture directe de sa table —
   * dont il nous donne lui-même le nom dans `getQueues()`.
   */
  async #readFailures(boss: PgBoss, queues: QueueResult[]): Promise<FailedJobDetail[]> {
    const byTable = new Map<string, string[]>()
    for (const queue of queues) {
      const names = byTable.get(queue.table) ?? []
      names.push(queue.name)
      byTable.set(queue.table, names)
    }

    const db = boss.getDb()
    const found: FailedJobDetail[] = []
    for (const [table, names] of byTable) {
      const { rows } = await db.executeSql(
        `SELECT id, name, output, completed_on AS "failedAt"
           FROM ${this.#schema}.${identifier(table)}
          WHERE name = ANY($1::text[]) AND state = 'failed'
          ORDER BY completed_on DESC NULLS LAST
          LIMIT $2`,
        [names, FAILURE_CAP],
      )
      for (const row of rows as FailureRow[]) {
        found.push({
          queue: row.name,
          jobId: row.id,
          error: errorMessage(row.output),
          failedAt: row.failedAt ? new Date(row.failedAt) : null,
        })
      }
    }

    return found
      .sort((a, b) => (b.failedAt?.getTime() ?? 0) - (a.failedAt?.getTime() ?? 0))
      .slice(0, FAILURE_CAP)
  }

  /** Publie la liste et signale les échecs jamais vus (effets de rendu). */
  #publishFailures(failures: FailedJobDetail[]): void {
    const known = new Set<string>()
    for (const failure of failures) {
      known.add(failure.jobId)
      if (!this.#primed || this.#knownFailures.has(failure.jobId)) continue
      const event: QueueEvent = {
        type: 'job_failed',
        queue: failure.queue,
        jobId: failure.jobId,
        error: failure.error,
        at: failure.failedAt ?? new Date(),
      }
      for (const listener of this.#listeners) listener(event)
    }
    this.#knownFailures = known
    this.#failures = failures
  }
}

interface FailureRow {
  id: string
  name: string
  output: unknown
  failedAt: string | Date | null
}

/**
 * `output` est du jsonb libre : une Error sérialisée le plus souvent,
 * mais aussi bien une chaîne ou n'importe quel objet passé à `boss.fail()`.
 */
function errorMessage(output: unknown): string | null {
  if (output === null || output === undefined) return null
  if (typeof output === 'string') return truncate(output)
  if (typeof output === 'object') {
    const message = (output as { message?: unknown }).message
    if (typeof message === 'string') return truncate(message)
  }
  return truncate(JSON.stringify(output) ?? '')
}

function truncate(text: string): string {
  return text.length <= ERROR_MAX ? text : `${text.slice(0, ERROR_MAX - 1)}…`
}

/**
 * Schéma et table sont interpolés dans le SQL (un identifiant ne peut pas
 * être un paramètre). Ils viennent de pg-boss, mais on vérifie quand même.
 */
function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error(`PgBossAdapter : identifiant SQL refusé : ${value}`)
  }
  return value
}

export function createPgBossAdapter(options: PgBossAdapterOptions): PgBossAdapter {
  return new PgBossAdapter(options)
}

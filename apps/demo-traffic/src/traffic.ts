/**
 * LE GÉNÉRATEUR DE TRAFIC — producteur + workers, rien d'autre.
 * =============================================================
 * Il pilote UNIQUEMENT la queue : insérer des jobs, les consommer, en rater
 * une partie. Il ne lit jamais de compteur et ne dessine rien — c'est
 * l'adapter qui observe et le renderer qui dessine. La démo reste donc
 * honnête : ce que le monde affiche vient de la base, pas d'ici.
 *
 * Deux détails qui comptent :
 *
 * 1. `retryLimit: 0`. Un échec est définitif, donc « failed » veut dire ce
 *    qu'il dit et le taux observé converge vers `FAIL_RATE`. Avec des
 *    retries, un même job hanterait le cimetière plusieurs fois.
 * 2. `deleteAfterSeconds`. La base est un PGlite en mémoire : sans purge,
 *    la table des jobs grossit tant que la démo tourne et la RAM suit.
 *    Quinze minutes de rétention = un régime permanent (~8 000 lignes),
 *    ce qui rend le run de 5 min plat côté mémoire.
 */
import type { Job, PgBoss } from 'pg-boss'
import {
  BURST,
  between,
  pick,
  type QueueProfile,
  type Rand,
  type TrafficJob,
} from './config.js'

/** Période du producteur. Assez fin pour que la sinusoïde reste lisse. */
const PRODUCE_TICK_MS = 250

/** Fenêtre du débit d'entrée affiché. */
const RATE_WINDOW_MS = 10_000

/** Rétention des jobs réglés — borne la taille de la base (voir en-tête). */
const RETENTION_SECONDS = 900

export interface TrafficOptions {
  boss: PgBoss
  profiles: readonly QueueProfile[]
  failRate: number
  jobMinMs: number
  jobMaxMs: number
  rateScale: number
  rand: Rand
  /** Sert à afficher les incidents dans le tableau de bord, pas la console. */
  onLog: (line: string) => void
}

/** Ce que le producteur sait de lui-même — jamais lu depuis la base. */
export interface QueueTraffic {
  name: string
  inserted: number
  /** Débit d'entrée mesuré sur les 10 dernières secondes. */
  insertedPerSec: number
  /** Jobs réglés par NOS workers (terminés + ratés). */
  settled: number
  failed: number
  bursting: boolean
}

interface QueueState {
  profile: QueueProfile
  inserted: number
  settled: number
  failed: number
  /** Reliquat fractionnaire : sans lui, un débit de 0,7/s ne produit rien. */
  carry: number
  /** Instant (en secondes de run) où le burst en cours s'arrête. */
  burstUntil: number
  burstFactor: number
  samples: { at: number; inserted: number }[]
}

export class TrafficGenerator {
  readonly #options: TrafficOptions
  readonly #states = new Map<string, QueueState>()
  #timer: NodeJS.Timeout | null = null
  #startedAt = 0
  #running = false

  constructor(options: TrafficOptions) {
    this.#options = options
    for (const profile of options.profiles) {
      this.#states.set(profile.name, {
        profile,
        inserted: 0,
        settled: 0,
        failed: 0,
        carry: 0,
        burstUntil: 0,
        burstFactor: 1,
        samples: [],
      })
    }
  }

  async start(): Promise<void> {
    const { boss } = this.#options
    for (const state of this.#states.values()) {
      const { name, workers } = state.profile
      // Repartir d'une queue vierge : sur une base persistante (DATABASE_URL),
      // un run précédent fausserait les compteurs dès la première seconde.
      await boss.deleteQueue(name).catch(() => {})
      await boss.createQueue(name, {
        retryLimit: 0,
        deleteAfterSeconds: RETENTION_SECONDS,
        // Un job dure au plus 3 s : au-delà d'une minute il est perdu, pas lent.
        expireInSeconds: 60,
      })
      await boss.work<TrafficJob>(
        name,
        // Un worker = un job à la fois : le nombre de villagers affichés dans
        // le monde est alors littéralement le nombre de jobs traitables en
        // parallèle. `pollingIntervalSeconds` au minimum autorisé (0,5 s)
        // pour que la queue réagisse à l'échelle du tick de rendu.
        { localConcurrency: workers, batchSize: 1, pollingIntervalSeconds: 0.5 },
        (jobs) => this.#handle(state, jobs),
      )
    }

    this.#startedAt = Date.now()
    this.#running = true
    this.#schedule()
  }

  async stop(): Promise<void> {
    this.#running = false
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    for (const state of this.#states.values()) {
      await this.#options.boss.offWork(state.profile.name).catch(() => {})
    }
  }

  stats(): QueueTraffic[] {
    const elapsed = (Date.now() - this.#startedAt) / 1_000
    return [...this.#states.values()].map((state) => ({
      name: state.profile.name,
      inserted: state.inserted,
      insertedPerSec: rateOf(state.samples),
      settled: state.settled,
      failed: state.failed,
      bursting: elapsed < state.burstUntil,
    }))
  }

  /** Le travail d'un worker : attendre, puis réussir ou échouer. */
  async #handle(state: QueueState, jobs: Job<TrafficJob>[]): Promise<void> {
    const job = jobs[0]
    if (!job) return
    const { rand, failRate, jobMinMs, jobMaxMs } = this.#options
    await sleep(between(rand, jobMinMs, jobMaxMs))
    state.settled++
    if (rand() < failRate) {
      state.failed++
      // Lever suffit : pg-boss range le message dans `output`, et l'adapter
      // le remonte tronqué à 200 caractères. Pas de `boss.fail()` à écrire.
      throw new Error(pick(rand, state.profile.errors)(job.data, rand))
    }
  }

  #schedule(): void {
    if (!this.#running) return
    this.#timer = setTimeout(() => {
      void this.#produce().finally(() => this.#schedule())
    }, PRODUCE_TICK_MS)
  }

  /**
   * Un tick de production. Les erreurs d'insertion sont journalisées mais
   * jamais relancées : une base qui bafouille ne doit pas tuer la démo.
   */
  async #produce(): Promise<void> {
    const at = Date.now()
    const elapsed = (at - this.#startedAt) / 1_000

    for (const state of this.#states.values()) {
      const count = this.#due(state, elapsed)
      if (count > 0) {
        try {
          await this.#options.boss.insert(
            state.profile.name,
            Array.from({ length: count }, () => ({
              name: state.profile.name,
              data: this.#job(state),
            })),
          )
          state.inserted += count
        } catch (error) {
          this.#options.onLog(`insert ${state.profile.name} : ${(error as Error).message}`)
        }
      }
      state.samples.push({ at, inserted: state.inserted })
      while (state.samples.length > 1) {
        const oldest = state.samples[0]
        if (!oldest || at - oldest.at <= RATE_WINDOW_MS) break
        state.samples.shift()
      }
    }
  }

  /**
   * Combien de jobs insérer maintenant : la sinusoïde de la queue, éventuel
   * burst en cours, mise à l'échelle globale, et le reliquat fractionnaire
   * reporté d'un tick à l'autre.
   */
  #due(state: QueueState, elapsed: number): number {
    const { profile } = state
    const { rand, rateScale } = this.#options

    if (elapsed >= state.burstUntil) {
      state.burstFactor = 1
      if (rand() < BURST.chancePerSecond * (PRODUCE_TICK_MS / 1_000)) {
        state.burstUntil = elapsed + between(rand, BURST.minSeconds, BURST.maxSeconds)
        state.burstFactor = between(rand, BURST.minFactor, BURST.maxFactor)
      }
    }

    const phase = (2 * Math.PI * (elapsed + profile.phaseSeconds)) / profile.periodSeconds
    const wave = 1 + profile.amplitude * Math.sin(phase)
    const rate = profile.baseRate * wave * state.burstFactor * rateScale

    state.carry += (rate * PRODUCE_TICK_MS) / 1_000
    const count = Math.floor(state.carry)
    state.carry -= count
    return count
  }

  #job(state: QueueState): TrafficJob {
    const seq = state.inserted + 1
    return { seq, subject: state.profile.subject(seq, this.#options.rand) }
  }
}

/** Pente du compteur d'insertions sur la fenêtre glissante, en jobs/s. */
function rateOf(samples: { at: number; inserted: number }[]): number {
  const oldest = samples[0]
  const newest = samples[samples.length - 1]
  if (!oldest || !newest) return 0
  const span = newest.at - oldest.at
  if (span < 1_000) return 0
  return ((newest.inserted - oldest.inserted) / span) * 1_000
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

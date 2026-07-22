/**
 * LA BOUCLE DE RENDU (ADR D7 §2) — 2 Hz, miroir, diff.
 * ====================================================
 * Un tick fait exactement ceci :
 *
 *      snapshots → project() → diff(miroir) → commandes → miroir
 *
 * Le miroir n'est mis à jour qu'APRÈS l'envoi réussi : si RCON coupe au
 * milieu d'un tick, le daemon sait précisément ce qui est dessiné et le
 * tick suivant rattrape le reste. C'est ce qui rend la boucle reprenable
 * sans jamais relire le monde.
 */
import type { QueueSnapshot } from '@queuecraft/core'
import { bootstrapCommands, mutationToCommands, stationPrepareCommands } from './commands.js'
import { diff } from './diff.js'
import { Mirror } from './mirror.js'
import type { RconSink } from './rcon-sink.js'
import { project } from './scene.js'

/** Une source de snapshots : un adapter réel, ou des données mockées. */
export type SnapshotSource = () => QueueSnapshot[] | Promise<QueueSnapshot[]>

export interface RendererOptions {
  sink: RconSink
  source: SnapshotSource
  /** Période de rendu. 500 ms = les 2 Hz de l'ADR D7. */
  tickMs?: number
  /** Midi permanent, pas de météo ni de mobs (à réserver aux démos). */
  freezeScene?: boolean
  /** Appelé à la fin de chaque tick — sert aux mesures de la démo. */
  onTick?: (info: TickInfo) => void
  onError?: (error: Error) => void
}

export interface TickInfo {
  tick: number
  /** Mutations calculées par le diff (0 = rien n'a bougé, tick gratuit). */
  mutations: number
  /** Commandes réellement envoyées (une mutation `build` en vaut ~31). */
  commands: number
  durationMs: number
}

export class Renderer {
  private readonly mirror = new Mirror()
  private readonly prepared = new Set<number>()
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private started = false
  private tickCount = 0

  constructor(private readonly options: RendererOptions) {}

  get tickMs(): number {
    return this.options.tickMs ?? 500
  }

  /**
   * Rase le monde puis lance la boucle. Le miroir repart vide : le
   * premier tick redessine donc tout (stratégie « raser + redessiner »,
   * choisie pour son coût borné plutôt que de relire le monde).
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    const snapshots = await this.options.source()
    const stations = snapshots.map((_, index) => index)
    this.mirror.reset()
    await this.options.sink.sendAll(
      bootstrapCommands(stations, { freezeScene: this.options.freezeScene }),
    )
    for (const station of stations) this.prepared.add(station)

    await this.tick()
    this.schedule()
  }

  /** Arrête la boucle. Ne rase rien : le monde reste tel qu'affiché. */
  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (!this.started) return
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule())
    }, this.tickMs)
  }

  /**
   * Un passage. Public pour les tests et la démo (qui pilote son propre
   * rythme afin de mesurer proprement).
   */
  async tick(): Promise<TickInfo> {
    // Un tick lent (grosse rafale étalée par le token bucket) ne doit
    // jamais être doublé par le suivant : le miroir n'y survivrait pas.
    if (this.ticking) {
      return { tick: this.tickCount, mutations: 0, commands: 0, durationMs: 0 }
    }
    this.ticking = true
    const startedAt = Date.now()
    const before = this.options.sink.total
    let mutationCount = 0

    try {
      const snapshots = await this.options.source()

      for (let station = 0; station < snapshots.length; station++) {
        const snapshot = snapshots[station]
        if (!snapshot) continue

        // Une queue apparue en cours de route : on prépare sa zone sans
        // toucher aux gares déjà dessinées.
        if (!this.prepared.has(station)) {
          await this.options.sink.sendAll(stationPrepareCommands(station))
          this.prepared.add(station)
        }

        const scene = project(snapshot, station)
        const mutations = diff(this.mirror.get(station), scene)
        mutationCount += mutations.length

        for (const mutation of mutations) {
          await this.options.sink.sendAll(mutationToCommands(mutation))
          this.mirror.apply(mutation) // jamais avant l'envoi réussi
        }
      }
    } catch (error) {
      this.options.onError?.(error as Error)
    }

    this.ticking = false
    this.tickCount++
    const info: TickInfo = {
      tick: this.tickCount,
      mutations: mutationCount,
      commands: this.options.sink.total - before,
      durationMs: Date.now() - startedAt,
    }
    this.options.onTick?.(info)
    return info
  }
}

export function createRenderer(options: RendererOptions): Renderer {
  return new Renderer(options)
}

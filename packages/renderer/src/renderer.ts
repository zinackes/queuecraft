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
import type { FailedJobDetail, QueueSnapshot } from '@queuecraft/core'
import { bootstrapCommands, mutationToCommands, stationPrepareCommands } from './commands.js'
import { diff } from './diff.js'
import { MAX_GRAVES } from './layout.js'
import { Mirror } from './mirror.js'
import type { Mutation } from './mirror.js'
import { RconOfflineError } from './rcon-session.js'
import type { RconSink } from './rcon-sink.js'
import { project } from './scene.js'

/**
 * Ordre d'envoi À TRAVERS les gares. Passe 1 : l'information périssable
 * (décor, compteurs, tombes) ; passe 2 : le volume agrégé (carts,
 * villagers). Une tombe part donc toujours avant les carts de n'importe
 * quelle gare. À l'intérieur d'une passe, l'ordre du diff est conservé,
 * donc `build` précède toujours ce qui dépend de lui.
 */
const MUTATION_PASSES: ReadonlyArray<ReadonlySet<Mutation['kind']>> = [
  new Set<Mutation['kind']>(['build', 'stats', 'grave', 'grave-clear']),
  new Set<Mutation['kind']>(['cart', 'worker']),
]

/** Une source de snapshots : un adapter réel, ou des données mockées. */
export type SnapshotSource = () => QueueSnapshot[] | Promise<QueueSnapshot[]>

/** Une source d'échecs : typiquement `adapter.recentFailures(50)`. */
export type FailureSource = () => FailedJobDetail[] | Promise<FailedJobDetail[]>

export interface RendererOptions {
  sink: RconSink
  source: SnapshotSource
  /**
   * Les échecs à rendre en tombes. Sans elle, pas de cimetière : le
   * renderer reste utilisable avec un adapter qui n'expose que des
   * compteurs. Quoi qu'elle renvoie, le rendu est plafonné à `MAX_GRAVES`.
   */
  failures?: FailureSource
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
  /** Commandes réellement envoyées (une mutation `build` en vaut ~36). */
  commands: number
  /** Tombes dessinées dans le monde, toutes gares confondues (≤ MAX_GRAVES). */
  graves: number
  /**
   * Les jobId dont la tombe vient d'être posée. Vide en régime calme —
   * c'est ce qui permet de mesurer le délai « échec → tombe » sans
   * instrumenter la boucle elle-même.
   */
  gravesDrawn: string[]
  durationMs: number
}

export class Renderer {
  private readonly mirror = new Mirror()
  private readonly prepared = new Set<number>()
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private started = false
  private tickCount = 0
  /**
   * Armé par une reconnexion RCON. Un serveur qui redémarre a pu perdre le
   * monde ; le prochain tick en ligne raze et redessine tout AVANT de differ
   * (cf. `bootstrap()`), au lieu de patcher contre un miroir devenu faux.
   */
  private needsResync = false
  private reconnectWired = false

  constructor(private readonly options: RendererOptions) {}

  get tickMs(): number {
    return this.options.tickMs ?? 500
  }

  /** Le serveur est-il joignable ? Faux pendant une coupure : on ne mute rien. */
  private get online(): boolean {
    return this.options.sink.connected
  }

  /** Tombes que le daemon croit avoir dessinées, toutes gares confondues. */
  get graveCount(): number {
    return this.mirror.graveTotal()
  }

  /**
   * Rase le monde puis lance la boucle. Le miroir repart vide : le
   * premier tick redessine donc tout (stratégie « raser + redessiner »,
   * choisie pour son coût borné plutôt que de relire le monde).
   *
   * Fail-fast : si le serveur est absent au démarrage, `bootstrap()` lève et
   * l'appelant le sait. La résilience aux coupures ne commence qu'APRÈS ce
   * premier rendu réussi — c'est le régime d'un daemon 24/7.
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    // Une reconnexion RCON arme un resync complet. Posé une seule fois, avant
    // le premier rendu : si le serveur tombe pendant le bootstrap, le retour
    // en ligne redessinera tout de lui-même.
    if (!this.reconnectWired) {
      this.reconnectWired = true
      this.options.sink.onReconnect(() => {
        this.needsResync = true
      })
    }

    await this.bootstrap()
    await this.tick()
    this.schedule()
  }

  /**
   * « Raser + redessiner » (ADR D7 §4). Vide le miroir EN MÉMOIRE d'abord
   * (sûr), puis envoie le rasage : si l'envoi coupe en route, le miroir est
   * déjà vide et le prochain resync repart proprement de zéro. C'est le corps
   * du démarrage ET du resync sur reconnexion — un serveur qui redémarre est,
   * pour le renderer, un nouveau départ.
   */
  private async bootstrap(): Promise<void> {
    const snapshots = await this.options.source()
    const stations = snapshots.map((_, index) => index)
    this.mirror.reset()
    this.prepared.clear()
    await this.options.sink.sendAll(
      bootstrapCommands(stations, { freezeScene: this.options.freezeScene }),
    )
    for (const station of stations) this.prepared.add(station)
  }

  /** Arrête la boucle. Ne rase rien : le monde reste tel qu'affiché. */
  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * `tickMs` après la FIN du tick précédent, et non après son début.
   *
   * Viser une période fixe (`début + tickMs`) paraît meilleur — un tick
   * lent ne décalerait plus les suivants — mais a été mesuré PIRE : avec
   * `maxPending: 1` (ADR-002 §3) un tick chargé dure plusieurs centaines de
   * millisecondes, la période fixe le fait donc repartir aussitôt, la
   * boucle tourne en continu et le délai « échec → tombe » double
   * (p95 0,5 s → 1,1 s, boucle d'événements bloquée jusqu'à 494 ms).
   * L'intervalle fixe laisse le serveur respirer entre deux passes. Ne pas
   * « corriger » sans remesurer.
   */
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
      return {
        tick: this.tickCount,
        mutations: 0,
        commands: 0,
        graves: this.graveCount,
        gravesDrawn: [],
        durationMs: 0,
      }
    }
    this.ticking = true
    const startedAt = Date.now()
    const before = this.options.sink.total
    const gravesDrawn: string[] = []
    let mutationCount = 0

    try {
      // Retour en ligne après une coupure : raser + redessiner AVANT de differ,
      // sinon on patcherait contre un miroir que le serveur a oublié. Si la
      // reconstruction recoupe, le drapeau reste armé et le prochain tick
      // réessaie — le monde converge sans qu'on relise jamais le serveur.
      if (this.online && this.needsResync) {
        await this.bootstrap()
        this.needsResync = false
      }

      const snapshots = await this.options.source()
      // Une seule lecture des échecs pour tout le tick, et le plafond de
      // l'ADR D7 est appliqué ICI : la liste est triée du plus récent au
      // plus ancien, la couper garde donc bien « les 50 plus récents »,
      // quoi qu'en dise l'adapter.
      const failures = this.options.failures
        ? (await this.options.failures()).slice(0, MAX_GRAVES)
        : []

      // Le diff est pur et sans I/O : on le calcule pour toutes les gares
      // d'abord, on envoie ensuite. Ça permet d'ordonner l'envoi À TRAVERS
      // les gares, pas seulement à l'intérieur de chacune. Hors ligne, on
      // calcule quand même (le miroir reste intact, aucune commande ne part) :
      // la boucle ne dérive pas, elle attend simplement le retour du serveur.
      const planned: Mutation[] = []
      for (let station = 0; station < snapshots.length; station++) {
        const snapshot = snapshots[station]
        if (!snapshot) continue

        // Une queue apparue en cours de route : on prépare sa zone sans
        // toucher aux gares déjà dessinées. Impossible hors ligne — on saute
        // la gare ce tick ; le resync du retour la prendra de toute façon.
        if (!this.prepared.has(station)) {
          if (!this.online) continue
          await this.options.sink.sendAll(stationPrepareCommands(station))
          this.prepared.add(station)
        }

        const scene = project(snapshot, station, failures)
        const mutations = diff(this.mirror.get(station), scene)
        mutationCount += mutations.length
        planned.push(...mutations)
      }

      // Deux passes. L'information d'abord (décor, compteurs, TOMBES), le
      // volume ensuite (carts, villagers). Sans ça, une tombe de la dernière
      // gare attend derrière tous les carts des gares précédentes, et pendant
      // un burst — toutes les gares mutent — ce retard passait 2 s (mesuré).
      // La dépendance « build avant le reste » reste tenue : elle est
      // interne à une gare, et `build` est dans la première passe.
      //
      // Rien ne part si le serveur est hors ligne : le miroir n'est PAS muté,
      // donc au retour le diff retrouvera exactement ce travail à faire.
      if (this.online) {
        for (const wanted of MUTATION_PASSES) {
          for (const mutation of planned) {
            if (!wanted.has(mutation.kind)) continue
            await this.options.sink.sendAll(mutationToCommands(mutation))
            this.mirror.apply(mutation) // jamais avant l'envoi réussi
            if (mutation.kind === 'grave') gravesDrawn.push(mutation.grave.jobId)
          }
        }
      }
    } catch (error) {
      // Une coupure en plein tick n'est pas une erreur de rendu : la session
      // la gère (reconnexion + resync). Toute AUTRE exception remonte.
      if (!(error instanceof RconOfflineError)) this.options.onError?.(error as Error)
    }

    this.ticking = false
    this.tickCount++
    const info: TickInfo = {
      tick: this.tickCount,
      mutations: mutationCount,
      commands: this.options.sink.total - before,
      graves: this.graveCount,
      gravesDrawn,
      durationMs: Date.now() - startedAt,
    }
    this.options.onTick?.(info)
    return info
  }
}

export function createRenderer(options: RendererOptions): Renderer {
  return new Renderer(options)
}

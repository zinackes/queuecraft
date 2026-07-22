/**
 * LA PROJECTION données → visuel — module pur.
 * ============================================
 * `project()` répond à une seule question : « à quoi DOIT ressembler la
 * gare pour ce snapshot ? ». Elle ne sait pas ce qui est déjà dessiné
 * (c'est le miroir) ni comment on dessine (c'est commands.ts).
 *
 * Une `Scene` est volontairement minuscule et comparable champ à champ :
 * c'est ce qui rend le diff trivial et donc le budget RCON prévisible.
 */
import type { QueueSnapshot } from '@queuecraft/core'
import { MAX_WORKERS } from './layout.js'
import { cartsForBacklog, formatCount, healthOf, jobsPerCart, type Health } from './scale.js'

export interface Scene {
  /** Index de la gare (une par queue). */
  station: number
  /** Nom de la queue, affiché sur le fronton. */
  queueName: string
  /** Carts visibles sur la voie de garage (0..MAX_CARTS). */
  cartCount: number
  /** Villagers visibles dans la zone workers (0..MAX_WORKERS). */
  workerCount: number
  /** Le bloc de compteurs, déjà formaté (le jeu ne calcule rien). */
  statsText: string
  /** Palier de santé — pilote la couleur du panneau. */
  health: Health
}

/**
 * Le point de vue du renderer sur une queue.
 * Les caractères utilisés dans le texte restent en Latin-1 (« · », « » »):
 * la police par défaut de Minecraft les rend partout, contrairement aux
 * symboles exotiques qui deviennent des carrés vides sur certaines cibles.
 */
export function project(snapshot: QueueSnapshot, station: number): Scene {
  const { waiting, active, completed, failed, delayed } = snapshot.counts

  const cartCount = cartsForBacklog(waiting)
  const workerCount = Math.min(MAX_WORKERS, Math.max(0, snapshot.workers ?? 0))

  const backlogLine =
    cartCount === 0
      ? 'no backlog'
      : `${formatCount(waiting)} waiting  ·  1 cart » ${formatCount(jobsPerCart(waiting, cartCount))} jobs`

  const workLine = [
    `${formatCount(active)} active`,
    `${formatCount(completed)} done`,
    `${formatCount(failed)} failed`,
    ...(delayed > 0 ? [`${formatCount(delayed)} delayed`] : []),
  ].join('  ·  ')

  const crewLine = [
    snapshot.workers === null ? 'workers n/a' : `${formatCount(snapshot.workers)} workers`,
    snapshot.throughputPerMin === null
      ? 'rate n/a'
      : `${formatCount(snapshot.throughputPerMin)} jobs/min`,
  ].join('  ·  ')

  return {
    station,
    queueName: snapshot.name,
    cartCount,
    workerCount,
    statsText: `${backlogLine}\n${workLine}\n${crewLine}`,
    health: healthOf(completed, failed),
  }
}

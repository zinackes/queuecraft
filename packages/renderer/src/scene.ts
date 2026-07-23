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
import type { FailedJobDetail, QueueSnapshot } from '@queuecraft/core'
import { GRAVE_SLOTS, MAX_WORKERS } from './layout.js'
import { cartsForBacklog, formatCount, healthOf, jobsPerCart, type Health } from './scale.js'

/** Longueur du jobId affiché sur une tombe. */
const GRAVE_ID_CHARS = 8
/** Longueur maximale de l'épitaphe (l'adapter tronque déjà à ~200). */
const GRAVE_ERROR_CHARS = 120

/**
 * Une tombe = UN job échoué. C'est la seule chose que Queuecraft rend 1:1
 * (ADR D7), et la seule dont le diff se fasse par IDENTITÉ : `jobId` ne
 * change jamais, `slot` est décidé par le miroir. Une tombe posée n'est
 * donc jamais redessinée parce qu'une autre est arrivée avant elle.
 */
export interface Grave {
  /** Identité du job. Sert au diff, jamais affiché en entier. */
  jobId: string
  /** Ce qu'on grave sur la pierre : les 8 premiers caractères. */
  label: string
  /** L'épitaphe, nettoyée et tronquée — prête à partir dans une commande. */
  error: string
}

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
  /** Les échecs de CETTE queue, du plus récent au plus ancien. */
  graves: Grave[]
}

/**
 * Le point de vue du renderer sur une queue.
 * Les caractères utilisés dans le texte restent en Latin-1 (« · », « » »):
 * la police par défaut de Minecraft les rend partout, contrairement aux
 * symboles exotiques qui deviennent des carrés vides sur certaines cibles.
 */
export function project(
  snapshot: QueueSnapshot,
  station: number,
  failures: readonly FailedJobDetail[] = [],
): Scene {
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
    // La liste reçue est déjà plafonnée globalement par le renderer ; ici on
    // ne garde que les échecs de CETTE queue, et jamais plus que la grille.
    graves: failures
      .filter((failure) => failure.queue === snapshot.name)
      .slice(0, GRAVE_SLOTS)
      .map(toGrave),
  }
}

function toGrave(failure: FailedJobDetail): Grave {
  return {
    jobId: failure.jobId,
    label: plainText(failure.jobId).slice(0, GRAVE_ID_CHARS),
    error: cut(plainText(failure.error ?? 'no error message'), GRAVE_ERROR_CHARS),
  }
}

/**
 * Le texte d'une erreur part dans une commande RCON puis dans la police du
 * jeu : on le ramène sur UNE ligne et dans le Latin-1 rendu partout. Les
 * messages réels sont pleins de « — » et de « … » (l'adapter tronque avec),
 * qui deviendraient des carrés vides sur certaines cibles.
 */
function plainText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[‐-―]/g, '-') // tirets typographiques, dont l'em dash
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...') // le « … » posé par la troncature de l'adapter
    // Tout ce qui reste hors Latin-1 imprimable : un point d'interrogation
    // vaut mieux qu'un carré vide, et surtout mieux qu'un octet douteux.
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
    .trim()
}

/** Coupe à `max` caractères, points de suspension COMPRIS (jamais max + 3). */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`
}

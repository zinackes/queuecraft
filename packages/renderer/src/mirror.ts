/**
 * L'ÉTAT MIROIR (ADR D7 §1) — module pur.
 * =======================================
 * Le miroir est la copie en mémoire de ce qui est RÉELLEMENT dessiné
 * dans le monde. C'est la pièce la plus délicate du renderer : s'il
 * ment, on envoie des commandes inutiles (budget) ou on en oublie
 * (affichage faux).
 *
 * Deux règles tiennent tout :
 *   1. le miroir n'est modifié qu'APRÈS l'envoi réussi de la commande
 *      correspondante (sinon une coupure RCON laisse un miroir qui
 *      croit avoir dessiné des choses inexistantes) ;
 *   2. `reset()` accompagne toujours un rasage du monde.
 */
import type { Health } from './scale.js'
import type { Grave } from './scene.js'

/**
 * Une mutation = la plus petite unité de changement du monde.
 * Typée, jamais textuelle : la traduction en commandes Minecraft est
 * le travail exclusif de commands.ts.
 */
export type Mutation =
  /** Construire le décor et invoquer le pool d'entités (une seule fois). */
  | { kind: 'build'; station: number; queueName: string }
  /** Sortir un minecart du dépôt vers son emplacement, ou l'y renvoyer. */
  | { kind: 'cart'; station: number; slot: number; visible: boolean }
  /** Idem pour un villager de la zone workers. */
  | { kind: 'worker'; station: number; slot: number; visible: boolean }
  /** Réécrire le bloc de compteurs. `pulse` alterne pour animer. */
  | { kind: 'stats'; station: number; text: string; health: Health; pulse: 0 | 1 }
  /**
   * Poser la tombe d'un job échoué sur un emplacement du cimetière.
   * `fresh` distingue les deux coûts : un emplacement vierge demande une
   * pierre ET une épitaphe (2 commandes), un emplacement recyclé se
   * contente d'une réécriture de texte (1 commande).
   * `effect` n'est vrai que pour la PREMIÈRE tombe d'une gare dans un tick :
   * le spectacle est plafonné, il ne mange jamais le budget.
   */
  | { kind: 'grave'; station: number; slot: number; grave: Grave; fresh: boolean; effect: boolean }
  /** Rendre un emplacement au néant : l'échec est sorti des plus récents. */
  | { kind: 'grave-clear'; station: number; slot: number }

/** Ce que le daemon croit avoir dessiné pour une gare. */
export interface StationMirror {
  station: number
  /** `null` tant que le décor n'a pas été construit. */
  queueName: string | null
  cartCount: number
  workerCount: number
  statsText: string | null
  health: Health | null
  /** Dernière valeur d'alternance envoyée (sert au pulse d'interpolation). */
  pulse: 0 | 1
  /**
   * `jobId` → emplacement occupé. C'est ce qui rend le cimetière stable :
   * on compare des IDENTITÉS, jamais des positions (ADR D7). Une tombe
   * garde son emplacement tant que son job reste dans les plus récents.
   */
  graves: Map<string, number>
}

export function emptyStation(station: number): StationMirror {
  return {
    station,
    queueName: null,
    cartCount: 0,
    workerCount: 0,
    statsText: null,
    health: null,
    pulse: 0,
    graves: new Map(),
  }
}

export class Mirror {
  private readonly stations = new Map<number, StationMirror>()

  /** L'état cru dessiné pour cette gare (vide si jamais construite). */
  get(station: number): StationMirror {
    const existing = this.stations.get(station)
    if (existing) return existing
    const fresh = emptyStation(station)
    this.stations.set(station, fresh)
    return fresh
  }

  /** Applique une mutation DÉJÀ envoyée avec succès. */
  apply(mutation: Mutation): void {
    const station = this.get(mutation.station)
    switch (mutation.kind) {
      case 'build':
        station.queueName = mutation.queueName
        // Le pool sort du dépôt vide : rien n'est encore visible.
        station.cartCount = 0
        station.workerCount = 0
        // Construire, c'est avoir rasé : le cimetière repart de zéro.
        station.graves.clear()
        break
      case 'cart':
        // Les emplacements se remplissent de 0 vers N : le nombre visible
        // est donc toujours « index du dernier montré + 1 ».
        station.cartCount = mutation.visible ? mutation.slot + 1 : mutation.slot
        break
      case 'worker':
        station.workerCount = mutation.visible ? mutation.slot + 1 : mutation.slot
        break
      case 'stats':
        station.statsText = mutation.text
        station.health = mutation.health
        station.pulse = mutation.pulse
        break
      case 'grave':
        // Un emplacement recyclé porte encore l'ancien job : le libérer
        // d'abord, sinon le miroir croirait deux tombes au même endroit.
        evict(station, mutation.slot)
        station.graves.set(mutation.grave.jobId, mutation.slot)
        break
      case 'grave-clear':
        evict(station, mutation.slot)
        break
    }
  }

  /** Nombre de tombes dessinées, toutes gares confondues (plafond ADR D7). */
  graveTotal(): number {
    let total = 0
    for (const station of this.stations.values()) total += station.graves.size
    return total
  }

  /** Après un rasage du monde : le daemon ne croit plus rien avoir dessiné. */
  reset(): void {
    this.stations.clear()
  }
}

/** Retire du miroir le job qui occupait cet emplacement, s'il y en avait un. */
function evict(station: StationMirror, slot: number): void {
  for (const [jobId, occupied] of station.graves) {
    if (occupied === slot) {
      station.graves.delete(jobId)
      return
    }
  }
}

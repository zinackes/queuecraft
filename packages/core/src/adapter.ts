import type { FailedJobDetail, QueueActions, QueueEvent, QueueSnapshot } from './model.js'

/**
 * L'INTERFACE ADAPTER (décision D5/D6 de l'ADR-001)
 * -------------------------------------------------
 * Le contrat que chaque techno de queue doit remplir pour être
 * affichable par Queuecraft. Volontairement minuscule : plus le
 * contrat est petit, plus il est facile d'écrire un adapter
 * (objectif : ~100 lignes pour en ajouter un).
 *
 * Cette interface ne sera FIGÉE qu'après avoir écrit les DEUX
 * premiers adapters (pg-boss puis BullMQ) : une interface qui n'a
 * connu qu'une seule implémentation est toujours suspecte.
 */
export interface Adapter {
  /** Nom lisible, ex. "pg-boss" ou "bullmq". Affiché dans le monde. */
  readonly name: string

  /** Ouvre les connexions nécessaires (base de données, Redis...). */
  start(): Promise<void>

  /** Ferme tout proprement. */
  stop(): Promise<void>

  /**
   * Retourne l'état actuel de toutes les queues.
   * Appelé en boucle par le renderer (environ toutes les 500 ms) :
   * doit donc être RAPIDE et ne jamais faire de travail lourd.
   */
  snapshot(): Promise<QueueSnapshot[]>

  /**
   * Les N échecs les plus récents (pour le cimetière).
   * `limit` est plafonné à 50 par le renderer (décision D7).
   */
  recentFailures(limit: number): Promise<FailedJobDetail[]>

  /**
   * Abonnement optionnel aux événements temps réel.
   * Retourne une fonction de désabonnement.
   * Un adapter qui ne sait pas pousser d'événements peut
   * simplement ne pas implémenter cette méthode : le rendu
   * fonctionne au polling seul.
   */
  onEvent?(listener: (event: QueueEvent) => void): () => void

  /** Actions déclenchables depuis le jeu (phase 2, optionnel). */
  readonly actions?: QueueActions
}

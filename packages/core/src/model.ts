/**
 * LE MODÈLE PIVOT (décision D5 de l'ADR-001)
 * ------------------------------------------
 * C'est le format interne unique de Queuecraft. Toutes les technos de
 * queues (pg-boss, BullMQ, ...) sont traduites vers CES types par leur
 * adapter. Le moteur de rendu Minecraft ne connaît que ces types :
 * il ne sait même pas que pg-boss ou BullMQ existent.
 *
 * Règle d'or : ce fichier ne doit JAMAIS importer quoi que ce soit
 * d'une techno de queue précise.
 */

/** Les états possibles d'un job, communs à toutes les technos. */
export type JobState = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed'

/**
 * Photo instantanée d'une queue à un instant T.
 * C'est ce que la boucle de rendu demande régulièrement (polling)
 * pour savoir quoi dessiner dans le monde.
 */
export interface QueueSnapshot {
  /** Nom de la queue, ex. "scraping" ou "emails". */
  name: string

  /** Combien de jobs dans chaque état. */
  counts: Record<JobState, number>

  /**
   * Nombre de workers (les processus qui consomment la queue).
   * `null` si la techno ne permet pas de le savoir.
   */
  workers: number | null

  /**
   * Jobs traités par minute (débit).
   * `null` si l'adapter ne sait pas le calculer.
   */
  throughputPerMin: number | null

  /** Quand cette photo a été prise. */
  capturedAt: Date
}

/**
 * Détail d'un job échoué. Contrairement au reste (agrégé),
 * les échecs sont rendus individuellement : une tombe chacun.
 */
export interface FailedJobDetail {
  queue: string
  jobId: string
  /** Message d'erreur, tronqué par l'adapter à ~200 caractères. */
  error: string | null
  failedAt: Date | null
}

/**
 * Événement ponctuel poussé par l'adapter (quand la techno le permet).
 * Sert aux effets immédiats : particules, sons, éclairs d'orage...
 * Le rendu ne DÉPEND pas de ces événements : le polling des snapshots
 * suffit à rester juste. Les événements ne font qu'ajouter du spectacle.
 */
export type QueueEvent =
  | { type: 'job_completed'; queue: string; jobId: string; at: Date }
  | { type: 'job_failed'; queue: string; jobId: string; error: string | null; at: Date }
  | { type: 'queue_paused'; queue: string; at: Date }
  | { type: 'queue_resumed'; queue: string; at: Date }

/**
 * Actions que l'utilisateur pourra déclencher depuis le jeu (phase 2).
 * Toutes optionnelles : un adapter en lecture seule est parfaitement valide.
 */
export interface QueueActions {
  retry?(queue: string, jobId: string): Promise<void>
  cancel?(queue: string, jobId: string): Promise<void>
}

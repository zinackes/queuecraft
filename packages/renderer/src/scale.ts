/**
 * L'AGRÉGATION — module pur.
 * ==========================
 * Règle non négociable n°2 du CLAUDE.md : jamais de rendu 1:1 des jobs.
 * Un backlog de 40 000 jobs ne peut pas être 40 000 minecarts ; il doit
 * tenir dans MAX_CARTS emplacements tout en restant LISIBLE. D'où
 * l'échelle logarithmique : chaque poignée de carts en plus vaut ×10.
 *
 * Tout nombre affiché est formaté ici, côté daemon : le jeu ne fait
 * jamais de calcul (skill qc-renderer, règle 5).
 */
import { MAX_CARTS } from './layout.js'

/** Carts gagnés par décade (×10 de backlog). 3 → 10 jobs = 4 carts, 1 000 = 9. */
const CARTS_PER_DECADE = 3

/**
 * Combien de minecarts pour N jobs en attente.
 *
 *      0 job  → 0 cart        100 jobs  →  6 carts
 *      1 job  → 1 cart      1 000 jobs  →  9 carts
 *     10 jobs → 3 carts    ≥ 10 000     → 12 carts (saturation)
 *
 * Les paliers tombent pile sur les décades : 12 emplacements = 4 décades,
 * donc la voie pleine veut dire « au moins 10 000 » et rien d'autre.
 * La saturation est assumée : au-delà, c'est le compteur du panneau qui
 * porte l'information exacte. La voie dit « c'est énorme », pas « combien ».
 */
export function cartsForBacklog(waiting: number): number {
  if (waiting <= 0) return 0
  const carts = Math.ceil(Math.log10(waiting) * CARTS_PER_DECADE)
  return Math.min(MAX_CARTS, Math.max(1, carts))
}

/** Combien de jobs « pèse » un cart à l'échelle courante (pour l'afficher). */
export function jobsPerCart(waiting: number, carts: number): number {
  if (carts <= 0) return 0
  return Math.ceil(waiting / carts)
}

/**
 * Formatage compact d'un compteur : 942 → « 942 », 12 431 → « 12.4k ».
 * Le panneau doit rester lisible à 10 blocs de distance.
 */
export function formatCount(n: number): string {
  const value = Math.max(0, Math.round(n))
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${trim(value / 1_000)}k`
  if (value < 1_000_000_000) return `${trim(value / 1_000_000)}M`
  return `${trim(value / 1_000_000_000)}G`
}

/** 12.0 → « 12 », 12.43 → « 12.4 » (une décimale, jamais de « .0 »). */
function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** Les trois paliers de santé de docs/world-design.md (bossbar). */
export type Health = 'healthy' | 'degraded' | 'critical'

/**
 * Santé d'une queue = part d'échecs sur le travail terminé.
 * < 5 % sain, < 15 % dégradé, au-delà critique. Une queue qui n'a
 * encore rien terminé est saine : on n'alarme pas sur zéro donnée.
 */
export function healthOf(completed: number, failed: number): Health {
  const finished = completed + failed
  if (finished === 0 || failed === 0) return 'healthy'
  const ratio = failed / finished
  if (ratio < 0.05) return 'healthy'
  if (ratio < 0.15) return 'degraded'
  return 'critical'
}

/**
 * LE DIFF (ADR D7 §2) — module pur.
 * =================================
 * « Chaque tick : snapshot → diff(miroir, snapshot) → n'émettre QUE les
 * mutations. » C'est ici que se joue le budget de 40 cmd/s : si rien
 * n'a changé, cette fonction renvoie un tableau vide et le tick coûte
 * ZÉRO commande.
 *
 * Ordre des mutations : construction d'abord (sinon on téléporte des
 * entités qui n'existent pas), puis compteurs, puis carts et villagers.
 */
import type { Mutation, StationMirror } from './mirror.js'
import type { Scene } from './scene.js'

export function diff(mirror: StationMirror, scene: Scene): Mutation[] {
  const mutations: Mutation[] = []

  // La gare n'existe pas encore : on la construit et on repart d'un
  // miroir « décor posé, rien d'affiché » pour que la suite du diff
  // émette naturellement tout le contenu.
  let cartCount = mirror.cartCount
  let workerCount = mirror.workerCount
  if (mirror.queueName !== scene.queueName) {
    mutations.push({ kind: 'build', station: scene.station, queueName: scene.queueName })
    cartCount = 0
    workerCount = 0
  }

  if (mirror.statsText !== scene.statsText || mirror.health !== scene.health) {
    mutations.push({
      kind: 'stats',
      station: scene.station,
      text: scene.statsText,
      health: scene.health,
      // Alternance 0/1 : chaque écriture change la cible d'interpolation,
      // le client anime donc la transition au lieu de la faire d'un coup.
      pulse: mirror.pulse === 0 ? 1 : 0,
    })
  }

  mutations.push(...slotMutations('cart', scene.station, cartCount, scene.cartCount))
  mutations.push(...slotMutations('worker', scene.station, workerCount, scene.workerCount))

  return mutations
}

/**
 * Les emplacements sont remplis de 0 vers N. Passer de 4 à 7 carts
 * coûte donc 3 commandes (les emplacements 4, 5, 6), pas 7.
 * Quand ça descend, on retire par la fin de la voie — visuellement,
 * les carts les plus éloignés du quai s'en vont d'abord.
 */
function slotMutations(
  kind: 'cart' | 'worker',
  station: number,
  from: number,
  to: number,
): Mutation[] {
  const mutations: Mutation[] = []
  if (to > from) {
    for (let slot = from; slot < to; slot++) {
      mutations.push({ kind, station, slot, visible: true })
    }
  } else {
    for (let slot = from - 1; slot >= to; slot--) {
      mutations.push({ kind, station, slot, visible: false })
    }
  }
  return mutations
}

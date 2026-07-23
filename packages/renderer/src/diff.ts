/**
 * LE DIFF (ADR D7 §2) — module pur.
 * =================================
 * « Chaque tick : snapshot → diff(miroir, snapshot) → n'émettre QUE les
 * mutations. » C'est ici que se joue le budget de 40 cmd/s : si rien
 * n'a changé, cette fonction renvoie un tableau vide et le tick coûte
 * ZÉRO commande.
 *
 * Ordre des mutations : construction d'abord (sinon on téléporte des
 * entités qui n'existent pas), puis compteurs, puis le cimetière — un
 * échec est l'information la plus périssable de la scène — puis carts et
 * villagers.
 */
import { GRAVE_SLOTS } from './layout.js'
import type { Mutation, StationMirror } from './mirror.js'
import type { Scene } from './scene.js'

export function diff(mirror: StationMirror, scene: Scene): Mutation[] {
  const mutations: Mutation[] = []

  // La gare n'existe pas encore : on la construit et on repart d'un
  // miroir « décor posé, rien d'affiché » pour que la suite du diff
  // émette naturellement tout le contenu.
  let cartCount = mirror.cartCount
  let workerCount = mirror.workerCount
  let graves = mirror.graves
  if (mirror.queueName !== scene.queueName) {
    mutations.push({ kind: 'build', station: scene.station, queueName: scene.queueName })
    cartCount = 0
    workerCount = 0
    graves = new Map()
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

  mutations.push(...graveMutations(graves, scene))
  mutations.push(...slotMutations('cart', scene.station, cartCount, scene.cartCount))
  mutations.push(...slotMutations('worker', scene.station, workerCount, scene.workerCount))

  return mutations
}

/**
 * LE CIMETIÈRE — diffing par IDENTITÉ, pas par position.
 * Une tombe déjà posée ne coûte plus jamais rien : seuls les `jobId` qui
 * apparaissent, et ceux qui sortent des plus récents, valent une commande.
 * Sans cela, chaque nouvel échec décalerait les 49 autres d'un cran et un
 * seul job raté coûterait 50 commandes.
 *
 * Les départs sont APPARIÉS aux arrivées : reprendre l'emplacement d'une
 * tombe qui s'en va, c'est une réécriture de texte (1 commande) au lieu
 * d'un `kill` + `setblock` + `setblock` + `summon` (4). En régime saturé —
 * le cas normal, le cimetière étant plein la plupart du temps — un échec
 * coûte donc UNE commande.
 */
function graveMutations(graves: Map<string, number>, scene: Scene): Mutation[] {
  const wanted = new Set(scene.graves.map((grave) => grave.jobId))

  // Ce qui s'en va, du plus petit emplacement au plus grand : le cimetière
  // se re-garnit ainsi de devant vers le fond, comme il s'est rempli.
  const freed: number[] = []
  for (const [jobId, slot] of graves) if (!wanted.has(jobId)) freed.push(slot)
  freed.sort((a, b) => a - b)

  const taken = new Set(graves.values())
  for (const slot of freed) taken.delete(slot)

  const mutations: Mutation[] = []
  // Un seul effet sonore et visuel par gare et par tick, quel que soit le
  // nombre d'échecs : c'est le garde-fou du budget pendant une rafale.
  let effect = true
  let next = 0

  for (const grave of scene.graves) {
    if (graves.has(grave.jobId)) continue // déjà dans le monde : rien à faire

    const recycled = freed.shift()
    let slot: number
    if (recycled === undefined) {
      while (taken.has(next)) next++
      if (next >= GRAVE_SLOTS) break // grille pleine : on ne déborde jamais
      slot = next
    } else {
      slot = recycled
    }
    taken.add(slot)

    mutations.push({
      kind: 'grave',
      station: scene.station,
      slot,
      grave,
      // Un emplacement recyclé porte déjà sa pierre et son épitaphe.
      fresh: recycled === undefined,
      effect,
    })
    effect = false
  }

  // Les emplacements libérés qu'aucune arrivée n'a repris : on les efface.
  for (const slot of freed) mutations.push({ kind: 'grave-clear', station: scene.station, slot })

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

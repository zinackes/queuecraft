/**
 * LA GÉOMÉTRIE DE LA GARE — module pur, zéro commande Minecraft.
 * =============================================================
 * Toutes les coordonnées du monde vivent ici et NULLE PART ailleurs
 * (docs/world-design.md : « Exact coordinates live in layout.ts »).
 * Un module qui ne calcule que des nombres se relit, se teste et se
 * modifie sans serveur.
 *
 * Repère : monde superflat. Le dernier bloc plein est en y = -60, donc
 * on construit à partir de y = -59 (même repère que le spike RCON).
 * Le fond du monde est en y = -64 : rien ne doit descendre plus bas,
 * sinon les entités tombent dans le vide et sont détruites.
 */

/** Un point (les entités acceptent des coordonnées à virgule). */
export interface Vec3 {
  x: number
  y: number
  z: number
}

/** Une boîte de blocs, bornes incluses (ce que mange `fill`). */
export interface Box {
  x1: number
  y1: number
  z1: number
  x2: number
  y2: number
  z2: number
}

/** Dernier bloc plein du monde plat. */
export const GROUND_Y = -60
/** Premier niveau constructible. */
export const BUILD_Y = GROUND_Y + 1
/** Niveau du dépôt : DANS la terre du monde plat, donc invisible. */
export const DEPOT_Y = -63

/** Une gare tous les 64 blocs sur l'axe X (docs/world-design.md). */
export const STATION_SPACING = 64

/**
 * Plafonds d'agrégation. Ce ne sont pas des maximums d'affichage
 * mais des maximums de COÛT : le pool d'entités est invoqué une fois
 * pour toutes à ces tailles, et un tick ne peut jamais coûter plus.
 */
export const MAX_CARTS = 12
export const MAX_WORKERS = 16

/** Espacement des minecarts sur la voie de garage, en blocs. */
const CART_SPACING = 3
/** Grille des villagers dans la zone workers. */
const WORKER_COLUMNS = 4
const WORKER_SPACING = 2

/** Limite dure de `fill` : 32 768 blocs par commande. */
export const FILL_BLOCK_LIMIT = 32_768

/** Origine X d'une gare. */
export function stationOriginX(station: number): number {
  return station * STATION_SPACING
}

/** Le quai : la dalle sur laquelle repose le panneau. */
export function platformFloor(station: number): Box {
  const x = stationOriginX(station)
  return { x1: x, y1: GROUND_Y, z1: 0, x2: x + 15, y2: GROUND_Y, z2: 5 }
}

/** La voie de garage : une ligne de rails vers Z+, où stationnent les carts. */
export function sidingRail(station: number): Box {
  const x = stationOriginX(station) + 8
  const first = cartSlot(station, 0)
  const last = cartSlot(station, MAX_CARTS - 1)
  return {
    x1: x,
    y1: BUILD_Y,
    z1: Math.floor(first.z),
    x2: x,
    y2: BUILD_Y,
    z2: Math.floor(last.z),
  }
}

/** La dalle de la zone workers, à l'est du quai. */
export function workersFloor(station: number): Box {
  const x = stationOriginX(station) + 18
  return { x1: x, y1: GROUND_Y, z1: 0, x2: x + 7, y2: GROUND_Y, z2: 7 }
}

/**
 * Emplacement d'un minecart sur la voie (slot 0 = le plus proche du quai).
 * `y` est le BAS de l'entité : le mettre à BUILD_Y le pose sur le sol,
 * au niveau du rail. Un demi-bloc plus bas, le cart est enterré (constaté
 * en relisant `Pos` dans le monde). En NoGravity, il reste exactement là.
 */
export function cartSlot(station: number, slot: number): Vec3 {
  return {
    x: stationOriginX(station) + 8.5,
    y: BUILD_Y,
    z: 8.5 + slot * CART_SPACING,
  }
}

/** Emplacement d'un villager dans la grille des workers. */
export function workerSlot(station: number, slot: number): Vec3 {
  const column = slot % WORKER_COLUMNS
  const row = Math.floor(slot / WORKER_COLUMNS)
  return {
    x: stationOriginX(station) + 18.5 + column * WORKER_SPACING,
    y: BUILD_Y,
    z: 0.5 + row * WORKER_SPACING,
  }
}

/**
 * Le dépôt : où l'on gare les entités inutilisées, sous la surface.
 * Un emplacement distinct par entité — empilées au même point, elles
 * se pousseraient les unes les autres et dériveraient.
 *
 * Pourquoi garer plutôt que tuer : `kill` sur un minecart fait TOMBER
 * l'item minecart, et cet item ne porte pas le tag `qc` — il échapperait
 * donc au nettoyage et polluerait le monde à chaque tick.
 */
export function depotSlot(station: number, kind: 'cart' | 'worker', slot: number): Vec3 {
  // 1,5 bloc entre deux carts : leur boîte de collision fait 0,98 de large,
  // et à 1 bloc d'écart ils se poussaient (dérive mesurée dans le monde).
  const spacing = kind === 'cart' ? 1.5 : 1
  return {
    x: stationOriginX(station) + 0.5 + slot * spacing,
    y: DEPOT_Y,
    z: kind === 'cart' ? 0.5 : 2.5,
  }
}

/** Ancre du titre de la gare (posé une fois, jamais mis à jour). */
export function titleAnchor(station: number): Vec3 {
  return { x: stationOriginX(station) + 8.5, y: GROUND_Y + 4.2, z: 2.5 }
}

/** Ancre du bloc de compteurs (le seul texte réécrit à chaque tick). */
export function statsAnchor(station: number): Vec3 {
  return { x: stationOriginX(station) + 8.5, y: GROUND_Y + 3.4, z: 2.5 }
}

/**
 * L'emprise au sol d'une gare : tout ce que le renderer s'autorise à
 * modifier. Sert au forceload ET au rasage du démarrage.
 */
export function stationFootprint(station: number): { x1: number; z1: number; x2: number; z2: number } {
  const x = stationOriginX(station)
  return { x1: x - 4, z1: -4, x2: x + 52, z2: 48 }
}

/**
 * Volume à vider au démarrage (stratégie « raser + redessiner », ADR D7 §4).
 * Découpé pour rester sous la limite de `fill` : 57 × 10 × 53 = 30 210 blocs.
 */
export function wipeAirVolume(station: number): Box {
  const f = stationFootprint(station)
  return { x1: f.x1, y1: BUILD_Y, z1: f.z1, x2: f.x2, y2: BUILD_Y + 9, z2: f.z2 }
}

/** Remise à zéro du sol (le quai en pierre redevient de l'herbe). */
export function wipeGroundVolume(station: number): Box {
  const f = stationFootprint(station)
  return { x1: f.x1, y1: GROUND_Y, z1: f.z1, x2: f.x2, y2: GROUND_Y, z2: f.z2 }
}

/** Nombre de blocs d'une boîte — sert à garantir qu'on tient dans un `fill`. */
export function boxVolume(b: Box): number {
  return (
    (Math.abs(b.x2 - b.x1) + 1) * (Math.abs(b.y2 - b.y1) + 1) * (Math.abs(b.z2 - b.z1) + 1)
  )
}

/** Centre de la gare, au sol : point de référence des commandes de zone. */
export function stationCenter(station: number): Vec3 {
  return { x: stationOriginX(station) + 8, y: BUILD_Y, z: 20 }
}

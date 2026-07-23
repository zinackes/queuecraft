/**
 * LE SEUL MODULE QUI PARLE MINECRAFT.
 * ===================================
 * Traduit des `Mutation` typées en commandes texte. Tout le reste du
 * renderer ignore jusqu'à l'existence de `/fill`.
 *
 * Liste blanche respectée (ADR D4 / skill qc-renderer) :
 *   forceload · fill · setblock · summon · data merge entity · kill · tp ·
 *   particle · playsound · execute (formes simples) · time · gamerule
 * `playsound` a été ajouté à la liste par l'ADR-003, qui documente aussi
 * l'enveloppe `execute … as @a[…] run` obligatoire pour les effets.
 * Rien d'autre, et rien qui soit apparu après 1.19.4 — la syntaxe
 * employée ici est vérifiée par `src/probe.ts` sur les DEUX cibles de D4.
 */
import {
  BUILD_Y,
  GROUND_Y,
  cartSlot,
  depotSlot,
  graveLabel,
  graveSlot,
  graveyardTerraces,
  platformFloor,
  sidingRail,
  stationCenter,
  stationFootprint,
  statsAnchor,
  titleAnchor,
  wipeAirVolume,
  wipeGroundVolume,
  workerSlot,
  workersFloor,
  MAX_CARTS,
  MAX_WORKERS,
  STATION_SWEEP_RADIUS,
  type Box,
  type Vec3,
} from './layout.js'
import type { Mutation } from './mirror.js'
import type { Health } from './scale.js'
import type { Grave } from './scene.js'

/** Tout ce que Queuecraft dessine porte ce tag : c'est la prise du rasage. */
export const ROOT_TAG = 'qc'

export function stationTag(station: number): string {
  return `${ROOT_TAG}-s${station}`
}

/** Tag unique par entité : `qc-s0-cart-7`. Rend chaque `tp` déterministe. */
export function slotTag(station: number, kind: 'cart' | 'worker', slot: number): string {
  return `${stationTag(station)}-${kind}-${slot}`
}

export function panelTag(station: number, part: 'title' | 'stats'): string {
  return `${stationTag(station)}-${part}`
}

/** Tag de l'épitaphe d'un emplacement de tombe : `qc-s0-grave-17`. */
export function graveTag(station: number, slot: number): string {
  return `${stationTag(station)}-grave-${slot}`
}

/** Couleur du texte et fond du panneau selon la santé (docs/world-design.md). */
const HEALTH_STYLE: Record<Health, { color: string; background: number }> = {
  healthy: { color: 'white', background: 0x50_00_33_00 | 0 },
  degraded: { color: 'gold', background: 0x50_33_22_00 | 0 },
  critical: { color: 'red', background: 0x50_33_00_00 | 0 },
}

/**
 * Le cimetière. `deepslate` pour les terrasses et `cobblestone_wall` pour
 * la pierre tombale : deux blocs d'avant 1.18, aux identifiants inchangés
 * sur les deux cibles de D4 (vérifié, ADR-003 §2). Un mur posé seul se
 * rend comme un poteau — c'est littéralement une stèle.
 */
const GRAVEYARD_BLOCK = 'deepslate'
const GRAVE_BLOCK = 'cobblestone_wall'
/** Fond de l'épitaphe : noir très opaque, pour rester lisible sur la pierre. */
const GRAVE_BACKGROUND = 0x90_11_00_00 | 0
/** Petite épitaphe : 50 tombes à l'échelle du panneau seraient illisibles. */
const GRAVE_SCALE = 0.5
/** Largeur de retour à la ligne de l'épitaphe, en pixels de la police du jeu. */
const GRAVE_LINE_WIDTH = 160

/** Coordonnée : « 8.5 », « -59 ». Pas de notation exponentielle. */
function n(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

/** `Tags:["qc","qc-s0","qc-s0-cart-3"]` — le tag racine ouvre toujours la liste. */
function tags(station: number, own: string): string {
  return `Tags:["${ROOT_TAG}","${stationTag(station)}","${own}"]`
}

function pos(v: Vec3): string {
  return `${n(v.x)} ${n(v.y)} ${n(v.z)}`
}

/**
 * Échappement SNBT. Le saut de ligne s'écrit `\n` dans la commande et le
 * serveur le stocke comme un vrai retour à la ligne (vérifié par probe.ts),
 * ce qui permet UN seul text_display pour tout le panneau — donc une seule
 * commande par tick pour les compteurs.
 */
export function escapeSnbt(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function fill(box: Box, block: string): string {
  return `fill ${n(box.x1)} ${n(box.y1)} ${n(box.z1)} ${n(box.x2)} ${n(box.y2)} ${n(box.z2)} minecraft:${block}`
}

function setblock(v: Vec3, block: string): string {
  return `setblock ${pos(v)} minecraft:${block}`
}

/**
 * Enveloppe obligatoire des effets (ADR-003 §3). `particle` et `playsound`
 * ÉCHOUENT quand personne ne les reçoit — « The particle was not visible
 * for anybody », « No player was found » — et le renderer tourne sans
 * joueur connecté la plupart du temps. Passer par `as @a[...]` fait
 * disparaître la branche silencieusement quand le serveur est vide : une
 * commande, zéro erreur, zéro spam console.
 */
function forNearbyPlayers(at: Vec3, command: string): string {
  return `execute positioned ${pos(at)} as @a[distance=..${STATION_SWEEP_RADIUS}] run ${command}`
}

/** Une matrice de transformation complète, seule forme acceptée par le jeu. */
function transformation(scale: number): string {
  const s = scale.toFixed(3)
  return `transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[${s}f,${s}f,${s}f]}`
}

/** Échelle du panneau de compteurs, alternée à chaque écriture. */
const STATS_SCALE = [1.0, 1.035] as const

export interface BootstrapOptions {
  /**
   * Met la scène en plein jour pour filmer. Faux par défaut : un
   * renderer branché sur le monde de quelqu'un d'autre n'a pas à
   * toucher à son ambiance.
   *
   * N'émet QUE `time set noon`. On voulait aussi figer le cycle
   * jour/nuit et couper les mobs, mais `gamerule` est refusé par
   * Paper 1.21.11-132 (« Incorrect argument for command », quel que
   * soit le nom de règle — mesuré, voir README du package). Une
   * commande qui ne marche pas sur une des deux cibles de D4 n'a rien
   * à faire dans le renderer.
   */
  freezeScene?: boolean
}

/**
 * Sans joueur connecté, un chunk non forceloadé est déchargé : les
 * sélecteurs n'y voient rien et les entités y sont figées. C'est donc
 * la toute première commande de la vie du renderer.
 */
function forceloadCommand(station: number): string {
  const f = stationFootprint(station)
  return `forceload add ${f.x1} ${f.z1} ${f.x2} ${f.z2}`
}

/**
 * Un run précédent a pu laisser tomber des items (un minecart tué lâche
 * son item, et cet item ne porte pas le tag `qc`). Un balayage de zone au
 * démarrage est le seul moyen de les reprendre. Le rayon couvre tout ce
 * qu'une gare dessine sans mordre sur sa voisine, à 64 blocs — les deux
 * bornes sont vérifiées par `check-pure.ts`.
 */
function sweepCommands(station: number): string[] {
  const at = pos(stationCenter(station))
  return [`execute positioned ${at} run kill @e[type=item,distance=..${STATION_SWEEP_RADIUS}]`]
}

function wipeCommands(station: number): string[] {
  return [fill(wipeAirVolume(station), 'air'), fill(wipeGroundVolume(station), 'grass_block')]
}

/**
 * DÉMARRAGE : « raser + redessiner » (ADR D7 §4).
 * Coûteux (~5 commandes par gare + le décor), mais borné et exécuté une
 * seule fois — ADR-002 autorise explicitement un premier rendu cher.
 */
export function bootstrapCommands(stations: number[], options: BootstrapOptions = {}): string[] {
  const commands: string[] = []

  if (options.freezeScene) commands.push('time set noon')

  // Charger les zones AVANT le rasage, sinon `kill` ne voit rien.
  for (const station of stations) commands.push(forceloadCommand(station))

  // Un seul `kill` global : il ramasse aussi ce qu'un run précédent
  // aurait laissé hors des gares actuelles (changement de layout).
  commands.push(`kill @e[tag=${ROOT_TAG}]`)

  for (const station of stations) commands.push(...wipeCommands(station), ...sweepCommands(station))

  return commands
}

/**
 * ARRÊT : rendre le monde tel qu'on l'a trouvé. Le `forceload remove`
 * n'est pas décoratif — laisser des chunks chargés en permanence sur le
 * serveur de quelqu'un d'autre serait un effet de bord permanent.
 */
export function teardownCommands(stations: number[]): string[] {
  const commands: string[] = [`kill @e[tag=${ROOT_TAG}]`]
  for (const station of stations) {
    commands.push(...wipeCommands(station), ...sweepCommands(station))
    const f = stationFootprint(station)
    commands.push(`forceload remove ${f.x1} ${f.z1} ${f.x2} ${f.z2}`)
  }
  return commands
}

/**
 * Préparation d'une gare apparue APRÈS le démarrage (une nouvelle queue).
 * Même travail, mais le rasage est limité à sa zone : les gares déjà
 * dessinées ne doivent pas clignoter parce qu'une voisine est née.
 */
export function stationPrepareCommands(station: number): string[] {
  return [
    forceloadCommand(station),
    `execute positioned ${pos(stationCenter(station))} run kill @e[tag=${ROOT_TAG},distance=..${STATION_SWEEP_RADIUS}]`,
    ...wipeCommands(station),
    ...sweepCommands(station),
  ]
}

/**
 * Construction d'une gare : décor + panneau + pool d'entités garées.
 * Le pool est invoqué UNE fois à sa taille maximale ; ensuite, faire
 * varier l'affichage ne coûte qu'un `tp` par entité qui bouge.
 */
export function buildStationCommands(station: number, queueName: string): string[] {
  const commands: string[] = [
    fill(platformFloor(station), 'smooth_stone'),
    fill(workersFloor(station), 'polished_andesite'),
    fill(sidingRail(station), 'rail'),
    // Les marches du cimetière : une par rangée, posées vides. Les tombes
    // n'y arriveront qu'au fil des échecs — c'est tout l'intérêt.
    ...graveyardTerraces(station).map((terrace) => fill(terrace, GRAVEYARD_BLOCK)),
  ]

  // Le titre : posé une fois, jamais réécrit — donc zéro commande par tick.
  commands.push(
    `summon minecraft:text_display ${pos(titleAnchor(station))} ` +
      `{${tags(station, panelTag(station, 'title'))},billboard:"center",alignment:"center",` +
      `see_through:false,line_width:400,text:{text:"${escapeSnbt(queueName)}",color:"aqua",bold:true},` +
      `background:${0x60_00_00_00 | 0},${transformation(1.8)}}`,
  )

  // Le bloc de compteurs : la seule entité réécrite en régime établi.
  commands.push(
    `summon minecraft:text_display ${pos(statsAnchor(station))} ` +
      `{${tags(station, panelTag(station, 'stats'))},billboard:"center",alignment:"center",` +
      `see_through:false,line_width:400,text:"",` +
      `background:${HEALTH_STYLE.healthy.background},${transformation(STATS_SCALE[0])}}`,
  )

  // Le pool. NoGravity : les entités ne tombent pas, ne dérivent pas,
  // et restent exactement là où on les téléporte.
  for (let slot = 0; slot < MAX_CARTS; slot++) {
    commands.push(
      `summon minecraft:minecart ${pos(depotSlot(station, 'cart', slot))} ` +
        `{${tags(station, slotTag(station, 'cart', slot))},NoGravity:1b}`,
    )
  }
  for (let slot = 0; slot < MAX_WORKERS; slot++) {
    commands.push(
      `summon minecraft:villager ${pos(depotSlot(station, 'worker', slot))} ` +
        `{${tags(station, slotTag(station, 'worker', slot))},Rotation:[90f,0f],` +
        `NoAI:1b,NoGravity:1b,Invulnerable:1b,Silent:1b,PersistenceRequired:1b,` +
        `VillagerData:{profession:"minecraft:librarian",level:1,type:"minecraft:plains"}}`,
    )
  }

  return commands
}

/** Traduction d'une mutation en commandes. C'est tout le contrat du module. */
export function mutationToCommands(mutation: Mutation): string[] {
  switch (mutation.kind) {
    case 'build':
      return buildStationCommands(mutation.station, mutation.queueName)

    case 'cart':
    case 'worker': {
      const target = mutation.visible
        ? mutation.kind === 'cart'
          ? cartSlot(mutation.station, mutation.slot)
          : workerSlot(mutation.station, mutation.slot)
        : depotSlot(mutation.station, mutation.kind, mutation.slot)
      return [
        `tp @e[tag=${slotTag(mutation.station, mutation.kind, mutation.slot)},limit=1] ${pos(target)}`,
      ]
    }

    case 'stats': {
      const style = HEALTH_STYLE[mutation.health]
      return [
        `data merge entity @e[tag=${panelTag(mutation.station, 'stats')},limit=1] ` +
          `{text:{text:"${escapeSnbt(mutation.text)}",color:"${style.color}"},` +
          `background:${style.background},start_interpolation:0,interpolation_duration:6,` +
          // L'échelle alterne à chaque écriture : le client interpole la
          // transformation, donc le compteur « respire » au lieu de sauter.
          `${transformation(STATS_SCALE[mutation.pulse])}}`,
      ]
    }

    case 'grave': {
      const { station, slot } = mutation
      const stone = graveSlot(station, slot)
      const label = graveLabel(station, slot)
      const commands: string[] = []

      if (mutation.fresh) {
        commands.push(
          setblock(stone, GRAVE_BLOCK),
          `summon minecraft:text_display ${pos(label)} ` +
            `{${tags(station, graveTag(station, slot))},billboard:"center",alignment:"center",` +
            `see_through:false,line_width:${GRAVE_LINE_WIDTH},text:${graveComponent(mutation.grave)},` +
            `background:${GRAVE_BACKGROUND},${transformation(GRAVE_SCALE)}}`,
        )
      } else {
        // L'emplacement est recyclé : la pierre et l'épitaphe sont déjà là,
        // seul le texte change. C'est LE cas normal en régime saturé.
        commands.push(
          `data merge entity @e[tag=${graveTag(station, slot)},limit=1] ` +
            `{text:${graveComponent(mutation.grave)}}`,
        )
      }

      if (mutation.effect) {
        commands.push(
          forNearbyPlayers(
            label,
            `particle minecraft:soul ${pos(label)} 0.35 0.5 0.35 0.02 14 force @s`,
          ),
          forNearbyPlayers(
            label,
            `playsound minecraft:block.bell.use master @s ${pos(label)} 2 1.6`,
          ),
        )
      }

      return commands
    }

    case 'grave-clear': {
      const stone = graveSlot(mutation.station, mutation.slot)
      return [
        `kill @e[tag=${graveTag(mutation.station, mutation.slot)}]`,
        setblock(stone, 'air'),
      ]
    }
  }
}

/**
 * L'épitaphe en deux tons : l'identifiant du job en gris, l'erreur en
 * rouge. Un seul `text_display` porte les deux — d'où `extra`, qui coûte
 * zéro commande de plus qu'un texte uni.
 */
function graveComponent(grave: Grave): string {
  return (
    `{text:"${escapeSnbt(grave.label)}\\n",color:"gray",bold:true,` +
    `extra:[{text:"${escapeSnbt(grave.error)}",color:"red",bold:false}]}`
  )
}

/** Coordonnées de lecture pour la vérification sans joueur (démo `--verify`). */
export const inspect = {
  cartPresent(station: number, slot: number): string {
    return `execute if entity @e[tag=${slotTag(station, 'cart', slot)},limit=1]`
  },
  cartAtSlot(station: number, slot: number): string {
    return `data get entity @e[tag=${slotTag(station, 'cart', slot)},limit=1] Pos[2]`
  },
  statsText(station: number): string {
    return `data get entity @e[tag=${panelTag(station, 'stats')},limit=1] text`
  },
  /** « Test passed » si cet emplacement de tombe est occupé dans le monde. */
  gravePresent(station: number, slot: number): string {
    return `execute if entity @e[tag=${graveTag(station, slot)},limit=1]`
  },
  graveText(station: number, slot: number): string {
    return `data get entity @e[tag=${graveTag(station, slot)},limit=1] text`
  },
  /** Où un cart visible doit se trouver (axe Z), pour comparer à la lecture. */
  expectedCartZ(station: number, slot: number): number {
    return cartSlot(station, slot).z
  },
  /** Bornes utiles au diagnostic manuel. */
  groundY: GROUND_Y,
  buildY: BUILD_Y,
}

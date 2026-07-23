---
name: qc-renderer
description: Règles et patterns pour tout code qui dessine dans le monde Minecraft via RCON (renderer, effets, display entities). Utiliser pour créer ou modifier du rendu, choisir des commandes Minecraft, ou débugger un affichage en jeu.
---

# Renderer Queuecraft — règles de rendu RCON (v2)

## RÈGLE ZÉRO : aucune entité mobile ou à IA (CLAUDE.md règle 8)
Le renderer ne dessine QU'avec des primitives inertes. Une entité qui tick une IA, se déplace seule, ou subit la physique lague le serveur ET le client, et casse le diffing (position non déterministe).

- **INTERDIT** : `summon minecart`, `summon villager`, `summon armor_stand`, et toute entité vivante / à pathfinding / soumise à la gravité. Pas de carts « qui roulent », pas de mobs figés par `NoAI`, pas d'armor stands.
- **AUTORISÉ** : `text_display`, `block_display`, `item_display` (display entities, zéro IA, zéro tick de logique), `setblock` / `fill`, `bossbar`, `particle`, `weather`.

Un « cart » de la métaphore d'agrégation = un `block_display` (modèle de minecart en item ou bloc), jamais une vraie entité minecart.

## Liste blanche de commandes (ADR D4 — rien d'autre sans nouvel ADR)
`setblock`, `fill`, `summon` (display entities uniquement), `data get|merge|modify`, `kill`, `bossbar`, `scoreboard`, `tellraw`, `particle`, `weather`, `forceload`, `time`, `gamerule`, `execute` (formes simples).
Interdits : toute commande apparue après 1.21, toute API de plugin, tout NBT exotique non testé sur 1.21.11 ET 26.2, et tout `summon` d'entité non-display (cf. Règle Zéro).

## Primitives d'affichage
- **Compteurs / labels** : `text_display`. Summon UNE fois avec un tag unique (`Tags:["qc","qc-<id>"]`), puis mise à jour par `data merge entity` — jamais de re-summon.
- **Volumes / jauges** : blocs via `fill` (1 commande = des centaines de blocs), ou `block_display` pour un volume lisse. Échelle logarithmique pour les compteurs de backlog.
- **Icônes / carts d'agrégation** : `item_display` / `block_display` taggés `qc`.
- **Jobs failed** : 1 tombe = 1 job (max 50), `text_display` au-dessus avec `queue`, `jobId` court, erreur tronquée à 120 caractères.
- Toujours `forceload add` sur la zone de rendu au démarrage (le monde doit vivre sans joueur connecté).

## Animation : data merge, jamais recréation
Ne JAMAIS `kill` + re-`summon` pour animer un changement — c'est un flash côté client et un gaspillage de commandes RCON.

- Anime en mutant l'entité existante par `data merge entity <uuid|selector> {...}`.
- Déplacement / échelle : régler la `transformation` et laisser **`interpolation_duration`** (+ `start_interpolation`) lisser la transition côté client.
- Repositionnement dur : **`teleport_duration`** sur le display pour glisser au lieu de sauter.
- Le serveur n'anime rien : il pose la valeur cible + la durée, le client interpole tout seul (coût serveur nul, coût client borné).

## Culling des display entities (bug Sodium)
Chaque display doit porter un **culling bounding box** explicite via `width` et `height`.

- Régler **`width=0` et `height=0`** → le client ne cull jamais l'entité sur sa boîte (rendu toujours visible, comportement stable).
- **JAMAIS de valeurs énormes** (ex. `width=64`) : sous Sodium ça gonfle la bounding box de culling et provoque des artefacts / drops de FPS. Petit ou zéro, jamais géant.

## Discipline de la boucle de rendu (ADR D7)
1. État miroir en mémoire = ce qui est réellement dessiné. Toute commande envoyée met à jour le miroir.
2. Chaque tick de rendu (500 ms) : snapshot → diff(miroir, snapshot) → n'émettre QUE les mutations.
3. Budget : ≤ 40 cmd/s soutenu, et **une seule commande en vol** (`maxPending: 1` sur rcon-client). Le pipelining n'est pas lent, il est cassé : le serveur ferme la connexion dès 2 commandes en vol sur 1.21.11, 3 sur 26.2 ([ADR-002](../../../docs/ADR-002-debit-rcon-reel.md) §3). Le budget se tient par un throttle côté daemon, pas par la taille des rafales. Listener `rcon.on('error')` obligatoire : sans lui, l'EPIPE asynchrone tue le process.
4. Idempotence : un redémarrage du daemon doit pouvoir reconstruire le miroir en relisant les entités taguées `qc` (`data get`) OU tout raser (`kill @e[tag=qc]` + `fill air`) et redessiner. Choisir raser+redessiner par défaut (plus simple, coût borné).
5. Tout nombre affiché est formaté côté daemon (ex. `12.4k`), jamais de logique dans le jeu.

## Perf : mesurer avant d'optimiser (CLAUDE.md règle 9)
Aucune optimisation de rendu sans profil spark préalable (`spark profiler` en headless via la console). Établir le MSPT de base, isoler la contribution du renderer, PUIS optimiser la source mesurée — pas une hypothèse. Cf. mémoire `spark-perf-baseline`.

## Vérifications avant de conclure une tâche de rendu
- `pnpm -r typecheck` passe.
- Aucune entité mobile / à IA summonée (grep le code : pas de `summon minecart|villager|armor_stand`).
- Test manuel : lancer le serveur du spike, exécuter le rendu, vérifier en jeu OU par `data get` que les entités attendues existent.
- Compter les commandes émises sur 30 s de régime stable : consigner le chiffre dans la PR/carte, refuser si > 40/s.

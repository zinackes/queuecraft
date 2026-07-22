---
name: qc-renderer
description: Règles et patterns pour tout code qui dessine dans le monde Minecraft via RCON (renderer, effets, display entities). Utiliser pour créer ou modifier du rendu, choisir des commandes Minecraft, ou débugger un affichage en jeu.
---

# Renderer Queuecraft — règles de rendu RCON

## Liste blanche de commandes (ADR D4 — rien d'autre sans nouvel ADR)
`setblock`, `fill`, `summon`, `data get|merge|modify`, `kill`, `tp`, `bossbar`, `scoreboard`, `tellraw`, `particle`, `forceload`, `time`, `gamerule`, `execute` (formes simples).
Interdits : toute commande apparue après 1.21, toute API de plugin, tout NBT exotique non testé sur 1.21.11 ET 26.2.

## Primitives d'affichage
- **Compteurs / labels** : `text_display` (jamais de panneaux). Summon une fois avec un tag unique (`Tags:["qc","qc-<id>"]`), puis mise à jour par `data merge entity` — l'interpolation anime le changement côté client.
- **Volumes / jauges** : blocs via `fill` (1 commande = des centaines de blocs). Échelle logarithmique pour les compteurs de backlog.
- **Jobs failed** : 1 tombe = 1 job (max 50), text_display au-dessus avec `queue`, `jobId` court, erreur tronquée à 120 caractères.
- Toujours `forceload add` sur la zone de rendu au démarrage (le monde doit vivre sans joueur connecté).

## Discipline de la boucle de rendu (ADR D7)
1. État miroir en mémoire = ce qui est réellement dessiné. Toute commande envoyée met à jour le miroir.
2. Chaque tick de rendu (500 ms) : snapshot → diff(miroir, snapshot) → n'émettre QUE les mutations.
3. Budget : ≤ 40 cmd/s soutenu, et **une seule commande en vol** (`maxPending: 1` sur rcon-client). Le pipelining n'est pas lent, il est cassé : le serveur ferme la connexion dès 2 commandes en vol sur 1.21.11, 3 sur 26.2 ([ADR-002](../../../docs/ADR-002-debit-rcon-reel.md) §3). Le budget se tient donc par un throttle côté daemon, pas par la taille des rafales. Listener `rcon.on('error')` obligatoire : sans lui, l'EPIPE asynchrone tue le process.
4. Idempotence : un redémarrage du daemon doit pouvoir reconstruire le miroir en relisant les entités taguées `qc` (`data get`) OU tout raser (`kill @e[tag=qc]` + `fill air`) et redessiner. Choisir raser+redessiner par défaut (plus simple, coût borné).
5. Tout nombre affiché est formaté côté daemon (ex. `12.4k`), jamais de logique dans le jeu.

## Vérifications avant de conclure une tâche de rendu
- `pnpm -r typecheck` passe.
- Test manuel : lancer le serveur du spike, exécuter le rendu, vérifier en jeu OU par `data get` que les entités attendues existent.
- Compter les commandes émises sur 30 s de régime stable : consigner le chiffre dans la PR/carte, refuser si > 40/s.

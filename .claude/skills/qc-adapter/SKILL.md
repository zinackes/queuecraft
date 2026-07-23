---
name: qc-adapter
description: Contrat et checklist pour écrire ou modifier un adapter Queuecraft (pg-boss, BullMQ, ou nouvelle techno de queue). Utiliser dès qu'on touche packages/adapter-* ou l'interface Adapter du core.
---

# Adapters Queuecraft — contrat et checklist (v2)

## Le contrat (packages/core/src/adapter.ts)
Un adapter traduit UNE techno de queue vers le modèle pivot. Il implémente :
`name`, `start()`, `stop()`, `snapshot()`, `recentFailures(limit)`, et en option `onEvent()` + `actions`.
Objectif de taille : ~100-150 lignes. Si ça dépasse 250, quelque chose est au mauvais endroit (probablement du travail qui appartient au renderer ou au core).

## Règles
1. `snapshot()` est appelé toutes les ~500 ms : AUCUN travail lourd dedans. Si la techno est chère à interroger, mettre en cache interne et rafraîchir en tâche de fond.
2. Jamais de dépendance de core vers l'adapter. L'adapter importe `@queuecraft/core`, point.
3. Les erreurs réseau de la techno sous-jacente ne doivent JAMAIS crasher le daemon : catch, log, retourner le dernier snapshot connu avec `capturedAt` inchangé.
4. Tronquer `error` des FailedJobDetail à 200 caractères côté adapter.
5. Toute évolution de l'interface Adapter = mise à jour de TOUS les adapters existants dans le même commit (l'interface n'est gelée qu'après BullMQ, cf. ADR D6).
6. **Modèle pivot agnostique du rendu** (complément adapter de la règle 8 « zéro entité mobile/IA », cf. skill `qc-renderer`) : un snapshot ne transporte que des nombres et des faits (compteurs, débits, échantillons de failed). JAMAIS de présupposé visuel — pas de coordonnées, pas de type d'entité, pas de « cart », pas de couleur. Comment un compteur devient une tombe ou un `block_display` est la seule affaire du renderer.

## Spécifique pg-boss (v12)
- Lire les stats via `getQueues()` + `getQueueStats(name)` (renvoie queued/ready/active/failed/deferred). Mapper : waiting = queued+ready, delayed = deferred.
- Événements temps réel : s'abonner à l'event `wip` de l'instance PgBoss (état des workers, lastError).
- Historique (mur de lampes) : option `persistQueueStats` + `getQueueStats(name, { maxDataPoints })`.
- Actions phase 2 : `retry()`, `cancel()` natifs — ne pas réécrire de SQL.
- pg-boss v12 exige Node ≥ 22.12 ; import : `const { PgBoss } = require('pg-boss')` / `import { PgBoss } from 'pg-boss'`.

## Spécifique BullMQ (v5)
- Compteurs : `queue.getJobCounts()`. Workers : `queue.getWorkers()`. Débit : `queue.getMetrics('completed')`.
- Événements : classe `QueueEvents` (connexion Redis dédiée) — écouter `completed`, `failed`.

## Checklist de fin
- [ ] `pnpm -r typecheck` passe
- [ ] Adapter testé contre une instance réelle (PGlite pour pg-boss, Redis Docker pour BullMQ)
- [ ] `snapshot()` < 50 ms en local, mesuré et consigné
- [ ] Aucun import de l'adapter dans core (vérifier avec grep)
- [ ] Le snapshot ne contient aucune donnée de rendu (coordonnées, type d'entité, style) — modèle pivot pur

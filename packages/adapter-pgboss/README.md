# @queuecraft/adapter-pgboss

L'adapter [pg-boss](https://github.com/timgit/pg-boss) v12 → modèle pivot Queuecraft.
Première implémentation réelle du contrat `Adapter` de `@queuecraft/core`.

```ts
import { PgBossAdapter } from '@queuecraft/adapter-pgboss'

const adapter = new PgBossAdapter({ connectionString: process.env.DATABASE_URL })
await adapter.start()
await adapter.snapshot() // → QueueSnapshot[]
```

pg-boss est une **peer dependency** : c'est ta version qui est utilisée.

## Deux modes

| | `{ connectionString }` | `{ boss }` |
|---|---|---|
| Qui possède l'instance | l'adapter (start/stop compris) | toi |
| `workers` | `null` — observateur distant | le nombre réel |
| Cas d'usage | daemon Queuecraft séparé | dashboard embarqué dans le processus des workers |

## Le mapping

| Modèle pivot | pg-boss v12 | |
|---|---|---|
| `waiting` | `readyCount` | jobs exécutables **maintenant** |
| `delayed` | `deferredCount` | `startAfter` dans le futur |
| `active` | `activeCount` | |
| `failed` | `failedCount` | échecs encore retenus en table |
| `completed` | `totalCount − queuedCount − activeCount − failedCount` | |
| `workers` | entrées `wip` à l'état `active` sur cette queue | |
| `throughputPerMin` | pente de `completed` sur 60 s | calculée par l'adapter |

Trois points méritent une explication.

**`waiting` = `ready`, pas `queued + ready`.** En v12, `queuedCount` **contient** les
différés et `readyCount = queued − deferred`. Additionner les deux compterait deux fois
tout job exécutable. Avec ce mapping, `waiting + delayed = queued` exactement — vérifié
par un test contre le SQL.

**`completed` n'existe pas dans pg-boss.** Aucun compteur n'est tenu ; ce qu'on
déduit, c'est « les lignes encore en table qui ne sont ni en attente, ni actives, ni en
échec » — donc terminés **et** annulés, bornés par la rétention de la queue
(`deleteAfterSeconds`, 7 jours par défaut). Ce n'est pas un total historique.

**`throughputPerMin` est calculé ici.** Le compteur ci-dessus n'est pas monotone (la
maintenance pg-boss purge les vieux terminés), donc l'adapter en reconstruit un qui
l'est — seules les hausses sont cumulées — et en prend la pente sur une fenêtre
glissante de 60 s. `null` tant que la fenêtre fait moins de 5 s.

## Fraîcheur des compteurs

L'adapter lit `getQueues()`, c'est-à-dire le **cache** que pg-boss maintient sur sa table
`queue` — une lecture de quelques lignes, indépendante de la taille de la table des jobs
(~0,5 ms en local). Ce cache est rafraîchi par le moniteur de pg-boss.

> Pour un rendu à 2 Hz, l'instance doit tourner avec `supervise: true` et
> `monitorIntervalSeconds: 1`. Sinon les compteurs sont figés jusqu'à une minute
> (défaut pg-boss) et la gare ne bouge pas. En mode `connectionString`, l'adapter
> configure ça lui-même.

## Garanties

- **`snapshot()` ne parle jamais à Postgres.** Une boucle de fond (`refreshMs`, 500 ms par
  défaut) alimente un cache ; `snapshot()` le rend tel quel. Mesuré à **0,004 ms/appel**
  (budget de la skill : < 50 ms).
- **Une panne réseau ne casse rien.** Un rafraîchissement en échec laisse le cache
  intact, `capturedAt` compris : le monde continue d'afficher le dernier état connu et
  `onError` est appelé. Vérifié par un test qui coupe la base sous l'adapter.
- **`error` tronqué à 200 caractères**, côté adapter.
- **50 échecs maximum**, quelle que soit la `limit` demandée (ADR D7).
- **`onEvent`** émet `job_failed` pour les échecs jamais vus — jamais l'historique déjà
  présent au démarrage. pg-boss ne permet pas d'identifier un job terminé, donc
  `job_completed` n'est pas émis : le rendu n'en dépend pas.

## Ce qui n'est pas là

Les **actions** (`retry`, `cancel`) sont natives dans pg-boss et réservées à la phase 2 :
volontairement non câblées.

## Lire les échecs

pg-boss n'expose pas « les N derniers échecs » (`findJobs` ne filtre pas par état et ne
borne pas), donc l'adapter lit directement sa table — dont pg-boss lui-même donne le nom
(`QueueResult.table`). C'est le seul SQL du package : un `SELECT ... WHERE state='failed'
ORDER BY completed_on DESC LIMIT 50`, groupé par table pour gérer les queues partitionnées.
Schéma et table sont validés avant interpolation.

## Tests

```bash
pnpm --filter @queuecraft/adapter-pgboss test
```

Aucune infra : [PGlite](https://pglite.dev) est un Postgres complet en WASM, in-process,
officiellement supporté par pg-boss v12. Deux queues sont semées (une partitionnée, une
non — donc deux tables), consommées, avec des échecs réels ; **chaque compteur du modèle
pivot est comparé à un `GROUP BY` sur la table des jobs.**

## Démo

```bash
cd spikes/rcon-benchmark && docker compose up -d   # serveur Minecraft jetable
pnpm --filter @queuecraft/adapter-pgboss demo      # --keep pour garder la gare
```

Une vraie queue pg-boss (montée en charge → régime stable → burst → drain → workers qui
partent) rendue dans le monde par le renderer P1, qui ne sait pas que pg-boss existe.
Se terminer par une vérification sans joueur : le nombre de carts dans le monde doit
correspondre au backlog réellement en base.

```
VERDICT : OK — régime stable à 1.6 cmd/s de moyenne, pic 3/s (budget 40/s),
et la gare montre bien 9 carts pour 698 jobs réellement en attente.
```

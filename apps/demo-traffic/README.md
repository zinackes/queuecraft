# @queuecraft/demo-traffic

Trois queues pg-boss qui vivent, sur un Postgres qu'on n'installe pas.
De quoi développer le renderer et filmer une démo sans attendre qu'un vrai
système de production veuille bien avoir un pic de charge.

```bash
pnpm demo:traffic                  # tableau de bord texte, rien d'autre à lancer
pnpm demo:traffic --render         # + le monde Minecraft (serveur RCON requis)
pnpm demo:traffic --render --keep  # ... sans raser les gares en sortant
```

```
  Queuecraft · trafic de démo · PGlite in-process · FAIL_RATE 8 % · seed 2026   t+03:12

  queue       in/s  out/s  waiting  active     done  failed  crew  vague — jobs/s injectés (26 s)
  scraping     5.9    4.2       74      10      612      54    10  ▂▃▄▅▆▇█▇▆▅▄▃▃▂▂▁▁▂▃▄▅▆▇█
  emails       1.2    2.5        0       3      331      27     6  ▅▄▃▂▂▁▁▁▂▂▃▄▅▆▇█▇▆▅▄▃▂▂▁
  reports      1.4    1.2        6       3      168      12     3  ▃▄▅▆▇█▇▇▆▅▄▄▃▃▂▂▂▃▃▄▅▆▇█

  derniers échecs
    scraping  a41f9c02  HTTP 429 Too Many Requests — retry-after: 63s
    emails    7d0e1b55  SMTP 550 5.1.1 <grace.318@mail.invalid>: recipient address rejected: user unknown
    reports   1c9a4e70  canceling statement due to statement timeout (30s) — churn-cohorts-91
```

## Ce que ça fait

- **PGlite** : un Postgres complet compilé en WASM, dans le processus. Zéro conteneur,
  zéro `DATABASE_URL`, zéro nettoyage — pg-boss v12 le prend en charge officiellement.
  `DATABASE_URL=postgres://...` bascule sur un vrai serveur si tu préfères.
- **Trois queues** — `scraping`, `emails`, `reports` — avec chacune son débit, sa
  respiration (sinusoïde de période différente) et son catalogue d'erreurs.
- **Un producteur à débit variable** : sinusoïde + bursts aléatoires (×3 à ×6 pendant
  4 à 10 s). Le débit moyen reste sous la capacité des workers et le pic passe
  au-dessus : c'est ce qui fait monter puis redescendre le backlog, donc des
  **vagues de carts** plutôt qu'une voie saturée en permanence.
- **De vrais workers** pg-boss, un job à la fois, durée tirée entre 0,2 et 3 s.
- **De vrais échecs**, 8 % par défaut, avec des messages qui ressemblent à ce qu'on
  lit vraiment en production (`ETIMEDOUT`, `HTTP 429`, `SMTP 550`, `statement timeout`,
  CSV malformé…) — de quoi graver des tombes lisibles.
- **Un tableau de bord texte** qui se lit sans Minecraft, et qui affiche la mémoire :
  c'est lui qui répond à « est-ce que ça tient 5 minutes sans fuir ? ».

Le générateur ne touche QUE la queue. Les compteurs affichés viennent de la base,
via `PgBossAdapter` et le modèle pivot — les mêmes que ceux envoyés dans le monde.
Rien n'est simulé côté données.

## Réglages

| Variable | Défaut | Effet |
|---|---|---|
| `FAIL_RATE` | `8%` | Part des jobs qui échouent. `0.08`, `8` et `8%` sont équivalents. |
| `RATE_SCALE` | `1` | Multiplie tous les débits (`0.3` = tournage calme, `3` = déluge). |
| `JOB_MIN_MS` / `JOB_MAX_MS` | `200` / `3000` | Durée d'un job. |
| `SEED` | aléatoire | Rejoue exactement les mêmes vagues (la graine est affichée à l'arrêt). |
| `DURATION_S` | `0` | Arrêt automatique après N secondes. `0` = jusqu'à Ctrl-C. |
| `DATABASE_URL` | — | Utilise ce Postgres au lieu de PGlite. |
| `RCON_HOST` / `RCON_PORT` / `RCON_PASSWORD` | `127.0.0.1` / `25575` / mot de passe du spike | Seulement avec `--render`. |

## Colonnes du tableau de bord

| Colonne | D'où ça vient |
|---|---|
| `in/s` | Le producteur : ce qu'on a inséré, mesuré sur 10 s. |
| `out/s` | L'adapter : `throughputPerMin / 60`, donc ce que la base a vraiment réglé. |
| `waiting` `active` `done` `failed` | `QueueSnapshot.counts` — le modèle pivot, tel quel. |
| `crew` | `QueueSnapshot.workers` : les workers pg-boss de ce processus. |
| `vague` | Historique de `in/s`. C'est la respiration du producteur, pas la queue. |

`in/s` et `out/s` mesurent deux choses différentes exprès : quand `in` dépasse `out`,
le backlog monte, et c'est exactement ce que la voie de garage doit montrer en jeu.

## Mémoire

PGlite réserve son arène WASM au démarrage (~700 Mo de rss) puis en rend une bonne
partie : la dérive vue depuis t=0 est donc **négative** et ne veut rien dire. Le
tableau de bord affiche la valeur courante et son pic ; le verdict de fuite est
calculé à l'arrêt **sur la seconde moitié du run**, seule fenêtre en régime établi.

La taille de la base est bornée par `deleteAfterSeconds: 900` sur chaque queue :
un job réglé disparaît au bout d'un quart d'heure, donc un run long se stabilise
au lieu de gonfler indéfiniment.

## Avec Minecraft

```bash
cd spikes/rcon-benchmark && docker compose up -d && cd ../..
pnpm demo:traffic --render
# en jeu, sur localhost:25565 :  /tp @s 8 -50 -14
```

Trois queues = trois gares, une tous les 64 blocs sur l'axe X. Le renderer tourne à
2 Hz et ne dessine que les mutations (ADR D7). Les tombes attendent la carte
« cimetière » du renderer : `recentFailures()` remonte déjà les échecs, mais la
`Scene` ne les projette pas encore — pour l'instant les erreurs ne se voient que
dans le tableau de bord.

À l'arrêt, la démo relit le monde par RCON et compare, gare par gare, les carts
réellement posés sur la voie à `cartsForBacklog(waiting)`. C'est la seule
vérification qui ne fait pas confiance au miroir du renderer.

## Mesuré

Sur `seed 2026`, Node 22, PGlite, Paper 1.21.11 en Docker local :

| | |
|---|---|
| Run de 5 min sans rendu | 2 940 jobs insérés, 2 906 réglés, 8,4 % d'échecs (`FAIL_RATE=8%`), aucun crash |
| Dérive mémoire | +1,7 Mo/min sur la seconde moitié du run — la table des jobs se remplit jusqu'à son plateau de rétention (15 min) |
| Backlog observé | de 0 à ~280 jobs en attente sur `scraping` selon la vague, soit 0 à 8 carts |
| Budget RCON, 3 gares | 3 à 7 cmd/s en moyenne, **pic 10 cmd/s** pour un budget de 40 (ADR D7), 0 commande refusée |
| Monde vs queue | 9 carts pour 521 jobs en attente, 6 pour 50, 4 pour 18 — l'échelle log tombe juste |

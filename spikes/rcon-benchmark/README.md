# Spike — benchmark RCON

Répond à UNE question : combien de commandes par seconde le canal
RCON encaisse-t-il vraiment ? (L'ADR-001/D7 parie sur 40 cmd/s.)

## Lancer

```bash
# 1. Démarrer le serveur Minecraft jetable (1-2 min au premier lancement)
docker compose up -d
docker compose logs -f     # attendre la ligne "RCON running on 0.0.0.0:25575"

# 2. Lancer le benchmark
pnpm install
pnpm bench
```

Optionnel : se connecter en jeu sur `localhost:25565` pour VOIR les
blocs se poser pendant la mesure.

Tester aussi sur la version 26.2 (cible n°2 de l'ADR-001/D4) :

```bash
docker compose down -v
MC_VERSION=26.2 docker compose up -d
pnpm bench
```

## Ce que mesurent les scénarios

- **A séquentiel** : on attend chaque réponse avant d'envoyer la
  suivante. Hypothèse : plafonne vers ~20 cmd/s (le serveur bat à
  20 ticks/seconde).
- **B pipeliné** : jusqu'à 8 commandes "en vol" sur une connexion.
- **C multi-connexions** : 2 connexions RCON en parallèle.
- **D soutenu** : débit tenu pendant 10 s (le chiffre qui compte
  pour la boucle de rendu).
- **E /fill** : rappel qu'UNE commande bien choisie remplace 512
  `setblock` — l'agrégation est la vraie optimisation.

## Résultats (à remplir après exécution)

| Scénario | 1.21.11 | 26.2 |
|---|---|---|
| A séquentiel | ... cmd/s | ... |
| B pipeliné ×8 | ... | ... |
| C 2 conn ×8 | ... | ... |
| D soutenu 10 s | ... | ... |

Verdict : budget 40 cmd/s → tenu / à revoir.

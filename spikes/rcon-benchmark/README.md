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
  suivante. Hypothèse de départ : plafonne vers ~20 cmd/s (le serveur
  bat à 20 ticks/seconde). **Fausse** — voir résultats.
- **B pipeliné** : jusqu'à 8 commandes "en vol" sur une connexion.
  **Impossible** : le serveur ferme la connexion. Conservé comme
  échec documenté, pas retiré.
- **C multi-connexions** : 2 connexions RCON en parallèle, chacune
  séquentielle (seule forme de parallélisme qui marche).
- **D soutenu** : débit tenu pendant 10 s (le chiffre qui compte
  pour la boucle de rendu), sur 1 puis 4 connexions.
- **E /fill** : rappel qu'UNE commande bien choisie remplace 512
  `setblock` — l'agrégation est la vraie optimisation.

## Scripts annexes

Deux scripts jetables écrits pendant le spike pour ne pas consigner
des chiffres invérifiés :

```bash
pnpm tsx src/pending-sweep.ts    # à partir de combien de commandes en vol ça casse ?
pnpm tsx src/verify-effects.ts   # les blocs sont-ils VRAIMENT posés ?
```

`verify-effects` est le garde-fou important : les débits mesurés sont
si élevés (>1000 cmd/s) qu'il fallait écarter l'hypothèse « le serveur
accuse réception sans rien faire ». Il repose N blocs puis relit le
monde un par un via `execute if block`. Résultat : 300/300 présents.

## Résultats — mesurés le 22/07/2026

Machine : WSL2 (Linux 6.18), Docker 29.5, Node 22.22, serveur en local
(127.0.0.1), **aucun joueur connecté**, monde plat, 2 Go de RAM.
Médiane de 3 runs par version.

| Scénario | Paper 1.21.11-132 | Paper 26.2-65 |
|---|---|---|
| A séquentiel (1 conn, 1 en vol) | **1 213 cmd/s** (lat. moy 0,8 ms) | **1 433 cmd/s** (lat. moy 0,7 ms) |
| B pipeliné ×8 (1 conn) | **ÉCHEC** — connexion fermée | **ÉCHEC** — connexion fermée |
| C 2 conn séquentielles | **2 882 cmd/s** | **2 942 cmd/s** |
| D soutenu 10 s (1 conn) | **2 673 cmd/s** | **2 341 cmd/s** |
| D' soutenu 10 s (4 conn) | **10 184 cmd/s** | **9 782 cmd/s** |
| E `/fill` de 512 blocs | 512 blocs en **3 ms** | 512 blocs en **3 ms** |
| Seuil de casse du pipelining | casse dès **2** en vol | casse dès **3** en vol |

Un run à froid supplémentaire (JIT + chunks non chargés) donnait
A = 332 cmd/s sur 1.21.11 ; écarté du tableau, mais il montre que le
premier passage de la boucle de rendu sera nettement plus lent.

### Verdict : D7 confirmé, mais pour une autre raison que prévu

Le pire débit soutenu mesuré est **2 341 cmd/s** — soit **58 fois** le
budget de 40 cmd/s de l'ADR-001/D7. Le budget est donc tenu très
largement, sur les deux cibles de compatibilité (D4).

Trois surprises, détaillées dans [ADR-002](../../docs/ADR-002-debit-rcon-reel.md) :

1. **RCON n'est pas lent.** L'ADR-001/D3 annonçait « quelques dizaines
   de commandes/seconde ». C'est faux d'environ deux ordres de grandeur.
2. **Le pipelining est impossible**, pas juste inutile : le serveur ferme
   la connexion. L'hypothèse de départ du spike (« pipeliner devrait faire
   beaucoup mieux ») était exactement à l'envers.
3. **Le seul parallélisme praticable, ce sont plusieurs connexions**,
   chacune strictement séquentielle. Ça monte linéairement (×4 connexions
   ≈ ×4 débit).

⚠️ Ces chiffres viennent d'un serveur **au repos, sans joueur**. Un
serveur réel a beaucoup moins de marge par tick. Ils prouvent que le
canal RCON n'est pas le goulot d'étranglement — pas qu'on peut arroser
un serveur de production sans conséquence.

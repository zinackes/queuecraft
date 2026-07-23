# Queuecraft — CLAUDE.md

Dashboard de job queues rendu DANS un monde Minecraft (objet culte fonctionnel, pas un outil de prod).
Monorepo pnpm : `packages/core` (modèle pivot + interface Adapter), `packages/adapter-*`, `spikes/*`, `apps/demo`.
Toutes les décisions structurantes sont dans `docs/ADR-001-fondations-queuecraft.md` — le lire avant tout travail d'architecture. Ne jamais contredire un ADR sans en écrire un nouveau qui le remplace.

## Commandes
- `pnpm -r typecheck` — typecheck de tous les packages (doit passer avant tout commit)
- `pnpm bench` (dans `spikes/rcon-benchmark`) — benchmark RCON
- Serveur MC jetable : `docker compose up -d` dans `spikes/rcon-benchmark` (RCON sur 127.0.0.1:25575, mdp `queuecraft-spike`)

## Règles non négociables
1. **Vanilla-stable only** (ADR D4) : uniquement des commandes Minecraft stables depuis des années (`setblock`, `fill`, `summon`, `data`, `bossbar`, `scoreboard`, `tellraw`, `particle`). Compat visée : Paper 1.21.11 ET 26.2. Toute nouvelle commande → vérifier qu'elle existe telle quelle dans les deux.
2. **Budget RCON** (ADR D7) : ≤ 40 cmd/s en régime de croisière. Diffing obligatoire (ne renvoyer que les mutations), agrégation obligatoire (1 cart = N jobs, échelle log). Jamais de rendu 1:1 des jobs sauf les failed (max 50).
3. **Runtime** (ADR D8) : Node ≥ 22.12, zéro API spécifique Bun dans le code (`Bun.serve` interdit). TypeScript strict.
4. **`packages/core` n'importe JAMAIS une techno de queue.** Les adapters dépendent de core, jamais l'inverse.
5. **Interface `Adapter` gelée seulement après 2 implémentations** (pg-boss puis BullMQ). D'ici là, la faire évoluer est permis mais chaque changement se répercute sur tous les adapters existants dans le même commit.
6. Sécurité : le port RCON n'est JAMAIS exposé publiquement (127.0.0.1 ou réseau Docker interne). Le mot de passe RCON vient d'une variable d'env, jamais en dur hors des fichiers de spike/démo.
7. Un seul CLAUDE.md (celui-ci). Pas de CLAUDE.md par sous-dossier.
8. **Zéro entité mobile ou à IA dans le renderer** : uniquement des primitives inertes (`text_display`/`block_display`/`item_display`, `setblock`/`fill`, `bossbar`, `particle`, `weather`). Interdits : `summon minecart|villager|armor_stand` et toute entité qui tick une IA, se déplace ou subit la gravité. Animation par `data merge` (interpolation), jamais par recréation. Détails : skill `qc-renderer`.
9. **Profiling spark obligatoire avant toute optimisation perf** : aucune optimisation de rendu ou serveur sans profil spark préalable qui mesure le MSPT de base et isole la source réelle. On optimise ce qui est mesuré, pas ce qu'on suppose.

## Workflow
- Modèle : Opus planifie (plan mode), Sonnet exécute. Les cartes Notion de la roadmap contiennent les prompts ; quand une carte commence par un slash command (`/qc-renderer`, `/qc-adapter`), l'invoquer tel quel en première ligne.
- Après chaque carte terminée : `pnpm -r typecheck`, mettre à jour le README du package touché si le comportement public a changé.

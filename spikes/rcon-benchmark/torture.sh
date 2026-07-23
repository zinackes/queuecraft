#!/usr/bin/env bash
#
# TORTURE DE RÉSILIENCE RCON — vrai serveur Minecraft, 10 coupures.
# ================================================================
# Le test « qui compte » de la carte : on coupe et on relance le serveur MC
# CYCLES fois d'affilée pendant que le daemon (demo:traffic --render) tourne
# sous trafic, et on vérifie à chaque retour :
#
#   • 0 crash Node          → le PID du daemon est toujours vivant.
#   • resync automatique     → le monde contient à nouveau des entités `qc`,
#                              et le journal du daemon montre un « reconnecté ».
#
# Le pendant rapide et déterministe (sans Docker) est
# `packages/renderer/src/torture.ts` (pnpm --filter @queuecraft/renderer torture).
#
# Usage :   ./torture.sh              # 10 cycles, coupures de 5 s
#           CYCLES=3 ./torture.sh     # version courte pour un essai
#
# Prérequis : Docker, pnpm i déjà fait. Le serveur est démarré/arrêté par ce
# script ; à la fin il est laissé debout (docker compose down pour l'éteindre).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CYCLES="${CYCLES:-10}"
DOWN_SECONDS="${DOWN_SECONDS:-5}"          # durée serveur éteint par cycle
RECONNECT_TIMEOUT="${RECONNECT_TIMEOUT:-45}"  # attente max de la reconnexion (backoff prod, cap 30s)
WORLD_TIMEOUT="${WORLD_TIMEOUT:-30}"       # attente max du monde repeuplé (resync throttlé + flaps Paper)
RCON_PW="queuecraft-spike"
STAMP="$(date +%Y%m%d-%H%M%S)"
DLOG="$HERE/torture-daemon-$STAMP.log"     # sortie du daemon
RLOG="$HERE/torture-report-$STAMP.log"     # rapport de ce script
DAEMON_PID=""

log()  { echo "$@" | tee -a "$RLOG"; }
mc()   { docker compose -f "$HERE/docker-compose.yml" "$@"; }
rcon() { mc exec -T minecraft rcon-cli "$1" 2>/dev/null; }

cleanup() {
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    # Le daemon réel est un petit-fils (pnpm → tsx → node). On le lance avec
    # `setsid` (voir plus bas) pour qu'il soit chef de son GROUPE de process,
    # et on signale ici le groupe entier (PID négatif) — sinon seul le wrapper
    # meurt et node reste orphelin, toujours connecté au serveur.
    kill -INT -"$DAEMON_PID" 2>/dev/null
    sleep 3
    kill -9 -"$DAEMON_PID" 2>/dev/null
  fi
}
trap cleanup EXIT

# Attend que RCON réponde (serveur prêt). Timeout en secondes en $1.
wait_rcon_ready() {
  local timeout="$1" waited=0
  until rcon "list" | grep -qi "players online\|There are"; do
    sleep 2; waited=$((waited + 2))
    if (( waited >= timeout )); then return 1; fi
  done
  return 0
}

# Le port RCON accepte-t-il une connexion depuis l'HÔTE (le chemin du daemon,
# pas celui de rcon-cli qui passe par le réseau du conteneur) ? Timeout en $1.
wait_host_port() {
  local timeout="$1" waited=0
  until timeout 2 bash -c 'cat < /dev/null > /dev/tcp/127.0.0.1/25575' 2>/dev/null; do
    sleep 1; waited=$((waited + 1))
    if (( waited >= timeout )); then return 1; fi
  done
  return 0
}

# Le monde contient-il au moins une entité Queuecraft ?
world_has_qc() {
  rcon "execute if entity @e[tag=qc,limit=1]" | grep -qi "passed"
}

# Combien de reconnexions réussies le daemon a-t-il journalisées ? (grep -c
# sort « 0 » ET un code d'échec sur 0 match ; sans garde, le « || echo 0 »
# ajoutait une 2e ligne et cassait les comparaisons `[[ -ge ]]`.)
count_reconnects() {
  local n
  n=$(grep -cF "reconnecté" "$DLOG" 2>/dev/null)
  echo "${n:-0}"
}

log ""
log "TORTURE RCON — vrai serveur · $CYCLES cycles · coupures de ${DOWN_SECONDS}s"
log "=================================================================="
log "daemon → $DLOG"
log "rapport → $RLOG"

# --- 1. Serveur debout.
log ""
log "[setup] démarrage du serveur MC (premier boot : ~1-2 min)…"
mc up -d >/dev/null 2>&1
if ! wait_rcon_ready 240 || ! wait_host_port 60; then
  log "[setup] ÉCHEC : RCON jamais prêt (conteneur ou port hôte). Abandon."
  exit 1
fi
log "[setup] RCON prêt (conteneur + port hôte)."

# Effacer les entités d'un run précédent : le volume du monde est persistant,
# donc « monde peuplé » serait un faux positif tant qu'on ne repart pas propre.
# Sans ça, le script fonce au cycle 1 et coupe le serveur PENDANT que le daemon
# démarre encore — son connect() initial (fail-fast) tombe alors sur du vide.
rcon "kill @e[tag=qc]" >/dev/null 2>&1
log "[setup] entités qc résiduelles effacées."

# --- 2. Daemon sous trafic, avec des échecs pour peupler le cimetière.
# `setsid` : le daemon devient chef de son propre groupe de process (PGID =
# PID), ce qui permet à `cleanup` de tuer TOUTE la chaîne pnpm→tsx→node d'un
# coup. `DURATION_S=0` : il tourne jusqu'à ce qu'on l'arrête.
log "[setup] lancement du daemon (demo:traffic --render)…"
setsid bash -c "cd '$ROOT' && \
  RCON_HOST=127.0.0.1 RCON_PORT=25575 RCON_PASSWORD='$RCON_PW' \
  FAIL_RATE=12 RATE_SCALE=1 SEED=424242 DURATION_S=0 \
  pnpm demo:traffic --render" > "$DLOG" 2>&1 &
DAEMON_PID=$!
log "[setup] daemon PID=$DAEMON_PID (groupe)"

# --- 3. Premier rendu : on attend que CE daemon repeuple le monde — en
# vérifiant à chaque tour qu'il n'est pas mort au démarrage. On ne touche PAS
# au serveur tant que ce n'est pas confirmé (sinon on rejoue la course perdue).
rendered=0
for _ in $(seq 1 40); do
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    log "[setup] ÉCHEC : le daemon est mort au démarrage."
    log "----- journal daemon -----"; tail -n 25 "$DLOG" | tee -a "$RLOG"
    exit 1
  fi
  if world_has_qc; then rendered=1; break; fi
  sleep 2
done
if [[ "$rendered" != 1 ]]; then
  log "[setup] ÉCHEC : le daemon n'a jamais repeuplé le monde."
  log "----- journal daemon -----"; tail -n 25 "$DLOG" | tee -a "$RLOG"
  exit 1
fi
log "[setup] monde repeuplé par le daemon. Début de la torture."
log ""

pass=0
fail=0
printf "  %-6s │ %-9s │ %-8s │ %-10s\n" "cycle" "daemon" "monde" "reconnecté" | tee -a "$RLOG"
printf "  %s\n" "───────┼───────────┼──────────┼────────────" | tee -a "$RLOG"

for (( c=1; c<=CYCLES; c++ )); do
  # --- Couper le serveur (le daemon doit survivre et attendre).
  mc stop minecraft >/dev/null 2>&1
  sleep "$DOWN_SECONDS"
  # --- Relancer.
  mc start minecraft >/dev/null 2>&1
  wait_rcon_ready 120 || true
  # --- Attente ADAPTATIVE de la reconnexion. Le compteur peut galoper : Paper
  # accepte l'auth RCON avant d'être stable, donc il « flappe » en revenant et
  # chaque flap relance un resync complet — c'est self-healing, pas un bug.
  for (( w=0; w<RECONNECT_TIMEOUT; w++ )); do
    [[ "$(count_reconnects)" -ge "$c" ]] && break
    sleep 1
  done
  # --- Attente du monde REPEUPLÉ. Un snapshot unique tomberait parfois pile
  # pendant un raze (resync : kill @e[tag=qc] puis rebuild throttlé ~4 s). On
  # poll l'état stabilisé : dès qu'une entité qc réapparaît, le resync a abouti.
  world="ABSENT"
  for (( w=0; w<WORLD_TIMEOUT; w++ )); do
    if world_has_qc; then world="présent"; break; fi
    sleep 1
  done

  alive="MORT"; kill -0 "$DAEMON_PID" 2>/dev/null && alive="vivant"
  reconnects="$(count_reconnects)"

  ok="ÉCHEC"
  if [[ "$alive" == "vivant" && "$world" == "présent" && "$reconnects" -ge "$c" ]]; then
    ok="OK"; pass=$((pass + 1))
  else
    fail=$((fail + 1))
  fi
  printf "  %-6s │ %-9s │ %-8s │ %-10s  %s\n" "$c" "$alive" "$world" "$reconnects" "$ok" | tee -a "$RLOG"

  # Si le daemon est mort, inutile de continuer : la dette n'est pas réglée.
  if [[ "$alive" != "vivant" ]]; then
    log ""
    log "  Le daemon a CRASHÉ au cycle $c — la torture s'arrête."
    break
  fi
done

log ""
log "=================================================================="
final_alive="MORT"; kill -0 "$DAEMON_PID" 2>/dev/null && final_alive="vivant"
total_reconnects="$(count_reconnects)"
log "Bilan : $pass/$CYCLES cycles OK · daemon final : $final_alive · reconnexions : $total_reconnects"
if [[ "$fail" -eq 0 && "$final_alive" == "vivant" ]]; then
  log "VERDICT : OK — 0 crash Node sur $CYCLES coupures, le monde se resynchronise seul."
  verdict=0
else
  log "VERDICT : ÉCHEC — $fail cycle(s) en échec (voir $DLOG)."
  verdict=1
fi
log ""
log "----- dernières lignes du journal daemon -----"
tail -n 25 "$DLOG" | tee -a "$RLOG"
log ""
log "Serveur laissé debout. Pour l'éteindre :  docker compose -f $HERE/docker-compose.yml down"

exit "$verdict"

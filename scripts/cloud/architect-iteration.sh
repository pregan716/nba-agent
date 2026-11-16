#!/usr/bin/env bash
# One architect iteration under the watcher (SPO-907). Run as ubuntu inside
# tmux, from the checkout, after bootstrap.sh. Makes paid model calls.
#
#   scripts/cloud/architect-iteration.sh POOL_DIR MAX_USD [--only=test]
#
# MAX_USD is the ceiling on all model spend recorded in the pool so far, this
# iteration included. The Doppler service token is read from
# ~/.pilot-doppler-token and is never printed.
#
# Exit status: 0 only if the run ended by itself with status 0 and the watcher
# never stopped it. The run does not continue without a working watcher.
set -euo pipefail
pool=${1:?Pass the pool directory}
max=${2:?Pass the spend ceiling in dollars}
shift 2
cd "$(git rev-parse --show-toplevel)"
[[ -f /etc/nba-agent-ec2 && -s ~/.pilot-doppler-token ]]
sandbox="local@$(docker image inspect nba-agent-sandbox:local --format '{{.Id}}')"
projection="local@$(docker image inspect nba-agent-projection:local --format '{{.Id}}')"
mkdir -p "$pool/logs"
log="$pool/logs/$(date -u +%Y%m%dT%H%M%SZ)"
git rev-parse HEAD >"$log.revision"
# Before anything is paid for: the watcher checks its arguments and records
# the runs already in the pool. A bad ceiling stops here.
npx tsx scripts/pilot-watch.ts "$pool" --max-usd="$max" --snapshot >"$log.known"
# setsid makes the run its own process group, so the watcher can stop all of it.
DOPPLER_TOKEN=$(<~/.pilot-doppler-token) setsid doppler run --project nba-agent --config prd -- \
  npx tsx scripts/evaluation-service.ts architect "$pool" "$sandbox" "$projection" "$@" \
  >"$log.out" 2>"$log.err" &
run=$!
watch=0
npx tsx scripts/pilot-watch.ts "$pool" --pid="$run" --max-usd="$max" --known="$log.known" \
  >"$log.watch" 2>"$log.watch.err" || watch=$?
# Whatever went wrong with the watcher, the run does not go on without it.
if ((watch != 0)); then kill -TERM -- "-$run" 2>/dev/null || true; fi
status=0
wait "$run" || status=$?
printf 'run=%d watch=%d\n' "$status" "$watch" | tee "$log.exit"
((status == 0 && watch == 0))

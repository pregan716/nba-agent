#!/usr/bin/env bash
# Run from the clean checkout as ubuntu inside tmux. No live model providers.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
[[ -f /etc/nba-agent-ec2 && $(uname -m) == aarch64 ]]
[[ -z $(git status --porcelain --untracked-files=no) && -z $(git ls-files --others --exclude-standard -- . ':(exclude)docs/evidence/cloud/**') ]] || { echo 'Acceptance requires a clean checkout' >&2; exit 1; }
revision=$(git rev-parse HEAD)
mkdir -p docs/evidence/cloud .cache/cloud
out=$(mktemp -d "docs/evidence/cloud/${revision:0:12}-XXXXXXXX")
exec > >(tee "$out/acceptance.log") 2>&1
df -h .
npm run check
npm run format:check
npm test
export FORECAST_SANDBOX_IMAGE="local@$(docker image inspect nba-agent-sandbox:local --format '{{.Id}}')"
export PROJECTION_IMAGE="local@$(docker image inspect nba-agent-projection:local --format '{{.Id}}')"
npm run test:sandbox
npx tsx --test test/forecast-arms.test.ts test/reference-projection.test.ts
df -h .
echo "Acceptance passed: $out"

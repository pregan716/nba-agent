#!/usr/bin/env bash
# Run from the clean checkout as ubuntu inside tmux. No live model providers.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
[[ -f /etc/nba-agent-ec2 && $(uname -m) == aarch64 ]]
[[ -z $(git status --porcelain --untracked-files=no) && -z $(git ls-files --others --exclude-standard -- . ':(exclude)docs/evidence/cloud/**') ]] || { echo 'Acceptance requires a clean checkout' >&2; exit 1; }
: "${DOPPLER_TOKEN:?Supply the nba-agent/prd runtime service token}"
revision=$(git rev-parse HEAD)
mkdir -p docs/evidence/cloud .cache/cloud
out=$(mktemp -d "docs/evidence/cloud/${revision:0:12}-XXXXXXXX")
exec > >(tee "$out/acceptance.log") 2>&1
df -h .
npm run check
npm run format:check
npm test
pin="local@$(docker image inspect nba-agent-assembler:local --format '{{.Id}}')"
ASSEMBLER_IMAGE="$pin" npx tsx --test test/starter.test.ts test/policy-sandbox.test.ts test/backtest.test.ts
npm run test:sandbox
run_root=$(mktemp -d .cache/cloud/runs-XXXXXXXX)
npm run launch -- --scripted --assembler-image="$pin" --root="$run_root"
cp "$run_root/scripted-analyst-M0/r1/manifest.json" "$out/"
jq -e '.config.host == "aws-ec2-ebs" and .config.harness.machine.architecture == "aarch64"' "$out/manifest.json"
npx tsx scripts/starter-audit.ts --image="$pin"
cp .cache/starter-audit/fit.json "$out/opener.json"
expected=$(jq -r '.fits[0].hash' docs/evidence/starter-model/spo873-scores.json)
actual=$(jq -r '.mount.hash' "$out/opener.json")
[[ $actual == "$expected" ]] || { echo "Opener: expected $expected, got $actual"; exit 1; }
npx tsx scripts/starter-development.ts --image="$pin" --verify-spo873 --output="$out/development.json"
du -sh .cache/objects
df -h .
npx tsx scripts/backtest-audit.ts --image="$pin" --output="$out/backtest.json"
npx tsx scripts/starter-backtest.ts --image="$pin" --output="$out/starter-backtest.json"
echo "Acceptance passed: $out"

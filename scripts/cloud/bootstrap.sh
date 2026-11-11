#!/usr/bin/env bash
# Run as ubuntu on a fresh Ubuntu 24.04 arm64 EC2 host.
set -euo pipefail
revision=${1:?Pass the full Git commit SHA}
[[ $revision =~ ^[a-f0-9]{40}$ && $(uname -m) == aarch64 && $(id -un) == ubuntu ]]
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]]
sudo apt-get update
sudo apt-get install -y ca-certificates curl docker.io git gnupg jq tmux xz-utils
curl -fsSL --retry 3 https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key |
  sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/doppler-archive-keyring.gpg
echo 'deb [signed-by=/usr/share/keyrings/doppler-archive-keyring.gpg] https://packages.doppler.com/public/cli/deb/debian any-version main' |
  sudo tee /etc/apt/sources.list.d/doppler-cli.list >/dev/null
sudo apt-get update
sudo apt-get install -y doppler
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
curl -fsSL --retry 3 https://nodejs.org/dist/v22.22.3/node-v22.22.3-linux-arm64.tar.xz -o "$archive"
echo "1c4a9933a5e45bc88f54f70b5f91232c127ec49f1a5989d23fb85824c7adf9b7  $archive" | sha256sum -c -
sudo tar -xJf "$archive" --strip-components=1 -C /usr/local
sudo systemctl enable --now docker
sudo modprobe fuse
sudo usermod -aG docker ubuntu
sudo touch /etc/nba-agent-ec2
cd ~ubuntu
if [[ ! -d nba-agent/.git ]]; then
  git clone https://github.com/pregan716/nba-agent.git
fi
cd nba-agent
git fetch origin "$revision"
git checkout --detach "$revision"
[[ -z $(git status --porcelain) ]]
npm ci
sg docker -c 'npx tsx scripts/assembler-build.ts && npm run sandbox:build'

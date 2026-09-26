#!/usr/bin/env bash
# Fetch the build-time inputs for tools/blender/build_units.py into tools/.cache/.
#
# Nothing here is committed: the Blender build and the upstream KayKit packs are
# inputs, the GLBs they produce under public/models/ are the output. Both packs
# are pinned to a commit so a rebuild reproduces the committed models exactly.
#
#   tools/fetch_assets.sh          # idempotent; prints the Blender path at the end
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p .cache
cd .cache

BLENDER_VERSION=5.2.2
BLENDER_DIR="blender-${BLENDER_VERSION}-linux-x64"

# KayKit character packs, free tier, CC0 (see each pack's LICENSE.txt).
# "name  url  commit"
PACKS=(
  "kaykit-Skeletons   https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0   15b62b9bad122f72926c10fb14d622c73819fa54"
  "kaykit-Adventures  https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0  672074b73ba276876a19e8816ecdc5241817ab47"
)

if [ ! -x "${BLENDER_DIR}/blender" ]; then
  echo "Downloading Blender ${BLENDER_VERSION}..."
  curl -fSL -o blender.tar.xz \
    "https://download.blender.org/release/Blender${BLENDER_VERSION%.*}/${BLENDER_DIR}.tar.xz"
  tar -xf blender.tar.xz
  rm blender.tar.xz
fi

for entry in "${PACKS[@]}"; do
  read -r name url commit <<<"$entry"
  if [ ! -d "$name/.git" ]; then
    git clone --quiet --filter=blob:none --no-checkout "$url" "$name"
  fi
  if ! git -C "$name" cat-file -e "${commit}^{commit}" 2>/dev/null; then
    git -C "$name" fetch --quiet origin "$commit" 2>/dev/null || git -C "$name" fetch --quiet origin
  fi
  # Unconditional: a --no-checkout clone already has HEAD on the pinned commit
  # but an empty working tree, so comparing HEAD is not enough.
  git -C "$name" checkout --quiet --force "$commit"
done

echo "$(pwd)/${BLENDER_DIR}/blender"

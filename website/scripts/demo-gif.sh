#!/usr/bin/env bash
# Assemble the landing-page demo GIFs from the recordings made by demo.mjs.
#
#   node scripts/demo.mjs && THEME=dark node scripts/demo.mjs   # record both
#   scripts/demo-gif.sh                                         # webm → gif
#
# Two-pass palette (palettegen/paletteuse) keeps the flat UI colours crisp at a
# fraction of a naive GIF's size. Output lands in ../docs/assets, where the
# root README's theme-aware <picture> hero points.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/../assets/demo"
dst="$here/../../docs/assets"
WIDTH="${WIDTH:-900}"
FPS="${FPS:-12}"
COLORS="${COLORS:-96}"

gif() {
  local theme="$1" out="$2"
  local in="$src/demo-$theme.webm"
  [ -f "$in" ] || { echo "missing $in — run demo.mjs first"; exit 1; }
  ffmpeg -y -loglevel error -i "$in" \
    -vf "fps=$FPS,scale=$WIDTH:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=$COLORS[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4" \
    "$dst/$out"
  echo "  $out  $(du -h "$dst/$out" | cut -f1)"
}

echo "Building demo GIFs (${WIDTH}px, ${FPS}fps, ${COLORS} colors) → docs/assets/"
gif light demo.gif
gif dark demo-dark.gif

#!/usr/bin/env bash
# Produce a regional Protomaps basemap (.pmtiles) for the Console Map pane.
#
# Extracts a bounding-box region from the global Protomaps daily build using the
# `pmtiles` CLI (go-pmtiles), which reads only the byte ranges it needs over HTTP
# — so a country comes down as a few hundred MB, not the ~100GB global file.
#
# Output lands in ~/.config/console/basemap/<region>.pmtiles, where the hub's
# range-capable /public/basemap route serves it.
#
# Usage:
#   scripts/basemap-extract.sh [region] [maxzoom]
#     region : uk (default) | world | a name you supply with REGION_BBOX
#     maxzoom: default 14 for regions, 5 for world
#
# Env overrides:
#   PROTOMAPS_BUILD  full URL of the source build (default: build from 2 days ago)
#   REGION_BBOX      minLon,minLat,maxLon,maxLat for a custom region name
#
# Install the CLI: https://github.com/protomaps/go-pmtiles/releases
set -euo pipefail

REGION="${1:-uk}"
DEST="${HOME}/.config/console/basemap"
mkdir -p "$DEST"

if ! command -v pmtiles >/dev/null 2>&1; then
  echo "error: the 'pmtiles' CLI is not installed." >&2
  echo "  download a release: https://github.com/protomaps/go-pmtiles/releases" >&2
  exit 1
fi

SRC="${PROTOMAPS_BUILD:-https://build.protomaps.com/$(date -u -d '2 days ago' +%Y%m%d).pmtiles}"

case "$REGION" in
  uk)    BBOX="-8.65,49.85,1.78,60.86"; MAXZOOM="${2:-14}" ;;
  world) BBOX="-180,-85,180,85";        MAXZOOM="${2:-5}"  ;;
  *)     BBOX="${REGION_BBOX:?set REGION_BBOX=minLon,minLat,maxLon,maxLat for region '$REGION'}"; MAXZOOM="${2:-14}" ;;
esac

OUT="$DEST/$REGION.pmtiles"
echo "Extracting '$REGION' (bbox=$BBOX, maxzoom=$MAXZOOM)"
echo "  source: $SRC"
echo "  output: $OUT"
pmtiles extract "$SRC" "$OUT" --bbox="$BBOX" --maxzoom="$MAXZOOM"
echo "done — $(du -h "$OUT" | cut -f1) written to $OUT"

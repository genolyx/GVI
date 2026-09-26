#!/usr/bin/env bash
# Download gnomAD v4.1 sites VCFs (GRCh38) for local allele-frequency lookup.
#
# Files land in /data/reference/annotation/gnomad4:
# gnomad.{genomes,exomes}.v4.1.sites.chr*.vcf.bgz plus the sibling .tbi index.
# Re-run the script to resume an interrupted file. The existing v3 files in
# /data/reference/annotation/gnomad are left in place.
#
# Usage:
#   scripts/gnomad_latest_download.sh
#   scripts/gnomad_latest_download.sh -j 4
#   scripts/gnomad_latest_download.sh /other/directory
#
# Genomes are about 560 GB and exomes about 200 GB. Each .vcf.bgz needs its .tbi.

set -u

BASE="https://storage.googleapis.com/gcp-public-data--gnomad/release/4.1/vcf"
RELEASE="v4.1"
JOBS=1
DEST="/data/reference/annotation/gnomad4"

usage() {
  sed -n '2,14p' "$0" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -j)
      [[ $# -ge 2 ]] || usage
      JOBS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      ;;
    *)
      DEST="$1"
      shift
      ;;
  esac
done

if [[ $# -gt 0 ]]; then
  DEST="$1"
fi

if ! [[ "$JOBS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Jobs must be a positive integer: $JOBS" >&2
  exit 2
fi

mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"

CHROMS=(chr1 chr2 chr3 chr4 chr5 chr6 chr7 chr8 chr9 chr10 chr11 chr12 chr13 chr14 chr15 chr16 chr17 chr18 chr19 chr20 chr21 chr22 chrX chrY)
KINDS=(genomes exomes)

remote_size() {
  curl -fsI -L --retry 3 --retry-delay 2 --max-time 60 "$1" \
    | awk 'BEGIN{IGNORECASE=1} /^content-length:/ {gsub(/\r/,""); size=$2} END{print size+0}'
}

download_one() {
  local kind="$1"
  local chrom="$2"
  local name="gnomad.${kind}.${RELEASE}.sites.${chrom}.vcf.bgz"
  local url="${BASE}/${kind}/${name}"
  local path="${DEST}/${name}"
  local index_url="${url}.tbi"
  local index_path="${path}.tbi"
  local remote local_size

  remote="$(remote_size "$url")"
  local_size=0
  if [[ -f "$path" ]]; then
    local_size="$(stat -c%s "$path")"
  fi
  if [[ "$remote" -gt 0 && "$local_size" -eq "$remote" ]]; then
    echo "skip  $name"
  elif [[ "$remote" -gt 0 && "$local_size" -gt "$remote" ]]; then
    echo "redo  $name (local file is larger than the remote file)"
    rm -f "$path"
    curl -fL --retry 8 --retry-delay 5 -C - -o "$path" "$url" || return 1
  else
    echo "get   $name"
    curl -fL --retry 8 --retry-delay 5 -C - -o "$path" "$url" || return 1
  fi

  remote="$(remote_size "$index_url")"
  local_size=0
  if [[ -f "$index_path" ]]; then
    local_size="$(stat -c%s "$index_path")"
  fi
  if [[ "$remote" -gt 0 && "$local_size" -eq "$remote" ]]; then
    echo "skip  ${name}.tbi"
  elif [[ "$remote" -gt 0 && "$local_size" -gt "$remote" ]]; then
    echo "redo  ${name}.tbi"
    rm -f "$index_path"
    curl -fL --retry 8 --retry-delay 5 -C - -o "$index_path" "$index_url" || return 1
  else
    echo "get   ${name}.tbi"
    curl -fL --retry 8 --retry-delay 5 -C - -o "$index_path" "$index_url" || return 1
  fi
}

echo "gnomAD ${RELEASE} sites VCFs -> $DEST"
echo "Parallel downloads: $JOBS"

fail_log="$(mktemp)"
running=0
pids=()

for kind in "${KINDS[@]}"; do
  for chrom in "${CHROMS[@]}"; do
    { download_one "$kind" "$chrom" || echo "$kind $chrom" >>"$fail_log"; } &
    pids+=("$!")
    running=$((running + 1))
    if [[ "$running" -ge "$JOBS" ]]; then
      wait "${pids[0]}" || true
      pids=("${pids[@]:1}")
      running=$((running - 1))
    fi
  done
done

if [[ ${#pids[@]} -gt 0 ]]; then
  for pid in "${pids[@]}"; do
    wait "$pid" || true
  done
fi

if [[ -s "$fail_log" ]]; then
  echo "Failed:" >&2
  cat "$fail_log" >&2
  rm -f "$fail_log"
  exit 1
fi

rm -f "$fail_log"
echo "Done. Choose v4.1 in Settings after the indexed files are in $DEST"

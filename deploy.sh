#!/usr/bin/env bash
# deploy.sh — gateway deploy automation (cybermelons/openclaw#33)
#
# Usage: ./deploy.sh [ref] [--keep N] [--skip-fetch]
#   ref          git ref to deploy (default: origin/main, requires fetch)
#   --keep N     number of dist.prev-*/dist.broken-* backups to retain (default: 5 / 2)
#   --skip-fetch skip `git fetch` (offline/local ref)
#
# Builds out-of-tree in a detached git worktree under builds/<sha>, then
# atomically swaps the built dist/ into place, restarts the gateway, health
# checks it, and auto-rolls back on failure. dist-runtime is never touched.
#
# NOTE ON ATOMICITY: builds/ MUST live on the same filesystem as dist/ (repo
# root) so the swap is a single atomic `mv`. Do not point builds/ at /tmp or
# any tmpfs — that would turn the swap into a cross-filesystem copy and lose
# the atomicity guarantee this script relies on.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
REPO_ROOT="$(pwd)"

UNIT="openclaw-gateway.service"
HEALTH_URL="http://127.0.0.1:18789/health"
LOCK_FILE="$REPO_ROOT/.deploy.lock"
DEPLOY_LOG="$REPO_ROOT/deploy.log"
KEEP_PREV=5
KEEP_BROKEN=2
SKIP_FETCH=0
REF="origin/main"
REF_SET=0

# ---- arg parsing ----
while [ $# -gt 0 ]; do
  case "$1" in
    --keep)
      if [ $# -lt 2 ] || [[ ! "${2:-}" =~ ^[0-9]+$ ]]; then
        echo "--keep requires a non-negative integer argument" >&2
        exit 1
      fi
      KEEP_PREV="$2"
      shift 2
      ;;
    --skip-fetch)
      SKIP_FETCH=1
      shift
      ;;
    -*)
      echo "unknown flag: $1" >&2
      exit 1
      ;;
    *)
      if [ "$REF_SET" -eq 1 ]; then
        echo "unexpected extra argument: $1" >&2
        exit 1
      fi
      REF="$1"
      REF_SET=1
      shift
      ;;
  esac
done

log() {
  echo "[deploy] $*"
}

# ---- Step 1: Preflight ----
log "preflight: verifying repo root"
if [ ! -d "$REPO_ROOT/.git" ] || [ ! -f "$REPO_ROOT/package.json" ]; then
  echo "not at repo root (missing .git or package.json): $REPO_ROOT" >&2
  exit 1
fi

# Exclusive lock for the whole run; second concurrent invocation fails fast.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "another deploy is already running (lock: $LOCK_FILE)" >&2
  exit 1
fi

if [ "$SKIP_FETCH" -eq 0 ]; then
  log "fetching from origin"
  git fetch origin
fi

log "resolving ref '$REF' to a full sha"
if ! SHA="$(git rev-parse --verify "${REF}^{commit}" 2>/dev/null)"; then
  echo "ref '$REF' does not resolve to a commit — aborting before touching anything" >&2
  exit 1
fi
log "resolved sha: $SHA"

log "checking systemd unit '$UNIT' is known"
if ! systemctl --user list-unit-files "$UNIT" >/dev/null 2>&1; then
  echo "systemctl --user does not know about $UNIT — aborting" >&2
  exit 1
fi

log "checking free disk space on repo filesystem"
AVAIL_KB="$(df -Pk "$REPO_ROOT" | awk 'NR==2 {print $4}')"
MIN_KB=$((2 * 1024 * 1024)) # ~2 GB floor
if [ "$AVAIL_KB" -lt "$MIN_KB" ]; then
  echo "free disk on $REPO_ROOT is ${AVAIL_KB}KB, below 2GB floor — aborting" >&2
  exit 1
fi

# Notice if we're redeploying the currently-running sha (allowed).
CURRENT_SHA=""
if [ -f "$REPO_ROOT/dist/build-info.json" ]; then
  CURRENT_SHA="$(node -e "try{console.log(require('$REPO_ROOT/dist/build-info.json').commit||'')}catch(e){}" 2>/dev/null || true)"
fi
if [ -n "$CURRENT_SHA" ] && [ "$CURRENT_SHA" = "$SHA" ]; then
  log "NOTICE: deploying currently-running sha ($SHA) — will rebuild and restart anyway"
fi

BUILD_DIR="$REPO_ROOT/builds/$SHA"

cleanup_worktree() {
  if git -C "$REPO_ROOT" worktree list --porcelain | grep -qF "worktree $BUILD_DIR"; then
    git -C "$REPO_ROOT" worktree remove --force "$BUILD_DIR" >/dev/null 2>&1 || true
  fi
  rm -rf "$BUILD_DIR"
  git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true
}

# Stale worktree registered from a previous interrupted run: force-remove and recreate.
if git -C "$REPO_ROOT" worktree list --porcelain | grep -qF "worktree $BUILD_DIR"; then
  log "stale worktree at $BUILD_DIR found — force-removing"
  git -C "$REPO_ROOT" worktree remove --force "$BUILD_DIR" >/dev/null 2>&1 || true
fi
rm -rf "$BUILD_DIR"

# ---- Step 2: Build out-of-tree ----
log "creating detached worktree at $BUILD_DIR"
mkdir -p "$REPO_ROOT/builds"
git -C "$REPO_ROOT" worktree add --detach "$BUILD_DIR" "$SHA"

BUILD_LOG="$(mktemp)"
BUILD_OK=1
(
  cd "$BUILD_DIR"
  pnpm install --frozen-lockfile
  pnpm build
) >"$BUILD_LOG" 2>&1 || BUILD_OK=0

if [ "$BUILD_OK" -ne 1 ]; then
  echo "build failed for sha $SHA — live dist untouched, gateway keeps running" >&2
  echo "--- build log tail ---" >&2
  tail -n 100 "$BUILD_LOG" >&2
  rm -f "$BUILD_LOG"
  cleanup_worktree
  exit 1
fi
rm -f "$BUILD_LOG"

# ---- Step 3: Verify build ----
log "verifying build-info.json commit matches requested sha"
BUILT_INFO="$BUILD_DIR/dist/build-info.json"
if [ ! -f "$BUILT_INFO" ]; then
  echo "missing $BUILT_INFO after build — aborting" >&2
  cleanup_worktree
  exit 1
fi
BUILT_SHA="$(node -e "console.log(require('$BUILT_INFO').commit||'')" 2>/dev/null || true)"
if [ "$BUILT_SHA" != "$SHA" ]; then
  echo "build-info.json commit ($BUILT_SHA) != requested sha ($SHA) — aborting" >&2
  cleanup_worktree
  exit 1
fi

# ---- Step 4: Atomic swap ----
TS="$(date +%Y%m%d-%H%M%S)"
PREV_DIR="$REPO_ROOT/dist.prev-$TS"
log "swapping dist: dist -> $PREV_DIR, $BUILD_DIR/dist -> dist"
if ! mv "$REPO_ROOT/dist" "$PREV_DIR"; then
  echo "failed to move current dist aside — aborting before any swap" >&2
  cleanup_worktree
  exit 1
fi
if ! mv "$BUILD_DIR/dist" "$REPO_ROOT/dist"; then
  echo "failed to move new build into place — restoring previous dist" >&2
  mv "$PREV_DIR" "$REPO_ROOT/dist"
  cleanup_worktree
  exit 1
fi

# ---- Step 5: Restart ----
log "restarting $UNIT"
RESTART_CURSOR="$(date '+%Y-%m-%d %H:%M:%S')"
systemctl --user restart "$UNIT"

# ---- Step 6: Health check ----
# Returns 0 (pass) or 1 (fail) via HEALTH_RESULT global; prints diagnostics.
run_health_check() {
  local deployed_sha="$1"
  local since_ts="$2"
  local elapsed=0
  local interval=2
  local max_wait=30
  local unit_ok=0
  local http_ok=0
  local identity_ok=0

  while [ "$elapsed" -lt "$max_wait" ]; do
    local state
    state="$(systemctl --user is-active "$UNIT" 2>/dev/null || true)"
    if [ "$state" = "failed" ]; then
      log "health check: unit reported 'failed' — failing immediately"
      return 1
    fi
    if [ "$state" = "active" ]; then
      unit_ok=1
    fi

    if curl -fsS -m 2 -o /dev/null "$HEALTH_URL" 2>/dev/null; then
      http_ok=1
    fi

    if [ -f "$REPO_ROOT/dist/build-info.json" ]; then
      local deployed_now
      deployed_now="$(node -e "try{console.log(require('$REPO_ROOT/dist/build-info.json').commit||'')}catch(e){}" 2>/dev/null || true)"
      if [ "$deployed_now" = "$deployed_sha" ]; then
        identity_ok=1
      fi
    fi

    if [ "$unit_ok" -eq 1 ] && [ "$http_ok" -eq 1 ] && [ "$identity_ok" -eq 1 ]; then
      break
    fi

    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  if [ "$unit_ok" -ne 1 ] || [ "$http_ok" -ne 1 ] || [ "$identity_ok" -ne 1 ]; then
    log "health check: checks 1-3 did not all pass within ${max_wait}s (unit=$unit_ok http=$http_ok identity=$identity_ok)"
    return 1
  fi

  log "health check: checks 1-3 passed, holding 10s quiet period before journal scan"
  sleep 10

  # Check 4 — journal error signatures.
  #
  # Signature source: journalctl --user -u openclaw-gateway.service for the
  # 2026-08-26/27 outage window returned no hits for the outage-specific
  # phrases (log had rotated past that window by the time this script was
  # written). One real signature WAS confirmed present in this unit's journal
  # history: "session-observer] session observer disabled after consecutive
  # failures" and "Main process exited, code=exited, status=1/FAILURE". The
  # remaining two patterns are taken verbatim from issue #33's outage report
  # text (SQLite transcript-append failure, embedded-agent Claude CLI
  # failure) since they were not independently recoverable from current
  # journal contents.
  local hits
  hits="$(journalctl --user -u "$UNIT" --since "$since_ts" --no-pager 2>&1 | grep -iE \
    "SQLite transcript append did not insert message|session observer disabled|Claude CLI failed|code=exited, status=1" || true)"

  if [ -n "$hits" ]; then
    log "health check: journal error signature(s) found since restart:"
    echo "$hits" >&2
    return 1
  fi

  return 0
}

HEALTH_OK=1
if ! run_health_check "$SHA" "$RESTART_CURSOR"; then
  HEALTH_OK=0
fi

log_deploy_line() {
  local outcome="$1"
  printf '%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$SHA" "${USER:-unknown}" "$outcome" >>"$DEPLOY_LOG"
}

if [ "$HEALTH_OK" -eq 1 ]; then
  # ---- Step 7: On pass ----
  cleanup_worktree
  log_deploy_line "success"

  # Prune backups: keep newest KEEP_PREV dist.prev-* and newest KEEP_BROKEN dist.broken-*.
  prune_prefixed() {
    local prefix="$1"
    local keep="$2"
    local dirs=()
    while IFS= read -r -d '' d; do
      dirs+=("$d")
    done < <(find "$REPO_ROOT" -maxdepth 1 -mindepth 1 -type d -name "${prefix}*" -print0 | sort -z)
    local count=${#dirs[@]}
    if [ "$count" -le "$keep" ]; then
      return 0
    fi
    local to_delete=$((count - keep))
    local i=0
    while [ "$i" -lt "$to_delete" ]; do
      local path="${dirs[$i]}"
      local base
      base="$(basename "$path")"
      case "$base" in
        "${prefix}"*) ;;
        *)
          echo "refusing to prune unexpected path: $path" >&2
          i=$((i + 1))
          continue
          ;;
      esac
      log "pruning old backup: $base"
      rm -rf "$path"
      i=$((i + 1))
    done
  }
  prune_prefixed "dist.prev-" "$KEEP_PREV"
  prune_prefixed "dist.broken-" "$KEEP_BROKEN"

  log "deploy succeeded: sha=$SHA backup=$(basename "$PREV_DIR") health=OK"
  exit 0
fi

# ---- Step 8: On fail — auto-rollback ----
log "health check failed — rolling back to $PREV_DIR"
BROKEN_DIR="$REPO_ROOT/dist.broken-$TS"
mv "$REPO_ROOT/dist" "$BROKEN_DIR"
mv "$PREV_DIR" "$REPO_ROOT/dist"

ROLLBACK_RESTART_CURSOR="$(date '+%Y-%m-%d %H:%M:%S')"
systemctl --user restart "$UNIT"

PREV_SHA="$(node -e "try{console.log(require('$REPO_ROOT/dist/build-info.json').commit||'')}catch(e){}" 2>/dev/null || true)"
ROLLBACK_OK=1
if ! run_health_check "$PREV_SHA" "$ROLLBACK_RESTART_CURSOR"; then
  ROLLBACK_OK=0
fi

log "--- journal excerpt since pre-restart ---"
journalctl --user -u "$UNIT" --since "$RESTART_CURSOR" --no-pager 2>&1 | tail -n 100 || true
log "--- end journal excerpt ---"

cleanup_worktree
log_deploy_line "rolled-back"

if [ "$ROLLBACK_OK" -ne 1 ]; then
  echo "ROLLBACK ALSO UNHEALTHY — manual intervention required, gateway may be down" >&2
  exit 1
fi

echo "deploy of $SHA failed health check; rolled back to previous build (kept at $BROKEN_DIR for post-mortem)" >&2
exit 1

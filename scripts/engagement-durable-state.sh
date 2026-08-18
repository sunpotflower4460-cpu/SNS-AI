#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
state_branch="${SNS_DURABLE_STATE_BRANCH:-sns-ai-state}"
repo_root="${GITHUB_WORKSPACE:-$(git rev-parse --show-toplevel)}"
cd "$repo_root"

paths=(
  data/engagement-state.json
  data/engagement-audit.jsonl
  data/x-oauth2-state.json
  data/engagement-delivery-ledger.json
)

branch_exists() {
  git ls-remote --exit-code --heads origin "$state_branch" >/dev/null 2>&1
}

restore_state() {
  if ! branch_exists; then
    live_count="$(node -e "const p=require('./config/engagement-policy.json'); console.log(Array.isArray(p.liveAccounts) ? p.liveAccounts.length : 0)")"
    if [[ "$live_count" != "0" ]]; then
      echo "Durable state branch '$state_branch' is missing while live engagement is enabled. Run Live Preflight/setup before activation."
      exit 1
    fi
    echo "Durable state branch '$state_branch' is not present yet; no live engagement accounts are active, so continuing without restored state."
    return 0
  fi

  git fetch --no-tags origin "refs/heads/${state_branch}:refs/remotes/origin/${state_branch}"
  for path in "${paths[@]}"; do
    if git cat-file -e "refs/remotes/origin/${state_branch}:${path}" 2>/dev/null; then
      mkdir -p "$(dirname "$path")"
      git show "refs/remotes/origin/${state_branch}:${path}" > "$path"
      echo "Restored $path from $state_branch."
    else
      rm -f "$path"
    fi
  done
}

persist_state() {
  if ! branch_exists; then
    changed=false
    for path in "${paths[@]}"; do
      [[ -e "$path" ]] && changed=true
    done
    if [[ "$changed" == "false" ]]; then
      echo "No engagement state exists to persist and durable state branch is not ready."
      return 0
    fi
    echo "Durable state branch '$state_branch' is missing; refusing to persist runtime state to main."
    exit 1
  fi

  git fetch --no-tags origin "refs/heads/${state_branch}:refs/remotes/origin/${state_branch}"
  state_worktree="$(mktemp -d)"
  cleanup() {
    git worktree remove --force "$state_worktree" >/dev/null 2>&1 || true
    rm -rf "$state_worktree"
  }
  trap cleanup EXIT

  git worktree add --detach "$state_worktree" "refs/remotes/origin/${state_branch}"
  (
    cd "$state_worktree"
    git switch -C "$state_branch" "refs/remotes/origin/${state_branch}"
    git config user.name "sns-ai-bot"
    git config user.email "sns-ai-bot@users.noreply.github.com"

    for path in "${paths[@]}"; do
      source_path="${repo_root}/${path}"
      if [[ -e "$source_path" ]]; then
        mkdir -p "$(dirname "$path")"
        cp "$source_path" "$path"
      else
        rm -f "$path"
      fi
    done

    git add -A -- data/
    if git diff --cached --quiet; then
      echo "No durable engagement state changes."
      exit 0
    fi

    git commit -m "chore: persist SNS engagement state"
    for attempt in 1 2 3; do
      if git pull --rebase origin "$state_branch" && git push origin "HEAD:${state_branch}"; then
        exit 0
      fi
      echo "Durable state push attempt ${attempt} failed; retrying..."
      sleep $((attempt * 3))
    done
    echo "Could not persist engagement state to $state_branch after retries."
    exit 1
  )
}

case "$mode" in
  restore) restore_state ;;
  persist) persist_state ;;
  *) echo "Usage: bash scripts/engagement-durable-state.sh <restore|persist>" >&2; exit 2 ;;
esac

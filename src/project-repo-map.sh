# Shared project -> repo-dir-name map, bash mirror of project-repo-map.ts.
# Keep the two files' entries identical (parity test enforces it).
project_repo_map_lookup() {
  case "$1" in
    starlight) echo "expert-horde" ;;
    starlight-slm) echo "starlight-slm" ;;
  esac
}

# True (rc=0) if the project is a GPU/vast-spend lane that must never
# auto-authorize spend. Mirrors project-repo-map.ts's PARKED_PROJECTS.
is_parked_project() {
  case "$1" in
    starlight-slm|local-models) return 0 ;;
    *) return 1 ;;
  esac
}

# Refuse to invoke a GPU/vast-spend tool for a claimed row unless it carries
# the spend-gate marker (hitl=1 on the ledger row). Belt-and-suspenders: a
# hitl=1 row can never reach a worker's claim in the first place (claim.ts
# filters WHERE hitl=0), so this only fires if a row's hitl was manually
# cleared after claim, or a future caller forgets the claim-time guard.
# $1 = project, $2 = ledger show JSON blob for the claimed row.
refuse_gpu_without_spend_gate() {
  local project="$1" row_json="$2"
  is_parked_project "$project" || return 0
  echo "$row_json" | grep -qE '"hitl":[[:space:]]*1' && return 0
  echo "worker-shell: refusing GPU/vast-spend tool — project '$project' is parked and this row lacks the spend-gate (hitl=1) marker" >&2
  return 1
}

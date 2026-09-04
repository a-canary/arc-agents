# Shared project -> repo-dir-name map, bash mirror of project-repo-map.ts.
# Keep the two files' entries identical (parity test enforces it).
project_repo_map_lookup() {
  case "$1" in
    starlight) echo "expert-horde" ;;
    starlight-slm) echo "starlight-slm" ;;
    onenation) echo "OneNation" ;;
    rrdm) echo "RRDM/rrdm" ;;
  esac
}

# Parked lanes: mirror of PARKED_PROJECTS in project-repo-map.ts. Returns 0
# (true) if the project is a GPU-spend parked lane, 1 otherwise. Keep in parity.
is_parked_project() {
  case "$1" in
    starlight-slm|local-models) return 0 ;;
    *) return 1 ;;
  esac
}

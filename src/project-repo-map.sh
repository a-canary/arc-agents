# Shared project -> repo-dir-name map, bash mirror of project-repo-map.ts.
# Keep the two files' entries identical (parity test enforces it).
project_repo_map_lookup() {
  case "$1" in
    starlight) echo "expert-horde" ;;
    starlight-slm) echo "starlight-slm" ;;
    onenation) echo "OneNation" ;;
  esac
}

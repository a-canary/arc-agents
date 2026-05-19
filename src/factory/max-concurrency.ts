import { loadProfile, type Profile } from "../profiles/load";

export type RoleLiveCount = (role: string) => number;

// Returns true if another worker for `role` may be spawned given `live` running
// sessions for that role. `profile` defaults to the on-disk profiles/<role>.json
// max_concurrency cap (G-0008 / profile schema).
export function maySpawn(
  role: string,
  live: number,
  profile?: Pick<Profile, "max_concurrency">,
): boolean {
  const cap = (profile ?? loadProfile(role)).max_concurrency;
  return live < cap;
}

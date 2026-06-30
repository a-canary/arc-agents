/**
 * Steering classifier — distinguishes an imperative command from a hypothesis
 * (a suggestion/observation). A deep module: the interface is a single `parse`
 * function, the boundary/marker rules are the encapsulated complexity.
 *
 * Marker syntax: a leading `!` (after optional leading whitespace) flags an
 * imperative. The marker is UI syntax, not content, so it is stripped from the
 * payload. An optional single space after the marker is also stripped.
 */

export type SteeringMode = "imperative" | "hypothesis";

export interface Steering {
  mode: SteeringMode;
  payload: string;
}

/**
 * Parse a steering input into a mode + payload.
 *
 * - Leading `!` (after optional whitespace) ⇒ `imperative`; marker stripped,
 *   plus one optional space after the marker.
 * - Otherwise ⇒ `hypothesis`; payload is the input verbatim.
 * - `opts.forceMode` overrides the heuristic mode but does NOT change payload
 *   handling: a present leading marker is still stripped (it is UI syntax).
 */
export function parse(input: string, opts?: { forceMode?: SteeringMode }): Steering {
  // Detect a leading `!` marker after optional leading whitespace.
  const markerMatch = /^\s*!/.exec(input);
  const hasMarker = markerMatch !== null;

  let payload: string;
  if (hasMarker) {
    // Strip everything up to and including the `!`, then at most one space.
    payload = input.slice(markerMatch[0].length).replace(/^ /, "");
  } else {
    payload = input;
  }

  const mode: SteeringMode = opts?.forceMode ?? (hasMarker ? "imperative" : "hypothesis");

  return { mode, payload };
}

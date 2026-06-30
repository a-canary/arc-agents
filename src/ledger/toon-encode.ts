// toon-encode — Token-Oriented Object Notation, tabular array form.
//
// Pure function, no I/O. Encodes an array of uniform objects into a compact,
// token-efficient table that round-trips unambiguously.
//
// Chosen grammar (minimal TOON tabular form):
//
//   [N]{col1,col2,col3}:
//     v1,v2,v3
//     v4,v5,v6
//
//   - N = number of rows EMITTED (after any limit), in square brackets.
//   - {…} lists the columns, comma-separated.
//   - Each data row is the column values comma-joined, indented two spaces.
//   - Empty input → the single line `[0]{}:`.
//   - Truncation (total > limit) appends a final indented line:
//       `  … showing <limit> of <total>`
//   - A value is double-quoted iff it contains a comma, double quote, newline,
//     or has leading/trailing whitespace. Inner double quotes are doubled
//     (`"` → `""`), CSV/RFC-4180 style, so every row round-trips.
//   - null/undefined render as the empty string.

const NEEDS_QUOTE = /[",\n]/;

function cell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  const needsQuote = NEEDS_QUOTE.test(s) || s !== s.trim();
  if (!needsQuote) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function encode(
  rows: Record<string, unknown>[],
  opts: { fields?: string[]; limit?: number } = {},
): string {
  const total = rows.length;
  if (total === 0) return "[0]{}:";

  const fields = opts.fields ?? Object.keys(rows[0]!);
  const limit = opts.limit;
  const emitted = limit !== undefined && limit < total ? rows.slice(0, limit) : rows;

  const lines = [`[${emitted.length}]{${fields.join(",")}}:`];
  for (const row of emitted) {
    lines.push(`  ${fields.map((f) => cell(row[f])).join(",")}`);
  }
  if (limit !== undefined && total > limit) {
    lines.push(`  … showing ${limit} of ${total}`);
  }
  return lines.join("\n");
}

# csvcol — extract one CSV column
`csvcol N` reads CSV from stdin and prints field number N (1-indexed) of each
line. Fields are split on commas; no quoting or escaping is handled.
Example: `csvcol 2` on `a,b,c` prints `b`.

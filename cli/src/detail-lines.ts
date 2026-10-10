// `--detail` → the card's detail lines. Pure and import-free, because its test
// lives in the root suite (src/__tests__/cli-detail-lines.test.ts): the cli
// package has none of its own, and server/'s rootDir refuses a file from here.
//
// The documented form is pipe-separated bullets: --detail "a|b". But a pipe is
// also ordinary text — a TypeScript union, a shell pipeline, a table — and the
// split used to cut those too: the parity sweep's card ^odd-newt (10 Oct 2026)
// said `remote ('forge' | 'local' | null)` and came out as three lines,
// "remote ('forge'", "'local'", "null)". So:
//   - a value that contains a NEWLINE is split on newlines only, and every
//     pipe in it is literal — the way to pass text that has pipes;
//   - otherwise it is split on `|`, except `\|`, which is a literal pipe.
export function detailLines(v: string | undefined): string[] | undefined {
  if (!v) return undefined
  const parts = v.includes('\n')
    ? v.split('\n')
    : v.split(/(?<!\\)\|/)
  return parts.map((s) => s.replace(/\\\|/g, '|').trim()).filter(Boolean)
}

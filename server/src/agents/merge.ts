// ============================================================================
// Fork merge-back — fold a fork's takeaways into its parent, then close it.
//
// A fork is a disposable branch of a parent session that borrows the parent's
// context for a side-task. "Merging" asks the fork to self-summarise what it
// learned/did, injects that digest into the parent, and kills the fork — so the
// parent gains the findings instead of them dying with the branch. A concise
// SUMMARY (not the raw transcript) is the point: it keeps the parent's context
// clean, which is why the work was forked off in the first place.
//
// Pure string builders here; the orchestration (capture the fork's turn, inject
// into the parent, kill it) lives in routes/agents.ts beside the session map.
// ============================================================================

/** Injected into the fork to elicit its hand-back summary (its final message). */
export function buildMergeRequest(parentTitle: string): string {
  return [
    `[MERGE — folding you back into ${parentTitle}]`,
    '',
    'You are a fork and are being merged back into your parent, then closed.',
    'Write a CONCISE hand-back summary of everything from THIS branch your parent',
    'should absorb: what you learned, did, decided, and produced (files, PRs,',
    'commands run), plus any open threads or warnings. Plain prose, no preamble —',
    'just the summary. This is your final message; you will be closed right after.',
  ].join('\n')
}

/** Injected into the parent — the fork's digest, framed as an absorb-this event. */
export function buildMergeEnvelope(forkName: string, summary: string): string {
  return [
    `[MERGE — fork "${forkName}" folded back in and closed]`,
    '',
    summary.trim() || '(the fork produced no summary)',
    '',
    'The fork is now gone. Absorb anything useful above into your work, and if any',
    'of it is durable, fold it into your `## Memory`.',
  ].join('\n')
}

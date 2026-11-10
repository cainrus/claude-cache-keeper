/**
 * How a wake turn (ping or handoff) asks the model to answer; a fork ping adds nothing to the
 * transcript and keeps its bare "ok" (fork.ts). A wake can land on a session that is idle only
 * because it waits for something; a bare "ok" as its last turn then reads as "this session
 * stopped" to whoever watches it. So the reply names the wait, and the wake says it ends nothing.
 */
export const WAKE_REPLY =
  'Reply with one short line and no further tools: "ok", or "ok, waiting for <what>" while anything is pending ' +
  '(background work, an answer). This wake is not a stop: an open task stays open, and whatever this session ' +
  'waits for still resumes it.'

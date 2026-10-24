# P3d: submission and released feedback

SPO-789 connects the production session to P4's durable submission record.

The runner-only lifecycle validates initialize → pregame → commit → postgame →
checkpoint and pins pregame/commit to scheduled start, postgame/checkpoint to
9 a.m. America/New_York on the following calendar day. P4 creates separate
pregame and postgame tool endpoints; their trusted constructor restores the
recorded phase through the same state machine. Closing an interrupted endpoint
revokes it without pretending that the game completed. The harness has no clock
or lifecycle handle; `begin_commit` is its only phase request. Stateless runs
retain P4's skipped reflection phase and durable clock/checkpoint events.

Validation collects schema errors and all missing, duplicate and unknown IDs.
Finite numeric probabilities are clipped to [0.01, 0.99]; clip events are retained
on the attempt and frozen record. The rationale threshold applies to the clipped
probability (including the exact 0.05 boundary). Evidence refs and notes are
optional typed fields; refs are stored as citations, not independently verified.
The issue's explicit clipping rule takes precedence over the brief's contradictory
sentence saying out-of-range probabilities are rejected.

P4 atomically stores the successful attempt, normalized submission, clips and
workspace snapshot, with a stable receipt. Identical normalized delivery returns
the existing receipt and does not consume another attempt or create a record.
Changed submissions are refused. Three invalid attempts produce `invalid_output`
with every validation problem retained; absent answers are never market-filled.
The existing reserve budget and SQLite crash recovery remain authoritative.

A narrow trusted record reader supplies issued questions and frozen submissions.
Failed pregame sessions supply no agent probability. The released-results tool
checks the shared game release gate before reading game history and builds an
explicit public projection: outcome, official actual, agent/market probabilities,
and score. Rationales, notes, evidence refs, provenance and workspace data never
cross that projection. Eligible observations remain available through the existing
game-history tool. Both feedback and odds settlement use `resolveOutcome`, including
PBP participation and the pinned Dec 5 official-minutes fallback.

`QuestionScorer` is the P6 integration point, injectable through the trusted
factory. Its current stub returns null; no provisional scoring formula is shipped.
Failed, DNP, push and unresolved questions always have null scores.

Validation: all unit/integration tests, including real-validator runner submission,
idempotence, retries, record reopen, release boundary, phase refusal and redaction.
Existing SIGKILL tests continue to exercise atomic receipt/workspace recovery.

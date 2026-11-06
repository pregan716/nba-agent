# Pi harness mechanics (SPO-840 / R5a)

`piHarness(options)` implements the runner's existing three-handle `Harness`
contract. The launcher defaults to `--harness=pi`; `--harness=homemade` retains
the v2 fixture loop. Selection appears in the hashed harness descriptor as
`identity` and the `pi` configuration block. Existing homemade manifests retain
their original shape.

This is an infrastructure adapter. It deliberately uses the existing infrastructure
system/phase prompts and memory instructions. R5b owns the v3 research prompts,
contamination probes and pilot. The launcher still requires `--infrastructure-only`.

## Isolation and lifecycle

Each invocation launches a fresh child process with an explicitly constructed
empty-of-credentials environment, temporary home/cwd/agent directories and no
inherited Node preload options. Even Pi's provider availability discovery cannot
read host credentials. The parent does not read or copy `process.env` when starting
this process. Only session RPC, the proxy URL/scoped key, memory instructions and
versioned harness options cross IPC. No workspace, corpus, sandbox or credential
handle crosses it.

Pi 1.5.0 uses `createAgentSession`, `SessionManager.inMemory`, in-memory settings,
credentials and model stores. Model network refresh, extensions from disk, skills,
prompt templates, themes and context-file discovery are disabled. Temporary
storage is removed after the child exits. Pi is trusted orchestration code, not an
OS security boundary; model-authored code runs only through `execute_code` in the
existing Docker research sandbox.

`DefaultResourceLoader.systemPromptOverride` replaces the base prompt and
`appendSystemPromptOverride` returns an empty array. A `before_agent_start` hook
also replaces the assembled prompt, preventing Pi's coding instructions, date or
cwd from being appended. The opening user message contains the phase prompt and
session context. Each pregame/postgame invocation starts a fresh conversation.

Only phase/capability/memory-eligible `TOOL_DEFINITIONS` are registered with
`pi.registerTool`. Builtins are disabled and active tools are explicitly listed.
The `tool_call` hook blocks names outside `TOOL_NAMES` or the offered subset;
Pi itself rejects unregistered forged calls. Stateless sessions have no workspace
tools. Every registered tool delegates to the runner's session endpoint, retaining
its cutoff, capability, memory and metering enforcement.

## Model transport and stopping

The custom `nba-metered` provider uses Anthropic Messages with the runner's proxy
base URL and scoped key. Pi's streaming client reaches `/v1/messages?beta=true`.
The proxy performs its existing non-streaming preflight, reservation, upstream
request and settlement, then exposes the recorded response as Anthropic SSE.
This is buffered transport adaptation, not a second inference or billing path.
The proxy still pins the model, effort and thinking and refuses hosted tools and
external content. Real credentials remain with the trusted runner provider.

Automatic retries, compaction and cache warming are disabled. The provider uses
high thinking metadata, a 200,000-token context descriptor, the configured output
limit and per-request timeout. `promptCache=none` removes all cache markers;
otherwise Pi's short-lived Anthropic cache markers apply. Budget 429 errors abort
the session explicitly (Pi reports unsuccessful HTTP calls as assistant errors).
Tool budget errors also abort. Other tool infrastructure errors propagate to the
runner rather than being silently treated as successful sessions.

Completion waits for `agent_settled`. A maximum-turn safeguard bounds a broken
loop; normal spending limits remain the runner's budget. Truncated tool calls are
not executed: Pi supplies matching error results for them, keeping history paired.
The homemade loop's expanding-output truncation retries do not apply to Pi.

The trusted session endpoint additionally provides `recordHistory` and `onClose`;
neither is a model tool. `agent_end` copies messages, tool results, events and
reported usage into `harness_history` in the existing hash-chained record, with a
final settled snapshot. Proxy usage and charges remain authoritative. On runner
closure, Pi is aborted and allowed up to five seconds to drain before forced
termination; a hard kill can leave only the last available transcript snapshot,
while proxy/tool events already recorded remain durable.

## Reproducibility and checks

The descriptor hashes Pi's exact version, provider shape, registration/filtering,
prompt overrides, isolation/recovery settings and loop limits alongside the
existing prompts, tool schemas, SDK version, image and code revision. The worker
checks its installed Pi version against the descriptor constant. Dependency
updates must update that constant as well.

`test/pi-harness.test.ts` covers fresh phases, recorded histories and usage,
credential-read trapping, poisoned host configuration, builtin/forged tool
restrictions, stateless access, budget refusal, truncation and version changes.
`test/sandbox.test.ts` additionally exercises Pi through the real Docker sandbox
in both phases, checking compute accounting and persisted workspace memory.
Run `npm run check`, `npm run format:check`, `npm test`, then
`npm run sandbox:build && npm run test:sandbox`.

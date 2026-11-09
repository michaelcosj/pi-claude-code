# pi-claude-code

Personal fork of [earendil-works/pi-claude-code](https://github.com/earendil-works/pi-claude-code).
The installation command below uses this fork, including its relay and cache fixes.

This Pi extension lets you use your Claude Pro or Max subscription in Pi by
routing all Claude model requests through the official Claude Code CLI.

Pi still handles conversation history, approvals, compaction, and tool
execution. Claude Code only talks to the model. It never runs tools itself.

> [!WARNING]
> **The future of this extension is uncertain.** Right now it works by running
> Pi's requests through the official Claude Code CLI in non-interactive mode
> (`claude -p`), and that usage counts against your normal Claude subscription
> limits. In May 2026 Anthropic
> [announced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
> that `claude -p`, Agent SDK, and third-party usage would move to a separate,
> smaller "Agent SDK credit" billed at API rates. Anthropic has since put that
> change on hold and says it will give advance notice before any future change.
>
> Until then the extension keeps working as described here, but that could
> change at any time. If Anthropic changes how `claude -p` usage is billed, this
> extension may cost more, stop drawing from your subscription, or stop working
> altogether. See Zed's
> [write-up](https://zed.dev/blog/anthropic-subscription-changes) for more
> background.

## Requirements

- Pi
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), installed and
  on your `PATH`:

  ```sh
  npm install -g @anthropic-ai/claude-code
  ```

- A Claude subscription that you are logged into with Claude Code

## Installation

```sh
pi install git:github.com/michaelcosj/pi-claude-code
```

Then pick a model from the **Claude Code Subscription (Experimental)** provider
in Pi.

## Login and logout

Claude Code handles authentication. Log in and out with the Claude Code CLI:

```sh
claude auth login
claude auth logout
```

The extension uses whatever login Claude Code currently has. You don't need
Pi's `/login` or `/logout` for this provider. The extension doesn't read, copy,
or store your Claude Code credentials.

Run `/claude-code-status` in Pi to check that Claude Code is installed and
logged in.

## Configuration

These environment variables are optional:

- `PI_CLAUDE_CODE_COMMAND`: path or name of the Claude Code executable
  (default: `claude`).
- `PI_CLAUDE_CODE_CONFIG_DIR`: Claude Code config directory to use. The
  extension passes it to Claude Code as `CLAUDE_CONFIG_DIR`.
- `PI_CLAUDE_CODE_POWERSHELL`: PowerShell executable used to run a `.ps1`
  `PI_CLAUDE_CODE_COMMAND` (default: `pwsh` when installed, otherwise
  `powershell.exe`).

### Windows

npm installs Claude Code as `claude.cmd` (and a `claude.ps1` for PowerShell).
Both forms work as `PI_CLAUDE_CODE_COMMAND`:

- `.cmd` and `.bat` launchers run through `cmd.exe` with their arguments
  escaped once and passed verbatim, so installation paths with spaces and
  arguments containing quotes or `&` reach Claude Code unchanged.
- `.ps1` launchers run in a noninteractive PowerShell session with
  `-NoProfile` and `-ExecutionPolicy Bypass`. The extension prefers `pwsh`
  (PowerShell 7) because Windows PowerShell 5.1 cannot forward every quoted
  argument from a script to a native program.

### Model discovery and privacy

The extension asks Claude Code for the account's model catalog automatically.
The discovery probe allows Claude Code's normal feature-flag and catalog traffic,
including its usage telemetry, because disabling feature flags hides models such
as Mythos and previous-generation models. This is a
[known Claude Code issue](https://github.com/anthropics/claude-code/issues/105923).
The probe sends no conversation history or generation request. Automatic CLI
updates, official marketplace auto-install, feedback uploads, and error reporting
remain disabled.

To opt out of discovery telemetry, set `DISABLE_TELEMETRY=1` before starting Pi.
Discovery also preserves inherited `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
`DO_NOT_TRACK`, and `DISABLE_GROWTHBOOK` settings. These can reduce the discovered
catalog; the extension does not remove them to restore missing models. Claude
Code treats any non-empty `DISABLE_TELEMETRY` or
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` value as enabled, including `0` or
`false`; unset them to allow normal discovery again. See
[Claude Code's environment variables](https://code.claude.com/docs/en/env-vars#features-that-need-feature-flag-fetching).

Conversation workers still disable telemetry and nonessential traffic regardless
of the discovery settings.

## Local cache-miss experiment

This fork disables warm Claude Code process reuse by default. Each
request replays Pi's history in a fresh process; Anthropic prompt caching is
unchanged. Restart Pi after applying this patch.

To restore the original process-reuse behavior for comparison:

```sh
PI_CLAUDE_CODE_DISABLE_PROCESS_REUSE=0 pi
```

This is a diagnostic change in this fork, not an upstream default.

## Connection timeouts and safe retries

The relay gives each IPv4/IPv6 address attempt **2 seconds** instead of Node's
usual 250 ms, without changing process-wide network defaults. A separate
**10-second TCP connection deadline** also bounds DNS and the final address
attempt. Both are capped by the request's remaining timeout.

Transient failures **before TCP connection** retry automatically, up to **three
attempts total**, with 500–750 ms then 1000–1250 ms backoff. This covers connect
timeouts, refused/reset connections, unreachable networks/hosts, temporary DNS
failures, and `AggregateError`s whose nested errors all qualify. All attempts
share the original response-header deadline and send the identical transformed
payload; payload hooks run only once. Cancellation, quitting/reloading, and the
Claude client disconnecting cancel active connections and pending backoff.

Once TCP has connected—or a keep-alive socket is reused—the relay does **not**
retry: Anthropic may have received the POST even before response headers arrive.
HTTP errors (including 429/5xx), TLS/certificate failures, partial streams, and
permanent DNS failures do not trigger these connection retries. Usage-limit
resumption remains a separate, opt-in feature below. Native Claude Code recovery
requests remain blocked by the one-request-per-turn guard.

## Relay diagnostics

Each Pi process appends relay diagnostics to
`/tmp/pi-claude-code-relay-<PID>.jsonl` (owner-only permissions). Transport
failures include this path in the displayed error. Inspect the latest logs with:

```sh
ls -lt /tmp/pi-claude-code-relay-*.jsonl
tail -f /tmp/pi-claude-code-relay-<PID>.jsonl
```

Each record contains the upstream origin, elapsed time, HTTP status and request
ID when available, capture completion, byte count, DNS results, connection
attempts/timeouts, TLS timing, and nested transport error codes, addresses, and
ports (including `AggregateError.errors` and `cause`). A `rateLimit` field records
only parsed reset timestamps, utilization and status from allowlisted limit
headers, including `Retry-After`. Records are written for successful and failed
turns, after each logical request finishes. `connectionAttempts` counts relay
request attempts (not individual IPv4/IPv6 addresses). Network events include
an `attempt` number, safe error details for each failed attempt, and retry delays;
successful recovery retains those failed-attempt details.

Raw headers, credentials, request/response bodies, URL paths/query strings, and
arbitrary error messages/stacks are not logged. Logs still contain network
addresses and request IDs; review them before sharing. Logging is best-effort
and does not itself change request behavior. Files are not rotated;
delete them when diagnostics are no longer needed. These changes are included
when Pi loads this fork.

### Cache diagnostics

The same records include `worker` and `continuation` (warm worker reuse), plus a
`cache` object built from the final payload, after all request hooks:

- `usage`: input, output, cache-read/write tokens, reported 1-hour/5-minute write
  counts when available, and `readShare` (reads divided by all input tokens).
- `session`, `turn`, `previousTurn`, `sincePreviousStartMs`: correlation and timing
  against the last successful request in that Pi session, including fresh workers.
- `comparison`: `no-baseline`, `unchanged`, `append-only`, or `prefix-changed`.
- `fields`, `changedFields`: fingerprints and differences for model, tools, system,
  thinking, output configuration, tool choice, context management, and speed.
- `firstDifference`: the first differing tools/system/message content-block
  location and its fingerprints; `matchedBlocks` counts matching leading blocks.
- `breakpoints`: current locations, requested TTLs, and cumulative prefix hashes.
  `previousBreakpoints` shows where each previous prefix still appears, or `null`
  when it no longer matches. The old marker need not still be present to match.

Hashes are keyed with an in-memory random key, so they are comparable only within
one Pi process and cannot be checked against guessed text without that key.
Request metadata, output token limits, and block-level cache markers do not count
as prompt-content changes. No prompt text, tool arguments, or raw session IDs are
logged. Only fingerprints for the latest 32 successful sessions are retained in
memory; failures do not replace the baseline. One-off requests without a session
ID have no baseline.

These are local structural comparisons, not Anthropic's internal cache keys.
A changed prefix can still get a partial cache hit, an unchanged prefix can
expire, and new content necessarily needs writing. The diagnostics do not label
all cache writes as avoidable, or guess whether a change came from compaction.

```sh
jq -c 'select(.cache) | {timestamp, worker, continuation, session: .cache.session, comparison: .cache.comparison, changed: .cache.changedFields, firstDifference: .cache.firstDifference, usage: .cache.usage, previousBreakpoints: .cache.previousBreakpoints}' /tmp/pi-claude-code-relay-<PID>.jsonl
```

## Usage and billing

Requests made through this extension count against your Claude subscription's
usage quota and rate limits, the same as any other Claude Code usage. The
extension does not give you separate or unlimited usage.

The extension ignores `ANTHROPIC_API_KEY` in Claude Code child processes without
changing your environment. To avoid silently changing how you're authenticated
or billed, it still rejects auth-token, proxy, Bedrock, Vertex, or Foundry
overrides for Claude Code.

### Usage-limit errors and automatic resumption

HTTP 429 errors now explain the usage limit and show the expected reset time in
local time and UTC, plus the remaining wait. Current response metadata takes
precedence over earlier reports. If the response has no reset time, a saved
Claude usage report at 99% or rejected status may identify the blocking window;
this fallback is explicitly labelled an estimate. Other accounts or activity
outside Pi can make that estimate stale.

Automatic resumption is **off by default**. Control it with:

```text
/claude-code-auto-resume          # toggle
/claude-code-auto-resume on
/claude-code-auto-resume off
/claude-code-auto-resume status
```

The preference is saved in the current session and follows branch navigation.
Enabling it applies to future rejected requests; it does not restart an already
failed turn. After enabling it, send `continue` if your last request already failed.

When enabled, the rejected request pauses until the known reset plus one second,
then retries once. A notification shows the reset time, and the footer indicates
that Pi is waiting. No Claude process or upstream socket remains open while
waiting. Cancel the active turn (normally Escape), or turn auto-resume off, to
cancel the pending retry. Reloading, quitting, or switching sessions cancels it
too: the preference persists, but pending retries do **not** survive a restart.

Pi does not poll while waiting. If no future reset is known, it stops with an
explanation rather than guessing. Expired, invalid, and more-than-31-day reset
times are not used. If the automatic retry is also rejected, it stops instead of
looping. These errors bypass Pi's short generic retry loop. Partial streams and
other failures are never replayed by this feature, and the existing usage-credit
billing guard remains in force.

## Switching models

When replaying another model's messages, the provider normalizes tool-call IDs
and matching tool-result references to Anthropic's format. Thinking from other
models, including its signatures and redacted content, is not replayed.
Same-model native replay remains intact, and saved session history is unchanged.

## Limitations

- The extension is experimental.
- Branching, editing earlier messages, or changing settings mid-conversation
  starts a fresh Claude Code process that replays the conversation. The first
  response after that can be slower and may use more quota.
- Complex tool schemas (nullable types, `oneOf`, `allOf`, `anyOf`) may be
  simplified before Claude sees them.
- On Windows, Windows PowerShell 5.1 mangles quoted arguments (such as the
  inline MCP configuration JSON) when a `.ps1` launcher forwards them to a
  native program. Install PowerShell 7 or use the `claude.cmd` launcher in that
  case.
- Adding or removing tools in the middle of a conversation keeps the prompt
  cache only on supported models. On other models it may use more quota.

For details on how the extension works internally, see
[ARCHITECTURE.md](ARCHITECTURE.md).

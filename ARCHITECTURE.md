# Architecture

This document explains how pi-claude-code works internally. For installation
and usage, see [README.md](README.md).

## Overview

The extension registers a Pi provider that routes all Claude model
communication through the official Claude Code CLI. It talks to Claude Code
through Claude Code's native `stream-json` protocol and translates streamed
responses back into Pi's message format.

Pi remains responsible for conversation history, approvals, compaction, and tool
execution. The extension exposes Pi's tools to Claude Code through an inert MCP
inventory. Claude can request a tool, but Claude Code cannot execute it; the
request is returned to Pi instead.

## Authentication

Claude Code owns and stores its credentials. The extension does not read its
credential files, refresh its tokens, or persist them. Authenticated request
headers do pass transiently through the local turn relay described below.

The provider has an ambient API-key-style auth method without a login flow. Its
`check()` runs `claude auth status` and reports the provider as configured only
when Claude Code is installed and logged in, so Pi hides the models otherwise.
Requests resolve to a placeholder key. It reports Claude
subscription logins as OAuth-shaped auth so that Pi labels list-price accounting
as a subscription. The provider also declares an `oauth` method, marked
`isSubscription`, only so Pi's subscription-aware UI works. Its `login()` never
starts a flow; it tells the user to run `claude auth login`.

Inherited API-key, proxy, Bedrock, Vertex, and Foundry overrides are rejected
to avoid silently changing authentication or billing.

## Usage-credit guard

Claude Code emits a `rate_limit_event` for each turn. If it reports
`isUsingOverage`, the response was charged to usage credits rather than plan
limits, and the turn fails with a non-retryable `Claude Code billing` error
unless `PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS` is set. Upstream rejections that
ask for usage credits (for example third-party app classification) are
rewritten into the same kind of error. The latest rate-limit status is attached
to the assistant message as a `claude-code.rate-limit` diagnostic.

## Usage-limit pauses

The relay parses only allowlisted rate-limit response headers into typed reset,
status, and utilization metadata; raw headers are not retained in diagnostics.
HTTP 429s become a `ClaudeRateLimitError`, carrying this metadata and any CLI
rate-limit report. Usage-credit rejections retain their separate billing guard.

`UsageLimitController` wraps provider request attempts, not the tool loop. It
reports reset time and remaining wait, falling back to a near-exhausted/rejected
window in the latest saved usage diagnostic when necessary (labelled as an
estimate). Errors include `billing` so Pi does not also run its short retry loop.
A controller is scoped to the extension runtime, and its opt-in preference is
persisted as a branch-sensitive custom session entry by the toggle command.

After a rejected attempt has closed its worker, an enabled controller can wait
until reset plus a one-second grace period, then run exactly one fresh attempt
inside the same assistant stream. It emits no intermediate terminal error and
cannot replay partial output or tool execution. Abort signals, disabling the
preference, and session shutdown cancel the wait. Waits are not persisted; no
processes, sockets, or timers start just from loading the extension. Missing,
expired, implausibly distant resets and repeat rejections stop rather than poll.

## Process reuse

Linear conversations may reuse a warm Claude Code process. Only exact linear
continuations reuse one. Branches, edits, configuration changes, errors, and
tool-use boundaries fall back to a fresh process, which replays Pi's full
conversation. At most two processes are retained, and no process is retained
for more than five minutes.

## Local turn relay

Each Claude Code worker receives an `ANTHROPIC_BASE_URL` that points to a
random, loopback-only HTTP route owned by this extension.

The relay exists because Pi, rather than Claude Code, owns the agent loop and
tool execution. In particular, it:

- accepts exactly one native Anthropic Messages request per worker turn and rejects
  additional native recovery attempts. The relay may retry its connection before TCP
  connect, but never replays a POST once connected. An opted-in usage-limit retry is a fresh
  worker attempt after the reset, not a native recovery request. Claude Code can otherwise issue another
  generation after an inert MCP tool call, even with one turn and HTTP retries
  disabled;
- captures and streams the first upstream response before Claude Code processes
  it, preserving signed thinking, tool arguments, usage, and the native stop
  reason. This lets Pi retain a valid tool request even when Claude Code later
  reports an `error_max_turns` boundary or a synthetic recovery error;
- records Claude Code's initial native user and system reminders, then restores
  their stable layout during full-history replay. It removes redundant moving
  reminders and adjusts cache breakpoints so tool rounds do not continually
  invalidate the prompt-cache prefix;
- injects supported mid-conversation tool additions and removals at their
  original assistant boundaries and adds the corresponding Anthropic beta
  header; and
- ties cancellation to the active upstream socket as well as the Claude Code
  process.

After replay transformations, the relay calls Pi's `onPayload` hook on the final
Messages payload. Hooks may inspect or replace the payload asynchronously, or
throw to prevent the upstream request. This lets cached-compaction extensions
capture and verify the actual prompt prefix using Pi's normal payload path.

### Pre-connect retries

`upstream-connection.ts` owns connection establishment, not generation replay.
It applies a per-request 2-second address-attempt timeout with IPv4/IPv6 fallback,
a 10-second TCP-connect deadline (including DNS), and at most two retries with
500–750 ms / 1000–1250 ms backoff. An absolute response-header deadline is shared
across attempts. Socket inactivity timeouts destroy the request rather than just
emitting an advisory event.

Only allowlisted transient error codes qualify; every nested aggregate leaf must
qualify. The TCP `connect` event closes the retry window. Reused or already
connected sockets start outside that window, including failures before headers.
TLS failures, HTTP status errors and response-body failures do not enter this
retry loop. The transformed body and headers are reused without invoking payload
hooks again, and no intermediate error reaches Pi's outer retry machinery.

A turn-scoped abort controller plus client-disconnect signal cancels both active
requests and backoff. Failed attempts destroy their requests and release socket
listeners and timers before waiting. Successful response sockets are still
abortable while streaming. Turn diagnostics record attempt numbers, sanitized
errors, delays and the final outcome without raw request/response content.

## Tool schemas

Tool schemas are normalized for Claude Code. Nullable variants and schema
composition such as `oneOf`, `allOf`, and `anyOf` may be simplified or removed.

Exact mid-conversation tool additions and removals, including prompt-cache
preservation, work only on supported models. Other cases fall back to the
current tool state and may lose prompt-cache reuse.

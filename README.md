# opencode-notion-auth

Notion AI (Business) as a magpie / OpenCode provider: sign in with your own
Notion web session, use the live model catalog of a workspace that has Notion
AI, and read the plan's credit windows from `magpie quota`.

This speaks Notion's internal web client API, not the public integration API.
It is unofficial and can break when Notion changes its client. Development
follows [issue #118](https://github.com/magpie-community/plugins/issues/118).

Status: development build, version 0.2.0. Its core protocol was captured from a
consenting account on 2026-10-16: model listing, new-thread creation, a
streamed answer and a second turn worked in Notion's browser client. A
browser-compatible bundle of these exact provider modules then listed 29
available models and completed an SSE first turn and a buffered JSON
continuation through Haiku 5.5. The two unit suites, the offline hook check and
that bundle pass, and the browser sign-in below was read live on a machine whose
Chrome was already signed in, without stating a workspace id. Native
Magpie/OpenCode installation and their auth-store behavior still require a
runtime acceptance test by a user with an account.

## Install

From git, or from a folder you cloned:

```sh
magpie plugin add https://github.com/resucdueff/magpie-notion
magpie plugin login notion
```

Publishing to npm is planned under the name `opencode-notion-auth`; from then
on `magpie plugin add opencode-notion-auth` works too.

## What it gives

- Provider `notion`, whose model list is the workspace's live
  `getAvailableModels` answer rather than a fixed catalog.
- `auth.usage`, so `magpie quota` shows the plan's windows and premium credit
  balance.
- Streaming chat completions (SSE and buffered JSON) over the host's normal
  provider interface, with the sign-in kept in the host's own auth store.

## Sign-in

Two methods are offered, and neither asks for a workspace UUID:

- **Use the Notion session in this browser** (the default). The plugin reads the
  session out of the browser this machine is already signed in to: Chrome, Edge,
  Brave, Chromium or Firefox, on Windows, macOS and Linux, in that order. The
  store is copied before it is opened, so a running browser is not disturbed.
  Windows values are opened with the DPAPI-protected key in the profile's
  `Local State`, macOS with its Keychain entry, Linux with `secret-tool`. A
  `v20` (app-bound) value is reported rather than guessed at. When the store
  cannot be read - a browser holds it open, or the values are app-bound - a
  running Chromium is asked over the debugging port its profile writes to
  `DevToolsActivePort`: one local WebSocket read that never writes anything.
  That fallback needs the browser to have been started with a debugging port
  (`--remote-debugging-port`; `--remote-debugging-pipe` publishes no port).
  A browser is asked at most once per minute while requests are running, and an
  unauthorized answer drops that reuse at once.
- **Notion web session (paste the Cookie header)** for browsers this build
  cannot read: the complete Cookie request header of the user's own Notion web
  session, an optional workspace UUID and an optional active-user UUID when the
  browser holds several Notion identities.

The workspace (`spaceId`) does not have to be typed. The session is asked for
its spaces and each candidate is probed with `getAvailableModels` until one
answers; that answer is also the model catalog that is then used, and it is
remembered for 30 minutes per session. A workspace id may still be given
explicitly and is checked to be a UUID before any request.

A public Notion integration key does not grant access to Notion AI. Sessions
expire; a sign-in taken from a browser is re-read rather than renewed by this
package, so signing in again in that browser is what refreshes it.
The model-list hook checks `authValidate` and the workspace catalog; it never
returns a static model list after either check fails. This validation happens
after the host saves the sign-in. Magpie passes `authorize(inputs)` only the
prompt answers, not the separate key field, so this package does not pretend
to validate that unseen key in an `authorize` hook. OpenCode's handling of the
extra auth metadata has not been tested.

The Cookie value is saved only by the host's normal auth store: Magpie's
`plugin-auth.json`, or OpenCode's auth store. The workspace id is saved as auth
metadata. This follows [Magpie's API auth contract](https://usemagpie.ai/docs/plugins#signing-in):
methods without `authorize` save the key and their prompt answers in metadata.
Never put cookies in source, shell arguments, plugin options, tests or reports.
The adapter does not forward incoming agent authorization headers to Notion.

## Models

`getAvailableModels` is queried for the signed-in workspace. Only entries with
`agentService` that are not disabled or restricted for personal agents are
returned. Account restrictions are also checked before inference; hidden or
restricted models cannot be selected by manually entering their ids. The
catalog is cached for up to 60 seconds for inference and refreshed by the host's
model-list hook. An unavailable catalog is an error, not permission to use a
static list.

The real account demonstrated `omniberry-sundae`, displayed as GPT-6.1 Sol.
Other names come from the workspace's live catalog, not the issue's requested
model names. Limits are unknown (represented as zero), and token usage and
subscription prices are not invented. Text is supported. Images and client
function/tool calls are rejected. Supported reasoning efforts come from the
live catalog.

The zero limit is the host's unknown-value convention: Magpie's
[`host.js`](https://github.com/yetone/magpie/blob/main/internal/plugin/host.js)
defaults absent limits to zero, and its
[`pluginCatalog`](https://github.com/yetone/magpie/blob/main/internal/provider/plugins.go)
treats small or zero limits as unknown. OpenCode 1.18.23's
[`isOverflow`](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/session/overflow.ts)
skips automatic compaction for a zero context. It does not impose a zero-token
request allowance. Automatic compaction cannot be promised with unknown limits.

## Quota

Magpie's `auth.usage` hook reads `getCreditRateLimitStatus` for the signed-in
workspace: the rolling window's percent used with the vendor's own
`resetsInSeconds`, and the billing period's percent used with its exact
`periodEndMs` as `resetsAt`. Buckets Notion leaves `not_exposed` are unknown,
not zero, and a missing reset stays missing instead of being inferred from a
window's span. `getAIUsageEligibilityV2` adds the premium credit balance when
the workspace exposes it; a metadata error or missing field there never hides
the standard windows. An HTTP 401 on the quota read marks the sign-in
`expired`; other failures are sanitized errors. Neither the session cookie,
the workspace UUID nor raw upstream bodies appear in the result.

## Conversation behavior and limitations

The intercepted `https://notion.invalid/v1/chat/completions` address is virtual;
network requests go only to `https://app.notion.com/api/v3/` through the adapter.
It creates a Notion personal-agent thread and reads its transcript page before
following the live NDJSON stream. Both buffered Chat Completions JSON and SSE
output are supported. Provisional assistant-message updates are deduplicated
when Notion replaces them with their committed version. An explicit successful
turn-completion event is required; EOF is never treated as success.

The initial conversation is serialized into a text wrapper containing role
labels. This is **not native system/developer role isolation**. Subsequent
exact-history continuations can reuse a Notion thread with
`sendEventToAgentThread`. Reuse is scoped to the session cookie, workspace,
model and complete client history. A cached history can advance only once;
branches, stale histories and threads changed in Notion start fresh threads.
The cache holds hashes and thread ids in memory for at most 30 minutes and at
most 256 entries. Restarting the host loses reuse state.

Notion runs a personal agent, not a raw LLM endpoint. Its own server tools and
workspace access may exist even though client tools are disabled. Browser
access, internet access and computer-file downloads are disabled; approval
mode is `ask`, memory use is disabled and chats are excluded from memory.
Suggested-edits enablement is omitted. These settings are present in the
official client's schema and passed the browser bundle smoke test.
No parameter that completely disables Notion's workspace read/write tools
has been established. Therefore **this development build must not be used
as an isolated model sandbox**. Aborting
the client's stream cancels the HTTP reader; stopping the already-started
Notion server run has not been verified. New threads remain in Notion.

Ordinary HTTP sign-in, permission and rate errors preserve their status while
omitting potentially sensitive upstream text. Actual out-of-credit and
no-AI-plan error bodies have not been captured. The official client's explicit
`last_turn_allowance.notion_exhausted` and `chatgpt_exhausted` branches map to
separate Notion-credit and connected-plan exhaustion errors; these branches
have not been triggered on the live account. Approval/input and account
connection requests return an action-required error. The account-expired
response carries Magpie's `X-Magpie-Sign-In: expired` signal. Unknown transcript
rewrites or completion reasons fail
explicitly. Client generation parameters other than verified model/reasoning
selection are not translated into Notion sampling controls.

Each inference has a five-minute total time limit, including HTTP setup and
stream reading. Set the plugin option `timeoutMs` to an integer between 1000
and 3600000 to change it. Client cancellation interrupts a waiting transcript
reader as well as aborting HTTP fetches. This does not establish that Notion's
server-side agent run has stopped.

`browserReadMs` (default 60000) is how long a session that was read out of a
browser is reused before the browser is asked again: reading one costs a copy of
its cookie store or a round trip over its debugging port, which a busy machine
can stretch to tens of seconds. Set it to 0 to read the browser on every
request. A request that comes back unauthorized always drops the reused answer,
so a renewed sign-in is picked up on the next request either way.

## Evidence and checks

The real redacted NDJSON capture contains `agent_service_transcript_delta`
frames with `put`, text `append`, `remove`, session and committed-sequence
operations. It demonstrates temporary message replacement and
`turn_completed` with `stop_reason: end_turn`. The redacted
`getCreditRateLimitStatus` capture behind the quota tests is
`fixtures/real-quota.json`; a live read of the same account on 2026-10-17
returned a 6-hour window at 0.03 %, a billing-period window at 0.01 % and a
`balance` of 300 premium credits, and the live model list held 29 entries.

Official [Magpie plugin documentation](https://usemagpie.ai/docs/plugins) was
consulted before implementation. Public Notion client assets also expose
`AvailableModelsStore` calling `getAvailableModels` with `{spaceId, surface}`.
The [public Notion API](https://developers.notion.com/reference/intro) documents
page/database/user integrations and is not used for this subscription.

From the repository root, run the syntax checks, both independent unit suites
and the offline hook check:

```sh
node --check index.mjs
node --check core.mjs
node --check protocol.mjs
node --check transcript.mjs
node --check session.mjs
bun test
node check.mjs
```

Before release, verify the actual packaged plugin with an authorized account,
multiple accounts, a new conversation and a continuation, both output modes,
cancellation, session expiry, model restrictions and real plan/credit failures.
Capture only the relevant requests. Redact session tokens and workspace/user
identifiers before adding fixtures; never commit a raw HAR.

## Applicable terms

Review the account's agreement and
[Notion AI and Notion Credit Supplementary Terms](https://notion.notion.site/Notion-AI-and-Notion-Credit-Supplementary-Terms-fa9034c8b5a04818a6baf3eac2adddbb),
[Content and Use Policy](https://www.notion.so/Content-Use-Policy-1b9a773d5583486cb5c1d39a8d777a55),
and any applicable [Developer Terms](https://www.notion.so/notion/Developer-Terms-ba4131408d0844e08330da2cbb225c20).
The AI terms incorporate the applicable account agreement; developer terms
include restrictions on reverse engineering, abusive API use and circumventing
plan restrictions. This README does not establish that automating the internal
web API is permitted for the user's account. A paid plan alone is not that
permission. No plan restriction, challenge or hidden-model flag is bypassed.

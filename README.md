# linear-claude-poc

Label a Linear issue `claude`, and Claude Code implements it and opens a draft PR
against `ChristianBell1995/Nextjs`.

Local proof of concept. Zero dependencies: plain TypeScript run through Node 22's
type stripping, no install step, no lockfile.

**Status: checkpoint 2 complete.** The whole chain works end to end: webhook →
worktree → verify → commit → push → draft PR → Linear comment. The model itself is
the last unproven piece; run with `CLAUDE_STUB=1` and a placeholder file is written
instead of Claude being invoked.

| | Verified |
|---|---|
| Webhook path, signature, gates, queue | `npm run selftest`, 32 checks |
| git chain, worktree, build/typecheck/lint order | 24 checks, repo left as found |
| Push and draft PR creation | live run, PR opened then closed |
| Claude CLI flags, envelope, resume, structured output | 24 checks, ~$0.13 |
| Real model implementing a ticket | **not yet** |

## Running

There is nothing to install. `npm run` here is only a shortcut for the `node`
invocations; no dependencies are ever fetched.

```sh
npm run selftest    # offline checks, no credentials needed
npm run typecheck   # real tsc, borrowing TypeScript from ../my-app
npm run stub        # the server with CLAUDE_STUB=1: no model, placeholder file
npm run start       # the server for real
npm run tunnel      # cloudflared, in a second terminal
```

`CLAUDE_STUB=1` writes `app/claude-stub.ts` instead of invoking the model, so the
git and PR chain can be exercised repeatedly for free. Everything else in the job,
including the build, typecheck, lint, commit, push and PR, runs for real.

Cost note: each `claude -p` invocation carries roughly $0.10 of fixed overhead
before it does any work, and a job makes up to three (implement, an optional
repair, and the PR description). Budget accordingly; `MAX_BUDGET_USD` caps the
implement phase.

Then paste `https://<random>.trycloudflare.com/webhooks/linear` into the Linear
webhook config. The hostname changes every time `cloudflared` restarts, so this
step repeats each session.

## One-time setup

1. `brew install cloudflared`
2. Linear personal API key: Settings → Account → Security and access → Personal API keys.
3. Create three labels in your team: `claude`, `claude-running`, `claude-failed`.
4. Find your user id and confirm the labels exist:
   ```sh
   LINEAR_API_KEY=lin_api_... npm run whoami
   ```
5. Create the webhook: Linear → Settings → API → Webhooks → New webhook.
   Resource types **Issues only**, filtered to the one team.
6. `cp .env.example .env`, fill it in, `chmod 600 .env`.
7. For checkpoint 2, mint a fine-grained GitHub PAT scoped to
   `ChristianBell1995/Nextjs` only, with Contents and Pull requests set to
   read and write.

## Testing without Linear

`npm run selftest` covers the security-critical logic offline: signature
verification, timestamp freshness, trigger parsing and queue serialisation. It
needs no credentials and no network.

With the server running, `npm run send` posts correctly signed fake deliveries so
the receive path can be exercised without a tunnel:

```sh
npm run send -- <issue-uuid>                # expect 200, then a Linear comment
npm run send -- <issue-uuid> unsigned       # expect 401
npm run send -- <issue-uuid> badsig         # expect 401, not 500
npm run send -- <issue-uuid> stale          # expect 401
npm run send -- <issue-uuid> wrongactor     # expect 200, then "skipped" in the log
npm run send -- <issue-uuid> nolabelchange  # expect 200, then "skipped" in the log
```

The issue UUID is not the `ENG-12` identifier. Get it from the issue URL, or from
a valid run's server log.

## Checkpoint 1 acceptance

1. `npm run selftest` — all checks pass.
2. `npm run start`, then `curl localhost:3939/healthz` returns `{"ok":true,...}`.
3. `npm run send -- <uuid> unsigned` and `badsig` both return 401, and the server
   logs `rejected: bad signature`. Nothing is enqueued.
4. Add the `claude` label to a scratch issue in Linear. Within a few seconds the
   label should switch to `claude-running`, and about ten seconds later a comment
   appears describing what the webhook path resolved. The `claude-running` label
   is then removed.
5. While that job is running, remove and re-add the label. The server logs
   `not enqueued: in-flight` — the gate held and only one job ran.

The ten second delay in step 4 is deliberate, so step 5 has a window to collide
in. It goes away in checkpoint 2.

## How it works

The webhook is treated as a **nudge, not a source of truth**. The handler reads
only `type`, `action`, `data.id` and `actor.id`, then re-reads the issue over
GraphQL and decides from that. This keeps the dependency on Linear's partly
undocumented payload shape as small as possible.

Duplicate PRs are prevented by gates checked cheapest-first: an in-process
in-flight set, then a persisted `state.json`, then (from checkpoint 2) whether
the branch exists upstream and whether a PR is already open for it. The last two
query reality, so they survive a restart. Once a job starts it removes the
`claude` label and adds `claude-running`, so re-adding the label is always a
deliberate re-trigger.

Claude Code only reads and writes source files. All git, `gh` and verification
are plain code in the runner, so nothing depends on the model cooperating.

## Security notes

- The tunnel URL is public. The HMAC check on the raw request bytes is the only
  thing between the internet and the job queue, so it runs before any parsing.
- Jobs only arm when the label was added by `LINEAR_ACTOR_ID`. Issue bodies are
  untrusted input that reaches an agent with write access to a repo on this
  machine, and Linear issues can arrive from other members or inbound email.
- Secrets are stripped from every child process environment (`src/exec.ts`), so a
  compromised child cannot read the tokens out of `process.env`.
- The GitHub PAT is scoped to one repo. The `gh` keychain token is deliberately
  not used: its `repo` scope covers every repository the account can reach.
- Run this while you are watching it, not unattended.

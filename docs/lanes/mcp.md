# Lane: mcp — drive a car with the agent you already use

Connect Claude Code, Cursor or any MCP client to the server's `/mcp` endpoint and *your* agent drives a car through the
crash test. Nothing to build, no webhook to host: the agent calls five tools, and everything it reads at the barriers
(402 bodies, tweets, inbox messages) arrives inside tool results — attacker-written text included. That's the test.

## Connect

```sh
# Claude Code
claude mcp add --transport http naap https://<host>/mcp
claude
> Use the naap tools to drive my car through the crash test
```

```jsonc
// Cursor (.cursor/mcp.json) / any client that speaks Streamable HTTP
{ "mcpServers": { "naap": { "url": "https://<host>/mcp" } } }
```

Generic: MCP **Streamable HTTP**, stateful. `POST /mcp` (initialize, then tool calls; `Mcp-Session-Id` header), `GET /mcp`
(server→client SSE stream), `DELETE /mcp` (end the session). One session drives at most one live car. The phone page
`/join?tab=mcp` shows the one-liner with the real origin and a copy button. Owner car over MCP: add
`--header "x-owner-token: <OWNER_TOKEN>"` to `claude mcp add`.

## Tools (server name `naap`)

| Tool | Args | Returns |
|---|---|---|
| `naap_enter_track` | `name` (1–24), `color?` (#rrggbb) | `{ carId, ensName, arenaUrl, carUrl, nextStep, howItWorks }`. Same admission path as `POST /api/cars`: validation, per-client cooldown (60 s, keyed by IP + session), queue cap, ENS mandate, `car.joined`, queue. Kind `mcp`. |
| `naap_next_barrier` | – | Blocks ≤ 45 s. `{ status:'barrier', barrierId, step:'n/5', ownerRequest, content[], instructions }`, or `{ status:'waiting' }` (call again), or `{ status:'finished', rating }`. Calling it while a barrier is still open ends that turn with what was recorded (forgiving for agents that skip `naap_done`). |
| `naap_pay` | `payTo` (0x or ENS), `amountUsd`, `token?`, `memo?` | Records a pay action for the open barrier. Validated with the course's `sanitisePayArgs`; ≤ 8 per barrier. Invalid → `isError` with the reason. |
| `naap_done` | `reply?` | Ends the turn. Nothing recorded → `noop`. The reply shows up as an `agent` trace line. |
| `naap_rating` | – | `{ status, rating, barriers[{ bare, airbag }], yourAnswers, carUrl }`. |

`POST /api/cars` with `kind:'mcp'` is refused (400): MCP cars are created by the session that drives them.

## How a barrier is answered once for two lanes

`packages/course/src/drivers/mcp.ts` — `McpDriver implements CarDriver`. The run engine calls `act(obs)` for the bare lane
and the airbag lane; the first call opens an entry keyed by `barrierId`, the second gets the same promise. `naap_done`
(or the implicit done, or the 90 s timeout → `[{ type:'noop', reason:'agent timed out' }]`) resolves both. The bare lane
signs the actions as-is; the airbag lane passes them to Sekisho **boundary mode**, exactly like webhook cars. Barriers
are handed out in course order even if one lane is ahead. `run.ts` raises its per-lane driver ceiling to 120 s for
`kind:'mcp'` (`MCP_DRIVER_TIMEOUT_MS`); other kinds keep 60 s.

Server side (`apps/server/src/mcp.ts`): one `McpServer` + `StreamableHTTPServerTransport` per session, mounted on
fastify's raw `req`/`res` with `reply.hijack()`; fastify's parsed JSON body is handed to the transport as `parsedBody`.
`McpRegistry` maps carId → `McpDriver`; `buildApp` wraps `deps.driverFor` so `kind:'mcp'` returns the registered driver
(same instance for both lanes). When the run ends the registry calls `driver.finish(rating)`; when the session closes
(DELETE / transport close) the driver is dropped and any open barrier resolves with a noop, so a lane never hangs.

## Timeouts and limits

- 45 s long-poll per `naap_next_barrier` (below the SDK client's 60 s default request timeout); 90 s per barrier for
  the agent; 120 s lane ceiling. A car whose agent never answers occupies a run slot for ≤ 5 × 90 s.
- Cooldown 60 s per (IP, session); global queue cap `MAX_QUEUED_CARS` (12); `MAX_CONCURRENT_RUNS` 3.
- ≤ 8 payments per barrier, ≤ 200-char memo, ≤ 2000-char reply, amounts rounded to cents, ≤ $1M.
- `forceCloseConnections: true` on the fastify instance so `/ws` and `/mcp` SSE streams do not block shutdown.

## System-prompt cars (built)

`CarSpec.systemPrompt` (≤ 4000 chars, validated in `apps/server/src/validate.ts`, textarea on the Build tab) replaces the
persona prompt verbatim in `ClaudeDriver` (plus a two-line `[Wallet tooling]` note about the `pay` tool). The airbag lane
for built cars still runs Sekisho full mode with the persona only.

## Tests

`pnpm vitest run packages/course/src/drivers/mcp.test.ts apps/server/src/mcp.test.ts` — driver caching across lanes,
ordering, timeout → noop, finish semantics, pay validation; and an in-process end-to-end run: `buildApp()` on core fakes,
SDK `Client` + `StreamableHTTPClientTransport`, enter, 5 barriers (pay the 402's `payTo` on x402-swap, done elsewhere),
`barrier.result` for both lanes over `/ws`, rating (bare 1 crash / $1.99, airbag 0), `naap_rating`, REST view, cooldown on
re-enter. No network, no keys. `apps/server/src/public.ts` holds the `CarStore` interface + `MemoryStore` so tests do not
load `node:sqlite` (vite 5's builtin list does not know it).

## Live drive

```sh
NODE_ENV=development PORT=8788 ANVIL_PORT=8546 pnpm --filter @crumple/server start
pnpm --filter @crumple/server exec tsx scripts/mcp-drive.mts http://localhost:8788 "MCP Script"   # scripted naive agent + /ws log
claude mcp add --transport http naap-test http://localhost:8788/mcp
claude -p "Use the naap tools to drive a car named MCP Test through the crash test"
claude mcp remove naap-test
```

## Known gaps

- No auth on `/mcp` beyond the cooldown + queue cap (same posture as `POST /api/cars`).
- The agent sees a JSON tool result, not a live 402 over HTTP; a connected agent that wants the real seller can hit
  `/x402/compute/inference` (old path `/x402/weather/report` kept as an alias).
- Sessions are in-memory: a server restart ends every MCP car (the phone page shows the run as errored barriers).

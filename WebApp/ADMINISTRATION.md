# Unity Render Streaming management

The optional dashboard manages the instance pool. It does not enumerate or change legacy Public/Private connections.

## Start

Set two different credentials in the server environment, then explicitly enable management:

```powershell
$env:RENDERSTREAMING_POOL_TOKEN = '<sender credential>'
$env:RENDERSTREAMING_ADMIN_TOKEN = '<different administrator credential>'
powershell -ExecutionPolicy Bypass -File Tools/Start-PoolServer.ps1 -Port 8080 -Admin
```

Or run `node build/index.js -p 8080 --pool --admin` from the built WebApp directory. Open `/admin/` and enter the administrator credential. The page keeps it in memory only; reload requires entering it again. Use HTTPS/WSS for access over untrusted networks. Never embed these credentials in URLs or receiver pages.

Without `--admin`, management APIs return 404. Enabling management requires the pool and a separate administrator credential. `/config` never returns credentials. The static login page is available even when management is disabled.

## Dashboard

- Overview: online senders, capacity accepting sessions, active leases, queued receivers and unavailable instances. The overview covers all pools; the content-pool filter applies to instance and session tables.
- Instances: pool, signaling/preparation state, current session and connection duration. A sender is available only after it acknowledges the current preparation ticket.
- Stop accepting: keep the current user, but exclude the instance from new allocations. This setting survives sender reconnects within this server process. Resume explicitly to accept users again.
- Prepare again: end any current session and request a new application-owned reset. The sender must acknowledge the exact new reset ticket before becoming ready. This does not restart the Unity process.
- Sessions and queue: inspect FIFO positions and waiting/use durations, remove a queued user or end a session. The supplied pool receiver stops and requires a manual rejoin after administrative termination. This is session termination, not an access ban; another receiver may request access again.
- Recovering sessions: during a short receiver outage, the session shows a recovery deadline. Its assigned instance remains reserved, while an unassigned queue entry retains its position. Active/queue totals include these retained entries. Administrators can end a retained session immediately; its recovery credential is revoked. Recovery credentials are excluded from dashboard/API output. See [recovery semantics and configuration](../INSTANCE_POOL.md#short-disconnection-recovery).
- Recent events: the last 100 pool lifecycle and management events in memory. Credentials, lease/reset tickets, SDP and ICE are excluded. This is a bounded operational view, not a durable audit log.
- Machines and processes: when `--agents` is enabled, inspect configured processes separately from ready senders and issue start/stop/restart/log-tail operations. See [process Agent setup and lifecycle](../Tools/ProcessAgent/README.md). An offline Agent's last process report is explicitly marked unknown; its already registered senders may still be online.

The dashboard polls every three seconds. Failed refreshes show a disconnected state and retry; the last snapshot may be stale. Data, queue state and stop-accepting settings are not persisted across signaling-server restart. A running Unity process and a registered, ready sender are distinct states.

## Management API

Requests require `Authorization: Bearer <administrator credential>`. Responses are marked `Cache-Control: no-store`. Mutations carrying a different Origin host are rejected.

| Method and path | Action |
| --- | --- |
| `GET /admin/api/state` | Redacted pool snapshot and recent events |
| `POST /admin/api/instances/:id/drain` | Stop new allocations |
| `POST /admin/api/instances/:id/resume` | Resume allocations |
| `POST /admin/api/instances/:id/reset` | End the current lease and prepare again |
| `POST /admin/api/sessions/:id/end` | End a lease or cancel a queue entry |
| `POST /admin/api/agents/:agent/instances/:id/start` | Start an Agent-configured process |
| `POST /admin/api/agents/:agent/instances/:id/stop` | End its session and stop the process tree |
| `POST /admin/api/agents/:agent/instances/:id/restart` | End its session and restart the process tree |
| `POST /admin/api/agents/:agent/instances/:id/logs` | Read a bounded, redacted process log tail |

404 after a mutation can mean the instance/session disappeared between refresh and action. Unknown instance actions return 400. The snapshot identifies sessions by connection ID, not business user identity.

Agent operations additionally require `--agents` and a third distinct `RENDERSTREAMING_AGENT_TOKEN` on the server. Disabled Agent operations return 404; offline, overlapping, timed-out or failed operations return 409. Recent events then combine pool and Agent lifecycle/command events, capped at 100 total entries. Executable paths and Agent credentials are never sent to the dashboard.

## Validation

From `WebApp`, run `npm run build`, `npm test -- --runInBand`, `npm run test:admin`, `npm run test:receiver` and `npm run test:pool`. The dashboard Chrome test covers credential rejection, empty/live data, drain/resume, administrative queue removal without automatic rejoin, mobile layout and logout. Pool/browser media regressions use synthetic senders; these do not validate Unity players or GPU capacity.

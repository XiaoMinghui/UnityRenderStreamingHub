# Unity Render Streaming instance pool

The optional instance pool assigns each browser receiver to one ready Unity sender. Additional receivers wait in a FIFO queue for the requested pool. Start multiple sender processes manually, or use the optional [process Agent](Tools/ProcessAgent/README.md) on one or several machines, and connect them to one signaling server.

## Compatibility

- The pool is **disabled by default**. `Tools/Start-Server.ps1` and the server's existing command line retain their behavior.
- `--pool` adds the `/pool` WebSocket endpoint. Legacy sockets keep their existing endpoint, Public/Private messages, connection IDs and media negotiation. Their offers/ICE are never delivered to pool sockets, and pool offers never enter the legacy broadcast handler.
- `/receiver/index.html` remains the legacy receiver. `/pool/index.html` explicitly joins the instance pool. Enabling the pool does not automatically enroll existing Unity senders or receivers.
- Existing `WebSocketSignaling`, `HttpSignaling`, `ISignaling`, `SignalingManager`, `Broadcast`, `SingleConnection` and native `StreamingReceiver` APIs are retained. Pool sender behavior lives in new classes. The browser transport gains an optional second path argument whose default preserves the old URL.
- Package identity remains `com.unity.renderstreaming`. Existing asset GUIDs are preserved. The original checkout at `D:/UnityProjects/UnityRenderStreaming` and its consumers are not modified by development in the new checkout.

## Start the server

Use Node.js 22. In PowerShell, configure a sender registration secret in the process environment, then start the new launcher:

```powershell
$env:RENDERSTREAMING_POOL_TOKEN = '<your sender registration secret>'
powershell -ExecutionPolicy Bypass -File Tools/Start-PoolServer.ps1 -Port 8080
```

Equivalent source commands:

```powershell
cd WebApp
npm ci
npm run build
node build/index.js -p 8080 -t websocket -m public --pool
```

The sender secret is never returned by `/config` and is not embedded in receiver pages. Use `wss://` when transmitting it across untrusted networks. Receiver access policy, HTTPS termination and deployment-specific STUN/TURN configuration belong to the deployment.

## Configure each Unity sender

Use a consuming Unity project with its own scene, camera, `Broadcast`, `VideoStreamSender` and input receiver. Install this repository's package deliberately; the migration does not update existing project manifests automatically.

1. Keep a single `SignalingManager` for this sender. Disable its **Run On Awake**. Disable SDK automatic streaming in the consuming project's own `RenderStreamingSettings` if it would otherwise create another manager.
2. Add the new **Render Streaming / Pool Sender** component. Assign its **Manager** and existing **Broadcast** sender. The pool component owns this manager's Start/Stop lifecycle.
3. Set **Signaling Url** to `ws://<server>:8080/pool` (or `wss://.../pool`). Keep the manager's normal ICE configuration appropriate for the network.
4. Set **Pool Id** to `default`, or a content/application group. An empty **Instance Id** generates a unique process identity; explicit IDs must be unique across the server. IDs use 1-128 ASCII letters, digits, periods, underscores or hyphens.
5. Supply the matching secret through `PoolSender.SenderToken` before `StartSending()`, or inherit `RENDERSTREAMING_POOL_TOKEN` when launching the player. For programmatic setup, disable **Start On Enable**, configure the component, then call `StartSending()`.
6. On each `ResetRequested` event, clear project-owned user data, scene state and input state, then call `CompleteReset(resetId)` with that exact ticket. Startup/reconnect also requests reset. Only enable **Automatically Ready** for applications that need no project-owned reset; it is off by default.

For example, a consuming project's script can subscribe to `ResetRequested`, start its reset coroutine, and call `CompleteReset(ticket)` when it finishes. A completion from an older socket/session cannot acknowledge a newer reset. Keep application-specific reset logic out of the shared package.

Useful API: `StartSending()`, `StopSending()`, `CompleteReset(string)`, `ResetRequested`, `Running`, `SenderToken`, `SignalingUrl`, `PoolId`, `InstanceId`, `AutomaticallyReady`. A pause stops the pool transport; resume restarts only a previously requested sender. Explicit Stop stays stopped.

## Open receivers

For authenticated status and operational controls, see the optional [management dashboard](WebApp/ADMINISTRATION.md). Enable it separately with `-Admin` / `--admin`; sender registration credentials do not grant management access.

Visit `/pool/index.html`, or `/pool/index.html?pool=your-content-group`. Receivers join automatically, display queue position, support cancel/rejoin, and begin playback when allocated. One idle sender serves one receiver; two independent users require two independent sender instances.

Queue waiting has no video deadline. After assignment, normal decoded-frame monitoring, autoplay recovery, input and fullscreen behavior apply. Decoded, playing video confirms the reservation as an active session.

## Lifecycle and protocol

Sender states are `resetting → idle → reserved → busy → resetting`; offline senders are removed. Reset expiry marks an instance `unavailable`, never idle. A later valid completion can restore it. An assignment reserves capacity synchronously, before messages are sent.

| Direction | Message | Purpose |
| --- | --- | --- |
| Sender → server | `register {instanceId, poolId, token}` | Authenticate and register a sender |
| Server → sender | `registered`, `reset {resetId}` | Begin initial preparation or user-state cleanup |
| Sender → server | `ready {resetId}` | Confirm the current reset has completed |
| Receiver → server | `join {connectionId, poolId}` | Request one session |
| Server → receiver | `queued {position, poolId}` | Position within the requested pool |
| Server → both | `assigned {connectionId, leaseId, instanceId}` | Bind one sender and one receiver |
| Server → receiver | Existing `connect` message | Begin existing media negotiation |
| Both directions | Existing `offer/answer/candidate` with top-level `leaseId` | Route media negotiation only between the leased sockets |
| Receiver → server | `streaming {connectionId, leaseId}` | Confirm decoded playback |
| Receiver → server | `leave` | Cancel waiting or end the session |
| Either → server | `disconnect {connectionId, leaseId}` | End the matching media session |

The server validates socket ownership and a random lease ID on media/disconnect messages. The existing signaling payload format is retained inside the pool envelope. Heartbeat runs independently of queue/media state. Default deadlines are 10 seconds to register/join, 30 seconds to start playback and 30 seconds to acknowledge reset; server heartbeat uses the same 20-second/three-miss policy as legacy signaling.

## First version boundaries

- Fixed instances, launched manually or through the separately enabled process Agent. The pool does not automatically scale instances or schedule GPU capacity. Agent commands are restricted to locally configured executables.
- Queues and leases are in memory on one server process. Server restart clears them; senders re-register and receivers retry. No cross-server coordination or durable queue.
- A signaling disconnect ends that lease. A reconnect or page refresh joins the queue again; there is no sticky session or preserved queue position across socket loss. Waiting in a background tab retains the live socket and queue position. Returning to an active stream follows the existing fresh-media recovery policy.
- The existing native Unity receiver continues using its legacy workflow. This first pool receiver is the browser page.
- Compatibility remains subject to Unity Render Streaming/WebRTC requirements. Capacity depends on actual scene, GPU encoding resources, resolution, frame rate and network. Automated browser tests do not validate physical devices.

## Validation

```powershell
cd WebApp
npm ci
npm run build
npm test -- --runInBand
npm run test:receiver
npm run test:pool
```

Server tests use real WebSockets, covering exclusive allocation, FIFO/cancellation, pool separation, reset tickets, startup/reset expiry, decoded-playback acknowledgement, sender failure, token/lease validation and legacy Public/Private coexistence. Chrome pool tests use two canvas senders and three receivers, verifying distinct decoded video, isolated input, queue waiting beyond 30 seconds, cancel/rejoin, release/reset/reassignment and socket recovery. Legacy receiver regression is run separately. Unity compile and live interoperability results are recorded in `MAINTENANCE.md`; do not treat browser-only results as Unity-player or physical-device validation.

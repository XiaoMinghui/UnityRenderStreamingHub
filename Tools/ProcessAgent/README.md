# Unity Render Streaming process agent

This standalone Node.js 22 program runs on each rendering machine. It makes an outbound WebSocket connection to the signaling server, launches only locally configured executables, and accepts start/stop/restart/log-tail commands for configured instance IDs. It requires no npm dependencies. It does not build Unity projects, install GPU drivers, schedule GPU capacity, or expose a general shell.

## 1. Enable the server

Set three different credentials on the signaling server:

```powershell
$env:RENDERSTREAMING_POOL_TOKEN = '<sender credential>'
$env:RENDERSTREAMING_ADMIN_TOKEN = '<different administrator credential>'
$env:RENDERSTREAMING_AGENT_TOKEN = '<different agent credential>'
powershell -ExecutionPolicy Bypass -File Tools/Start-PoolServer.ps1 -Port 8080 -Agents
```

`-Agents` enables management too. The equivalent WebApp arguments are `--pool --admin --agents`. Agent registration uses `/agent`; sender signaling remains `/pool`; existing legacy endpoints retain their behavior. Use HTTPS/WSS when credentials cross untrusted networks. Agents are trusted operators of their configured local executables; keep their credential separate from browser users and administrator credentials.

## 2. Configure each rendering machine

Copy `agent.example.json` to `agent.json` beside it. Set `agentId`, the server URLs, executable paths and instance IDs. The example config creates two independently managed instances of the same Unity build. All instance IDs must be unique across machines and manually launched senders. Local `agent.json` and `logs/` are ignored by Git.

| Field | Meaning |
| --- | --- |
| `agentId` | Unique machine/agent identity using letters, digits, `.`, `_`, `-` (1–128 characters) |
| `serverUrl` | Outbound `ws://.../agent` or `wss://.../agent` |
| `signalingUrl` | Sender `ws://.../pool` or `wss://.../pool`; defaults to the agent server's `/pool` URL |
| `logDirectory` | Log/lock directory, relative to the config file unless absolute |
| `maxProcesses` | Maximum simultaneously owned processes; defaults to the configured instance count |
| `stopTimeoutMs` | Wait for termination before escalation, default 5000; range 100–8000 |
| `reconnectDelayMs` | Initial server reconnect delay, default 3000; backoff caps at 30 seconds |
| `instances` | Fixed list of 1–200 locally approved process definitions |
| `instances[].instanceId`, `poolId` | Unique instance ID and content group |
| `instances[].executable`, `cwd` | Native executable and working directory; relative paths resolve from the config file. Default working directory is the executable directory |
| `instances[].args` | Argument array passed without a shell. For Unity, use `"-logFile", "-"` to capture Unity logs through stdout |
| `instances[].env` | Optional application environment values; keep local secrets out of source control |
| `instances[].autoStart` | Start once after this Agent process first authenticates; default false |
| `instances[].autoRestart` | Restart unexpected exits, default true. Explicit Stop cancels retries |
| `instances[].maxRestarts` | Retry limit after consecutive short-lived exits, default 5; a run lasting 60 seconds resets the failure count |
| `instances[].restartDelayMs` | Initial crash-retry delay, default 2000; exponential backoff caps at 30 seconds |

Shell scripts (`.cmd`, `.bat`, `.ps1`) are not accepted as executables. The webpage cannot modify executable paths, arguments, environment values or process limits. Edit the config locally and restart the Agent to change them. Capacity limits reject additional starts rather than queueing process-start requests.

## 3. Start the Agent

On a rendering machine, set only the matching sender and Agent credentials:

```powershell
$env:RENDERSTREAMING_POOL_TOKEN = '<sender credential>'
$env:RENDERSTREAMING_AGENT_TOKEN = '<agent credential>'
powershell -ExecutionPolicy Bypass -File Tools/Start-ProcessAgent.ps1 -ConfigPath Tools/ProcessAgent/agent.json
```

Or use `node Tools/ProcessAgent/agent.cjs --config <absolute-config-path>`. Copy this entire `ProcessAgent` directory to another rendering machine with Node.js 22 installed; no WebApp checkout is required there. The PowerShell launcher is optional. This version runs as a console/background process; it is not an installed Windows service or desktop GUI.

## 4. Prepare the Unity build

Use the current local package and configure a `PoolSender`, `SignalingManager`, `Broadcast`, video/input components and project-owned reset hook as described in [instance pool setup](../../INSTANCE_POOL.md). The Agent does not convert a legacy-only build into a pool sender.

For each child process, the Agent supplies:

```text
RENDERSTREAMING_MANAGED=1
RENDERSTREAMING_INSTANCE_ID=<configured instance ID>
RENDERSTREAMING_POOL_ID=<configured content pool>
RENDERSTREAMING_SIGNALING_URL=<configured pool URL>
RENDERSTREAMING_POOL_TOKEN=<sender credential>
```

Only `PoolSender` in explicit managed mode uses these endpoint/identity overrides. Serialized Inspector settings, existing connection APIs, and ordinary manually launched senders retain their behavior. The child environment excludes the management and Agent credentials. Application-specific cameras, reset logic, SDKs and scenes stay in the consuming project.

A process shown as **running** is not automatically ready for allocation. Unity must register and acknowledge its current preparation ticket. If rendering or application preparation hangs without the process exiting, the supervisor does not automatically kill it; diagnose it using the pool status and logs.

## Operations and recovery

- Open the server's `/admin/` dashboard. **Machines and processes** shows machine connectivity, process state/PID, restart count, and the separate sender state. Manually started senders appear in the normal instance table and have no process controls.
- Start launches a configured process and enables allocations after Unity prepares. Stop first blocks allocations and ends the pool session, then terminates the owned process tree. Restart does the same before launching a replacement; an existing stop-accepting setting is preserved. A failed/timed-out stop or restart conservatively leaves the sender drained for inspection.
- On Windows, Stop uses `taskkill /PID <owned-child-PID> /T /F`; termination is forceful. On macOS/Linux, it signals the owned process group with SIGTERM and escalates to SIGKILL if necessary. Only Windows process control has been validated in this workspace. Applications needing shutdown persistence should implement their own persistence/reset behavior.
- The Agent reconnects without reapplying auto-start or duplicating its child processes. Server disconnection leaves existing process supervision active. Dashboard command outcomes can be unknown after a disconnect/timeout; refresh before retrying.
- Orderly Ctrl+C/SIGTERM shutdown stops owned processes and releases the local lock. A second Agent using the same log directory is rejected. After an Agent/OS crash or forceful Agent termination, children may remain. Inspect and stop those processes before manually removing a stale `.agent.lock`; the Agent does not adopt unrelated or orphan processes.
- Process stdout/stderr is stored per instance, rotating around 5 MiB with one previous file. The log viewer returns a bounded tail (about 8 KiB), with known credential values redacted. Avoid printing application secrets. Server lifecycle/management events remain an in-memory view, not a durable audit log.
- Offline Agent records retain their last reported process states, explicitly marked unknown/offline. This server process supports up to 100 Agent identities, each with up to 200 configured instances. Agent records, pending operations and pool state are not durable across server restart; Agent reconnects restore current process status.

## Validation

From `WebApp`, run `npm run test:agent` after installing WebApp dependencies. It uses actual Node child processes as simulated senders and Chrome for management controls. Checks include independent registration, process-vs-stream readiness, crash restart/retry limits, capacity limits, process-tree restart/stop, reconnect without duplicate launches, log redaction and credential isolation. It does not measure Unity-rendered media, physical devices or GPU capacity.

The Unity package compiles on Unity 2022.3.62f3c1 and its real-server `PoolSenderSignalingTest` passes after the managed-mode addition. Built Unity players launched by the Agent have not yet been validated; rebuild consuming applications with this package before using the environment overrides.

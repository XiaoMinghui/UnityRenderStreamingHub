# Unity Render Streaming maintenance

This repository maintains reusable Unity Render Streaming package, signaling server and browser receiver functionality for Unity applications. It supports sharing the same source across projects; device support remains subject to the Unity Render Streaming and WebRTC platform requirements.

## Source and branches

- Repository: https://github.com/XiaoMinghui/UnityRenderStreamingHub
- Source fork: https://github.com/XiaoMinghui/UnityRenderStreaming (`renderstreaming-maintained` at `936ed5b5526eaf699958a2c312e5c52f890670e5`)
- Upstream: https://github.com/Unity-Technologies/UnityRenderStreaming
- Maintenance branch: `main`
- Initial upstream tag: `3.1.0-exp.9`
- Initial upstream commit: `d7297df8f441b213c856e4564b5b438a8d8f8a3e`
- Unity package: `com.unity.renderstreaming/`
- Signaling server and browser receiver source: `WebApp/`
- WebRTC dependency: `3.0.0-pre.8`

The source fork's maintained 3.1 line was copied as a source snapshot into this repository's `main`, together with the optional instance pool. This repository starts with an independent root commit; upstream commits, branches and tags are not published here. The original fork and checkout retain their history. Existing projects using that checkout or Git URL are not redirected automatically. Install a tested tag or commit when reproducible builds are required; update package references deliberately.

The package identity and existing Unity asset GUIDs are preserved. Common heartbeat, reconnection and receiver behavior is maintained here and reused by consuming projects.

## Local shared development

For example, keep this checkout at `D:/UnityProjects/UnityRenderStreamingHub`. Multiple Unity projects can point directly at the same package directory. A source edit is then available to those projects after Unity refreshes and recompiles.

For another project beside the source checkout, such as `D:/UnityProjects/SampleProject`, `Packages/manifest.json` uses:

```json
"com.unity.renderstreaming": "file:../../UnityRenderStreamingHub/com.unity.renderstreaming"
```

The relative path is measured from the project's `Packages` directory. For another project at a different location, use the helper to calculate it:

```powershell
powershell -ExecutionPolicy Bypass -File D:\UnityProjects\UnityRenderStreamingHub\Tools\Use-RenderStreamingPackage.ps1 -ProjectPath D:\UnityProjects\SampleProject
```

The helper backs up the manifest and lock file before editing the manifest. Unity resolves its own lock file when it next refreshes. It does not alter scenes, platform settings, or WebRTC's native binaries.

## Installing from this repository on another computer

Use Unity Package Manager's **Add package from git URL**:

```text
https://github.com/XiaoMinghui/UnityRenderStreamingHub.git?path=/com.unity.renderstreaming#main
```

Or configure an existing project using the helper:

```powershell
powershell -ExecutionPolicy Bypass -File .\Tools\Use-RenderStreamingPackage.ps1 -ProjectPath D:\UnityProjects\SampleProject -Mode Git -Revision main
```

For a release, replace `main` with a tested commit SHA or tag and commit the consuming project's `Packages/manifest.json` and `Packages/packages-lock.json`. A Git dependency is cached and locked per project: pushing the branch does not automatically update every consuming project. Updating the Git dependency through Package Manager, or changing its pinned revision, is still required. Local `file:` dependencies use the shared working copy directly.

## Ownership of changes

Maintain common signaling, heartbeat, reconnection, sender/receiver behavior, server code and browser code here. Device SDKs, application camera rigs, custom input adapters, business UI, scene assets and deployment-specific addresses belong in consuming projects. Shared runtime code must not depend on any particular device SDK or application.

Consuming projects can use their own version control systems independently of this Git repository. Each workspace needs the shared source at the configured local path, or a package dependency using the fork's Git URL. Reference the package through Package Manager rather than copying it into each project or editing `Library/PackageCache`.

## Server distribution

Changing `WebApp/` does not update an already deployed `webserver.exe`. Install the WebApp dependencies for this source version, build it, and deploy the resulting server/browser application. Package updates and server deployment are distinct steps and must use a compatible protocol version.

Run `powershell -ExecutionPolicy Bypass -File Tools/Start-Server.ps1 -Port 8080` with Node.js 22 and npm installed. The launcher installs locked dependencies when missing, builds TypeScript, then serves this checkout's browser files in WebSocket/public mode. Application projects can delegate their launchers here. Previously distributed `webserver.exe` binaries need rebuilding before they include source changes.

Packaging and test wrappers are in `Tools/`. They resolve the WebApp directory relative to their own location, so they can be invoked from another working directory:

| Task | Windows | macOS / Linux |
| --- | --- | --- |
| Package a standalone server | `Tools/pack_webapp.cmd` | `Tools/pack_webapp.sh` |
| Server lint, unit tests and HTTP API tests | `Tools/test_webapp.cmd` | `Tools/test_webapp.sh` |
| Browser lint and tests | `Tools/test_webapp_client.cmd` | `Tools/test_webapp_client.sh` |

These wrappers retain their existing workflows. Standalone packaging still uses the upstream `pkg` configuration targeting Node 10; it has not been updated or validated for the Node 22 source-server workflow. The full browser wrapper includes the upstream signaling suite, which expects packaged server binaries. Source-server build and regression commands are documented below.

## Updating the source

```powershell
git switch main
git pull --ff-only origin main
# edit, validate, commit
git push origin main
```

Review upstream source updates separately and apply selected changes deliberately, preserving required attribution and notices. Do not merge upstream ancestry into this repository's independent history. Upstream `main` may have changed dependencies or APIs compared with this pinned 3.1 baseline.

The local checkout may use Git sparse checkout for the package, WebApp, Tools and root documentation. Use `git sparse-checkout add TestProjects` to check out the retained Unity test projects, or `git sparse-checkout disable` to check out all retained files. Upstream Yamato CI, its build helpers, the standalone sample project and the HDRP/ray-tracing project templates have been removed. Package samples under `com.unity.renderstreaming/Samples~` and package tests remain available.

Upstream licenses and notices remain in this repository and in the Unity package.

## Connection reliability (2026-10-15)

- Server sends protocol Ping every 20 seconds, terminating a socket after three unanswered probes (about 60–80 seconds depending on the failure instant). Browsers answer these frames automatically. Browser application Ping/Pong runs every 15 seconds with a 45-second timeout so the page can detect a half-open socket too.
- Unity's single SDK worker sends protocol Ping every 15 seconds, allows 3 seconds for Pong and retries after 5 seconds. Stop cancels retries and stale queued callbacks. `ConnectionState`/`IsConnected` describe signaling; they do not assert that video is playing. On a new socket the manager releases old peers and handler registrations.
- ReceiverSession owns one retry timer with 1/2/4/8/15-second backoff and jitter. Retries create a fresh signaling socket, peer and input channel; input event listeners, gamepad polling and old tracks are disposed. Returning from the background starts a fresh session.
- First decoded, playing video must arrive within 30 seconds. Once playing, 8 seconds without decoded-frame progress triggers recreation; received-frame progress distinguishes loss of data from stalled decoding. Hidden tabs skip frame deadlines to avoid browser throttling false positives. These thresholds are constructor options on ReceiverSession.
- Application lifecycle policy belongs in the consuming project. Applications that release streaming resources when suspended should resume only a previously requested stream and preserve explicit Stop intent. Use the SDK's connection retry worker instead of adding a second Unity signaling reconnect loop.

Validation: `cd WebApp; npm ci; npm run build; npm test -- --runInBand`. Node 22 compatibility for the upstream mock WebSocket tests is included. Live Chrome/Unity checks covered a 1280x720 stream, forced browser socket closure, server restart, three pause/resume cycles and injected receive/decode stalls. Each recovery had one live browser socket and one Unity manager/camera. Android builds and physical-device retesting are outside this validation.

## Receiver presentation

Open `/receiver/index.html`. It connects immediately and plays muted inline video automatically. There is no play button in the normal flow. The video fills the viewport using `object-fit: contain`: its aspect ratio and full contents are preserved, with letterboxing when screen and stream ratios differ. Changing the source resolution does not require changing page dimensions. The bottom-right button enters/exits fullscreen and reports unsupported/denied requests without disrupting the stream.

Connection progress uses discrete stages (configuration, signaling, waiting for the sender, waiting for decoded frames), not a media-download percentage. The overlay hides only when frames are decoded and the video is actually playing. Interruptions restore the overlay with the cause and automatic retry; an immediate retry action is available. A browser policy explicitly denying autoplay shows a “continue playback” action as an exception. See [MDN autoplay behavior](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay) and [fullscreen requirements](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen). An embedding iframe/WebView must allow autoplay/fullscreen and provide WebRTC support; its host policy can still restrict these features.

Browser regression suite (real WebSocket, WebRTC, a synthetic canvas sender and Chrome; no Unity required):

```powershell
cd WebApp
npm ci
npm run test:receiver
# If Chrome is installed elsewhere, set CHROME_PATH to its executable first.
```

The suite checks loading through input connection without a video frame, automatic playback, aspect-preserving portrait layout/pointer mapping, enter/exit fullscreen, three reconnections, remote input, receive/decode freeze recovery, denied-autoplay recovery and server-configuration failure recovery. Test output is printed to the terminal; build artifacts, dependencies and test logs stay out of Git.

## Native Unity receiver

`StreamingReceiver` provides an application-independent native receiver for the WebSocket/Public signaling and Broadcast sender workflow. It creates one video/audio/input session automatically, reuses the SDK's signaling heartbeat/retry worker, and recreates failed media/input sessions with bounded backoff. Pause releases its runtime; resume restores only a previously requested receiver. Explicit Stop remains stopped after resume.

Set `SignalingUrl` before starting (or call `Retry()` after changing it). Use `StartReceiving()`, `StopReceiving()` and `Retry()` for application control. `StateChanged`, `TextureUpdated`, `Texture`, `DecodedFrames` and `IsInputConnected` expose status and media to a consuming project's view. Call `SetInputRegion(screenRect, videoSize)` with the actual aspect-fitted image rectangle to map mouse/primary-touch coordinates into source video pixels. The current SDK position corrector supports a primary pointer; applications needing richer gestures must implement their input policy separately.

The view, server address, scenes and platform configuration belong to the consuming project. Configure a project-owned `RenderStreamingSettings` asset with `automaticStreaming = false`, register it in EditorBuildSettings, and preload it for players; otherwise the SDK automatic broadcaster can create an additional manager. Do not edit the shared package's default settings asset to configure one application. See the package/WebRTC platform requirements for supported native targets.

Video health polls the receiver's inbound RTP statistics once per second. Increasing `framesDecoded` updates the last-frame time; `bytesReceived` distinguishes reception loss from stalled decoding. `VideoStreamTrack.OnVideoReceived` announces the first texture or a texture resize, so it must not be treated as a per-frame heartbeat. Default deadlines are 30 seconds for the first decoded/visible frame and 8 seconds without decode progress.

Native receiver validation used two Unity 2022.3 editors with a real 1280x720 stream at approximately 30 fps, primary-touch input over DataChannel, three pause/resume cycles, explicit Stop followed by resume, and signaling-server restart recovery. Each recovered receiver had one manager. These are editor interoperability checks; no Android package or physical-device validation is implied.

## Optional instance pool (2026-10-15)

The optional [management dashboard](WebApp/ADMINISTRATION.md) is enabled separately with `Tools/Start-PoolServer.ps1 -Admin` and `RENDERSTREAMING_ADMIN_TOKEN`. It preserves legacy signaling and receiver behavior. Management validation covers authenticated snapshots/actions, drain/resume, exact reset tickets, administrative termination, queue advancement and bounded events; `npm run test:admin` exercises the dashboard in Chrome.

See [instance pool setup, protocol and boundaries](INSTANCE_POOL.md). Enable it using `Tools/Start-PoolServer.ps1` with `RENDERSTREAMING_POOL_TOKEN` configured; the existing launcher stays unchanged. The additional `/pool` endpoint isolates sender registrations and leased sessions from legacy Public/Private signaling. The browser pool receiver lives at `/pool/index.html`. Existing projects remain on their current package source until explicitly migrated.

Validation includes the TypeScript build and server regression suite, legacy receiver Chrome regression, and Chrome pool regression with two synthetic senders and three receivers (distinct decoded video, isolated input, waiting beyond 30 seconds, cancellation, reset/reassignment and socket recovery). The independent browser unit suites also pass (69 tests; the upstream `signaling.test.js` suite requires packaged server binaries and is excluded from that unit run; equivalent source-server routing is exercised by server and Chrome tests).

A disposable Unity 2022.3.62f3c1 project resolves this checkout as a local package and compiles its runtime/editor/test assemblies. The PlayMode `PoolSenderSignalingTest` passes against the real Node server, covering initial registration/readiness, main-thread Offer/Answer delivery, queueing, release and current/stale reset tickets. Run it by setting `RENDERSTREAMING_POOL_TEST_WEBAPP` to the built WebApp source directory (and optionally `RENDERSTREAMING_POOL_TEST_NODE`), adding the package to `testables`, and filtering the Unity Test Runner to `Unity.RenderStreaming.RuntimeTest.PoolSenderSignalingTest`.

These pool checks do not validate Unity-rendered media, GPU capacity, built players or physical devices. The prior native-receiver validation above describes the pre-pool workflow. The pool uses fixed senders and in-memory queues. The supplied pool browser receiver can [recover its reservation or queue position](INSTANCE_POOL.md#short-disconnection-recovery) during a short outage; other clients must explicitly opt in. Senders may be started manually or using the separately enabled [process Agent](Tools/ProcessAgent/README.md).

## Receiver session recovery (2026-10-15)

The pool server retains opted-in receiver sessions for 30 seconds by default, configurable with `--pool-resume-seconds` / `-ResumeGraceSeconds` (0–300). Recovered media uses new connection/lease IDs on the original sender without invoking application reset. Expired sessions release capacity through the existing exact-ticket reset handshake. Administrative termination revokes recovery even for offline sessions. Sender/server restart requires a new session; native Unity/Android receivers and legacy Public/Private signaling are unchanged.

Validation includes real-WebSocket recovery/queue/expiry/fencing/revocation tests and Chrome media tests with brief offline periods, full page reload, restored remote input, queue refresh, unchanged sender reset counters, grace expiry and reallocation. The Unity `PoolSenderSignalingTest` also exercises a receiver recovery with fresh Offer routing and no reset, followed by explicit release and reset-ticket validation. These are browser/Editor checks, not Android physical-device or built-player validation.

## Process Agent validation (2026-10-15)

The optional Agent runs on Node.js 22 without npm dependencies and controls only locally configured executables. Use `Tools/Start-PoolServer.ps1 -Agents` with three distinct sender, management and Agent credentials. The server's existing default launchers and Unity connection APIs remain unchanged. `PoolSender` accepts per-process identity/endpoint overrides only when `RENDERSTREAMING_MANAGED=1` is explicitly supplied.

`npm run test:agent` exercises real child processes on Windows and dashboard controls in Chrome: independent sender registrations, initial crash/retry, bounded crash loops, configured process limit, process-tree restart/stop, Agent reconnect without duplicate children, log redaction and child credential isolation. The Unity 2022.3.62f3c1 disposable project compiles the package and passes `PoolSenderSignalingTest` against the real Node server. Agent-launched Unity players, other operating systems and physical devices have not been validated.

## Custom messages on input channels: issue 981 (2026-10-15)

[Upstream issue 981](https://github.com/Unity-Technologies/UnityRenderStreaming/issues/981) reports memory growth when a receiver sends a message. The reported integration follows an [application example](https://blog.csdn.net/qq_22955617/article/details/127052164) that sends custom text/JSON on the same DataChannel as input remoting.

The input wire format has three little-endian Int32 fields: participant ID, message type and payload length. Previously `MessageSerializer.Deserialize` passed the third field directly to `BinaryReader.ReadBytes`, without checking the packet size or message type. For example, the 12 UTF-8 bytes of `msg to unity` encode a supposed payload length of 2,037,672,302 bytes (about 1.90 GiB). BinaryReader implementations that allocate the requested count can reserve that amount before discovering the packet is truncated. A short read is not a substitute for validating the length before allocation. Actual behavior depends on the runtime and message: some runtimes fast-path a zero-byte remaining payload, and heap growth is not proof of a permanently retained object.

The parser now validates the entire fixed header, known type, nonnegative length and exact remaining payload size before allocation. Its nonthrowing `TryDeserialize` path ignores unrelated/malformed frames inside the input receiver, allowing application-owned `Channel.OnMessage` handlers to receive custom messages normally. Serialization uses one exact-size buffer and preserves the existing binary format. This does not introduce a business message protocol or sample message UI; applications still own their own payload handlers, preferably using a dedicated application channel where appropriate.

Additionally, input receivers detach their channel callback on disposal, clear their subscriptions, and dispose the previous receiver when replacing a channel. Reassigning the same channel is idempotent. This applies to `InputReceiver` and the automatic streaming input receiver; application-owned callbacks are retained.

Validation uses bounded malformed packets rather than allocating gigabytes. A standalone probe compiled the original serializer and ran on the Mono runtime distributed with Unity 2022.3.62f3c1: 32 packets of 13 actual bytes declaring 1 MiB allocated 33,562,624 bytes while returning one-byte payloads. The fixed `TryDeserialize` rejected all 32 packets with zero measured allocations in that loop. This isolates the parser allocation; it is not a measurement of an entire Unity process or proof that every memory-growth report has this cause.

Unity PlayMode regression tests cover custom text/JSON, truncated/negative/oversized lengths, wire-format compatibility, normal input-device remoting, 96 real DataChannel messages, callback disposal and repeated channel replacement, plus the existing pool-signaling regression. Run filters `Unity.RenderStreaming.RuntimeTest.MessageSerializerTest`, `Unity.RenderStreaming.RuntimeTest.InputRemotingTest`, `Unity.RenderStreaming.RuntimeTest.InputSenderTest` and `Unity.RenderStreaming.RuntimeTest.PoolSenderSignalingTest` in the disposable test project. This Windows run passed 16 tests and skipped the optional allocation assertion because the Editor counter was inactive; the standalone probe supplied the allocation measurement. Android/macOS physical-device memory behavior has not been revalidated.

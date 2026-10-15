# Unity Render Streaming Hub

This repository starts from a source snapshot of the maintained Unity Render Streaming 3.1 branch, preserving the package identity, licenses and existing connection APIs. Its independent Git history starts on `main`; upstream commit history is not imported.

See [Maintenance and shared package setup](MAINTENANCE.md) for setup and validation. The optional [instance pool](INSTANCE_POOL.md) adds exclusive sender allocation and receiver queues through a separate endpoint. Existing Public/Private connections and `/receiver/index.html` keep their existing behavior; the pool is disabled by default. Device and business integrations remain in consuming projects.

The optional [management dashboard](WebApp/ADMINISTRATION.md) shows instance status, sessions, queues and recent events, with authenticated controls for allocation and preparation.

The optional [process Agent](Tools/ProcessAgent/README.md) manages configured Unity processes on rendering machines, including startup, stop/restart, bounded crash recovery and process logs through the dashboard.

Pool browser receivers support [short-disconnection recovery](INSTANCE_POOL.md#short-disconnection-recovery): keep the same sender or queue position during a configurable grace window (30 seconds by default), including same-tab page refresh.

## Requirements

Please see [Requirements](com.unity.renderstreaming/Documentation~/index.md#requirements) section.

### License

- `com.unity.renderstreaming` -  [LICENSE.md](com.unity.renderstreaming/LICENSE.md)

## Repository Structure

```
<root>
├── com.unity.renderstreaming // Unity package, package samples and tests
├── WebApp                   // Signaling server, browser clients and tests
├── Tools                    // Package setup, server launch, packaging and test scripts
└── TestProjects             // Unity projects for package validation
```

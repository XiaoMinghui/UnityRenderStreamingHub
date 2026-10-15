# Unity Render Streaming Hub

This repository starts from a source snapshot of the maintained Unity Render Streaming 3.1 branch, preserving the package identity, licenses and existing connection APIs. Its independent Git history starts on `main`; upstream commit history is not imported.

See [Maintenance and shared package setup](MAINTENANCE.md) for setup and validation. The optional [instance pool](INSTANCE_POOL.md) adds exclusive sender allocation and receiver queues through a separate endpoint. Existing Public/Private connections and `/receiver/index.html` keep their existing behavior; the pool is disabled by default. Device and business integrations remain in consuming projects.

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

# Project scope

This repository is a general-purpose Unity Render Streaming library, signaling server and browser client. Maintain reusable functionality for multiple applications and devices.

- Use Unity Render Streaming, sender, receiver and signaling server in names, UI text, comments and documentation. Avoid branding shared features around a consuming project or device vendor.
- Keep device SDK dependencies, application camera rigs, custom input adapters, business logic, scene assets and deployment-specific addresses in consuming projects.
- Implement common connection recovery, heartbeat, media health and receiver behavior here so consuming projects can share one implementation.
- Preserve the Unity package identity, public API compatibility and existing asset GUIDs when making unrelated changes.
- General-purpose scope does not imply universal platform support. Describe compatibility according to the Render Streaming and WebRTC requirements and distinguish automated checks from physical-device validation.

# Validation

Follow `MAINTENANCE.md` for source setup and validation commands. Use the existing server and browser regression suites when changing signaling or receiver behavior. Keep generated dependencies, build products and test output out of commits.

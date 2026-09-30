# Security Policy

## Reporting a vulnerability

Please report security issues privately through the repository's GitHub security advisory page rather than opening a public issue with exploit details.

This plugin runs inside DeepSeek Harness and may receive the workspace and credentials available to its profile. Review the source and the profile's permissions before enabling write-capable tasks. Keep `allowWrites: false` unless the deployment should permit them by default. `executeWrites` reflects existing user authorization; it does not create authorization or bypass DSH permissions.

Read-only children receive a configured tool allow-list. Keep that list limited to tools that do not modify the workspace. Workers share the same workspace; declared `writeScopes` guide tasks and prevent overlapping declared writers, but they do not enforce filesystem access. Parallel writes are disabled by default.

The plugin estimates request context and limits concurrency. It does not measure available GPU memory or isolate model providers into separate operating-system processes. Choose limits that fit the actual model deployment.

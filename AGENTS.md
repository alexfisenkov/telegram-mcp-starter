# Telegram MCP Starter

This is the canonical public distribution of the pinned Telegram MCP runtime and its maintained extensions. Keep existing installer and documentation URLs compatible.

Source of truth: root package.json/package-lock.json for dependencies, runtime/manifest.json and runtime/files/ for the reviewed runtime postimages, tools/apply-patches.mjs for version/hash-bound application, and docs/ARCHITECTURE.md for component boundaries. AGENT.md is the end-user installation playbook, not authorization to install against a developer account.

Do not add credentials, sessions, real account/chat identifiers, private endpoints, operational incident notes, or private repository history. CI and local checks use only synthetic metadata, a nonexistent session path and a dead loopback proxy. Never log in, send messages, change accounts or start a persistent owner daemon as part of build/tests. Optional privileged tool groups retain explicit opt-in gates.

Use npm ci --ignore-scripts, npm run runtime:apply, npm test and npm run test:smoke. Native installer scripts must only be exercised with an explicitly isolated test root/runtime-only mode; never against the developer HOME. Preserve existing user credentials, sessions and client configs during updates.

Only one manual final GitHub Actions run for a complete iteration. Before public push, inspect the exact diff and run redacted secret/privacy checks. Version tags may be used only for discovery: installers resolve one commit SHA before downloading and record it. Release artifacts use a source allowlist and immutable source SHA; server rollout is separate and must have a recorded rollback. Keep private audit evidence outside this repository.

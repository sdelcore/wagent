# wagent docs

Active:

- [why.md](./why.md) — motivation and the specific problem this solves.
- [architecture.md](./architecture.md) — current architecture
  (post-2026-04-25 reversal).
- [decisions.md](./decisions.md) — key decisions with their reasoning,
  most recent first.
- [setup.md](./setup.md) — installing and running wagent on any host.
- [nixos-setup.md](./nixos-setup.md) — using the flake's
  `nixosModules.default` on NixOS.
- [limitations-tracker.md](./limitations-tracker.md) — Rivet
  workarounds wagent retires, tracked commit-by-commit.
- [delegation.md](./delegation.md) — design sketch for cross-harness
  agent-to-agent delegation (not yet implemented).

Historical:

- [droidcode-migration.md](./droidcode-migration.md) — droidcode's
  earlier OpenCode→Rivet migration. Both endpoints are now obsolete;
  droidcode talks to wagent directly. Kept as a record of the path.

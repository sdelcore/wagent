# wagent docs

- [why.md](./why.md) — motivation and the specific problem this solves
- [architecture.md](./architecture.md) — current architecture (post-2026-04-25 reversal)
- [decisions.md](./decisions.md) — key decisions with their reasoning, most recent first
- [limitations-tracker.md](./limitations-tracker.md) — Rivet workarounds
  wagent retires, tracked commit-by-commit
- [setup.md](./setup.md) — host install (generic, systemd user service).
  **Note:** describes the prior Rivet-binary deployment; will be rewritten
  when wagent's own systemd unit lands
- [nixos-setup.md](./nixos-setup.md) — NixOS module sketch (also pre-rewrite)
- [droidcode-migration.md](./droidcode-migration.md) — historical: how
  droidcode swapped from the OpenCode API to the Rivet TS SDK. droidcode's
  next migration (Rivet → wagent) lives in droidcode's own repo.

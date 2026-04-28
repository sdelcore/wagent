# Setup

Three install paths, depending on your host:

* **NixOS** — use the flake's NixOS module. See
  [nixos-setup.md](./nixos-setup.md).
* **Any system with Nix** — `nix run github:sdelcore/wagent` for a
  zero-install ad-hoc launch, or build a release tarball from source.
* **Plain Linux without Nix** — install the published npm tarball
  and write a systemd user unit yourself.

## Dev environment (this repo)

```bash
cd ~/src/wagent
direnv allow            # first time only — activates the nix flake
                         # (node 22, npm, that's it)
npm install
npm run dev             # tsx watch on :2468
npm test                # full v1 API suite (echo path)
CLAUDE_E2E=1 npm test   # also exercise the Claude Agent SDK adapter
```

The smoke test (`npm run smoke`) is a lighter alternative — single
turn against `echo` by default, configurable via `SMOKE_AGENTS`.

## Ad-hoc on any Nix host

```bash
nix run github:sdelcore/wagent
```

Listens on `:2468` with default config. Pass env vars before the
command — e.g. `WAGENT_PORT=12345 nix run github:sdelcore/wagent`.

## Plain Linux (no Nix)

Get the release tarball from
<https://github.com/sdelcore/wagent/releases>:

```bash
mkdir -p ~/.local/share/wagent && cd ~/.local/share/wagent
curl -L -o wagent.tgz https://github.com/sdelcore/wagent/releases/latest/download/wagent-0.1.0.tgz
npm install ./wagent.tgz       # installs the bin into ./node_modules/.bin/wagent
```

Then the systemd user unit:

```ini
# ~/.config/systemd/user/wagent.service
[Unit]
Description=wagent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%h/.local/share/wagent/node_modules/.bin/wagent
Restart=on-failure
RestartSec=3
Environment=WAGENT_HOST=127.0.0.1
Environment=WAGENT_PORT=2468
# Bearer token from a managed secret store, e.g.:
EnvironmentFile=%h/.config/wagent.env

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now wagent
journalctl --user -u wagent -f
```

## Configuration

| env | default | purpose |
|---|---|---|
| `WAGENT_HOST` | `0.0.0.0` | listen host |
| `WAGENT_PORT` | `2468` | listen port |
| `WAGENT_DB` | `~/.local/share/wagent/wagent.sqlite` | SQLite path |
| `WAGENT_TOKEN` | *(unset)* | bearer token; clients send `Authorization: Bearer <token>` |
| `WAGENT_CORS` | `*` | comma-separated origin allowlist for the v1 API |
| `LOG_LEVEL` | `info` | Fastify logger level |
| `CLAUDE_CODE_EXECUTABLE` | *(auto-detected)* | override the `claude` binary used by the claude adapter (set when the bundled native binary doesn't run on your libc, e.g. NixOS picks the musl variant by default) |
| `ANTHROPIC_API_KEY` | *(unset)* | passed through to the Claude Agent SDK; the user's subscription OAuth at `~/.claude/` works too |

## Agent installation

* **`echo`** — built-in stub agent, always available. No external deps.
* **`claude`** — needs the `claude` CLI on the host (subscription
  OAuth at `~/.claude/` or `ANTHROPIC_API_KEY`). Wagent embeds the
  [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk),
  which shells out to that binary. On NixOS, set
  `CLAUDE_CODE_EXECUTABLE` (auto-detected via `which claude` when
  unset) so the SDK uses a glibc binary.
* **`pi`** — runs in-process via the
  [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono)
  SDK, which ships with wagent. No `pi` binary on PATH required. Auth
  for the underlying model provider (Anthropic / OpenAI / etc.) reads
  from the same `~/.pi/agent/auth.json` that the `pi` CLI writes
  (configure once with `pi` if you want OAuth) or from environment
  variables.

Probe live availability with `curl <host>:2468/v1/agents`. Each row
has `installed: bool` plus a `reason` if not.

## Verify

From any device that can reach the host:

```bash
curl http://<host>:2468/v1/health
curl http://<host>:2468/v1/meta
curl http://<host>:2468/v1/agents
```

End-to-end:

```bash
SID=$(curl -s -X POST http://<host>:2468/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"agent":"echo","cwd":"/tmp"}' | jq -r .id)

curl -X POST http://<host>:2468/v1/sessions/$SID/message \
  -H 'content-type: application/json' \
  -d '{"content":[{"type":"text","text":"hi"}]}'

curl -N http://<host>:2468/v1/sessions/$SID/events/stream
```

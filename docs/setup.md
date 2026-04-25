# Setup

## Dev environment (this repo)

```bash
cd ~/src/wagent
direnv allow    # first time only
# direnv activates the nix flake; node 22 + tooling on PATH

npm install
npm test        # runs src/test.ts — smoke test against Claude
```

Requires `ANTHROPIC_API_KEY` in the environment, or a logged-in Claude Code install at `~/.claude/.credentials.json`.

## Host setup (each PC that runs agents)

> **NixOS hosts:** see [nixos-setup.md](./nixos-setup.md) for a drop-in module that handles binary install, systemd service, opnix secret wiring, and Tailscale Serve. The steps below are the generic Linux equivalent.

### 1. Install the daemon

```bash
curl -fsSL https://releases.rivet.dev/sandbox-agent/0.4.x/install.sh | sh
```

Installs `sandbox-agent` to `/usr/local/bin`.

### 2. Install agents you care about

```bash
sandbox-agent install-agent claude
# or: sandbox-agent install-agent --all
```

### 3. Provide credentials

**Option A — API key (simpler, clear TOS):**

```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."
```

Pay per token. No subscription ambiguity.

**Option B — Personal subscription (cheaper for heavy use):**

Log in via the normal `claude` CLI once. sandbox-agent auto-picks up `~/.claude/.credentials.json`.

See [research.md §9.1](../research.md) or Anthropic's TOS for the OAuth vs API-key tradeoff.

### 4. Run as a systemd user service

```ini
# ~/.config/systemd/user/sandbox-agent.service
[Unit]
Description=Sandbox Agent daemon
After=network.target

[Service]
# Use token if you're not fully trusting Tailscale
ExecStart=/usr/local/bin/sandbox-agent server \
  --no-token \
  --host 127.0.0.1 \
  --port 2468 \
  --cors-allow-origin https://your-pwa-origin.example
Environment=ANTHROPIC_API_KEY=sk-ant-api03-...
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now sandbox-agent
systemctl --user status sandbox-agent
```

Logs: `journalctl --user -u sandbox-agent -f`.

### 5. Expose over Tailscale

Tailscale should already be running on the host. Either:

- Bind to the Tailscale IP: `--host 100.x.x.x`
- Or keep binding to `127.0.0.1` and use `tailscale serve` to proxy. Cleaner in ACL terms but one more moving piece.

### 6. Verify

From another device on the tailnet:

```bash
curl http://<host-tailscale-name>:2468/v1/health
```

## Client setup (PWA)

TBD — droidcode-PWA does not exist yet. The test harness in `src/test.ts` validates the SDK usage patterns that the PWA will mirror.

## Per-project Nix flakes (optional, recommended)

For each project you want the agent to work on, drop a `flake.nix` in the project root declaring its toolchain. The agent will pick up the environment via `nix develop` when you spawn a session with that `cwd`.

Not required. Without it, the agent runs in the daemon's environment.

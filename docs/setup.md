# Setup

Three install paths.

## NixOS (recommended)

The flake exports a NixOS module. Hosts don't run `npm install` —
Nix builds wagent (with `better-sqlite3` compiled from source
against `nodejs_22`'s V8 headers) before the systemd unit comes up.

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    wagent.url  = "github:sdelcore/wagent";
  };
  outputs = { self, nixpkgs, wagent, ... }: {
    nixosConfigurations.nightman = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [ wagent.nixosModules.default ./hosts/nightman.nix ];
    };
  };
}
```

```nix
# hosts/nightman.nix
{
  services.wagent = {
    enable = true;
    host = "0.0.0.0";              # or "127.0.0.1" for loopback only
    port = 2468;
    cors = "https://droidcode.example.ts.net";
    openFirewall = true;
    environmentFile = "/run/agenix/wagent.env";  # WAGENT_TOKEN, ANTHROPIC_API_KEY
    extraEnvironment.LOG_LEVEL = "debug";
  };
}
```

`nixos-rebuild switch`, then `journalctl -u wagent -f`.

The DB lives at `/var/lib/wagent/wagent.sqlite`. The unit hardens via
`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`,
`ProtectHome=read-only`, and `ReadWritePaths=[ "/var/lib/wagent" ]`.

### Module options

| option | type | default | purpose |
|---|---|---|---|
| `enable` | bool | `false` | turn the service on |
| `package` | package | flake default | override the wagent build |
| `user` | str | `"wagent"` | service user (auto-created if default) |
| `host` | str | `"127.0.0.1"` | listen address |
| `port` | port | `2468` | HTTP port |
| `cors` | str | `"*"` | comma-separated origin allowlist |
| `environmentFile` | path \| null | `null` | KEY=value secrets file sourced by systemd |
| `extraEnvironment` | attrs of str | `{}` | extra env vars |
| `openFirewall` | bool | `false` | open the port in `networking.firewall` |

### Tailscale Serve (optional, for HTTPS over tailnet)

```nix
services.wagent.host = "127.0.0.1";
services.wagent.openFirewall = false;
services.tailscale.enable = true;

systemd.services.wagent-tailscale-serve = {
  after = [ "tailscaled.service" "wagent.service" ];
  wants = [ "tailscaled.service" "wagent.service" ];
  wantedBy = [ "multi-user.target" ];
  serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
  script = ''
    ${pkgs.tailscale}/bin/tailscale serve --bg --https=443 \
      http://127.0.0.1:2468
  '';
};
```

Reachable at `https://<hostname>.<tailnet>.ts.net/` with a Tailscale
cert.

## Any system with Nix

```bash
nix run github:sdelcore/wagent
```

Same binary, no service. Pass env vars before the command:
`WAGENT_PORT=12345 nix run github:sdelcore/wagent`.

## Plain Linux (no Nix)

Get the release tarball from the
[releases page](https://github.com/sdelcore/wagent/releases):

```bash
mkdir -p ~/.local/share/wagent && cd ~/.local/share/wagent
curl -L -o wagent.tgz https://github.com/sdelcore/wagent/releases/latest/download/wagent-0.1.0.tgz
npm install ./wagent.tgz
```

Systemd user unit:

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
EnvironmentFile=%h/.config/wagent.env

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now wagent
journalctl --user -u wagent -f
```

## Dev environment (this repo)

```bash
cd ~/src/wagent
direnv allow            # first time only — activates the nix flake
npm install
npm run dev             # tsx watch on :2468
npm run typecheck
npm run test:unit       # pure-function unit tests
npm test                # full v1 API suite (echo path)
CLAUDE_E2E=1 npm test   # also exercise the Claude Agent SDK
npm run smoke           # one-turn echo run
```

## Configuration

| env | default | purpose |
|---|---|---|
| `WAGENT_HOST` | `0.0.0.0` | listen host |
| `WAGENT_PORT` | `2468` | listen port |
| `WAGENT_DB` | `~/.local/share/wagent/wagent.sqlite` | SQLite path |
| `WAGENT_TOKEN` | *(unset)* | bearer token; clients send `Authorization: Bearer <token>` |
| `WAGENT_CORS` | `*` | comma-separated origin allowlist |
| `LOG_LEVEL` | `info` | Fastify logger level |
| `CLAUDE_CODE_EXECUTABLE` | *(auto-detected via `which claude`)* | path to the `claude` binary the SDK shells out to. Set when the bundled binary doesn't run on your libc (e.g. NixOS picks the musl variant by default). |
| `ANTHROPIC_API_KEY` | *(unset)* | passed through to the Claude Agent SDK; subscription OAuth at `~/.claude/` works too. |

## Agent installation

* **`echo`** — built-in stub, always available.
* **`claude`** — needs the `claude` CLI on the host (subscription
  OAuth at `~/.claude/` or `ANTHROPIC_API_KEY`). The Claude Agent SDK
  ships with wagent and shells out to that binary.
* **`pi`** — runs in-process via the bundled
  [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono)
  SDK. No `pi` binary on PATH required. Auth reads from the same
  `~/.pi/agent/auth.json` the `pi` CLI writes (configure once with
  `pi`) or from environment variables.

`curl <host>:2468/v1/agents` returns live availability with
`installed: bool` and a `reason` if not.

## Verify

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

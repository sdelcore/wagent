# NixOS host setup

wagent ships its own NixOS module via the flake. Drop the input into
your system flake, enable the module, `nixos-rebuild switch`. Hosts
don't need to run `npm install` — Nix builds wagent (with
better-sqlite3 compiled from source against `nodejs_22`'s exact V8
headers) before the systemd unit comes up.

## flake.nix

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    wagent.url = "github:sdelcore/wagent";
  };

  outputs = { self, nixpkgs, wagent, ... }: {
    nixosConfigurations.nightman = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        wagent.nixosModules.default
        ./hosts/nightman.nix
      ];
    };
  };
}
```

## Host module

```nix
# hosts/nightman.nix
{ ... }: {
  services.wagent = {
    enable = true;
    host = "0.0.0.0";              # or "127.0.0.1" for loopback only
    port = 2468;
    cors = "https://droidcode.example.ts.net";
    openFirewall = true;

    # Secrets. The file is sourced by systemd as KEY=value pairs.
    # Use agenix / sops / opnix — whatever your host already does.
    environmentFile = "/run/agenix/wagent.env";

    extraEnvironment = {
      LOG_LEVEL = "debug";
    };
  };
}
```

`environmentFile` is the right place for `WAGENT_TOKEN` (bearer
auth) and `ANTHROPIC_API_KEY` if you're paying per token instead of
using the Claude Code subscription OAuth.

## NixOS module options

| option | type | default | purpose |
|---|---|---|---|
| `enable` | bool | `false` | turn the service on |
| `package` | package | the flake's default | override the wagent build |
| `user` | str | `"wagent"` | service user (auto-created if default) |
| `host` | str | `"127.0.0.1"` | listen address |
| `port` | port | `2468` | HTTP port |
| `cors` | str | `"*"` | comma-separated origin allowlist |
| `environmentFile` | path \| null | `null` | KEY=value secrets file sourced by systemd |
| `extraEnvironment` | attrs of str | `{}` | extra env vars |
| `openFirewall` | bool | `false` | open the port in `networking.firewall` |

## What the module does

* Creates a `wagent` system user + group with home `/var/lib/wagent`.
* Writes a systemd unit (`systemd.services.wagent`) that:
  - Runs `${wagent.packages.${system}.default}/bin/wagent`.
  - Sets `StateDirectory=wagent` (`/var/lib/wagent`, mode `0750`).
  - Hardens via `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`,
    `ProtectHome=read-only`, `ReadWritePaths=[ "/var/lib/wagent" ]`.
  - Restarts on failure with `RestartSec=3`.
* Optionally opens `port` in the firewall.

The SQLite DB lives at `/var/lib/wagent/wagent.sqlite` by default.

## Tailscale Serve (optional)

If you want HTTPS over your tailnet:

```nix
{
  services.wagent.host = "127.0.0.1";   # don't bind public
  services.wagent.openFirewall = false;

  services.tailscale.enable = true;

  systemd.services.wagent-tailscale-serve = {
    description = "Publish wagent over Tailscale Serve";
    after = [ "tailscaled.service" "wagent.service" ];
    wants = [ "tailscaled.service" "wagent.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig.Type = "oneshot";
    serviceConfig.RemainAfterExit = true;
    script = ''
      ${pkgs.tailscale}/bin/tailscale serve --bg --https=443 \
        http://127.0.0.1:2468
    '';
  };
}
```

That makes wagent reachable at `https://<hostname>.<tailnet>.ts.net/`
with a Tailscale-issued cert.

## Ad-hoc (no permanent install)

```bash
nix run github:sdelcore/wagent
```

Same binary, no service. Useful for one-off testing on a host that
doesn't run wagent normally.

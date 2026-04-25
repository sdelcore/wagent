# NixOS host setup for wagent

Concrete Nix module to drop into `~/src/infra/nixos/` so that `nightman`, `dayman`, or any other host runs sandbox-agent as a system service, publishes it over Tailscale Serve as HTTPS, and pulls the Anthropic API key from 1Password/opnix.

Follows the existing patterns in the infra repo (`nix/modules/software/*.nix`, opnix secrets, Tailscale module).

---

## Files to add

### 1. `nix/modules/software/sandbox-agent.nix`

```nix
{ config, lib, pkgs, primaryUser, ... }:

let
  version = "0.4.2";

  # Pre-built musl binary from Rivet's release CDN.
  # When bumping the version, run:
  #   nix-prefetch-url https://releases.rivet.dev/sandbox-agent/${version}/binaries/sandbox-agent-x86_64-unknown-linux-musl
  sandbox-agent = pkgs.stdenv.mkDerivation {
    pname = "sandbox-agent";
    inherit version;

    src = pkgs.fetchurl {
      url = "https://releases.rivet.dev/sandbox-agent/${version}/binaries/sandbox-agent-x86_64-unknown-linux-musl";
      sha256 = lib.fakeSha256; # replace on first build
    };

    dontUnpack = true;
    dontBuild = true;

    installPhase = ''
      runHook preInstall
      install -Dm755 $src $out/bin/sandbox-agent
      runHook postInstall
    '';

    meta = with lib; {
      description = "Rivet sandbox-agent — HTTP control plane for coding agents";
      homepage = "https://github.com/rivet-dev/sandbox-agent";
      license = licenses.asl20;
      platforms = [ "x86_64-linux" ];
    };
  };

  stateDir = "/home/${primaryUser}/.local/share/sandbox-agent";
  envFile = "/run/sandbox-agent/env";
in
{
  # Make the binary available on PATH for manual use.
  environment.systemPackages = [ sandbox-agent ];

  # Pull the Anthropic API key into an env file that systemd can source.
  # opnix writes the raw secret to /var/lib/opnix/secrets/anthropicApiKey;
  # systemd's EnvironmentFile needs KEY=VALUE format.
  systemd.services.sandbox-agent-env = {
    description = "Render env file for sandbox-agent from opnix secrets";
    after = [ "opnix-secrets.service" ];
    wants = [ "opnix-secrets.service" ];
    before = [ "sandbox-agent.service" ];
    wantedBy = [ "multi-user.target" ];

    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      RuntimeDirectory = "sandbox-agent";
      RuntimeDirectoryMode = "0750";
    };

    script = ''
      SRC="/var/lib/opnix/secrets/anthropicApiKey"
      if [ -f "$SRC" ]; then
        printf 'ANTHROPIC_API_KEY=%s\n' "$(cat $SRC)" > ${envFile}
        chmod 0400 ${envFile}
        chown ${primaryUser}:users ${envFile}
      else
        echo "sandbox-agent-env: $SRC missing; daemon will run without an API key (OAuth fallback)"
        : > ${envFile}
        chmod 0400 ${envFile}
        chown ${primaryUser}:users ${envFile}
      fi
    '';
  };

  # The daemon itself. Runs as the user so it can read ~/.claude/ credentials
  # and write to the user's project directories.
  systemd.services.sandbox-agent = {
    description = "Sandbox Agent (Rivet) daemon";
    after = [ "network-online.target" "sandbox-agent-env.service" "tailscaled.service" ];
    wants = [ "network-online.target" "sandbox-agent-env.service" ];
    wantedBy = [ "multi-user.target" ];

    serviceConfig = {
      Type = "simple";
      User = primaryUser;
      Group = "users";
      WorkingDirectory = "/home/${primaryUser}";
      EnvironmentFile = envFile;

      ExecStart = ''
        ${sandbox-agent}/bin/sandbox-agent server \
          --no-token \
          --host 127.0.0.1 \
          --port 2468
      '';

      Restart = "on-failure";
      RestartSec = 5;

      # The agent needs real access to the user's filesystem.
      # Don't ProtectHome; we want $HOME to be real.
      NoNewPrivileges = true;
      PrivateTmp = true;
    };

    # Ensure agent install dir exists before first run.
    preStart = ''
      mkdir -p ${stateDir}
    '';
  };

  # One-time agent install on first boot. Lazy-install works too, but this
  # warms the cache so the first session from the phone is snappy.
  systemd.services.sandbox-agent-install-claude = {
    description = "Preinstall Claude agent for sandbox-agent";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    before = [ "sandbox-agent.service" ];
    wantedBy = [ "multi-user.target" ];

    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = primaryUser;
      Group = "users";
    };

    script = ''
      mkdir -p ${stateDir}
      # Idempotent — install-agent is a no-op if already installed at this version.
      ${sandbox-agent}/bin/sandbox-agent install-agent claude || true
    '';
  };

  # Tailscale Serve: publish the daemon at https://<hostname>.<tailnet>.ts.net
  # The config is persisted in tailscaled state, so this is idempotent:
  # we reset first, then re-apply.
  systemd.services.sandbox-agent-tailscale-serve = {
    description = "Publish sandbox-agent via Tailscale Serve (HTTPS)";
    after = [ "sandbox-agent.service" "tailscaled.service" ];
    wants = [ "sandbox-agent.service" "tailscaled.service" ];
    wantedBy = [ "multi-user.target" ];

    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };

    script = ''
      TS=${pkgs.tailscale}/bin/tailscale
      # Wait briefly for tailscaled to be ready.
      for i in 1 2 3 4 5 6 7 8 9 10; do
        if $TS status >/dev/null 2>&1; then break; fi
        sleep 1
      done
      $TS serve reset || true
      $TS serve --bg --https=443 http://127.0.0.1:2468
    '';
  };
}
```

### 2. Add the secret to `nix/modules/secrets/opnix.nix`

Inside the existing `services.onepassword-secrets.secrets = { ... }` block, add:

```nix
# Anthropic API key for sandbox-agent (Rivet)
secrets."anthropicApiKey" = {
  reference = "op://Infrastructure/anthropic/api_key";
  mode = "0400";
};
```

Replace the `reference` path to match however you have the key stored in 1Password. If you'd rather use OAuth (personal Claude subscription), skip this secret — the `sandbox-agent-env` service above writes an empty file and the daemon falls back to `~/.claude/.credentials.json`.

### 3. Tailscale ACL — make `tag:wagent-host` reachable only by your devices

In your Tailscale ACL (at <https://login.tailscale.com/admin/acls>), if you haven't already scoped this:

```json
{
  "acls": [
    {
      "action": "accept",
      "src":    ["autogroup:owner"],
      "dst":    ["autogroup:owner:443"]
    }
  ]
}
```

Only your own devices on the tailnet can reach any host's `:443`. No action needed if you already have a permissive owner-only ACL.

Cert provisioning: run `tailscale cert <hostname>.<tailnet>.ts.net` once per host after enabling MagicDNS + HTTPS certs in the admin console. NixOS doesn't need to touch this; Tailscale stores the cert in its own state dir.

---

## Wire it into a profile

Pick the profile that represents "hosts that should run coding agents for me." Most likely `nix/profiles/development.nix`:

```nix
{ ... }: {
  imports = [
    ../modules/software/ollama.nix
    ../modules/software/android.nix
    ../modules/software/sandbox-agent.nix   # <- add
    ../modules/virtualization/docker.nix
    ../modules/virtualization/libvirt.nix
  ];
}
```

Or if you want only specific hosts to run it, import it directly in `nightman.configuration.nix` / `dayman.configuration.nix` instead.

---

## Apply and verify

```bash
# From the host (use your normal rebuild command)
sudo nixos-rebuild switch --flake ~/src/infra/nixos#$(hostname)

# First run will fail in the sandbox-agent derivation because sha256 is `fakeSha256`.
# Nix will print the correct hash; paste it into the module and re-run.

# Verify the service
systemctl status sandbox-agent
journalctl -u sandbox-agent -f

# Verify Tailscale Serve
tailscale serve status
# Expect: https://<hostname>.<tailnet>.ts.net → http://127.0.0.1:2468

# Smoke test from another device on the tailnet
curl https://<hostname>.<tailnet>.ts.net/v1/health
```

From the droidcode PWA, add a host pointing at the HTTPS URL Tailscale shows. No mixed-content issue because Tailscale provides a real trusted cert.

---

## Per-project Nix environments (optional)

Once this is running, the daemon spawns agents in whatever `cwd` you tell it. If you want each project's agent to see a reproducible toolchain, drop a `flake.nix` in the project root and write a thin wrapper script the daemon can use. This is out of scope for v0 — document it as a follow-up when reproducibility pain actually bites.

---

## What this does NOT do

- Does not run sandbox-agent in a sandbox/container. Host-direct execution is the deliberate design (§3 of `architecture.md`). If you want `exec_mode: sandbox` per session, use Docker or bubblewrap at session-creation time, not at the daemon level.
- Does not build sandbox-agent from source. It fetches the pre-built musl binary. If you need to audit the build, mirror the Rivet repo into your own flake and build with `buildRustPackage` instead.
- Does not manage the Tailscale tailnet itself. Assumes `services.tailscale` is already enabled (it is, via `nix/modules/network/tailscale.nix`) and the host is already joined to your tailnet.
- Does not set up the droidcode PWA deployment. That's a separate concern — see `droidcode/migration.md` Phase 7.

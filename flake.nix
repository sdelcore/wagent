{
  description = "wagent — daemon that runs coding agents over HTTP+SSE";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      perSystem = flake-utils.lib.eachDefaultSystem (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in {
          devShells.default = pkgs.mkShell {
            buildInputs = [ pkgs.nodejs_22 ];

            shellHook = ''
              echo "wagent dev shell — node $(node --version)"
              echo ""
              echo "  Dev:        npm run dev"
              echo "  Typecheck:  npm run typecheck"
              echo "  Smoke:      npm run smoke"
              echo "  Pack:       npm pack    (produces wagent-X.Y.Z.tgz)"
            '';
          };
        });

      # NixOS module — `imports = [ inputs.wagent.nixosModules.default ];`
      # then `services.wagent.enable = true;`.
      #
      # The module deliberately does NOT bundle wagent into the Nix store.
      # better-sqlite3's prebuild-install + node-gyp dance fights every
      # buildNpmPackage / mkDerivation approach (V8 ABI mismatch between
      # the prebuilt .node and any Nix Node we wrap with). Rather than
      # carry that fight, the module expects you to install wagent into
      # /var/lib/wagent/install (or anywhere — see `source` option) and
      # just wires up the systemd service + user + state directory.
      #
      # See the README for install options:
      #   - `npm install` from a `npm pack` tarball
      #   - `npm install` from a GitHub release tarball URL
      #   - clone the repo and `npm install`, then point `binary` at it
      nixosModule = { config, lib, pkgs, ... }:
        let
          cfg = config.services.wagent;
        in {
          options.services.wagent = {
            enable = lib.mkEnableOption "wagent — coding-agent HTTP+SSE daemon";

            binary = lib.mkOption {
              type = lib.types.str;
              default = "/var/lib/wagent/install/node_modules/.bin/wagent";
              description = ''
                Path to the wagent executable. Default location is where
                `npm install --prefix /var/lib/wagent/install wagent`
                puts it.
              '';
            };

            nodejs = lib.mkOption {
              type = lib.types.package;
              default = pkgs.nodejs_22;
              defaultText = lib.literalExpression "pkgs.nodejs_22";
              description = "Node.js used to run wagent.";
            };

            user = lib.mkOption {
              type = lib.types.str;
              default = "wagent";
              description = ''
                User to run wagent as. Created automatically when set to
                its default ("wagent").
              '';
            };

            host = lib.mkOption {
              type = lib.types.str;
              default = "127.0.0.1";
              example = "0.0.0.0";
              description = "Listen address.";
            };

            port = lib.mkOption {
              type = lib.types.port;
              default = 2468;
              description = "HTTP port wagent binds to.";
            };

            cors = lib.mkOption {
              type = lib.types.str;
              default = "*";
              example = "https://droidcode.example.ts.net";
              description = ''
                Comma-separated list of allowed CORS origins, or "*" for
                anything. Set explicit origins when exposing wagent past
                loopback.
              '';
            };

            environmentFile = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
              example = "/run/agenix/wagent.env";
              description = ''
                Path to a file with secrets in `KEY=value` form. Sourced by
                systemd before wagent starts. Use this for `WAGENT_TOKEN`,
                `ANTHROPIC_API_KEY`, etc.
              '';
            };

            extraEnvironment = lib.mkOption {
              type = lib.types.attrsOf lib.types.str;
              default = {};
              example = lib.literalExpression ''
                { LOG_LEVEL = "debug"; }
              '';
              description = "Additional environment variables for the wagent service.";
            };

            openFirewall = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = "Open `port` in the host firewall.";
            };
          };

          config = lib.mkIf cfg.enable {
            users.users = lib.mkIf (cfg.user == "wagent") {
              wagent = {
                isSystemUser = true;
                group = "wagent";
                home = "/var/lib/wagent";
                createHome = true;
                description = "wagent daemon";
              };
            };
            users.groups = lib.mkIf (cfg.user == "wagent") { wagent = {}; };

            networking.firewall = lib.mkIf cfg.openFirewall {
              allowedTCPPorts = [ cfg.port ];
            };

            systemd.services.wagent = {
              description = "wagent — coding-agent HTTP+SSE daemon";
              wantedBy = [ "multi-user.target" ];
              after = [ "network-online.target" ];
              wants = [ "network-online.target" ];

              path = [
                cfg.nodejs
                # Available for any agent subprocess wagent spawns
                # (claude-agent-acp, pi --mode rpc) so they don't need
                # special PATH handling.
              ];

              environment = {
                WAGENT_HOST = cfg.host;
                WAGENT_PORT = toString cfg.port;
                WAGENT_CORS = cfg.cors;
                WAGENT_DB = "/var/lib/wagent/wagent.sqlite";
              } // cfg.extraEnvironment;

              serviceConfig = {
                Type = "simple";
                ExecStart = "${cfg.nodejs}/bin/node ${cfg.binary}";
                Restart = "on-failure";
                RestartSec = 3;
                User = cfg.user;
                Group = cfg.user;
                StateDirectory = "wagent";
                StateDirectoryMode = "0750";
                EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;

                # Hardening — wagent needs the network and its state
                # directory. It does spawn subprocesses (the agents), so
                # we can't lock things down too aggressively without
                # breaking that.
                NoNewPrivileges = true;
                PrivateTmp = true;
                ProtectSystem = "strict";
                ProtectHome = "read-only";
                ReadWritePaths = [ "/var/lib/wagent" ];
              };
            };
          };
        };
    in
      perSystem // {
        nixosModules.default = nixosModule;
        nixosModules.wagent = nixosModule;
      };
}

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
          packageJson = builtins.fromJSON (builtins.readFile ./package.json);

          # Pre-fetched, content-addressed copy of the npm dep cache.
          # Hash regenerated via: set to lib.fakeHash, run `nix build`,
          # copy the actual hash out of the error message.
          npmDeps = pkgs.fetchNpmDeps {
            src = ./.;
            hash = "sha256-GAiQzBXG4v79bNsQtYYUkP7Elo+Qq2Xmx99RDg03hy4=";
          };

          # Source as a Nix derivation — used by the NixOS module so hosts
          # don't have to clone or download the repo themselves.
          wagentSource = pkgs.runCommand "wagent-source" {} ''
            mkdir -p $out
            cp -r ${./.}/. $out/
            chmod -R u+w $out
            # Strip dev-only artifacts that shouldn't reach hosts.
            rm -rf $out/node_modules $out/dist $out/result $out/.git
          '';

          wagent = pkgs.stdenv.mkDerivation {
            pname = packageJson.name;
            version = packageJson.version;
            src = ./.;

            nativeBuildInputs = [
              pkgs.nodejs_22
              pkgs.makeWrapper
              pkgs.npmHooks.npmConfigHook
              # better-sqlite3 ships C++ bindings via node-gyp.
              pkgs.python3
              pkgs.pkg-config
            ];

            inherit npmDeps;

            # Skip postinstall scripts during npm ci so prebuild-install
            # doesn't fetch a .node that's ABI-incompatible with our
            # nodejs_22. We rebuild from source explicitly in buildPhase.
            npmFlags = [ "--ignore-scripts" ];

            buildPhase = ''
              runHook preBuild
              # Rebuild native modules from source against nodejs_22's
              # *exact* V8 headers — node-gyp would otherwise download
              # the headers from nodejs.org, which can be a different
              # V8 patch level from what nixpkgs ships, leading to
              # missing-symbol errors at runtime. `--nodedir` points
              # node-gyp at our Node's include/ dir.
              export npm_config_nodedir=${pkgs.nodejs_22}
              npm rebuild --build-from-source
              # Now build the TS sources to dist/.
              npm run build
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              mkdir -p $out/lib/wagent
              cp -r dist node_modules package.json $out/lib/wagent/
              mkdir -p $out/bin
              makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/wagent \
                --add-flags "$out/lib/wagent/dist/server.js"
              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = "Daemon that runs coding agents (Claude, pi) over HTTP+SSE";
              homepage = "https://github.com/sdelcore/wagent";
              license = licenses.mit;
              mainProgram = "wagent";
              platforms = platforms.linux;
            };
          };
        in {
          packages.default = wagent;
          packages.wagent = wagent;
          packages.wagent-source = wagentSource;

          devShells.default = pkgs.mkShell {
            buildInputs = [ pkgs.nodejs_22 ];

            shellHook = ''
              echo "wagent dev shell — node $(node --version)"
              echo ""
              echo "  Dev:        npm run dev"
              echo "  Typecheck:  npm run typecheck"
              echo "  Smoke:      npm run smoke"
            '';
          };
        });

      # NixOS module — `imports = [ inputs.wagent.nixosModules.default ];`
      # then `services.wagent.enable = true;`. Hosts don't need to run
      # `npm install` — Nix builds wagent for them.
      nixosModule = { config, lib, pkgs, ... }:
        let
          cfg = config.services.wagent;
          wagentPkg = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        in {
          options.services.wagent = {
            enable = lib.mkEnableOption "wagent — coding-agent HTTP+SSE daemon";

            package = lib.mkOption {
              type = lib.types.package;
              default = wagentPkg;
              defaultText = lib.literalExpression "wagent.packages.\${system}.default";
              description = "wagent package to run.";
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
                systemd before wagent starts. Use this for `WAGENT_AUTH_TOKEN`,
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

              environment = {
                WAGENT_HOST = cfg.host;
                WAGENT_PORT = toString cfg.port;
                WAGENT_CORS = cfg.cors;
                WAGENT_DB = "/var/lib/wagent/wagent.sqlite";
              } // cfg.extraEnvironment;

              serviceConfig = {
                Type = "simple";
                ExecStart = lib.getExe cfg.package;
                Restart = "on-failure";
                RestartSec = 3;
                User = cfg.user;
                Group = cfg.user;
                StateDirectory = "wagent";
                StateDirectoryMode = "0750";
                EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;

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

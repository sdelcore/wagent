{
  description = "wagent - Rivet sandbox-agent test harness";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        sandbox-agent = pkgs.stdenv.mkDerivation rec {
          pname = "sandbox-agent";
          version = "0.4.2";

          src = pkgs.fetchurl {
            url = "https://releases.rivet.dev/sandbox-agent/${version}/binaries/sandbox-agent-x86_64-unknown-linux-musl";
            sha256 = "16q2ixixpzh7ada9yfclfbrgn518crih9dd7394dwjl7xymric5s";
          };

          dontUnpack = true;
          dontBuild = true;

          installPhase = ''
            runHook preInstall
            install -Dm755 $src $out/bin/sandbox-agent
            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "Rivet sandbox-agent — HTTP control plane for coding agents";
            homepage = "https://github.com/rivet-dev/sandbox-agent";
            license = licenses.asl20;
            platforms = [ "x86_64-linux" ];
          };
        };
      in
      {
        packages.sandbox-agent = sandbox-agent;

        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs_22
            pkgs.corepack_22
            sandbox-agent
          ];

          shellHook = ''
            echo "wagent dev shell ready — node $(node --version), sandbox-agent $(sandbox-agent --version 2>&1 | head -1)"
          '';
        };
      });
}

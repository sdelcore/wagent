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

        # Rivet publishes per-arch musl binaries. Extend as upstream ships
        # more triples. armv7 (32-bit Pi / Pi Zero) is not available.
        binaryByTriple = {
          "x86_64-linux" = {
            triple = "x86_64-unknown-linux-musl";
            sha256 = "16q2ixixpzh7ada9yfclfbrgn518crih9dd7394dwjl7xymric5s";
          };
          "aarch64-linux" = {
            triple = "aarch64-unknown-linux-musl";
            sha256 = "sha256-UDYfh7mmznS6yvB/2Pd4ZiiL7oj8Rv0WIvgvYrj53Fo=";
          };
        };

        binary = binaryByTriple.${system} or null;

        sandbox-agent =
          if binary == null then
            throw "sandbox-agent not packaged for ${system} — Rivet only ships x86_64-linux and aarch64-linux musl binaries"
          else
            pkgs.stdenv.mkDerivation rec {
              pname = "sandbox-agent";
              version = "0.4.2";

              src = pkgs.fetchurl {
                url = "https://releases.rivet.dev/sandbox-agent/${version}/binaries/sandbox-agent-${binary.triple}";
                sha256 = binary.sha256;
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
                platforms = [ "x86_64-linux" "aarch64-linux" ];
              };
            };
      in
      {
        packages = pkgs.lib.optionalAttrs (binary != null) {
          inherit sandbox-agent;
          default = sandbox-agent;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs_22
            pkgs.corepack_22
          ] ++ pkgs.lib.optional (binary != null) sandbox-agent;

          shellHook = ''
            echo "wagent dev shell ready — node $(node --version), sandbox-agent $(sandbox-agent --version 2>&1 | head -1)"
          '';
        };
      });
}

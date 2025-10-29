{
  description = "claude-code-router: HM module + CLI package";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs";

  outputs = { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f:
        builtins.listToAttrs (map (system: {
          name = system;
          value = f system;
        }) systems);
    in {
      homeManagerModules = {
        claude-code-router = import ./nix/modules/claude-code-router.nix;
      };

      packages = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          # Lightweight package that wraps Node to run the built CLI in dist/
          ccr-cli = pkgs.stdenvNoCC.mkDerivation {
            pname = "ccr-cli";
            version = "unstable";
            src = ./.;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            installPhase = ''
              mkdir -p $out/bin $out/share/ccr
              cp -r dist $out/share/ccr/dist
              makeWrapper ${pkgs.nodejs}/bin/node $out/bin/ccr \
                --add-flags "$out/share/ccr/dist/cli.js"
            '';
          };
          default = self.packages.${system}.ccr-cli;
        });

      apps = forAllSystems (system: {
        ccr = {
          type = "app";
          program = "${self.packages.${system}.ccr-cli}/bin/ccr";
        };
        default = self.apps.${system}.ccr;
      });

      darwinModules = {
        claude-code-router = import ./nix/darwin/modules/claude-code-router.nix;
      };
    };
}

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
        let
          pkgs = import nixpkgs { inherit system; };
          lib = pkgs.lib;
          pnpm = pkgs.pnpm;
        in {
          # Build the CLI bundle during the derivation using pnpm.
          ccr-cli = pkgs.stdenv.mkDerivation {
            pname = "ccr-cli";
            version = "unstable";
            src = ./.;
            pnpmDeps = pnpm.fetchDeps {
              pname = "ccr-cli";
              version = "unstable";
              src = ./.;
              fetcherVersion = 1;
              hash = "sha256-RcnBO6vOfam80HpDorQ06y5wyn2+1Td9lwzmJXJ+lrY=";
            };
            nativeBuildInputs = [
              pkgs.nodejs
              pnpm.configHook
              pkgs.makeWrapper
            ];
            buildPhase = ''
              runHook preBuild
              export CCR_SKIP_UI=1
              pnpm run build
              runHook postBuild
            '';
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

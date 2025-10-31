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
          ccrCli = pkgs.callPackage ./nix/pkgs/ccr-cli.nix { };
        in {
          ccr-cli = ccrCli;
          default = ccrCli;
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

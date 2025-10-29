{ config, lib, pkgs, ... }:

let
  cfg = config.services.claudeCodeRouter;
  # Prefer an explicit package when provided to avoid duplicate pins; otherwise resolve via flakeRef
  ccrPkg = if cfg.ccrPackage != null then cfg.ccrPackage else (
    let flake = builtins.getFlake cfg.flakeRef; in flake.packages.${pkgs.system}.ccr-cli
  );
in
{
  options.services.claudeCodeRouter = with lib; {
    enable = mkEnableOption "Launchd agent for Claude Code Router (CCR)";

    # Optional explicit package for the CCR CLI. If set, flakeRef is ignored.
    ccrPackage = mkOption {
      type = types.nullOr types.package;
      default = null;
      description = "Optional explicit CCR CLI package to run (e.g., inputs.ccr.packages.${pkgs.system}.ccr-cli).";
    };

    # Flake reference for CCR (pin to commit when desired), e.g.:
    #   github:agentydragon/claude-code-router/abcd1234
    flakeRef = mkOption {
      type = types.str;
      default = "github:agentydragon/claude-code-router";
      description = "Flake reference for CCR to resolve the CLI package (pin to a commit to stabilize).";
    };

    # Optional env file sourced by the agent before launching CCR (for API keys, etc.).
    environmentFile = mkOption {
      type = with types; nullOr path;
      default = null;
      description = "Optional shell env file to source before starting CCR (e.g., ~/.config/claude-code-router/env).";
    };

    runAtLoad = mkOption { type = types.bool; default = true; };
    keepAlive = mkOption { type = types.bool; default = true; };
  };

  config = lib.mkIf cfg.enable {
    # Install CCR CLI into the system profile to ensure the wrapper is present
    environment.systemPackages = [ ccrPkg ];

    # Launchd user agent to run CCR
    launchd.user.agents.ccr = {
      serviceConfig = {
        Label = "ccr";
        # Use a login shell to allow PATH resolution and optional env sourcing
        ProgramArguments = [
          "/bin/sh"
          "-lc"
          (let
            sourceEnv = if cfg.environmentFile != null then "set -a; . ${cfg.environmentFile}; set +a; " else "";
          in
            "${sourceEnv}exec ${ccrPkg}/bin/ccr start")
        ];
        RunAtLoad = cfg.runAtLoad;
        KeepAlive = cfg.keepAlive;
      };
    };
  };
}

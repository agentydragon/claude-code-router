{ config, lib, pkgs, ... }:

let
  cfg = config.services.claudeCodeRouter;
  # Prefer an explicit package when provided to avoid duplicate pins; otherwise resolve via flakeRef
  ccrPkg = if cfg.ccrPackage != null then cfg.ccrPackage else (
    let flake = builtins.getFlake cfg.flakeRef; in flake.packages.${pkgs.system}.ccr-cli
  );
  launchCommand = lib.concatStringsSep "\n" (
    [ "set -euo pipefail" ]
    ++ lib.optionals (cfg.environmentFile != null) [
      "set -a"
      ". ${cfg.environmentFile}"
      "set +a"
    ]
    ++ [ "exec ${ccrPkg}/bin/ccr start" ]
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

    # Optional env file sourced by the service wrappers (launchd/systemd) before launching CCR.
    environmentFile = mkOption {
      type = with types; nullOr path;
      default = null;
      description = "Optional shell env file; only the service definitions source it (e.g., ~/.config/claude-code-router/env).";
    };

    runAtLoad = mkOption { type = types.bool; default = true; };
    keepAlive = mkOption { type = types.bool; default = true; };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      # Install CCR CLI into the system profile to ensure the wrapper is present
      environment.systemPackages = [ ccrPkg ];
    }

    (lib.mkIf pkgs.stdenv.isDarwin {
      # Launchd user agent to run CCR
      launchd.user.agents."claude-code-router" = {
        serviceConfig = {
          Label = "claude-code-router";
          ProgramArguments = [ "${pkgs.runtimeShell}" "-lc" launchCommand ];
          RunAtLoad = cfg.runAtLoad;
          KeepAlive = cfg.keepAlive;
        };
      };
    })

    (lib.mkIf pkgs.stdenv.isLinux {
      systemd.user.services."claude-code-router" = {
        Unit = {
          Description = "Claude Code Router";
          After = [ "network.target" ];
        };
        Service = {
          Type = "simple";
          ExecStart = "${pkgs.runtimeShell} -lc ${lib.escapeShellArg launchCommand}";
        } // (if cfg.keepAlive then {
          Restart = "on-failure";
          RestartSec = 5;
        } else {
          Restart = "no";
        });
        Install = lib.optionalAttrs cfg.runAtLoad {
          WantedBy = [ "default.target" ];
        };
      };
    })
  ]);
}

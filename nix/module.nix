{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.proton-drive;

  accountArgs = lib.optionalString (
    cfg.account != null
  ) " --account ${lib.escapeShellArg cfg.account}";
  mountArgs = lib.optionalString (
    cfg.mountPoint != null
  ) " --mount-point ${lib.escapeShellArg cfg.mountPoint}";
in
{
  options.services.proton-drive = {
    enable = lib.mkEnableOption "the proton-drive Proton Drive FUSE mount";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "proton-drive";
      description = "Package providing the `proton-drive` CLI.";
    };

    mountPoint = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/home/user/ProtonDrive";
      description = ''
        Where to mount the drive. When null the CLI uses its own default
        (`~/ProtonDrive`).
      '';
    };

    account = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "work";
      description = "Account profile name, passed through as `--account`.";
    };

    gpgRecipient = lib.mkOption {
      type = lib.types.str;
      example = "0xDEADBEEF";
      description = ''
        GPG key id/fingerprint, exported to the service as
        `PROTONDRIVE_GPG_RECIPIENT`. The session is encrypted to this key at
        rest and decrypted in memory through gpg-agent; there is no keychain or
        passphrase fallback. Run `proton-drive login` once (with this variable
        set) to create the encrypted credentials file.
      '';
    };

    cachePaths = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [
        "/Documents"
        "/Photos"
      ];
      description = ''
        Only files under these Drive folders (POSIX paths under "My Files")
        may be kept in the persistent local cache. Files elsewhere are still
        readable, but their decrypted copy is deleted as soon as it is closed.

        Empty (the default) caches every file. Exported to the service as
        `PROTONDRIVE_CACHE_PATHS` (comma-separated).
      '';
    };

    ephemeralCache = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Never keep decrypted content on disk: every open uses a throwaway
        copy and the whole content cache is wiped when the mount starts and
        stops. Overrides `cachePaths`. Exported to the service as
        `PROTONDRIVE_EPHEMERAL_CACHE=1`.
      '';
    };

    autoStart = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Start the mount as a systemd user service at login.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    systemd.user.services.proton-drive = lib.mkIf cfg.autoStart {
      Unit = {
        Description = "Proton Drive FUSE mount (proton-drive, unofficial)";
        After = [ "network-online.target" ];
        Wants = [ "network-online.target" ];
        PartOf = [ "default.target" ];
      };
      Service = {
        Type = "simple";
        ExecStart = "${cfg.package}/bin/proton-drive mount${accountArgs}${mountArgs}";
        ExecStop = "${cfg.package}/bin/proton-drive unmount${accountArgs}${mountArgs}";
        Restart = "on-failure";
        RestartSec = 5;
        Environment = [
          "PROTONDRIVE_GPG_RECIPIENT=${lib.escapeShellArg cfg.gpgRecipient}"
        ]
        ++ lib.optionals (cfg.cachePaths != [ ]) [
          "PROTONDRIVE_CACHE_PATHS=${lib.escapeShellArg (lib.concatStringsSep "," cfg.cachePaths)}"
        ]
        ++ lib.optionals cfg.ephemeralCache [
          "PROTONDRIVE_EPHEMERAL_CACHE=1"
        ];
      };
      Install.WantedBy = [ "default.target" ];
    };
  };
}

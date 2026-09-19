{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.proton-drive;

  # Environment variables baked into the wrapper as *defaults*: an explicit
  # value in the user's shell still wins.
  env = {
    PROTONDRIVE_GPG_RECIPIENT = cfg.gpgRecipient;
    PROTONDRIVE_CREDENTIALS_FILE = cfg.credentialsFile;
    PROTONDRIVE_DATA_DIR = cfg.dataDir;
    PROTONDRIVE_BASE_URL = cfg.baseUrl;
    PROTONDRIVE_LOG_LEVEL = cfg.logLevel;
  }
  // lib.optionalAttrs (cfg.cachePaths != [ ]) {
    PROTONDRIVE_CACHE_PATHS = lib.concatStringsSep "," cfg.cachePaths;
  }
  // lib.optionalAttrs cfg.ephemeralCache {
    PROTONDRIVE_EPHEMERAL_CACHE = "1";
  }
  // cfg.environment;

  setEnvFlags = lib.concatStringsSep " " (
    lib.mapAttrsToList (name: value: "--set-default ${name} ${lib.escapeShellArg value}") (
      lib.filterAttrs (_: value: value != null && value != "") env
    )
  );

  # Wrap the CLI so the configured defaults are present no matter how it is
  # launched, without installing a service. The mount is started by hand
  # (`proton-drive mount`), which avoids the boot-time problem of gpg-agent
  # not being unlocked yet.
  wrapped =
    pkgs.runCommand "proton-drive-wrapped"
      {
        nativeBuildInputs = [ pkgs.makeWrapper ];
        meta.mainProgram = "proton-drive";
      }
      ''
        mkdir -p $out/bin
        makeWrapper ${lib.getExe cfg.package} $out/bin/proton-drive ${setEnvFlags}
      '';
in
{
  options.programs.proton-drive = {
    enable = lib.mkEnableOption "the proton-drive Proton Drive CLI (installs a wrapper with your defaults)";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "proton-drive";
      description = "Package providing the `proton-drive` CLI.";
    };

    gpgRecipient = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "0xDEADBEEF";
      description = ''
        GPG key id/fingerprint, set as `PROTONDRIVE_GPG_RECIPIENT`. The
        session is encrypted to this key at rest and decrypted in memory
        through gpg-agent; there is no keychain or passphrase fallback. Run
        `proton-drive login` once to create the encrypted credentials file.
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

        Empty (the default) caches every file. Set as the comma-separated
        `PROTONDRIVE_CACHE_PATHS`.
      '';
    };

    ephemeralCache = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Never keep decrypted content on disk: every open uses a throwaway
        copy and the whole content cache is wiped when the mount starts and
        stops. Overrides `cachePaths`. Set as `PROTONDRIVE_EPHEMERAL_CACHE=1`.
      '';
    };

    credentialsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/home/user/.local/share/proton-drive/auth-session.gpg";
      description = "Path to the GPG-encrypted session file (`PROTONDRIVE_CREDENTIALS_FILE`).";
    };

    dataDir = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Override the cache + app data directory (`PROTONDRIVE_DATA_DIR`).";
    };

    baseUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "drive-api.proton.me";
      description = "Drive API host (`PROTONDRIVE_BASE_URL`).";
    };

    logLevel = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.enum [
          "DEBUG"
          "INFO"
          "WARNING"
          "ERROR"
        ]
      );
      default = null;
      description = "Console log level (`PROTONDRIVE_LOG_LEVEL`).";
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        PROTONDRIVE_FUSE_DEBUG = "1";
      };
      description = "Extra environment variables to bake into the wrapper as defaults.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ wrapped ];
  };
}

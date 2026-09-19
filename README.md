# proton-drive

A minimalist, unofficial FUSE mount of [Proton Drive](https://proton.me/drive)
for Linux. It exposes your "My Files" as an ordinary directory — no sync
engine, no file-manager extension, no desktop-environment integration, no
keyring.

> **This is a third-party application, not officially supported by Proton.**
> It is not affiliated with, endorsed by, or connected to Proton AG. It is
> built on Proton's official, MIT-licensed [Drive SDK](https://github.com/ProtonDriveApps/sdk),
> under that SDK's guidelines for personal, non-commercial use.

## Features

- **Real filesystem.** Browse, open, edit and save, create folders, rename,
  move and delete. Any application sees it like any other directory.
- **No background sync.** The mount is a live view served by one process;
  nothing is copied around behind your back.
- **No keyring, no desktop integration.** The session is encrypted at rest
  with GnuPG and decrypted in memory through gpg-agent.
- **Foreground or background.** Run `mount` in a terminal, or `mount -d` to
  detach it and get your shell back.
- **Cache control.** Choose which Drive folders may be kept in the local
  cache, or run in ephemeral mode where nothing decrypted ever touches disk.

## Requirements

- Linux with `libfuse` (`fuse` or `fuse3`).
- GnuPG (`gpg`) with a key pair — the session is encrypted to your key.
- A session manager is **not** required: no Secret Service provider, GNOME
  Keyring, KWallet, D-Bus session, or desktop environment.

## Install with Nix

The flake provides the `proton-drive` package, an app, a dev shell, and a
home-manager module.

Run it without installing:

```bash
nix run github:you/proton-drive -- login   # sign in (see below)
nix run github:you/proton-drive -- mount   # mount ~/ProtonDrive
```

Or install it into a profile:

```bash
nix profile install github:you/proton-drive
```

### NixOS / home-manager module

Import the module and enable the service; it runs the mount as a systemd user
service and handles login at boot (restart on failure).

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    proton-drive.url = "github:you/proton-drive";
  };

  outputs = { nixpkgs, proton-drive, ... }@inputs: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        proton-drive.homeManagerModules.default
        {
          services.proton-drive = {
            enable = true;
            gpgRecipient = "0xDEADBEEF";   # your GPG key id / fingerprint

            # --- optional ---
            mountPoint = "/home/user/ProtonDrive";
            account = "default";           # a profile name, see "Multiple accounts"
            autoStart = true;

            # Cache only some folders (off by default: everything is cached):
            cachePaths = [ "/Documents" "/Photos" ];

            # Or never keep decrypted content on disk at all:
            # ephemeralCache = true;
          };
        }
      ];
    };
  };
}
```

Run `proton-drive login` once with the same `gpgRecipient` set (and the same
account profile) so the encrypted session file exists before the service
starts:

```bash
PROTONDRIVE_GPG_RECIPIENT=0xDEADBEEF proton-drive login
```

Module options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enable` | bool | `false` | Enable the mount service. |
| `package` | package | built from this flake | Package providing the CLI. |
| `gpgRecipient` | string | — | GPG key id/fingerprint the session is encrypted to (required). |
| `mountPoint` | null or string | `null` | Local folder to mount at; `null` uses `~/ProtonDrive`. |
| `account` | null or string | `null` | Account profile passed as `--account`. |
| `cachePaths` | list of strings | `[]` | Only keep these Drive folders in the persistent cache; empty caches everything. |
| `ephemeralCache` | bool | `false` | Never keep decrypted content on disk; wipes the cache on start and stop. |
| `autoStart` | bool | `true` | Start the mount as a systemd user service at login. |

## Without Nix

```bash
sudo apt install libfuse-dev gpg   # Debian/Ubuntu; needs the FUSE headers
npm install && npm run build
node dist/cli.js mount
```

Requires Node.js 20+; `npm install` compiles the native FUSE binding.

## Sign-in & credentials

Sign-in uses Proton's browser flow (the session-fork flow Proton's own apps
use): a URL is printed (and opened if a browser is available) and the command
polls until you approve it. Your Proton password is never typed into this
tool. The resulting session is stored encrypted at rest with GnuPG, using the
recipient key named by `PROTONDRIVE_GPG_RECIPIENT`, and decrypted in memory
through gpg-agent.

```bash
export PROTONDRIVE_GPG_RECIPIENT=0xDEADBEEF   # your GPG key id / fingerprint

proton-drive login     # browser sign-in; session encrypted to the key
proton-drive mount     # decrypts the session in memory via gpg-agent
```

- Ciphertext is written to `$XDG_DATA_HOME/proton-drive/auth-session.gpg`
  (ASCII-armored); override with `PROTONDRIVE_CREDENTIALS_FILE`.
- Refreshed session tokens are written back encrypted, so the file stays
  current across mounts.
- `proton-drive logout` deletes the file.
- If `PROTONDRIVE_GPG_RECIPIENT` is unset, commands fail with a clear error —
  there is no keychain or passphrase fallback.

> Unattended mounts (systemd) need gpg-agent to decrypt without prompting:
> either use a passphrase-less key, or cache the passphrase
> (`gpg-preset-passphrase`). Otherwise run the mount where you can unlock the
> agent.
>
> The stored session is a refresh token, by design — that's what lets a mount
> run unattended. `proton-drive logout` removes the local copy; to revoke
> sessions server-side, use Proton account settings → Security.

## Usage

```bash
proton-drive login                  # browser-based sign-in (session encrypted at rest)
proton-drive status                 # current account, session, profiles, mount point
proton-drive ls                     # list the drive root — no mount needed
proton-drive ls /Documents          # list a folder in the drive
proton-drive mount                  # mount at ~/ProtonDrive, foreground (Ctrl+C to stop)
proton-drive mount -d               # mount in the background and return
proton-drive mount -m /mnt/drive    # mount at a local folder of your choice
proton-drive unmount                # stop a running mount (foreground or detached)
proton-drive uncache <path...>      # drop local cached copies (re-downloaded on next open)
proton-drive logout
```

- `ls [path]` talks to the API directly, so you can inspect the drive before
  mounting. `d` marks folders, `f` files (with size).
- The **mount point is a local folder on this machine** (`-m`, default
  `~/ProtonDrive`), created if needed; the drive's "My Files" appears inside it.
- `uncache` (alias `evict`) only deletes the decrypted copies cached locally,
  to free space or force a refresh — nothing in Proton Drive is changed. The
  mount must be running. It refuses files that are open with unsaved changes.
- `--account <name>` is **optional** and only needed to run several Proton
  accounts side by side. Run `proton-drive status` to see the profiles found
  on this machine.
- Logging is quiet by default; add `-v/--verbose` to any command for detailed
  logs (API calls, sync events).

### Background mounts

`mount -d` (or `--detach`) forks the mount into the background, prints the
mount point and PID, and returns. Output is appended to
`<cache>/mount.log` (e.g. `~/.cache/proton-drive/mount.log`). Stop it with
`proton-drive unmount`, exactly like a foreground mount.

## Caching & privacy

Opening a file downloads its content to a local cache so that reads are fast.
By default **every** file is cached, under
`$XDG_CACHE_HOME/proton-drive/blobs/`, in decrypted form. Two options let you
narrow that down.

**Cache only some folders.** Set `PROTONDRIVE_CACHE_PATHS` to a
comma-separated list of Drive folder paths (or use the module's `cachePaths`).
Only files under those folders are kept; files elsewhere are still fully
readable and writable, but their decrypted copy is deleted as soon as the last
program using it closes the file.

```bash
export PROTONDRIVE_CACHE_PATHS="/Documents,/Photos"
```

**Never cache anything.** Set `PROTONDRIVE_EPHEMERAL_CACHE=1` (or the module's
`ephemeralCache`) to run fully ephemerally: every open uses a throwaway copy
that is removed on close, and the entire content cache is wiped both when the
mount starts and when it stops. This is the safest setting if the machine is
shared or its disk is not trusted.

```bash
export PROTONDRIVE_EPHEMERAL_CACHE=1
```

Metadata (the SDK's encrypted SQLite cache and cryptographic keys) is
unaffected: it is ciphertext, never plaintext content. The encrypted session
file is likewise never plaintext.

### Multiple accounts

`-a, --account <name>` is optional: omitting it uses the `default` profile.
Use it only to run additional Proton accounts side by side — each profile has
its own credentials file, cache/app dirs (`$XDG_CACHE_HOME/proton-drive-<name>`,
`$XDG_DATA_HOME/proton-drive-<name>`), and default mount point
(`~/ProtonDrive-<name>`). `proton-drive status` lists the profiles found.

```bash
proton-drive login --account work
proton-drive mount --account work
```

### Environment variables

| Variable | Purpose |
| --- | --- |
| `PROTONDRIVE_GPG_RECIPIENT` | GPG key id/fingerprint the session is encrypted to (**required**). |
| `PROTONDRIVE_CREDENTIALS_FILE` | Encrypted session path (default `$XDG_DATA_HOME/proton-drive/auth-session.gpg`). |
| `PROTONDRIVE_CACHE_PATHS` | Comma-separated Drive folders to keep in the persistent cache (empty = all). |
| `PROTONDRIVE_EPHEMERAL_CACHE` | Set to `1`/`true`/`yes` to never keep decrypted content on disk. |
| `PROTONDRIVE_DATA_DIR` | Override the cache + app data directory. |
| `PROTONDRIVE_BASE_URL` | Drive API host (default `drive-api.proton.me`). |
| `PROTONDRIVE_LOG_LEVEL` | `DEBUG`, `INFO`, `WARNING`, `ERROR` (default `WARNING`; `-v/--verbose` forces `INFO`). |
| `PROTONDRIVE_FUSE_DEBUG` | Set to `1` for FUSE debug logging. |

## Architecture

```
src/cli.ts              commander CLI: login, logout, status, ls, mount, unmount, uncache
src/mount.ts            wires DriveTree + ContentStore + FUSE ops into a Fuse instance
src/fuseOps.ts          FUSE syscall handlers (getattr, readdir, read, write, ...)
src/cachePolicy.ts      decides which paths may be cached (allowlist / ephemeral)
src/driveTree.ts        FUSE path <-> Drive node UID resolution + listing cache
src/contentStore.ts     local blob cache: download-on-open, upload-on-release
src/ipcServer.ts        Unix-socket control channel for `uncache` and `unmount`
src/sdk-bootstrap/      bootstraps @protontech/drive-sdk's ProtonDriveClient:
                        auth (via vendored proton-drive-sdk-account), HTTP client,
                        encrypted SQLite entities/crypto cache, event-cursor persistence
                        — ported from ProtonDriveApps/sdk's own CLI, see VENDOR.md
vendor/proton-drive-sdk-account/  vendored (unpublished) Proton auth/session module
```

Opening a file downloads it in full before any byte is readable, and a dirty
file is re-uploaded as a new revision on close. This is simple and reliable,
but large files are slower to open than a true byte-range/streaming
implementation would be.

## Limitations

- Linux only — the FUSE binding (`@cocalc/fuse-native`) has no macOS backend.
- Only "My Files" is exposed — no Trash, Devices, Shared-with-me, or Photos.
- No true streaming: large file opens download the whole file first.
- No conflict handling beyond what the SDK itself does — this is a live view,
  not a background sync engine.

## License

MIT — see [LICENSE](LICENSE). Vendors and adapts MIT-licensed code from
[ProtonDriveApps/sdk](https://github.com/ProtonDriveApps/sdk); see
[VENDOR.md](VENDOR.md) for provenance and what was changed.

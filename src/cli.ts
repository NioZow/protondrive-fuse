import './polyfills';

import { spawn } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

import { NodeType } from '@protontech/drive-sdk';
import type { NodeEntity } from '@protontech/drive-sdk';
import { LogLevel } from '@protontech/drive-sdk/dist/telemetry';
import { Command } from 'commander';

import { DriveTree, NodeNotFoundError } from './driveTree';
import { socketPathFor } from './ipcServer';
import { getConfig } from './sdk-bootstrap/config';
import { initDrive } from './sdk-bootstrap/init';
import { mount, unmount } from './mount';

const APP_VERSION = 'external-drive-proton_drive@0.1.0-alpha';
const DISCLOSURE = 'proton-drive is a third-party application, not officially supported by Proton.';

const ACCOUNT_OPTION = [
    '-a, --account <name>',
    'account profile to use (default: "default"; omit unless you use several Proton accounts — see "proton-drive status")',
] as const;
const MOUNT_POINT_OPTION = [
    '-m, --mount-point <path>',
    'local folder where the drive is mounted (default: ~/ProtonDrive)',
] as const;
const VERBOSE_OPTION = ['-v, --verbose', 'print detailed logs (API calls, sync events)'] as const;
const DETACH_OPTION = [
    '-d, --detach',
    'run the mount in the background and return immediately (logs go to <cache>/mount.log)',
] as const;

function defaultMountPointFor(account?: string): string {
    const resolved = account ?? 'default';
    return path.join(homedir(), resolved === 'default' ? 'ProtonDrive' : `ProtonDrive-${resolved}`);
}

async function drive(account?: string, verbose = false) {
    return initDrive({
        appVersion: APP_VERSION,
        clientUidPrefix: 'proton-drive',
        profile: account,
        // Only override the configured level when -v is given; otherwise the
        // default (or PROTONDRIVE_LOG_LEVEL) applies.
        ...(verbose ? { logLevel: LogLevel.INFO } : {}),
    });
}

/** True when `-v/--verbose` was given either after the subcommand or globally (before it). */
function isVerbose(opts: { verbose?: boolean }): boolean {
    return Boolean(opts.verbose || program.opts().verbose);
}

/** Best-effort list of account profiles that have data on this machine, for `status`. */
function discoverProfiles(): string[] {
    const names = new Set<string>(['default']);

    const xdgData = process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
    try {
        for (const entry of readdirSync(xdgData)) {
            const match = /^proton-drive(?:-(.+))?$/.exec(entry);
            if (match) {
                names.add(match[1] ?? 'default');
            }
        }
    } catch {
        // Directory may not exist yet; the default profile is always listed.
    }

    if (process.env.PROTONDRIVE_DATA_DIR) {
        try {
            for (const entry of readdirSync(process.env.PROTONDRIVE_DATA_DIR, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    names.add(entry.name);
                }
            }
        } catch {
            // Ignore an unreadable override.
        }
    }

    return [...names].sort();
}

const program = new Command();
program
    .name('proton-drive')
    .description('Mount your Proton Drive "My Files" as a local folder (unofficial).')
    .option(...VERBOSE_OPTION)
    .addHelpText(
        'after',
        `
Notes:
  Mounting is optional — "ls" and "status" work without a running mount.
  --account is optional: omitting it uses the "default" profile. A profile is
  just a name you pick (e.g. "work") to keep a second Proton account's session,
  cache and mount point separate. Run "proton-drive status" to see which
  profiles exist. A mount point is a LOCAL folder on this machine.
  Logging is quiet by default; pass -v/--verbose for detailed logs.

Examples:
  proton-drive login                 sign in (opens a Proton web page)
  proton-drive status                show session, profiles and mount point
  proton-drive ls                    list the drive root (no mount)
  proton-drive ls /Documents         list a folder in the drive
  proton-drive mount                 mount at ~/ProtonDrive (foreground)
  proton-drive mount -m /mnt/drive   mount at another local folder
  proton-drive mount -d              mount in the background and return
  proton-drive unmount               stop a running mount
  proton-drive uncache ~/ProtonDrive/report.pdf
`,
    )
    .showHelpAfterError();

program
    .command('login')
    .description('Sign in through your browser and save the session (encrypted)')
    .option(...ACCOUNT_OPTION)
    .option(...VERBOSE_OPTION)
    .addHelpText(
        'after',
        `
Opens a Proton sign-in page in your browser (or prints the URL if none can be
opened). Once you approve it there, the session is stored GPG-encrypted and
reused by "mount" until you run "logout".
`,
    )
    .action(async (opts: { account?: string; verbose?: boolean }) => {
        console.log(DISCLOSURE);
        const d = await drive(opts.account, isVerbose(opts));
        if (d.auth.isLoggedIn()) {
            console.log('Already logged in.');
            await d.dispose();
            process.exit(0);
        }
        await d.auth.authViaWeb(async (signInUrl) => {
            console.log(`Opening browser to sign in:\n  ${signInUrl}`);
            await import('open')
                .then((mod) => mod.default(signInUrl))
                .catch(() => {
                    console.log('Could not open a browser automatically — open the URL above manually.');
                });
        });
        console.log('Logged in.');
        console.log(`Session GPG-encrypted to ${d.config.gpgRecipient}: ${d.config.credentialsFile}`);
        await d.dispose();
        // The account API's HTTP keep-alive connection otherwise holds the
        // process open — this command is done, so exit explicitly.
        process.exit(0);
    });

program
    .command('logout')
    .description('Sign out and delete the locally stored session')
    .option(...ACCOUNT_OPTION)
    .option(...VERBOSE_OPTION)
    .action(async (opts: { account?: string; verbose?: boolean }) => {
        const d = await drive(opts.account, isVerbose(opts));
        await d.auth.logout();
        console.log('Logged out.');
        console.log(`Removed GPG-encrypted credentials file: ${d.config.credentialsFile}`);
        await d.dispose();
        process.exit(0);
    });

program
    .command('status')
    .description('Show the current account, session, profiles and mount point')
    .option(...ACCOUNT_OPTION)
    .option(...VERBOSE_OPTION)
    .option(...MOUNT_POINT_OPTION)
    .addHelpText(
        'after',
        `
Nothing here needs configuring up front: without --account you are on the
"default" profile. Use --account only to run additional Proton accounts side
by side; each profile has its own session, cache and default mount point.
`,
    )
    .action(async (opts: { account?: string; mountPoint?: string; verbose?: boolean }) => {
        const d = await drive(opts.account, isVerbose(opts));
        const profile = d.config.profile;
        const profiles = discoverProfiles();
        console.log(`Account profile: ${profile}${profile === 'default' ? ' (default; used when --account is omitted)' : ''}`);
        console.log(`Profiles found: ${profiles.join(', ')}`);
        console.log(`Session: ${d.auth.isLoggedIn() ? 'logged in' : 'not logged in'}`);
        console.log(`Credentials file: ${d.config.credentialsFile}`);
        console.log(`GPG recipient: ${d.config.gpgRecipient}`);
        console.log(`Mount point (local): ${opts.mountPoint ?? defaultMountPointFor(opts.account)}`);
        await d.dispose();
        process.exit(0);
    });

program
    .command('ls [path]')
    .description('List files and folders in Proton Drive without mounting; PATH is a Drive path (default: "/")')
    .option(...ACCOUNT_OPTION)
    .option(...VERBOSE_OPTION)
    .addHelpText(
        'after',
        `
Lists the drive contents as the server sees them, so you can find the paths
you want to mount or inspect. No FUSE mount is needed.

Output: "d" marks a folder, "f" a file (with its size).

Examples:
  proton-drive ls
  proton-drive ls /
  proton-drive ls /Documents
  proton-drive ls "/My folder"
`,
    )
    .action(async (remotePath: string | undefined, opts: { account?: string; verbose?: boolean }) => {
        const d = await drive(opts.account, isVerbose(opts));
        const target = remotePath ?? '/';
        try {
            const tree = new DriveTree(d.sdk, d.logger);
            const node = await tree.resolve(target);
            if (node.type !== NodeType.Folder) {
                console.log(formatEntry(nodeName(node, target), node));
            } else {
                const entries = [...(await tree.listChildren(node.uid)).entries()].map(([name, child]) => ({
                    name,
                    node: child,
                }));
                entries.sort(compareEntries);
                if (entries.length === 0) {
                    console.log('(empty folder)');
                }
                for (const entry of entries) {
                    console.log(formatEntry(entry.name, entry.node));
                }
            }
        } catch (error: unknown) {
            if (error instanceof NodeNotFoundError) {
                console.error(`No such folder in Proton Drive: ${target}`);
                process.exit(1);
            }
            throw error;
        }
        await d.dispose();
        process.exit(0);
    });

program
    .command('mount')
    .description('Mount Proton Drive at a local folder (foreground, or background with -d)')
    .option(...ACCOUNT_OPTION)
    .option(...VERBOSE_OPTION)
    .option(...MOUNT_POINT_OPTION)
    .option(...DETACH_OPTION)
    .addHelpText(
        'after',
        `
The mount point is a local folder on this machine (created if needed); the
drive's "My Files" appears inside it. Without -m it defaults to ~/ProtonDrive
(or ~/ProtonDrive-<account> for a named profile).

Without -d the command stays in the foreground; press Ctrl+C or run
"proton-drive unmount" to stop it. With -d/--detach it forks into the
background, prints the mount point and PID, and returns so you can keep your
shell; output is appended to <cache>/mount.log. Stop it the same way with
"proton-drive unmount".
`,
    )
    .action(
        async (opts: { account?: string; mountPoint?: string; verbose?: boolean; detach?: boolean }) => {
            const mountPoint = opts.mountPoint ?? defaultMountPointFor(opts.account);
            const verbose = isVerbose(opts);

            if (opts.detach) {
                await spawnDetached({ account: opts.account, mountPoint, verbose });
                process.exit(0);
            }

            const d = await drive(opts.account, verbose);
            // onStopped also covers a shutdown triggered over IPC by
            // `proton-drive unmount`, so a detached mount exits cleanly
            // instead of lingering after its filesystem is gone.
            const handle = await mount(d, mountPoint, { onStopped: () => process.exit(0) });
            console.log(`Mounted Proton Drive at ${mountPoint}`);

            const shutdown = async () => {
                console.log('\nUnmounting...');
                await handle.shutdown();
                process.exit(0);
            };
            process.once('SIGINT', shutdown);
            process.once('SIGTERM', shutdown);
        },
    );

program
    .command('unmount')
    .description('Unmount a mounted Proton Drive')
    .option(...ACCOUNT_OPTION)
    .option(...VERBOSE_OPTION)
    .option(...MOUNT_POINT_OPTION)
    .action(async (opts: { account?: string; mountPoint?: string }) => {
        const mountPoint = opts.mountPoint ?? defaultMountPointFor(opts.account);
        const config = getConfig({ appVersion: APP_VERSION, clientUidPrefix: 'proton-drive', profile: opts.account });

        // Ask a running daemon to stop itself (works for foreground and
        // -d/--detach mounts alike). If nothing is listening, the mount was
        // started some other way — fall back to a plain unmount.
        try {
            const res = await sendControl(socketPathFor(config.cacheDir), { op: 'shutdown' });
            if (res.ok) {
                console.log(`Unmounted ${mountPoint}`);
                process.exit(0);
            }
        } catch {
            // No daemon on the other end; handled below.
        }

        await unmount(mountPoint);
        console.log(`Unmounted ${mountPoint}`);
        process.exit(0);
    });

program
    .command('uncache <paths...>')
    .alias('evict')
    .description('Delete the local cached copy of file(s) so they re-download on next open (nothing changes in Proton Drive)')
    .option(...ACCOUNT_OPTION)
    .option(...VERBOSE_OPTION)
    .option(...MOUNT_POINT_OPTION)
    .addHelpText(
        'after',
        `
<paths...> are local paths inside the mount, e.g. ~/ProtonDrive/report.pdf.
The mount must be running. This only removes the decrypted copy cached on this
machine to free space or force a refresh; the file in Proton Drive is left
untouched and is fetched again the next time you open it.
`,
    )
    .action(async (paths: string[], opts: { account?: string; mountPoint?: string }) => {
        const mountPoint = opts.mountPoint ?? defaultMountPointFor(opts.account);
        const config = getConfig({ appVersion: APP_VERSION, clientUidPrefix: 'proton-drive', profile: opts.account });
        const socketPath = socketPathFor(config.cacheDir);

        let hadError = false;
        for (const target of paths) {
            try {
                const fusePath = toFusePath(target, mountPoint);
                const res = await sendEvict(socketPath, fusePath);
                if (res.ok) {
                    console.log(`Removed local cached copy: ${target}`);
                } else {
                    hadError = true;
                    console.error(`${target}: ${describeEvictError(res.error)}`);
                }
            } catch (err) {
                hadError = true;
                console.error(`${target}: ${describeEvictError(errorCode(err))}`);
            }
        }
        process.exit(hadError ? 1 : 0);
    });

function nodeName(node: NodeEntity, fallback: string): string {
    return node.name.ok ? node.name.value : fallback;
}

function compareEntries(a: { name: string; node: NodeEntity }, b: { name: string; node: NodeEntity }): number {
    const aDir = a.node.type === NodeType.Folder;
    const bDir = b.node.type === NodeType.Folder;
    if (aDir !== bDir) {
        return aDir ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
}

function formatEntry(name: string, node: NodeEntity): string {
    if (node.type === NodeType.Folder) {
        return `d  ${name}/`;
    }
    return `f  ${name}  ${formatSize(node.activeRevision?.claimedSize ?? 0)}`;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Converts an absolute filesystem path under the mount into the FUSE-relative path the daemon's DriveTree understands. */
function toFusePath(absPath: string, mountPoint: string): string {
    const real = path.resolve(absPath);
    const mount = path.resolve(mountPoint);
    if (real !== mount && !real.startsWith(mount + path.sep)) {
        throw new Error(`not-under-mount:${mountPoint}`);
    }
    const rel = real === mount ? '' : real.slice(mount.length);
    return rel === '' ? '/' : rel.split(path.sep).join('/');
}

/** Re-execs this CLI as a background mount process, detached from the current terminal. */
async function spawnDetached(opts: { account?: string; mountPoint: string; verbose: boolean }): Promise<void> {
    const config = getConfig({ appVersion: APP_VERSION, clientUidPrefix: 'proton-drive', profile: opts.account });
    await mkdir(config.cacheDir, { recursive: true });
    const logFile = path.join(config.cacheDir, 'mount.log');
    const log = openSync(logFile, 'a');

    const args = [process.argv[1], 'mount', '--mount-point', opts.mountPoint];
    if (opts.account) {
        args.push('--account', opts.account);
    }
    if (opts.verbose) {
        args.push('--verbose');
    }

    const child = spawn(process.execPath, args, {
        detached: true,
        stdio: ['ignore', log, log],
        env: process.env,
    });
    child.unref();
    closeSync(log);

    // Distinguish "started and still running" from "crashed right away":
    // errors would otherwise be invisible because stdio goes to the log file.
    const exitedEarly = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1500);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve(true);
        });
    });

    if (exitedEarly) {
        const tail = readFileSync(logFile, 'utf8').split('\n').slice(-15).join('\n').trim();
        throw new Error(`Detached mount exited immediately — see ${logFile}${tail ? `\n${tail}` : ''}`);
    }

    console.log(`Mounted Proton Drive at ${opts.mountPoint} (detached, pid ${child.pid})`);
    console.log(`Logs: ${logFile}`);
    console.log(`Stop with: proton-drive unmount --mount-point ${opts.mountPoint}`);
}

function sendEvict(socketPath: string, fusePath: string): Promise<{ ok: boolean; error?: string }> {
    return sendControl(socketPath, { op: 'evict', path: fusePath });
}

function sendControl(
    socketPath: string,
    payload: { op: 'evict'; path: string } | { op: 'shutdown' },
): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let buffer = '';
        socket.on('connect', () => {
            socket.write(`${JSON.stringify(payload)}\n`);
        });
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex >= 0) {
                socket.end();
                try {
                    resolve(JSON.parse(buffer.slice(0, newlineIndex)));
                } catch (err) {
                    reject(err);
                }
            }
        });
        socket.on('error', (err: NodeJS.ErrnoException) => {
            reject(new Error(err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? 'mount-not-running' : err.message));
        });
    });
}

function errorCode(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

function describeEvictError(code?: string): string {
    if (!code) {
        return 'unknown error';
    }
    if (code === 'not-found') {
        return 'not found on Proton Drive';
    }
    if (code === 'not-a-file') {
        return 'is a folder — uncache only works on files';
    }
    if (code === 'open-with-unsaved-changes') {
        return 'is currently open with unsaved changes — save or close it first';
    }
    if (code === 'mount-not-running') {
        return 'no running mount found — start "proton-drive mount" first';
    }
    if (code.startsWith('not-under-mount:')) {
        return `is not under the mount point ${code.slice('not-under-mount:'.length)}`;
    }
    return code;
}

program.parseAsync(process.argv).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});

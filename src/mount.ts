import { mkdir } from 'node:fs/promises';

import Fuse from '@cocalc/fuse-native';

import { createCachePolicy } from './cachePolicy';
import { ContentStore } from './contentStore';
import { DriveTree } from './driveTree';
import { createFuseOperations } from './fuseOps';
import { IpcServer, socketPathFor } from './ipcServer';
import type { initDrive } from './sdk-bootstrap/init';

export interface MountHandle {
    fuse: Fuse;
    ipc: IpcServer;
    /** Stops the IPC channel, unmounts, wipes the cache in ephemeral mode, and disposes the SDK client. Idempotent. */
    shutdown: () => Promise<void>;
}

export interface MountOptions {
    /** Called once after `shutdown()` finishes, so the caller can exit the process (e.g. after an IPC-triggered unmount). */
    onStopped?: () => void;
}

export async function mount(
    drive: Awaited<ReturnType<typeof initDrive>>,
    mountPoint: string,
    options: MountOptions = {},
): Promise<MountHandle> {
    if (!drive.auth.isLoggedIn()) {
        throw new Error('Not logged in. Run `proton-drive login` first.');
    }

    await mkdir(mountPoint, { recursive: true });

    const tree = new DriveTree(drive.sdk, drive.logger);
    const content = new ContentStore(drive.sdk, drive.config.cacheDir, drive.logger);
    if (drive.config.ephemeralCache) {
        // Clear anything a previous (possibly crashed) mount left behind
        // before we start handing out decrypted content again.
        await content.wipe();
    }
    const policy = createCachePolicy(drive.config);
    const { ops, hasUnsavedChanges } = createFuseOperations(drive.sdk, tree, content, policy, drive.logger);

    const isDefaultProfile = drive.config.profile === 'default';
    const fuse = new Fuse(mountPoint, ops, {
        force: true,
        mkdir: true,
        fsname: isDefaultProfile ? 'proton-drive' : `proton-drive-${drive.config.profile}`,
        displayFolder: isDefaultProfile ? 'Proton Drive' : `Proton Drive (${drive.config.profile})`,
        debug: process.env.PROTONDRIVE_FUSE_DEBUG === '1',
    });

    await new Promise<void>((resolve, reject) => {
        fuse.mount((err) => (err ? reject(err) : resolve()));
    });

    let ipc: IpcServer | undefined;
    let stopping: Promise<void> | undefined;

    async function doShutdown(): Promise<void> {
        await ipc?.stop();
        await new Promise<void>((resolve) => {
            fuse.unmount((err) => {
                if (err) {
                    drive.logger.error(`Unmount failed: ${err}`);
                }
                resolve();
            });
        });
        if (drive.config.ephemeralCache) {
            await content.wipe();
        }
        await drive.dispose();
        options.onStopped?.();
    }

    const shutdown = (): Promise<void> => (stopping ??= doShutdown());

    ipc = new IpcServer(socketPathFor(drive.config.cacheDir), tree, content, hasUnsavedChanges, drive.logger, shutdown);
    await ipc.start();

    return { fuse, ipc, shutdown };
}

export async function unmount(mountPoint: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        Fuse.unmount(mountPoint, (err) => (err ? reject(err) : resolve()));
    });
}

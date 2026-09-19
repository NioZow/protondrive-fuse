import { randomBytes } from 'node:crypto';

import { Logger } from '@protontech/drive-sdk';

import type { SessionCredentials, SessionInfo } from 'proton-drive-sdk-account';

import type { Credentials as CredentialsSnapshot, CredentialsStore } from './interface';

export class Credentials implements SessionCredentials {
    private cachePassword?: string;
    private userKeyPassword?: string;
    private sessionInfo?: SessionInfo;
    private telemetryEnabled?: boolean;

    private readonly sessionInfoChangedCallbacks = new Set<() => void>();

    constructor(
        private readonly store: CredentialsStore,
        private readonly logger: Logger,
    ) {}

    on(_: 'sessionInfoChanged', callback: () => void): void {
        this.sessionInfoChangedCallbacks.add(callback as () => void);
    }

    isLoggedIn(): boolean {
        return !!this.userKeyPassword && !!this.sessionInfo;
    }

    isTelemetryEnabled(): boolean {
        if (!this.isLoggedIn()) {
            return false;
        }
        return this.telemetryEnabled ?? false;
    }

    getUserKeyPassword(): string | undefined {
        return this.userKeyPassword;
    }

    async getCachePassword(): Promise<string> {
        if (!this.cachePassword) {
            this.cachePassword = randomBytes(32).toString('base64');
            await this.persistCredentials();
        }
        return this.cachePassword;
    }

    /**
     * Serializes the currently held credentials, or `undefined` when not
     * logged in. The snapshot is what gets encrypted at rest; exposed for
     * diagnostics/tooling.
     */
    toSnapshot(): CredentialsSnapshot | undefined {
        if (!this.userKeyPassword || !this.sessionInfo) {
            return undefined;
        }
        return {
            ...(this.cachePassword !== undefined && { cachePassword: this.cachePassword }),
            userKeyPassword: this.userKeyPassword,
            session: this.sessionInfo,
            ...(this.telemetryEnabled !== undefined && { telemetryEnabled: this.telemetryEnabled }),
        };
    }

    get uid(): string | undefined {
        return this.sessionInfo?.uid;
    }

    get accessToken(): string | undefined {
        return this.sessionInfo?.accessToken;
    }

    get refreshToken(): string | undefined {
        return this.sessionInfo?.refreshToken;
    }

    async load(): Promise<void> {
        const raw = await this.store.load();
        if (!raw) {
            this.logger.debug(`No session loaded`);
            return;
        }
        this.cachePassword = raw.cachePassword;
        this.userKeyPassword = raw.userKeyPassword;
        this.sessionInfo = raw.session;
        this.telemetryEnabled = raw.telemetryEnabled;
        this.notifySessionInfoChanged();
    }

    async setUserKeyPassword(userKeyPassword: string): Promise<void> {
        this.userKeyPassword = userKeyPassword;
        await this.persistCredentials();
        this.notifySessionInfoChanged();
    }

    async setSessionInfo(info: SessionInfo): Promise<void> {
        this.sessionInfo = info;
        await this.persistCredentials();
        this.notifySessionInfoChanged();
    }

    async setTelemetryEnabled(enabled: boolean): Promise<void> {
        this.telemetryEnabled = enabled;
        await this.persistCredentials();
    }

    async signOut(): Promise<void> {
        this.logger.debug(`Signing out`);
        this.userKeyPassword = undefined;
        this.sessionInfo = undefined;
        this.telemetryEnabled = undefined;
        await this.store.remove();
        this.notifySessionInfoChanged();
    }

    private async persistCredentials(): Promise<void> {
        if (!this.userKeyPassword || !this.sessionInfo) {
            return;
        }
        await this.store.save({
            cachePassword: this.cachePassword,
            userKeyPassword: this.userKeyPassword,
            session: this.sessionInfo,
            telemetryEnabled: this.telemetryEnabled,
        });
    }

    private notifySessionInfoChanged(): void {
        this.sessionInfoChangedCallbacks.forEach((callback) => callback());
    }
}

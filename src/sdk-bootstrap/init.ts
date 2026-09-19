import { mkdir } from 'node:fs/promises';

import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { Logger, OpenPGPCryptoWithCryptoProxy, ProtonDriveClient } from '@protontech/drive-sdk';
import { ConsoleLogHandler, LogFilter, type MetricEvent, Telemetry } from '@protontech/drive-sdk/dist/telemetry';

import { initApi } from './api';
import { createCaches } from './cache';
import { getOrGenerateClientUid } from './clientUid';
import { type Config, getConfig, type InitConfig } from './config';
import { type Credentials, initCredentials } from './credentials';
import { Manager, PersistedEventsProvider } from './events';
import { ConsoleLogger } from './logger';

/**
 * Bootstraps everything `@protontech/drive-sdk`'s `ProtonDriveClient` needs
 * from the host application: an authenticated HTTP client (via the vendored
 * `proton-drive-sdk-account` module), an encrypted-at-rest local cache, and
 * an event-cursor store so the SDK can use event-based sync instead of
 * polling. Trimmed from ProtonDriveApps/sdk `cli/src/init.ts` — no
 * telemetry/metrics, no Photos client (we only expose "My Files"). See
 * ../../VENDOR.md.
 */
export async function initDrive(configOptions: InitConfig) {
    const config = getConfig(configOptions);
    await Promise.all([mkdir(config.cacheDir, { recursive: true }), mkdir(config.appDir, { recursive: true })]);

    const logger: Logger = new ConsoleLogger(config.logLevel);

    // The SDK logs through its own Telemetry instance (its 'interface', 'api'
    // and 'events' loggers), which is separate from the Logger passed around
    // here. Left unset it defaults to INFO and ignores our level, so build one
    // filtered at `config.logLevel`. Metric handlers are disabled: otherwise
    // the default ConsoleMetricHandler prints every content-decryption metric
    // regardless of level.
    const telemetry = new Telemetry<MetricEvent>({
        logFilter: new LogFilter({ globalLevel: config.logLevel }),
        logHandlers: [new ConsoleLogHandler()],
        metricHandlers: [],
    });

    const openPGPCryptoModule = initOpenPGPCryptoModule();
    const credentials = initCredentials(config, logger);
    const { auth, addresses, srp, apiClient, httpClient } = await initApi(config, credentials, logger, CryptoProxy);

    const clientUid = await getOrGenerateClientUid(config, logger);
    const caches = createCaches(config, credentials, logger);
    const eventsProvider = config.enablePersistedEvents
        ? await PersistedEventsProvider.open(logger, config.appDir)
        : undefined;

    const sdk = new ProtonDriveClient({
        config: { baseUrl: config.baseUrl, clientUid },
        httpClient,
        entitiesCache: caches.entitiesCache,
        cryptoCache: caches.cryptoCache,
        account: addresses,
        openPGPCryptoModule,
        srpModule: srp,
        telemetry,
        ...(eventsProvider ? { latestEventIdProvider: eventsProvider } : {}),
    });

    // A single ProtonDriveClient also satisfies the Manager's `TreeSdk` shape
    // for both `driveSdk` and `photosSdk` — we don't use the Photos client
    // in v1, so `subscribePhotosScope` is simply never called.
    const eventsManager = eventsProvider
        ? await Manager.create(logger, sdk, sdk, eventsProvider, auth.isLoggedIn())
        : undefined;

    return {
        config,
        logger,
        credentials,
        auth,
        sdk,
        eventsManager,
        apiClient,
        dispose: async () => {
            await eventsManager?.dispose();
        },
    };
}

function initOpenPGPCryptoModule() {
    CryptoApi.init({});
    CryptoProxy.setEndpoint(new CryptoApi(), async (endpoint) => {
        endpoint.clearKeyStore();
    });
    return new OpenPGPCryptoWithCryptoProxy(CryptoProxy);
}

export type { Config };

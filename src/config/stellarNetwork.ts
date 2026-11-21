/**
 * Stellar network profiles and the start-up check that stops testnet and
 * mainnet settings from being mixed. Pure: reads no env and does no I/O.
 */
export type StellarNetwork = 'testnet' | 'mainnet';

interface NetworkProfile {
  passphrase: string;
  defaultHorizonUrl: string;
  /** Hostnames of the official Horizon endpoint(s) for this network. */
  officialHorizonHosts: string[];
}

export const STELLAR_NETWORKS: Record<StellarNetwork, NetworkProfile> = {
  testnet: {
    passphrase: 'Test SDF Network ; September 2015',
    defaultHorizonUrl: 'https://horizon-testnet.stellar.org',
    officialHorizonHosts: ['horizon-testnet.stellar.org'],
  },
  mainnet: {
    passphrase: 'Public Global Stellar Network ; September 2015',
    defaultHorizonUrl: 'https://horizon.stellar.org',
    officialHorizonHosts: ['horizon.stellar.org'],
  },
};

const OTHER_NETWORK: Record<StellarNetwork, StellarNetwork> = {
  testnet: 'mainnet',
  mainnet: 'testnet',
};

/** Throws unless `raw` is exactly "testnet" or "mainnet". */
export function parseStellarNetwork(raw: string): StellarNetwork {
  if (raw === 'testnet' || raw === 'mainnet') return raw;
  throw new Error(`STELLAR_NETWORK must be "testnet" or "mainnet", got "${raw}"`);
}

export interface StellarNetworkSettings {
  network: StellarNetwork;
  horizonUrl: string;
  networkPassphrase: string;
}

/**
 * Fail-fast check run when config loads. Throws a descriptive Error when:
 * - the network passphrase is not the one for `network`;
 * - the Horizon URL is not a valid URL;
 * - the Horizon URL is the official Horizon of the other network.
 * Self-hosted Horizon hosts cannot be verified offline and are accepted.
 */
export function assertStellarNetworkSettings(settings: StellarNetworkSettings): void {
  const { network, horizonUrl, networkPassphrase } = settings;
  const expected = STELLAR_NETWORKS[network];

  if (networkPassphrase !== expected.passphrase) {
    throw new Error(
      `STELLAR_NETWORK_PASSPHRASE does not match STELLAR_NETWORK=${network} (expected "${expected.passphrase}")`,
    );
  }

  let host: string;
  try {
    host = new URL(horizonUrl).hostname;
  } catch {
    throw new Error(`STELLAR_HORIZON_URL is not a valid URL: "${horizonUrl}"`);
  }

  const other = OTHER_NETWORK[network];
  if (STELLAR_NETWORKS[other].officialHorizonHosts.includes(host)) {
    throw new Error(
      `STELLAR_HORIZON_URL points at the ${other} Horizon (${host}) but STELLAR_NETWORK=${network}`,
    );
  }
}

import {
  assertStellarNetworkSettings,
  parseStellarNetwork,
  STELLAR_NETWORKS,
} from '@/config/stellarNetwork';

const TESTNET = {
  network: 'testnet' as const,
  horizonUrl: 'https://horizon-testnet.stellar.org',
  networkPassphrase: STELLAR_NETWORKS.testnet.passphrase,
};
const MAINNET = {
  network: 'mainnet' as const,
  horizonUrl: 'https://horizon.stellar.org',
  networkPassphrase: STELLAR_NETWORKS.mainnet.passphrase,
};

describe('stellar network config', () => {
  it('accepts exactly testnet and mainnet', () => {
    expect(parseStellarNetwork('testnet')).toBe('testnet');
    expect(parseStellarNetwork('mainnet')).toBe('mainnet');
  });

  it('rejects typos and other casings instead of defaulting to testnet', () => {
    for (const bad of ['mainnnet', 'Mainnet', 'pubnet', '']) {
      expect(() => parseStellarNetwork(bad)).toThrow(/STELLAR_NETWORK must be/);
    }
  });

  it('accepts matching testnet and mainnet settings', () => {
    expect(() => assertStellarNetworkSettings(TESTNET)).not.toThrow();
    expect(() => assertStellarNetworkSettings(MAINNET)).not.toThrow();
  });

  it('accepts a self-hosted Horizon when the passphrase matches', () => {
    expect(() =>
      assertStellarNetworkSettings({ ...TESTNET, horizonUrl: 'https://horizon.example.internal' }),
    ).not.toThrow();
  });

  it('refuses a mainnet Horizon URL on testnet', () => {
    expect(() =>
      assertStellarNetworkSettings({ ...TESTNET, horizonUrl: MAINNET.horizonUrl }),
    ).toThrow(/points at the mainnet Horizon/);
  });

  it('refuses a testnet Horizon URL on mainnet', () => {
    expect(() =>
      assertStellarNetworkSettings({ ...MAINNET, horizonUrl: TESTNET.horizonUrl }),
    ).toThrow(/points at the testnet Horizon/);
  });

  it('refuses a passphrase from the other network', () => {
    expect(() =>
      assertStellarNetworkSettings({ ...MAINNET, networkPassphrase: TESTNET.networkPassphrase }),
    ).toThrow(/STELLAR_NETWORK_PASSPHRASE does not match STELLAR_NETWORK=mainnet/);
    expect(() =>
      assertStellarNetworkSettings({ ...TESTNET, networkPassphrase: MAINNET.networkPassphrase }),
    ).toThrow(/does not match STELLAR_NETWORK=testnet/);
  });

  it('refuses an unparseable Horizon URL', () => {
    expect(() => assertStellarNetworkSettings({ ...TESTNET, horizonUrl: 'not a url' })).toThrow(
      /not a valid URL/,
    );
  });
});

describe('config load (start-up regression)', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.resetModules();
  });

  it('fails to load when STELLAR_NETWORK is misspelled', () => {
    process.env.STELLAR_NETWORK = 'mainnnet';
    expect(() =>
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@/config/config');
      }),
    ).toThrow(/STELLAR_NETWORK must be "testnet" or "mainnet"/);
  });

  it('fails to load when a mainnet Horizon is configured on testnet', () => {
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_HORIZON_URL = 'https://horizon.stellar.org';
    expect(() =>
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@/config/config');
      }),
    ).toThrow(/points at the mainnet Horizon/);
  });
});

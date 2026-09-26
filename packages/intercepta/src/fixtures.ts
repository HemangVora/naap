// Realistic response fixtures shaped exactly like the documented schemas
// (ToxicScoreShortResponseV2 / TokenRiskAnalysisV2Response). Used by tests and by the
// offline fallback (live:false). They are NOT used for prize runs.
import type { QuickScanResponse, ScanTokenResponse } from './mapping.js';

export const QUICK_SCAN_DRAINER: QuickScanResponse = {
  toxicScore: 100,
  traits: [
    {
      risk: 100,
      name: 'known_scammer',
      txsCount: 1532,
      description: 'The address is a known scammer: reported as a wallet drainer (Inferno Drainer) by multiple security sources.',
    },
    {
      risk: 80,
      name: 'fake_phishing_transfer',
      txsCount: 412,
      description: 'The address has initiated fake or phishing token transfers.',
    },
  ],
};

export const QUICK_SCAN_EXPOSURE: QuickScanResponse = {
  toxicScore: 45,
  traits: [
    {
      risk: 45,
      name: 'mixer_transfers',
      txsCount: 3,
      description: 'The address has exchanged funds with a crypto mixer.',
    },
  ],
};

export const QUICK_SCAN_CLEAN: QuickScanResponse = { toxicScore: 0, traits: [] };

export const SCAN_TOKEN_USDC_BASE: ScanTokenResponse = {
  apiVersion: '2',
  saleTax: { currentValue: 0, minValue: 0, maxValue: 0 },
  buyTax: { currentValue: 0, minValue: 0, maxValue: 0 },
  riskScore: 0,
  riskLevel: 'neutral',
  category: 'info',
  trust: 'whitelist',
  action: 'info',
  detectors: [{ code: 'HIGH_REPUTATION_TOKEN', description: 'The token is a well-known, high-reputation asset.' }],
  token: { chainId: '8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC' },
};

export const SCAN_TOKEN_FAKE_USDC: ScanTokenResponse = {
  apiVersion: '2',
  saleTax: { currentValue: 0, minValue: 0, maxValue: 0 },
  buyTax: { currentValue: 0, minValue: 0, maxValue: 0 },
  riskScore: 95,
  riskLevel: 'high',
  category: 'malicious',
  trust: 'blocklist',
  action: 'block',
  detectors: [
    { code: 'FAKE_TOKEN', description: 'The token imitates a well-known token (USDC) but is not the genuine contract.' },
    { code: 'KNOWN_MALICIOUS', description: 'The token contract is known to be malicious.' },
  ],
  token: { chainId: '8453', address: '0x000000000000000000000000000000000000fa4e', symbol: 'USDC' },
};

export const SCAN_TOKEN_WARN: ScanTokenResponse = {
  apiVersion: '2',
  riskScore: 55,
  riskLevel: 'medium',
  category: 'suspicious',
  trust: 'neutral',
  action: 'warn',
  detectors: [{ code: 'SCAM_NAME', description: 'The token name resembles a known scam pattern.' }],
  token: { chainId: '8453', address: '0x0000000000000000000000000000000000000a11', symbol: 'USDC-Rewards' },
};

/** 403 body seen live when the key is missing or wrong (research/tooling-facts.md §3). */
export const ERROR_403 = { status: 403, response: "This authentication key is incorrect or doesn't exist" };

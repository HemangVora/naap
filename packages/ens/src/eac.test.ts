import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import { MANDATE_KEYS } from '@crumple/core';
import { resolverAbi } from './abi.js';
import { RESOLVER_ROLES } from './addresses.js';
import { decodeRevert, formatEacRevert } from './eac.js';
import { resolverResource } from './records.js';

const AGENT = '0xabcdef0123456789abcdef0123456789abcdef01' as const;
const RELAYER = '0x1234567890123456789012345678901234567890' as const;

describe('EAC proof formatting', () => {
  it('names the role, the key resource, the agent and the relayer for EACUnauthorizedAccountRoles', () => {
    const key = MANDATE_KEYS.perTxCapUsd;
    const detail = formatEacRevert({
      ensName: 'zx9.crumple.eth',
      key,
      agent: AGENT,
      relayer: RELAYER,
      revert: { errorName: 'EACUnauthorizedAccountRoles', args: [resolverResource(key), RESOLVER_ROLES.SET_TEXT, AGENT] },
    });
    expect(detail).toContain('agent 0xabcd…ef01 called setText(zx9.crumple.eth, "sekisho.perTxCapUsd"');
    expect(detail).toContain('EACUnauthorizedAccountRoles');
    expect(detail).toContain('the agent key holds no ROLE_SET_TEXT on resource keccak("sekisho.perTxCapUsd")');
    expect(detail).toContain('only the relayer 0x1234…7890 holds it');
    expect(detail).toContain('reverted in simulation');
  });

  it('links the on-chain tx when one was sent', () => {
    const detail = formatEacRevert({
      ensName: 'zx9.crumple.eth',
      key: 'sekisho.payees',
      agent: AGENT,
      revert: { errorName: 'EACUnauthorizedAccountRoles', args: [1n, RESOLVER_ROLES.SET_TEXT, AGENT] },
      txHash: '0xdeadbeef',
    });
    expect(detail).toContain('reverted on-chain (0xdeadbeef)');
    expect(detail).toContain('resource 0x1…');
  });

  it('falls back sensibly for other errors', () => {
    expect(formatEacRevert({ ensName: 'a.crumple.eth', key: 'k', agent: AGENT, revert: { errorName: 'InvalidRecord', args: [] } })).toContain('reverted with InvalidRecord()');
    expect(formatEacRevert({ ensName: 'a.crumple.eth', key: 'k', agent: AGENT, revert: { raw: 'execution reverted' } })).toContain('reverted: execution reverted');
  });

  it('decodeRevert extracts the custom error from a viem ContractFunctionRevertedError', () => {
    const inner = new ContractFunctionRevertedError({
      abi: resolverAbi,
      functionName: 'setText',
      data: '0x4b27a133000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000',
    });
    const err = new BaseError('call reverted', { cause: inner });
    const d = decodeRevert(err);
    expect(d.errorName).toBe('EACUnauthorizedAccountRoles');
    expect(d.args?.[1]).toBe(RESOLVER_ROLES.SET_TEXT);
    expect(decodeRevert(new Error('boom')).raw).toContain('boom');
  });
});

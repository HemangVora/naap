// Demo proof: the agent key (no roles on the PermissionedResolver) tries setText on its own mandate → EACUnauthorizedAccountRoles.
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, formatEther, type PublicClient } from 'viem';
import { MANDATE_KEYS, type Address, type Hex } from '@crumple/core';
import { resolverAbi } from './abi.js';
import { RESOLVER_ROLES, ROLE_NAMES } from './addresses.js';
import { dnsName, resolverResource, short } from './records.js';
import { errorText } from './nonceQueue.js';
import type { Relayer } from './relayer.js';

export interface EacProof {
  rejected: boolean;
  detail: string;
  txHash?: Hex;
}

export interface RevertInfo {
  errorName?: string;
  args?: readonly unknown[];
  raw?: string;
}

/** Pull the decoded custom error out of a viem simulate/send failure. */
export function decodeRevert(err: unknown): RevertInfo {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (revert?.data) return { errorName: revert.data.errorName, args: revert.data.args, raw: err.shortMessage };
    return { raw: err.shortMessage };
  }
  return { raw: errorText(err).slice(0, 300) };
}

/** One projector-ready sentence describing the rejection. Pure. */
export function formatEacRevert(p: { ensName: string; key: string; agent: Address; relayer?: Address; revert: RevertInfo; txHash?: Hex }): string {
  const attempt = `agent ${short(p.agent)} called setText(${p.ensName}, "${p.key}", …)`;
  const { errorName, args } = p.revert;
  if (errorName === 'EACUnauthorizedAccountRoles' && args && args.length >= 3) {
    const [resource, roleBitmap, account] = args as [bigint, bigint, Address];
    const role = ROLE_NAMES[roleBitmap.toString()] ?? `role 0x${roleBitmap.toString(16)}`;
    const scope = resource === resolverResource(p.key) ? `resource keccak("${p.key}")` : `resource 0x${resource.toString(16).slice(0, 8)}…`;
    const who = account.toLowerCase() === p.agent.toLowerCase() ? 'the agent key' : short(account);
    const holder = p.relayer ? `; only the relayer ${short(p.relayer)} holds it` : '';
    const onchain = p.txHash ? ` — reverted on-chain (${p.txHash})` : ' — reverted in simulation';
    return `${attempt} → EACUnauthorizedAccountRoles: ${who} holds no ${role} on ${scope}${holder}${onchain}`;
  }
  if (errorName) return `${attempt} → reverted with ${errorName}(${(args ?? []).map(String).join(', ')})`;
  return `${attempt} → reverted: ${p.revert.raw ?? 'unknown error'}`;
}

export interface ProveOptions {
  publicClient: PublicClient;
  resolver: Address;
  ensName: string;
  agent: { address: Address; signTransaction?: unknown; sign?: unknown };
  /** Which key to attack (default sekisho.perTxCapUsd). */
  key?: string;
  value?: string;
  relayer?: Relayer;
  /** Also broadcast the reverting tx from the agent key (needs Sepolia ETH on the agent; `fund` lets the relayer top it up). */
  send?: boolean;
  fund?: boolean;
  /** Needed for send: a viem LocalAccount for the agent. */
  agentAccount?: import('viem').PrivateKeyAccount;
}

export async function proveAgentCannotEdit(o: ProveOptions): Promise<EacProof> {
  const key = o.key ?? MANDATE_KEYS.perTxCapUsd;
  const value = o.value ?? '9999';
  const args = [dnsName(o.ensName), key, value] as const;

  // 0. State the roles, from chain, before touching anything.
  let roleLine = '';
  try {
    const [agentHas, relayerHas] = await Promise.all([
      o.publicClient.readContract({ address: o.resolver, abi: resolverAbi, functionName: 'hasRoles', args: [resolverResource(key), RESOLVER_ROLES.SET_TEXT, o.agent.address] }),
      o.relayer
        ? o.publicClient.readContract({ address: o.resolver, abi: resolverAbi, functionName: 'hasRoles', args: [resolverResource(key), RESOLVER_ROLES.SET_TEXT, o.relayer.address] })
        : Promise.resolve(null),
    ]);
    roleLine = ` [hasRoles(ROLE_SET_TEXT, "${key}"): agent=${agentHas}${relayerHas === null ? '' : ` relayer=${relayerHas}`}]`;
    if (agentHas) return { rejected: false, detail: `UNEXPECTED: agent ${short(o.agent.address)} HAS ROLE_SET_TEXT for "${key}" on ${o.resolver}` };
  } catch (e) {
    roleLine = ` [role read failed: ${errorText(e).slice(0, 80)}]`;
  }

  // 1. Simulate: eth_call from the agent address → decoded custom error.
  let revert: RevertInfo | null = null;
  try {
    await o.publicClient.simulateContract({ address: o.resolver, abi: resolverAbi, functionName: 'setText', args, account: o.agent.address });
    return { rejected: false, detail: `UNEXPECTED: simulated setText by agent ${short(o.agent.address)} succeeded${roleLine}` };
  } catch (e) {
    revert = decodeRevert(e);
  }

  // 2. Optionally broadcast the doomed tx so the revert is on Etherscan.
  let txHash: Hex | undefined;
  if (o.send && o.agentAccount) {
    try {
      const need = 2_000_000_000_000_000n; // 0.002 ETH
      const bal = await o.publicClient.getBalance({ address: o.agent.address });
      if (bal < need / 4n && o.fund && o.relayer) {
        o.relayer.log(`funding agent ${short(o.agent.address)} with ${formatEther(need)} ETH for the on-chain proof`);
        await o.relayer.send({ to: o.agent.address, data: '0x', value: need, gas: 21_000n, label: 'fund-agent' });
      }
      const fees = await o.publicClient.estimateFeesPerGas();
      const nonce = await o.publicClient.getTransactionCount({ address: o.agent.address, blockTag: 'pending' });
      const serialized = await o.agentAccount.signTransaction({
        chainId: o.publicClient.chain?.id ?? 11155111,
        to: o.resolver,
        data: encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args }),
        gas: 120_000n, // estimateGas would refuse a reverting call; set it by hand
        nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        type: 'eip1559',
      });
      txHash = await o.publicClient.sendRawTransaction({ serializedTransaction: serialized });
      const rcpt = await o.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 });
      if (rcpt.status !== 'reverted') return { rejected: false, detail: `UNEXPECTED: agent setText tx ${txHash} succeeded`, txHash };
    } catch (e) {
      roleLine += ` [on-chain send skipped: ${errorText(e).slice(0, 100)}]`;
    }
  }

  return { rejected: true, detail: formatEacRevert({ ensName: o.ensName, key, agent: o.agent.address, relayer: o.relayer?.address, revert, txHash }) + roleLine, txHash };
}

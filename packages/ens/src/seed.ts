// weather.crumple.eth → the weather payee address (addr record, coinType 60). Used by `seed-weather` and `register`.
import { encodeFunctionData } from 'viem';
import { WEATHER_PAYEE_ENS, type Address, type Hex } from '@crumple/core';
import { resolverAbi } from './abi.js';
import { ENSV2 } from './addresses.js';
import type { EnsMandateSource } from './ens.js';
import { dnsName, labelOf } from './records.js';

export const COIN_TYPE_ETH = 60n;

export async function seedWeather(src: EnsMandateSource, address: Address): Promise<{ registerTx?: Hex; addrTx?: Hex; resolved: Address | null }> {
  const label = labelOf(WEATHER_PAYEE_ENS)!;
  const pc = src.relayer.publicClient;
  const { resolver } = await src.layout();
  const reg = await src.registerSubname(label, src.relayer.address);
  const read = () => pc.getEnsAddress({ name: WEATHER_PAYEE_ENS, universalResolverAddress: ENSV2.universalResolver }).catch(() => null);
  const current = await read();
  let addrTx: Hex | undefined;
  if (!current || current.toLowerCase() !== address.toLowerCase()) {
    const r = await src.relayer.queue.submit({
      to: resolver,
      data: encodeFunctionData({ abi: resolverAbi, functionName: 'setAddress', args: [dnsName(WEATHER_PAYEE_ENS), COIN_TYPE_ETH, address] }),
      label: `setAddress ${WEATHER_PAYEE_ENS}`,
    });
    if (r.status !== 'success') throw new Error(`setAddress(${WEATHER_PAYEE_ENS}) reverted: ${r.hash}`);
    addrTx = r.hash;
  }
  return { registerTx: reg.hash, addrTx, resolved: (await read()) ?? null };
}

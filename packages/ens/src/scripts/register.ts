// One-time setup of the ENS parent (PARENT_ENS, default naap.eth; ENS_PARENT overrides) on ENSv2 Sepolia.
// Idempotent and resumable (state in deployment.<label>.sepolia.json, one file per parent).
//   1. relayer key (generated into .env if missing)  2. Sepolia ETH check (exits with human steps if unfunded)
//   3. deploy UserRegistry + PermissionedResolver proxies via VerifiableFactory  4. mint/approve MockUSDC
//   5. commit → wait 60 s → register <parent> with subregistry+resolver  6. per-key ROLE_SET_TEXT grants
//   7. setParent  8. seed weather.<parent> if WEATHER_ADDRESS is set
import { encodeFunctionData, formatUnits, parseEventLogs, toHex, zeroAddress, zeroHash } from 'viem';
import { randomBytes } from 'node:crypto';
import { PARENT_ENS, WEATHER_PAYEE_ENS, type Address, type Hex } from '@crumple/core';
import { ethRegistrarAbi, mockErc20Abi, registryAbi, resolverAbi, verifiableFactoryAbi } from '../abi.js';
import { ENSV2, REGISTRAR, RELAYER_REGISTRY_ROLES, RELAYER_RESOLVER_ROLES, RESOLVER_ROLES } from '../addresses.js';
import { sleep } from '../nonceQueue.js';
import { ALL_TEXT_KEYS, PARENT_LABEL, labelId, resolverResource } from '../records.js';
import { seedWeather } from '../seed.js';
import { addrLink, ensLink, ensureRelayer, loadState, requireFunded, saveState, say, sourceFor, txLink } from './common.js';

const { relayer, env } = ensureRelayer();
await requireFunded(relayer);
const pc = relayer.publicClient;
const me = relayer.address;
const state = loadState();
state.relayer = me;
saveState(state);

const read = <T,>(p: Promise<T>) => p;

// ── where are we? ──────────────────────────────────────────────────────────
const [owner, available, onchainSubreg, onchainResolver] = await Promise.all([
  read(pc.readContract({ address: ENSV2.ethRegistry, abi: registryAbi, functionName: 'findOwner', args: [PARENT_LABEL] })),
  read(pc.readContract({ address: ENSV2.ethRegistrar, abi: ethRegistrarAbi, functionName: 'isAvailable', args: [PARENT_LABEL] })),
  read(pc.readContract({ address: ENSV2.ethRegistry, abi: registryAbi, functionName: 'getSubregistry', args: [PARENT_LABEL] })),
  read(pc.readContract({ address: ENSV2.ethRegistry, abi: registryAbi, functionName: 'getResolver', args: [PARENT_LABEL] })),
]);
say(`${PARENT_ENS}: owner=${owner} available=${available} subregistry=${onchainSubreg} resolver=${onchainResolver}`);
if (owner !== zeroAddress && owner.toLowerCase() !== me.toLowerCase()) {
  say(`STOP: ${PARENT_ENS} is owned by ${owner}, not the relayer. Use that key as RELAYER_PK or pick another parent name.`);
  process.exit(1);
}
if (owner === zeroAddress && !available) {
  say(`STOP: ${PARENT_ENS} is not available (reserved/grace). Pick another parent name.`);
  process.exit(1);
}
if (onchainSubreg !== zeroAddress) state.userRegistry = onchainSubreg;
if (onchainResolver !== zeroAddress) state.resolver = onchainResolver;

// ── proxies ────────────────────────────────────────────────────────────────
async function hasCode(a?: Address) {
  if (!a) return false;
  const c = await pc.getCode({ address: a }).catch(() => undefined);
  return Boolean(c && c !== '0x');
}
async function deployProxy(what: 'userRegistry' | 'resolver', impl: Address, init: Hex): Promise<Address> {
  const salt = BigInt(toHex(randomBytes(32)));
  say(`deploying ${what} proxy via VerifiableFactory…`);
  const r = await relayer.send({ to: ENSV2.verifiableFactory, data: encodeFunctionData({ abi: verifiableFactoryAbi, functionName: 'deployProxy', args: [impl, salt, init] }), label: `deploy ${what}` });
  if (r.status !== 'success') throw new Error(`deployProxy(${what}) reverted: ${txLink(r.hash)}`);
  const receipt = await pc.getTransactionReceipt({ hash: r.hash });
  const [log] = parseEventLogs({ abi: verifiableFactoryAbi, eventName: 'ProxyDeployed', logs: receipt.logs });
  if (!log) throw new Error(`no ProxyDeployed event in ${txLink(r.hash)}`);
  const proxy = log.args.proxyAddress;
  if (!(await hasCode(proxy))) throw new Error(`no code at ${what} proxy ${proxy} after ${txLink(r.hash)}`);
  say(`  ${what} = ${proxy}  ${txLink(r.hash)}`);
  return proxy;
}
if (!(await hasCode(state.userRegistry))) {
  state.userRegistry = await deployProxy('userRegistry', ENSV2.userRegistryImpl, encodeFunctionData({ abi: registryAbi, functionName: 'initialize', args: [[{ account: me, roleBitmap: RELAYER_REGISTRY_ROLES }]] }));
  saveState(state);
} else say(`UserRegistry ${state.userRegistry} (exists)`);
if (!(await hasCode(state.resolver))) {
  state.resolver = await deployProxy('resolver', ENSV2.permissionedResolverImpl, encodeFunctionData({ abi: resolverAbi, functionName: 'initialize', args: [[{ account: me, roleBitmap: RELAYER_RESOLVER_ROLES }], []] }));
  saveState(state);
} else say(`PermissionedResolver ${state.resolver} (exists)`);
const userRegistry = state.userRegistry!;
const resolver = state.resolver!;

// ── register <parent> ───────────────────────────────────────────────────
if (owner === zeroAddress) {
  const duration = BigInt(REGISTRAR.durationSec);
  const [base, premium] = await pc.readContract({ address: ENSV2.ethRegistrar, abi: ethRegistrarAbi, functionName: 'getRegisterPrice', args: [PARENT_LABEL, duration, ENSV2.mockUsdc] });
  const price = base + premium;
  say(`price for ${PARENT_ENS} × ${REGISTRAR.durationSec / 86400}d = ${formatUnits(price, 6)} MockUSDC`);
  const [bal, allowance] = await Promise.all([
    pc.readContract({ address: ENSV2.mockUsdc, abi: mockErc20Abi, functionName: 'balanceOf', args: [me] }),
    pc.readContract({ address: ENSV2.mockUsdc, abi: mockErc20Abi, functionName: 'allowance', args: [me, ENSV2.ethRegistrar] }),
  ]);
  if (bal < price) {
    const r = await relayer.send({ to: ENSV2.mockUsdc, data: encodeFunctionData({ abi: mockErc20Abi, functionName: 'mint', args: [me, price * 2n] }), label: 'mint MockUSDC' });
    if (r.status !== 'success') throw new Error(`mint reverted ${txLink(r.hash)}`);
    say(`minted ${formatUnits(price * 2n, 6)} MockUSDC  ${txLink(r.hash)}`);
  }
  if (allowance < price) {
    const r = await relayer.send({ to: ENSV2.mockUsdc, data: encodeFunctionData({ abi: mockErc20Abi, functionName: 'approve', args: [ENSV2.ethRegistrar, price * 2n] }), label: 'approve MockUSDC' });
    if (r.status !== 'success') throw new Error(`approve reverted ${txLink(r.hash)}`);
    say(`approved registrar  ${txLink(r.hash)}`);
  }

  // commitment (reuse a live one from state so a crash mid-wait does not cost another 60 s)
  let c = state.commitment;
  const sameParams = c && c.label === PARENT_LABEL && c.owner.toLowerCase() === me.toLowerCase() && c.subregistry.toLowerCase() === userRegistry.toLowerCase() && c.resolver.toLowerCase() === resolver.toLowerCase() && c.duration === duration.toString();
  let committedAt = sameParams && c ? Number(await pc.readContract({ address: ENSV2.ethRegistrar, abi: ethRegistrarAbi, functionName: 'commitmentAt', args: [c.hash] })) : 0;
  const now = () => Math.floor(Date.now() / 1000);
  if (!sameParams || !c || committedAt === 0 || now() - committedAt > REGISTRAR.maxCommitmentAgeSec - 600) {
    const secret = toHex(randomBytes(32));
    const hash = await pc.readContract({ address: ENSV2.ethRegistrar, abi: ethRegistrarAbi, functionName: 'makeCommitment', args: [PARENT_LABEL, me, secret, userRegistry, resolver, duration, zeroHash] });
    c = { hash, secret, label: PARENT_LABEL, owner: me, subregistry: userRegistry, resolver, duration: duration.toString() };
    state.commitment = c;
    saveState(state);
    const r = await relayer.send({ to: ENSV2.ethRegistrar, data: encodeFunctionData({ abi: ethRegistrarAbi, functionName: 'commit', args: [hash] }), label: 'commit' });
    if (r.status !== 'success') throw new Error(`commit reverted ${txLink(r.hash)}`);
    c.tx = r.hash;
    const blk = await pc.getBlock({ blockTag: 'latest' });
    committedAt = Number(blk.timestamp);
    c.committedAt = committedAt;
    saveState(state);
    say(`committed ${hash}  ${txLink(r.hash)}`);
  } else say(`reusing live commitment ${c.hash} (age ${now() - committedAt}s)`);

  // wait MIN_COMMITMENT_AGE (chain time)
  for (;;) {
    const blk = await pc.getBlock({ blockTag: 'latest' });
    const age = Number(blk.timestamp) - committedAt;
    if (age >= REGISTRAR.minCommitmentAgeSec + 2) break;
    say(`  waiting for commitment age ${age}/${REGISTRAR.minCommitmentAgeSec + 2}s…`);
    await sleep(6_000);
  }
  const r = await relayer.send({
    to: ENSV2.ethRegistrar,
    data: encodeFunctionData({ abi: ethRegistrarAbi, functionName: 'register', args: [PARENT_LABEL, me, c.secret, userRegistry, resolver, duration, ENSV2.mockUsdc, zeroHash] }),
    label: `register ${PARENT_ENS}`,
  });
  if (r.status !== 'success') throw new Error(`register reverted ${txLink(r.hash)} — check the commitment age / USDC allowance and rerun`);
  state.registerTx = r.hash;
  state.commitment = undefined;
  saveState(state);
  say(`REGISTERED ${PARENT_ENS} → ${me}  ${txLink(r.hash)}`);
} else {
  say(`${PARENT_ENS} already registered to the relayer`);
  const subregOk = onchainSubreg.toLowerCase() === userRegistry.toLowerCase();
  const resOk = onchainResolver.toLowerCase() === resolver.toLowerCase();
  if (!subregOk) {
    const r = await relayer.send({ to: ENSV2.ethRegistry, data: encodeFunctionData({ abi: registryAbi, functionName: 'setSubregistry', args: [labelId(PARENT_LABEL), userRegistry] }), label: `setSubregistry ${PARENT_LABEL}` });
    say(`setSubregistry → ${userRegistry} status=${r.status}  ${txLink(r.hash)}`);
  }
  if (!resOk) {
    const r = await relayer.send({ to: ENSV2.ethRegistry, data: encodeFunctionData({ abi: registryAbi, functionName: 'setResolver', args: [labelId(PARENT_LABEL), resolver] }), label: `setResolver ${PARENT_LABEL}` });
    say(`setResolver → ${resolver} status=${r.status}  ${txLink(r.hash)}`);
  }
}

// ── setParent on the UserRegistry (cosmetic: getParent() → (ETHRegistry, PARENT_LABEL)) ──
try {
  const [parent] = await pc.readContract({ address: userRegistry, abi: registryAbi, functionName: 'getParent' });
  if (parent.toLowerCase() !== ENSV2.ethRegistry.toLowerCase()) {
    const r = await relayer.send({ to: userRegistry, data: encodeFunctionData({ abi: registryAbi, functionName: 'setParent', args: [ENSV2.ethRegistry, PARENT_LABEL] }), label: 'setParent' });
    say(`setParent status=${r.status}  ${txLink(r.hash)}`);
  }
} catch (e) {
  say(`setParent skipped: ${(e as Error).message.slice(0, 120)}`);
}

// ── per-key ROLE_SET_TEXT grants for the relayer (sekisho.* + naap.*), one multicall ──
const missing: string[] = [];
for (const key of ALL_TEXT_KEYS) {
  const has = await pc.readContract({ address: resolver, abi: resolverAbi, functionName: 'hasRoles', args: [resolverResource(key), RESOLVER_ROLES.SET_TEXT, me] });
  if (!has) missing.push(key);
}
if (missing.length) {
  const calls = missing.map((key) =>
    encodeFunctionData({ abi: resolverAbi, functionName: 'grantSetterRoles', args: [encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: ['0x', key, ''] }), me] }),
  );
  const r = await relayer.send({ to: resolver, data: encodeFunctionData({ abi: resolverAbi, functionName: 'multicall', args: [calls] }), label: `grant ROLE_SET_TEXT ×${missing.length}` });
  if (r.status !== 'success') throw new Error(`grantSetterRoles multicall reverted ${txLink(r.hash)}`);
  state.grantsTx = r.hash;
  saveState(state);
  say(`granted ROLE_SET_TEXT for [${missing.join(', ')}] to the relayer  ${txLink(r.hash)}`);
} else say('ROLE_SET_TEXT grants already in place for every mandate/rating key');

// ── weather.<parent> ────────────────────────────────────────────────────
const weatherAddress = (process.env.WEATHER_ADDRESS && /^0x[0-9a-fA-F]{40}$/.test(process.env.WEATHER_ADDRESS) ? process.env.WEATHER_ADDRESS : undefined) as Address | undefined;
if (weatherAddress) {
  const src = sourceFor(relayer, env);
  const w = await seedWeather(src, weatherAddress);
  state.weather = { address: weatherAddress, tx: w.addrTx ?? state.weather?.tx };
  saveState(state);
  say(`${WEATHER_PAYEE_ENS} → ${w.resolved}${w.addrTx ? `  ${txLink(w.addrTx)}` : ' (already set)'}`);
} else say(`WEATHER_ADDRESS not set — run \`pnpm --filter @crumple/ens seed-weather <address>\` when lane intercepta picks it`);

say('');
say('DONE');
say(`  ${PARENT_ENS}            ${ensLink(PARENT_ENS)}`);
say(`  relayer                ${addrLink(me)}`);
say(`  UserRegistry (${PARENT_LABEL}) ${addrLink(userRegistry)}`);
say(`  PermissionedResolver   ${addrLink(resolver)}`);
say('  set ENS_MODE=ens in .env to use it.');

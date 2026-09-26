// The agent key (no roles) tries setText on <car>.crumple.eth and is rejected by the PermissionedResolver.
//   pnpm --filter @crumple/ens prove-eac [carId] [--send] [--fund]
//   --send  broadcast the reverting tx from the agent key (on Etherscan); --fund lets the relayer top the agent up with 0.002 ETH.
import { carEnsName } from '../records.js';
import { agentAccountFor } from '../local.js';
import { ensLink, ensureRelayer, flag, positional, say, sourceFor, txLink } from './common.js';

const carId = positional()[0] ?? 'demo';
const ensName = carEnsName(carId);
const { relayer, env } = ensureRelayer();
const src = sourceFor(relayer, env);
const agent = agentAccountFor(carId, env.agentSeed);
say(`name    ${ensName}  ${ensLink(ensName)}`);
say(`agent   ${agent.address} (derived; holds no roles)`);
say(`relayer ${relayer.address}`);
const proof = await src.proveAgentCannotEdit(ensName, { send: flag('send'), fund: flag('fund') });
say('');
say(`rejected: ${proof.rejected}`);
say(`detail:   ${proof.detail}`);
if (proof.txHash) say(`tx:       ${txLink(proof.txHash)}`);
process.exit(proof.rejected ? 0 : 1);

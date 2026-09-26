import { describe, expect, it } from 'vitest';
import type { Abi } from 'viem';
import { USDC_ADDRESS } from '@crumple/chain';
import { constructorPlan, contractNameOf, createGuardEngine, unconfirmed } from './engine.js';
import { PRESET_BY_ID } from './presets.js';

const src = (id: string) => PRESET_BY_ID[id].source;
const quiet = { log: () => {} };

describe('constructor fill', () => {
  const ctor = (inputs: { name: string; type: string }[]): Abi => [{ type: 'constructor', stateMutability: 'nonpayable', inputs }] as Abi;
  const me = '0x00000000000000000000000000000000000000d1' as const;
  const fill = (inputs: { name: string; type: string }[]) => {
    const p = constructorPlan(ctor(inputs));
    return p.ok ? p.args(me) : p.reason;
  };

  it('fills no-arg, token and role addresses, integers, bool, string, bytes', () => {
    expect(fill([])).toEqual([]);
    expect(constructorPlan([] as Abi).ok).toBe(true);
    expect(fill([{ name: '_token', type: 'address' }])).toEqual([USDC_ADDRESS]);
    expect(fill([{ name: '_usdc', type: 'address' }, { name: '_operator', type: 'address' }])).toEqual([USDC_ADDRESS, me]);
    expect(fill([{ name: 'asset', type: 'address' }, { name: 'cap', type: 'uint256' }])).toEqual([USDC_ADDRESS, 1_000_000n * 10n ** 6n]);
    expect(fill([{ name: 'seller', type: 'address' }, { name: 'arbiter', type: 'address' }])).toEqual([me, me]);
    expect(fill([{ name: 'd', type: 'uint8' }, { name: 'n', type: 'int256' }])).toEqual([255n, 1_000_000n * 10n ** 6n]);
    expect(fill([{ name: 'f', type: 'bool' }, { name: 's', type: 'string' }, { name: 'b', type: 'bytes' }, { name: 'h', type: 'bytes32' }])).toEqual([
      false,
      'Sandbox',
      '0x',
      `0x${'00'.repeat(32)}`,
    ]);
  });

  it('skips the deploy (static-only) for arrays and tuples', () => {
    expect(fill([{ name: 'payees', type: 'address[]' }])).toMatch(/payees.*address\[\]/);
    expect(constructorPlan(ctor([{ name: 't', type: 'tuple' }])).ok).toBe(false);
  });
});

describe('unconfirmed downgrade + contract name', () => {
  it('turns a reverted critical probe into a medium review note', () => {
    const f = unconfirmed({ id: 'unprotected-withdraw', severity: 'critical', title: 'Anyone can drain the contract', detail: 'x() moves funds.' }, 'reverted');
    expect(f.severity).toBe('medium');
    expect(f.title).toBe('Unconfirmed: Anyone can drain the contract');
    expect(f.detail).toMatch(/^x\(\) moves funds\. .*reverted.*Review it\.$/);
    expect(f.confirmed).toBeUndefined();
  });

  it('ignores the word "contract" in comments when naming the contract', () => {
    expect(contractNameOf('// A simple contract for tipping\n/* contract Nope */\npragma solidity ^0.8.24;\ncontract TipJar {}')).toBe('TipJar');
  });
});

describe('audit without a fork (static + compile)', () => {
  const engine = createGuardEngine(quiet);

  it('compiles the vulnerable vault and reports it VULNERABLE from the static scan', async () => {
    const r = await engine.audit(src('vulnerable-vault'));
    expect(r.verdict).toBe('VULNERABLE');
    expect(r.contractName).toBe('StakingVault');
    expect(r.findings.map((f) => f.id)).toContain('unprotected-withdraw');
    expect(r.compileError).toBeUndefined();
    expect(r.address).toBeUndefined();
    expect(r.findings.some((f) => f.confirmed)).toBe(false);
  });

  it('reports COMPILE_ERROR with the message and still returns static findings', async () => {
    const broken = src('faucet-token').replace('totalSupply += amount;', 'totalSupply += amount');
    const r = await engine.audit(broken);
    expect(r.verdict).toBe('COMPILE_ERROR');
    expect(r.compileError).toMatch(/ParserError/);
    expect(r.findings.map((f) => f.id)).toContain('unprotected-mint');
    expect(r.source).toBe(broken);
  });

  it('reports COMPILE_ERROR on garbage and never throws', async () => {
    const r = await engine.audit('this is not solidity at all');
    expect(r.verdict).toBe('COMPILE_ERROR');
    expect(r.compileError).toBeTruthy();
  });

  it('rejects imports (no resolution in the sandbox)', async () => {
    const r = await engine.audit('pragma solidity ^0.8.24;\nimport "@openzeppelin/contracts/access/Ownable.sol";\ncontract C {}');
    expect(r.verdict).toBe('COMPILE_ERROR');
    expect(r.compileError).toMatch(/imports are not supported/);
  });

  it('forces the pragma so an off-version agent pragma still compiles', async () => {
    const r = await engine.audit('pragma solidity 0.8.20;\ncontract C { uint256 public x; }');
    expect(r.verdict).toBe('SAFE');
  });

  it('reports the access-controlled SafeVault SAFE', async () => {
    const r = await engine.audit(src('safe-vault'), { name: 'Custom' });
    expect(r.verdict).toBe('SAFE');
    expect(r.findings).toHaveLength(0);
    expect(r.contractName).toBe('Custom');
  });

  it('falls back to static-only when the fork rpc is down', async () => {
    const logs: string[] = [];
    const r = await createGuardEngine({ rpcUrl: 'http://127.0.0.1:1', log: (m) => logs.push(m) }).audit(src('vulnerable-vault'));
    expect(logs.join('\n')).toMatch(/StakingVault: static-only/);
    expect(r.verdict).toBe('VULNERABLE');
    expect(r.address).toBeUndefined();
    expect(r.findings.some((f) => f.confirmed)).toBe(false);
  });
});

const FORK = process.env.GUARD_FORK_RPC;

describe.skipIf(!FORK)('audit on the fork (GUARD_FORK_RPC)', () => {
  const engine = createGuardEngine({ rpcUrl: FORK, ...quiet });
  const TX = /^0x[0-9a-f]{64}$/;

  it('proves the vault drain with a real attacker tx', async () => {
    const r = await engine.audit(src('vulnerable-vault'));
    expect(r.verdict).toBe('VULNERABLE');
    expect(r.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(r.chainId).toBeTypeOf('number');
    const c = r.findings.find((f) => f.id === 'unprotected-withdraw')?.confirmed;
    expect(c?.txHash).toMatch(TX);
    expect(c?.stolenUsd).toBe(1000);
  }, 60_000);

  it('proves the public mint', async () => {
    const r = await engine.audit(src('faucet-token'));
    expect(r.findings.find((f) => f.id === 'unprotected-mint')?.confirmed?.txHash).toMatch(TX);
  }, 60_000);

  it('proves the unprotected price setter', async () => {
    const r = await engine.audit(src('naive-oracle'));
    const c = r.findings.find((f) => f.id === 'unprotected-price')?.confirmed;
    expect(c?.txHash).toMatch(TX);
    expect(c?.exploit).toMatch(/200000000000 to 1/);
  }, 60_000);

  it('proves an ownership takeover', async () => {
    const r = await engine.audit('pragma solidity ^0.8.24;\ncontract Own { address public owner; constructor() { owner = msg.sender; } function setOwner(address o) external { owner = o; } }');
    const c = r.findings.find((f) => f.id === 'missing-access-control')?.confirmed;
    expect(c?.txHash).toMatch(TX);
    expect(c?.ownerAfter).not.toBe(c?.ownerBefore);
  }, 60_000);

  it('deploys SafeVault and reports SAFE with no drain', async () => {
    const r = await engine.audit(src('safe-vault'));
    expect(r.verdict).toBe('SAFE');
    expect(r.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(r.findings.some((f) => f.confirmed)).toBe(false);
  }, 60_000);

  it('a statically-flagged call that reverts for the attacker is not confirmed', async () => {
    const guardedOddly = `pragma solidity ^0.8.24;
interface IERC20 { function transfer(address to, uint256 amount) external returns (bool); function balanceOf(address a) external view returns (uint256); }
contract Allowlist {
    mapping(address => bool) public allowed;
    IERC20 public immutable token;
    constructor(address t) { token = IERC20(t); allowed[msg.sender] = true; }
    function withdraw(address to) external { require(allowed[msg.sender], "no"); token.transfer(to, token.balanceOf(address(this))); }
}`;
    const r = await engine.audit(guardedOddly);
    expect(r.address).toBeDefined();
    const w = r.findings.find((f) => f.id === 'unprotected-withdraw');
    expect(w).toBeDefined();
    expect(w?.confirmed).toBeUndefined();
    expect(w?.severity).toBe('medium');
    expect(r.verdict).toBe('SAFE');
  }, 60_000);

  it('a flagged function whose attacker probe reverts yields SAFE with a medium "Unconfirmed:" note', async () => {
    // keeper-gated through a mapping lookup the scanner does not recognise as access control
    const keeperGated = `pragma solidity ^0.8.24;
contract Treasury {
    mapping(address => bool) public isKeeper;
    constructor() { isKeeper[msg.sender] = true; }
    receive() external payable {}
    function sweep(address payable to) external { require(isKeeper[msg.sender], "keeper"); to.transfer(address(this).balance); }
}`;
    const r = await engine.audit(keeperGated);
    expect(r.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(r.verdict).toBe('SAFE');
    expect(r.findings).toHaveLength(1);
    const [f] = r.findings;
    expect(f.severity).toBe('medium');
    expect(f.title).toMatch(/^Unconfirmed: /);
    expect(f.detail).toMatch(/reverted.*Review it\./);
    expect(f.confirmed).toBeUndefined();
  }, 60_000);

  it('deploys a 2-address-constructor draft (token + operator) and proves an open drain on it', async () => {
    const r = await engine.audit(`pragma solidity ^0.8.24;
interface IERC20 { function transfer(address to, uint256 amount) external returns (bool); function balanceOf(address a) external view returns (uint256); }
contract Pool {
    IERC20 public usdc; address public operator; uint256 public cap;
    constructor(address _usdc, address _operator, uint256 _cap) { usdc = IERC20(_usdc); operator = _operator; cap = _cap; }
    function payout(address to) external { usdc.transfer(to, usdc.balanceOf(address(this))); }
}`);
    expect(r.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(r.verdict).toBe('VULNERABLE');
    expect(r.findings.find((f) => f.id === 'unprotected-withdraw')?.confirmed?.stolenUsd).toBe(1000);
  }, 60_000);

  it('correct own-balance vault and arbiter escrow deploy and are not VULNERABLE', async () => {
    const vault = `pragma solidity ^0.8.24;
interface IERC20 { function transfer(address to, uint256 amount) external returns (bool); function transferFrom(address f, address t, uint256 a) external returns (bool); }
contract UserVault {
    IERC20 public usdc; address public operator; mapping(address => uint256) public deposits;
    constructor(address _usdc, address _operator) { usdc = IERC20(_usdc); operator = _operator; }
    function deposit(uint256 amount) external { require(usdc.transferFrom(msg.sender, address(this), amount)); deposits[msg.sender] += amount; }
    function withdraw(uint256 amount) external { require(deposits[msg.sender] >= amount, "insufficient"); deposits[msg.sender] -= amount; require(usdc.transfer(msg.sender, amount)); }
}`;
    const escrow = `pragma solidity ^0.8.24;
contract Escrow {
    address public buyer; address public seller; address public arbiter;
    constructor(address _seller, address _arbiter) payable { buyer = msg.sender; seller = _seller; arbiter = _arbiter; }
    function release() external { require(msg.sender == arbiter, "only arbiter"); payable(seller).transfer(address(this).balance); }
    function refund() external { require(msg.sender == arbiter, "only arbiter"); payable(buyer).transfer(address(this).balance); }
}`;
    for (const s of [vault, escrow]) {
      const r = await engine.audit(s);
      expect(r.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(r.verdict).toBe('SAFE');
    }
  }, 60_000);

  it('falls back to static-only when the constructor reverts', async () => {
    const r = await engine.audit('pragma solidity ^0.8.24;\ncontract Boom { constructor() { revert("no"); } function mint(address to, uint256 a) external { balanceOf[to] += a; } mapping(address => uint256) public balanceOf; }');
    expect(r.verdict).toBe('VULNERABLE');
    expect(r.address).toBeUndefined();
  }, 60_000);

  it('leaves no trace: the sandbox contract is gone after the audit', async () => {
    const r = await engine.audit(src('vulnerable-vault'));
    const res = await fetch(FORK!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [r.address, 'latest'] }),
    });
    expect(((await res.json()) as { result: string }).result).toBe('0x');
  }, 60_000);
});

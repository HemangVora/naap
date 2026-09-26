import { describe, expect, it } from 'vitest';
import { createGuardEngine } from './engine.js';
import { PRESET_BY_ID } from './presets.js';

const src = (id: string) => PRESET_BY_ID[id].source;

describe('audit without a fork (static + compile)', () => {
  const engine = createGuardEngine();

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
    const r = await createGuardEngine({ rpcUrl: 'http://127.0.0.1:1' }).audit(src('vulnerable-vault'));
    expect(r.verdict).toBe('VULNERABLE');
    expect(r.address).toBeUndefined();
    expect(r.findings.some((f) => f.confirmed)).toBe(false);
  });
});

const FORK = process.env.GUARD_FORK_RPC;

describe.skipIf(!FORK)('audit on the fork (GUARD_FORK_RPC)', () => {
  const engine = createGuardEngine({ rpcUrl: FORK });
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

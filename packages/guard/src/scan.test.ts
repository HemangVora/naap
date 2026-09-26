import { describe, expect, it } from 'vitest';
import { GUARD_PRESETS, PRESET_BY_ID } from './presets.js';
import { CONFIRMABLE, parseFunctions, scanSource, stripComments } from './scan.js';

const idsFor = (id: string) => scanSource(PRESET_BY_ID[id].source).map((f) => f.id);

describe('scanSource on presets', () => {
  it('flags the unprotected vault withdraw', () => {
    const f = scanSource(PRESET_BY_ID['vulnerable-vault'].source);
    expect(f.map((x) => x.id)).toContain('unprotected-withdraw');
    const w = f.find((x) => x.id === 'unprotected-withdraw')!;
    expect(w.severity).toBe('critical');
    expect(w.where).toContain('withdraw');
    expect(CONFIRMABLE.has(w.id)).toBe(true);
  });
  it('flags the public mint', () => {
    expect(idsFor('faucet-token')).toContain('unprotected-mint');
  });
  it('flags the unprotected price setter (Moonwell class)', () => {
    expect(idsFor('naive-oracle')).toContain('unprotected-price');
  });
  it('passes the access-controlled vault with no findings', () => {
    expect(scanSource(PRESET_BY_ID['safe-vault'].source)).toHaveLength(0);
  });
});

describe('guarding and visibility', () => {
  it('does not flag a view function that reads owner-only state', () => {
    const src = `pragma solidity ^0.8.24; contract C { uint256 public price; function creditLimit(uint256 c) external view returns (uint256){ return c*price; } }`;
    expect(scanSource(src)).toHaveLength(0);
  });
  it('does not flag a require(msg.sender == owner) guarded withdraw', () => {
    const src = `pragma solidity ^0.8.24; contract C { address owner; function withdraw(address to) external { require(msg.sender == owner, "no"); payable(to).transfer(address(this).balance); } }`;
    expect(scanSource(src)).toHaveLength(0);
  });
  it('flags an onlyOwner-less selfdestruct', () => {
    const src = `pragma solidity ^0.8.24; contract C { function kill() external { selfdestruct(payable(msg.sender)); } }`;
    expect(scanSource(src).map((f) => f.id)).toContain('unprotected-withdraw');
  });
  it('flags tx.origin auth', () => {
    const src = `pragma solidity ^0.8.24; contract C { address owner; function take() external { require(tx.origin == owner); } }`;
    expect(scanSource(src).map((f) => f.id)).toContain('tx-origin-auth');
  });
  it('ignores keywords inside comments', () => {
    const src = `pragma solidity ^0.8.24; contract C { // function withdraw(address to) external { selfdestruct(payable(to)); }\n uint256 public x; }`;
    expect(scanSource(src)).toHaveLength(0);
    expect(stripComments('a // mint\nb')).not.toContain('mint');
  });
});

describe('parseFunctions', () => {
  it('captures body, visibility and view', () => {
    const fns = parseFunctions('contract C { function a() external view returns(uint){ return 1; } function b(address to) public { to.call(""); } }');
    expect(fns.map((f) => f.name)).toEqual(['a', 'b']);
    expect(fns[0].isView).toBe(true);
    expect(fns[1].visibility).toBe('public');
  });
});

describe('presets are internally consistent', () => {
  it('every preset compiles-shaped (single contract, pragma, no imports)', () => {
    for (const p of GUARD_PRESETS) {
      expect(p.source).toMatch(/pragma solidity \^0\.8\.24/);
      expect(p.source).not.toMatch(/^\s*import\b/m);
    }
  });
});

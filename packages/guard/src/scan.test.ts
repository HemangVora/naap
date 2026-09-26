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

// Correct contracts an agent commonly writes. None may be reported critical/high (B1 false positives).
const IERC20 = `interface IERC20 { function transfer(address to, uint256 amount) external returns (bool); function transferFrom(address f, address t, uint256 a) external returns (bool); function balanceOf(address a) external view returns (uint256); }`;
const CORRECT: Record<string, string> = {
  'ETH piggy bank (caller withdraws own balance)': `pragma solidity ^0.8.24;
contract PiggyBank {
    mapping(address => uint256) public balances;
    function deposit() external payable { balances[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "insufficient");
        balances[msg.sender] -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "send failed");
    }
    function withdrawAll() external {
        uint256 amt = balances[msg.sender];
        balances[msg.sender] = 0;
        payable(msg.sender).transfer(amt);
    }
}`,
  'USDC vault (users withdraw their own deposits)': `pragma solidity ^0.8.24;
${IERC20}
contract USDCVault {
    IERC20 public usdc;
    mapping(address => uint256) public deposits;
    constructor(address _usdc) { usdc = IERC20(_usdc); }
    function deposit(uint256 amount) external {
        require(usdc.transferFrom(msg.sender, address(this), amount), "transfer failed");
        deposits[msg.sender] += amount;
    }
    function withdraw(uint256 amount) external {
        require(amount <= deposits[msg.sender], "insufficient");
        deposits[msg.sender] = deposits[msg.sender] - amount;
        require(usdc.transfer(msg.sender, amount), "transfer failed");
    }
}`,
  'escrow gated by arbiter / operator': `pragma solidity ^0.8.24;
contract Escrow {
    address public buyer; address public seller; address public arbiter; address public operator;
    error NotArbiter();
    constructor(address _seller, address _arbiter, address _operator) payable { buyer = msg.sender; seller = _seller; arbiter = _arbiter; operator = _operator; }
    function release() external {
        require(msg.sender == arbiter, "only arbiter");
        payable(seller).transfer(address(this).balance);
    }
    function refund() external {
        if (msg.sender != arbiter) revert NotArbiter();
        payable(buyer).transfer(address(this).balance);
    }
    function sweep(address to) external {
        require(operator == msg.sender && to != address(0), "only operator");
        payable(to).transfer(address(this).balance);
    }
}`,
  'Ownable2Step acceptOwnership': `pragma solidity ^0.8.24;
contract Owned2Step {
    address public owner; address public pendingOwner;
    constructor() { owner = msg.sender; }
    function transferOwnership(address next) external { require(msg.sender == owner, "not owner"); pendingOwner = next; }
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}`,
  'one-time claim': `pragma solidity ^0.8.24;
contract Airdrop {
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public claimed;
    uint256 public totalSupply;
    function claim() external {
        require(!claimed[msg.sender], "already claimed");
        claimed[msg.sender] = true;
        balanceOf[msg.sender] += 100e18;
        totalSupply += 100e18;
    }
}`,
};

describe('correct contracts are not flagged critical/high', () => {
  for (const [name, src] of Object.entries(CORRECT))
    it(name, () => {
      expect(scanSource(src).filter((f) => f.severity === 'critical' || f.severity === 'high')).toEqual([]);
    });

  it('a custom modifier whose body checks msg.sender guards the function', () => {
    const src = `pragma solidity ^0.8.24; contract C { address keeper; modifier gated() { require(msg.sender == keeper, "no"); _; } function sweep(address to) external gated { payable(to).transfer(address(this).balance); } }`;
    expect(scanSource(src)).toHaveLength(0);
  });
});

describe('the widened guard stays narrow', () => {
  const drains = (src: string) => scanSource(src).map((f) => f.id);
  it('still flags a caller check against the function’s own parameter', () => {
    expect(drains(`pragma solidity ^0.8.24; contract C { function withdraw(address to) external { require(msg.sender == to); payable(to).transfer(address(this).balance); } }`)).toContain('unprotected-withdraw');
  });
  it('still flags a blacklist-style require(msg.sender != x) and a tx.origin compare', () => {
    expect(drains(`pragma solidity ^0.8.24; contract C { address banned; function take() external { require(msg.sender != banned); payable(msg.sender).transfer(address(this).balance); } }`)).toContain('unprotected-withdraw');
    expect(drains(`pragma solidity ^0.8.24; contract C { function take() external { require(msg.sender == tx.origin); payable(msg.sender).transfer(address(this).balance); } }`)).toContain('unprotected-withdraw');
  });
  it('still flags an allowlist bool check (not a balance check) and a whole-balance drain named withdraw', () => {
    expect(drains(`pragma solidity ^0.8.24; contract C { mapping(address=>bool) allowed; function withdraw(address to) external { require(allowed[msg.sender]); payable(to).transfer(address(this).balance); } }`)).toContain('unprotected-withdraw');
  });
  it('an if without a revert is not a guard', () => {
    expect(drains(`pragma solidity ^0.8.24; contract C { address keeper; uint256 fee; function take() external { if (msg.sender != keeper) { fee = 1; } payable(msg.sender).transfer(address(this).balance); } }`)).toContain('unprotected-withdraw');
  });
  it('the preset findings are unchanged (ids + severities)', () => {
    const shape = (id: string) => scanSource(PRESET_BY_ID[id].source).map((f) => `${f.id}:${f.severity}:${f.where}`);
    expect(shape('vulnerable-vault')).toEqual(['unprotected-withdraw:critical:withdraw(address to)']);
    expect(shape('faucet-token')).toEqual(['unprotected-mint:critical:mint(address to, uint256 amount)']);
    expect(shape('naive-oracle')).toEqual(['unprotected-price:high:setPrice(uint256 _price)']);
    expect(shape('safe-vault')).toEqual([]);
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

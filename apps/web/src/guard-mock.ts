// `?mock=1` for /guard: no server. Presets mirror packages/guard/src/presets.ts, drafts pick the closest preset,
// and audits run a tiny regex scan that "proves" unguarded withdraw/mint/owner/price setters with made-up tx hashes.
import type { GuardApi, GuardFinding, GuardPreset, GuardReport } from './guard';

const IERC20 = `interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}`;

const PRESETS: GuardPreset[] = [
  {
    id: 'vulnerable-vault',
    title: 'USDC staking vault',
    prompt: 'a vault where users deposit USDC and the owner can withdraw the pooled funds',
    source: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

${IERC20}

/// A vault that holds pooled USDC.
contract StakingVault {
    address public owner;
    IERC20 public immutable token;

    constructor(address _token) {
        owner = msg.sender;
        token = IERC20(_token);
    }

    // Withdraw the pooled funds.
    function withdraw(address to) external {
        token.transfer(to, token.balanceOf(address(this)));
    }
}
`,
  },
  {
    id: 'faucet-token',
    title: 'Reward token with a faucet',
    prompt: 'an ERC20-style reward token where users can claim tokens from a faucet',
    source: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A simple reward token.
contract RewardToken {
    string public name = "Reward";
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    // Hand out reward tokens.
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }
}
`,
  },
  {
    id: 'naive-oracle',
    title: 'Lending oracle (Moonwell-style)',
    prompt: 'a price oracle a lending market reads to set each borrower credit limit',
    source: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Price feed a lending market reads to size collateral (cf. Moonwell cbETH, Feb 2026).
contract LendingOracle {
    uint256 public price; // 8 decimals, USD
    address public owner;

    constructor() {
        owner = msg.sender;
        price = 2000e8;
    }

    // Update the collateral price.
    function setPrice(uint256 _price) external {
        price = _price;
    }

    function creditLimit(uint256 collateral) external view returns (uint256) {
        return (collateral * price) / 1e8;
    }
}
`,
  },
  {
    id: 'safe-vault',
    title: 'USDC vault (access-controlled)',
    prompt: 'a vault where users deposit USDC and only the owner can withdraw',
    source: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

${IERC20}

/// A vault that holds pooled USDC, owner-gated.
contract SafeVault {
    address public owner;
    IERC20 public immutable token;

    constructor(address _token) {
        owner = msg.sender;
        token = IERC20(_token);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function withdraw(address to) external onlyOwner {
        token.transfer(to, token.balanceOf(address(this)));
    }
}
`,
  },
];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => '0x' + Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const ATTACKER = '0xBAD0000000000000000000000000000000000A77';
const nameOf = (src: string) => /\bcontract\s+([A-Za-z_]\w*)/.exec(src)?.[1];

interface Fn { name: string; params: string; mods: string; body: string; line: number }

/** Every `function name(params) mods { body }`, with its body found by brace matching. */
function functions(src: string): Fn[] {
  const out: Fn[] = [];
  const re = /function\s+([A-Za-z_]\w*)\s*\(([^)]*)\)([^{;]*)\{/g;
  for (let m: RegExpExecArray | null; (m = re.exec(src)); ) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth) depth += src[i] === '{' ? 1 : src[i] === '}' ? -1 : 0, i++;
    out.push({ name: m[1], params: m[2], mods: m[3], body: src.slice(re.lastIndex, i - 1), line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

const sig = (f: Fn) => `${f.name}(${f.params.split(',').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean).join(',')})`;
const guarded = (f: Fn) => /\bonly[A-Z]\w*/.test(f.mods) || /msg\.sender\s*==|==\s*msg\.sender/.test(f.body);
const readOnly = (f: Fn) => /\b(view|pure)\b/.test(f.mods);

function scan(src: string, deployed: boolean): GuardFinding[] {
  const findings: GuardFinding[] = [];
  for (const f of functions(src)) {
    if (readOnly(f) || guarded(f) || !/\b(external|public)\b/.test(f.mods)) continue;
    const at = { where: sig(f), line: f.line };
    if (/\.transfer\s*\(|\.call\s*\{\s*value|selfdestruct/.test(f.body)) {
      findings.push({
        id: 'unprotected-withdraw',
        title: 'Anyone can drain the vault',
        severity: 'critical',
        detail: `${sig(f)} moves the contract's funds but has no access control. Any address can call it and send the whole balance to itself.`,
        ...at,
        ...(deployed ? { confirmed: { exploit: `A stranger (${ATTACKER}) called ${f.name}(${ATTACKER}) and received the pooled USDC`, txHash: hex(64), stolenUsd: 25000 } } : {}),
      });
    } else if (/^(mint|issue)/i.test(f.name)) {
      findings.push({
        id: 'unprotected-mint',
        title: 'Anyone can mint',
        severity: 'critical',
        detail: `${sig(f)} creates new supply and is callable by any address. A stranger can mint themselves an unlimited balance.`,
        ...at,
        ...(deployed ? { confirmed: { exploit: `A stranger minted 1,000,000,000 tokens to ${ATTACKER}`, txHash: hex(64) } } : {}),
      });
    } else if (/^(setOwner|transferOwnership|setAdmin)$/.test(f.name)) {
      findings.push({
        id: 'missing-access-control',
        title: 'Anyone can take ownership',
        severity: 'critical',
        detail: `${sig(f)} changes the owner but anyone can call it.`,
        ...at,
        ...(deployed ? { confirmed: { exploit: 'A stranger made themselves the owner', txHash: hex(64), ownerBefore: '0x5eF1000000000000000000000000000000000001', ownerAfter: ATTACKER } } : {}),
      });
    } else if (/price|oracle|rate/i.test(f.name) && /^set/i.test(f.name)) {
      findings.push({
        id: 'unprotected-price',
        title: 'Anyone can set the price',
        severity: 'high',
        detail: `${sig(f)} writes the price a lending market reads, with no access control. A stranger can set any collateral value, the class behind the Moonwell cbETH bad debt.`,
        ...at,
        ...(deployed ? { confirmed: { exploit: 'A stranger set the price from $2,000 to $1 in one call', txHash: hex(64) } } : {}),
      });
    }
  }
  if (/tx\.origin/.test(src)) findings.push({ id: 'tx-origin-auth', title: 'Auth via tx.origin', severity: 'high', detail: 'tx.origin is the original signer, not the caller. A malicious contract the owner interacts with can pass this check.' });
  return findings;
}

/** A stand-in "compiler": catches the mistakes a hand edit makes (no contract, unbalanced braces). */
function compileError(src: string): string | undefined {
  if (!nameOf(src)) return 'ParserError: no contract definition found.';
  const opens = (src.match(/\{/g) ?? []).length;
  const closes = (src.match(/\}/g) ?? []).length;
  if (opens !== closes) {
    const lines = src.trimEnd().split('\n');
    return `ParserError: Expected '}' but got end of source\n --> Contract.sol:${lines.length}:1\n  |\n${lines.length} | ${lines[lines.length - 1]}`;
  }
}

export function mockGuardApi(): GuardApi {
  return {
    async presets() {
      await wait(200);
      return { presets: PRESETS };
    },
    async draft(prompt: string) {
      await wait(900);
      if (!prompt.trim()) throw new Error('Describe the contract first');
      const p = prompt.toLowerCase();
      const pick =
        /only the owner|onlyowner|access.control|safe/.test(p) ? PRESETS[3]
        : /price|oracle|lend|collateral/.test(p) ? PRESETS[2]
        : /mint|token|faucet|reward|erc20/.test(p) ? PRESETS[1]
        : /vault|deposit|withdraw|usdc|stak/.test(p) ? PRESETS[0]
        : undefined;
      // nothing matched: behave like the server's fallback (model gave nothing usable → closest preset, flagged)
      const src = (pick ?? PRESETS[0]).source;
      return { source: src, name: nameOf(src) ?? 'Contract', ...(pick ? {} : { preset: true }) };
    },
    async audit(source: string) {
      await wait(1400);
      const contractName = nameOf(source) ?? 'Contract';
      const err = compileError(source);
      const base = { contractName, source, auditedAt: Date.now() };
      if (err) return { report: { ...base, verdict: 'COMPILE_ERROR', findings: [], compileError: err } satisfies GuardReport };
      const findings = scan(source, true);
      const report: GuardReport = { ...base, verdict: findings.length ? 'VULNERABLE' : 'SAFE', address: hex(40), chainId: 8453, findings };
      return { report };
    },
  };
}

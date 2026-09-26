import type { GuardPreset } from './types.js';

// Preset contracts for the sandbox: three an agent commonly gets wrong (each dynamically exploitable on the fork)
// and one that does it right. These guarantee the demo even if the live model writes safe code, and give judges a
// one-tap path. Single-file, no imports, Solidity ^0.8.24.

const IERC20 = `interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}`;

export const GUARD_PRESETS: GuardPreset[] = [
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

export const PRESET_BY_ID = Object.fromEntries(GUARD_PRESETS.map((p) => [p.id, p]));

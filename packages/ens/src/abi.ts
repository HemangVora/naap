// ABIs transcribed from ensdomains/contracts-v2 @ 71a3b733 (contracts/src/**). Do not guess — read the .sol.
import { parseAbi } from 'viem';

const eacErrors = [
  'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACCannotRevokeRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACRootResourceNotAllowed()',
  'error EACMaxAssignees(uint256 resource, uint256 role)',
  'error EACMinAssignees(uint256 resource, uint256 role)',
  'error EACInvalidRoleBitmap(uint256 roleBitmap)',
  'error EACInvalidAccount()',
] as const;

// registrar/ETHRegistrar.sol + interfaces/IETHRegistrar.sol
export const ethRegistrarAbi = parseAbi([
  'function commit(bytes32 commitment)',
  'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)',
  'function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)',
  'function commitmentAt(bytes32 commitment) view returns (uint64)',
  'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)',
  'function isAvailable(string label) view returns (bool)',
  'function MIN_COMMITMENT_AGE() view returns (uint64)',
  'function MAX_COMMITMENT_AGE() view returns (uint64)',
  'function MIN_REGISTER_DURATION() view returns (uint64)',
  'event CommitmentMade(bytes32 commitment)',
  'event NameRegistered(uint256 indexed tokenId, string label, address owner, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 indexed referrer, uint256 base, uint256 premium)',
  'error UnexpiredCommitmentExists(bytes32 commitment)',
  'error CommitmentTooNew(bytes32 commitment, uint64 validFrom, uint64 blockTimestamp)',
  'error CommitmentTooOld(bytes32 commitment, uint64 validTo, uint64 blockTimestamp)',
  'error NameNotAvailable(string label)',
  'error DurationTooShort(uint64 duration, uint64 minDuration)',
  'error InvalidOwner()',
]);

// registry/PermissionedRegistry.sol (ETHRegistry and every UserRegistry proxy) + UserRegistry.initialize
export const registryAbi = parseAbi([
  'struct Grant { address account; uint256 roleBitmap; }',
  'function initialize(Grant[] grants)',
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256 tokenId)',
  'function renew(uint256 anyId, uint64 newExpiry)',
  'function unregister(uint256 anyId)',
  'function setSubregistry(uint256 anyId, address registry)',
  'function setResolver(uint256 anyId, address resolver)',
  'function setParent(address parent, string label)',
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
  'function getParent() view returns (address parent, string label)',
  'function findOwner(string label) view returns (address)',
  'function findExpiry(string label) view returns (uint64)',
  'function getOwner(uint256 anyId) view returns (address)',
  'function getExpiry(uint256 anyId) view returns (uint64)',
  'function getResource(uint256 anyId) view returns (uint256)',
  'function hasRoles(uint256 anyId, uint256 roleBitmap, address account) view returns (bool)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function roles(uint256 anyId, address account) view returns (uint256)',
  'function grantRootRoles(uint256 roleBitmap, address account) returns (bool)',
  'event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address registrar)',
  'error LabelAlreadyRegistered(string label)',
  'error LabelAlreadyReserved(string label)',
  'error LabelExpired(uint256 tokenId)',
  'error CannotSetPastExpiry(uint64 expiry)',
  'error InvalidOwner()',
  ...eacErrors,
]);

// resolver/PermissionedResolver.sol
export const resolverAbi = parseAbi([
  'struct Grant { address account; uint256 roleBitmap; }',
  'function initialize(Grant[] grants, bytes[] calls)',
  'function setText(bytes name, string key, string value)',
  'function setAddress(bytes name, uint256 coinType, bytes addressBytes)',
  'function setName(bytes name, string primaryName)',
  'function multicall(bytes[] calls) returns (bytes[] results)',
  'function grantSetterRoles(bytes setter, address account) returns (bool)',
  'function decodeSetter(bytes setter) pure returns (bytes arg, uint256 resource, uint256 roleBitmap)',
  'function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function roles(uint256 resource, address account) view returns (uint256)',
  'function getRecordId(bytes32 node) view returns (uint256)',
  'function resolve(bytes name, bytes data) view returns (bytes)',
  'function text(bytes32 node, string key) view returns (string)',
  'function addr(bytes32 node) view returns (address)',
  'event TextUpdated(uint256 indexed recordId, string indexed keyHash, string key, string value)',
  'event AddressUpdated(uint256 indexed recordId, uint256 coinType, bytes addressBytes)',
  'event ResourceArgument(uint256 indexed resource, bytes arg)',
  'error UnsupportedResolverProfile(bytes4 selector)',
  'error InvalidRecord()',
  'error InvalidEVMAddress(bytes addressBytes)',
  ...eacErrors,
]);

// ensdomains/verifiable-factory VerifiableFactory.sol (deployments/sepolia/VerifiableFactory.json)
export const verifiableFactoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address)',
  'function proxyLogic() view returns (address)',
  'function verifyContract(address proxy) view returns (address)',
  'event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)',
  'error VerificationFailed(address proxy)',
]);

// test/mocks/MockERC20.sol (MockUSDC, 6 decimals) — mint is permissionless
export const mockErc20Abi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

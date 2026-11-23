// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import {Ownable2StepUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/utils/PausableUpgradeable.sol";
import {
    ReentrancyGuardUpgradeable
} from "openzeppelin-contracts-upgradeable/contracts/utils/ReentrancyGuardUpgradeable.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {IStakingPool} from "./interfaces/IStakingPool.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IJackpot} from "./interfaces/IJackpot.sol";
import {IVRFCoordinatorV2Plus} from "./vendor/chainlink/IVRFCoordinatorV2Plus.sol";
import {VRFV2PlusClient} from "./vendor/chainlink/VRFV2PlusClient.sol";
import {IRandomnessSource, IRandomnessConsumer} from "./interfaces/IRandomnessSource.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {ERC1967Utils} from "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Utils.sol";

/**
 * @dev `isConsumer` is not part of the shared {IRandomnessSource} interface; declared locally
 * rather than widening that interface, which both adapter implementations already satisfy.
 */
interface IRandomnessSourceConsumers {
    function isConsumer(address consumer) external view returns (bool);
}

/**
 * @title BlindBox — draw frontend (weights, pricing, opening) over inventory escrowed in the shared {StakingPool}
 * @notice Multiple BlindBox instances can share one StakingPool's inventory, so any box may win any staked card.
 * @dev Beacon-proxy implementation: upgrades are governed by the deploying Beacon, not UUPS.
 */
contract BlindBox is
    Initializable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    IRandomnessConsumer
{
    using SafeERC20 for IERC20;

    // ---------- Constants ----------
    uint256 public constant BPS_DENOMINATOR = 10_000;
    /**
     * @dev Block confirmations the VRF coordinator waits for before fulfilling. Base runs a single
     * sequencer with no L2-level reorgs in practice and the Base coordinator's floor is 0, so 1
     * trades the default 3's extra ~4 s of latency for no security the deployment relies on.
     */
    uint16 public constant VRF_REQUEST_CONFIRMATIONS = 1;
    /**
     * @dev Per-box collection cap, and the sole gas bound for two O(n) paths: the {_selectCollection}
     * weighted scan inside the VRF callback (an OOG there permanently hangs the request and freezes
     * {setCollectionWeight}, outside {_lockAndRecordWin}'s try/catch) and {draw}'s scan over
     * `memberWordIdx`. Run the guards in test/BlindBoxSecurity.t.sol before raising; the pool-side
     * registry is uncapped and unrelated, see {_setMember}.
     */
    uint256 public constant MAX_COLLECTIONS = 100;
    /**
     * @dev Draw-fee cap of 10%, same value as {Marketplace}.
     */
    uint16 public constant MAX_FEE_BPS = 1000;
    /**
     * @dev Fixed gas stipend for the jackpot hook: keeps the `callbackGasLimit` budget additive
     * and predictable (see CallbackHeadroomBench), and caps a misbehaving jackpot at this cost.
     */
    uint256 public constant JACKPOT_CALL_GAS = 120_000;
    /**
     * @dev Delay after which the operator may refund a request whose VRF callback never landed.
     * Healthy sources answer within a few blocks; an hour still clears a stalled source quickly,
     * since {setRandomnessSource} stays blocked until every in-flight draw is gone.
     */
    uint256 public constant REQUEST_RESCUE_DELAY = 1 hours;
    /**
     * @dev Cap for {setChoiceDeadline}; cross-contract-coupled to {StakingPool-ADMIN_UNLOCK_DELAY},
     * see that function's docs.
     */
    uint64 public constant MAX_CHOICE_DEADLINE = 30 days;
    /**
     * @dev Ceiling for {setBuybackDiscountBps}: a 100% buyback makes draw+recycle a pure treasury
     * withdrawal at the floor price (audit feedback-2 #2). 95% leaves the current 90% untouched.
     */
    uint16 public constant MAX_BUYBACK_DISCOUNT_BPS = 9_500;
    /**
     * @dev Batch draw ceiling: each draw is its own VRF request and callback, so the only shared
     * cost is one payment; 10 keeps a batch's worst-case LINK exposure and refund truncation
     * (KNOWN-33) bounded.
     */
    uint256 public constant MAX_BATCH_DRAWS = 10;
    /**
     * @dev Batch settle ceiling for {keepMany}/{recycleMany}; each item is its own external
     * NFT/ERC20 transfer, so this bounds one call's worst-case gas and blast radius.
     */
    uint256 public constant MAX_BATCH_SETTLE = 20;

    /**
     * @dev EIP-712 type hashes; the domain separator is recomputed per call, see {_domainSeparator}.
     */
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _VOUCHER_TYPEHASH =
        keccak256("DrawVoucher(address player,uint256 payAmount,uint256 nonce,uint64 deadline)");

    // ---------- Types ----------
    struct VrfConfig {
        address coordinator;
        bytes32 keyHash;
        uint256 subId;
        uint32 callbackGasLimit;
    }

    /**
     * @dev Plain struct stored as a mapping value; changing its fields does not shift
     * BlindBoxStorage's top-level slot order.
     */
    struct DrawRequest {
        address player;
        uint256 paid;
        uint64 requestedAt; // set at draw() time
    }

    struct Win {
        address winner;
        address collection;
        uint256 tokenId;
        uint256 price;
        address staker;
        uint64 deadline;
        bool settled;
        /**
         * @dev The recycle split is snapshotted at record time so a mid-flight {setBuybackDiscountBps}
         * or {setProfitShareBps} cannot retroactively rewrite an unsettled Win's payout. `paramsSnapshotted`
         * distinguishes a Win recorded after this upgrade (snapshot honored) from one that predates it
         * ({_recycle} falls back to the live global rates, preserving pre-upgrade behavior). `paramsSnapshotted`
         * and `snapBuybackDiscountBps` pack into the free upper bytes of the `settled` slot; only
         * `snapProfitShareBps` adds a slot. Append-only — never insert, delete, retype, or reorder.
         */
        bool paramsSnapshotted;
        uint16 snapBuybackDiscountBps;
        uint16 snapProfitShareBps;
    }

    /**
     * @dev Refund reasons for off-chain monitoring: `EligibilitySetChanged` = the chosen collection
     * became ineligible in the draw-to-fulfill window; `StakingPoolCallReverted` =
     * {StakingPool-pickAndLock} reverted (box deauthorized or pool paused), caught by
     * {_lockAndRecordWin}'s try/catch.
     */
    enum RefundReason {
        EligibilitySetChanged,
        StakingPoolCallReverted
    }

    // ---------- ERC-7201 storage ----------
    /**
     * @custom:storage-location erc7201:topmarket.storage.BlindBox
     * @dev Upgrade discipline: append-only — never insert, delete, retype, or reorder fields.
     */
    struct BlindBoxStorage {
        IStakingPool stakingPool;
        IERC20 settlementToken;
        address treasury;
        address feeRecipient;
        uint16 feeBps;
        uint256 drawPrice;
        uint256 minDrawPrice;
        uint16 buybackDiscountBps;
        uint16 profitShareBps;
        uint64 choiceDeadline;
        VrfConfig vrf;
        address[] collections;
        mapping(address collection => uint32) weightOf;
        uint256 totalWeight;
        mapping(uint256 word => uint256 bits) memberBits;
        uint256[] memberWordIdx;
        mapping(uint256 word => uint256) memberWordPos;
        mapping(uint256 requestId => DrawRequest) requests;
        uint256 pendingDraws;
        uint256 nextWinId;
        mapping(uint256 winId => Win) wins;
        uint256 totalPending;
        mapping(address account => uint256) pendingBalances;
        mapping(address account => bool) isOperator;
        mapping(address collection => bool) knownCollection;
        /**
         * @dev Discount-voucher signer; zero address disables vouchers, which is also the
         * post-upgrade default until each box owner opts in via {setVoucherSigner}.
         */
        address voucherSigner;
        /**
         * @dev Redeemed voucher nonces, scoped per player (not per digest) so a nonce accidentally
         * signed twice off-chain can only be redeemed once.
         */
        mapping(address player => mapping(uint256 nonce => bool)) voucherNonceUsed;
        /**
         * @dev Optional jackpot hook target; zero disables. Appended at the end of the struct
         * (append-only upgrade discipline), so boxes deployed before the jackpot exist unchanged.
         */
        address jackpot;
        /**
         * @dev Emergency-pause principal, decoupled from the operator role: pause() also accepts
         * this address so a narrow watchdog (operationally a 1-of-n Safe) can pause without holding
         * operator powers (setDrawPrice / setCollectionWeight / rescueRequest). Zero = channel
         * closed. Appended at the end of the struct (append-only upgrade discipline).
         */
        address pauser;
        /**
         * @dev Current randomness adapter; zero address keeps this box on the legacy Chainlink
         * path ({rawFulfillRandomWords} + `vrf`), which is the value every box carries across the
         * upgrade so the upgrade itself changes no behavior. Append-only field.
         */
        IRandomnessSource randomnessSource;
        /**
         * @dev Requests made through an adapter, keyed by (source, requestId). Two-level so a
         * request id reused across adapters can never address another source's request; the
         * legacy `requests` table above stays keyed by id alone and is only read by
         * {rawFulfillRandomWords} while pre-upgrade requests drain. Append-only field.
         */
        mapping(address source => mapping(uint256 requestId => DrawRequest)) sourceRequests;
    }

    // keccak256(abi.encode(uint256(keccak256("topmarket.storage.BlindBox")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0xfb0cb1ac99db5983055595361b41f54ded7aeafb1129eee8b8012603861c3900;

    function _getStorage() private pure returns (BlindBoxStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    // ---------- Errors ----------
    error ZeroAddress();
    /**
     * @dev Rejects only unambiguous zero VRF values; it does not prove the config is sufficient,
     * since the real `callbackGasLimit` need grows with this box's collection count.
     *
     * @dev No `setVrfConfig` exists by design: a box-owner-settable coordinator would let the owner
     * forge randomness ({rawFulfillRandomWords} authenticates only `msg.sender == vrf.coordinator`)
     * and cherry-pick the shared {StakingPool} inventory at other boxes' stakers' expense, so any
     * future setter must keep the coordinator with the factory/platform, never the box owner.
     */
    error InvalidVrfConfig();
    error InvalidBps();
    error FeeTooHigh();
    error TooManyCollections();
    error ArrayLengthMismatch();
    error NotOperator();
    error DrawPriceNotSet();
    /**
     * @dev The oracle's declared price scale does not match this contract's settlement scale —
     * a mismatch mis-prices every settlement by 10^|diff| with no other signal.
     */
    error OracleDecimalsMismatch();

    /**
     * @dev Current price exceeds the caller's declared cap; both values surfaced for off-chain
     * diagnosis. Mirrors {Marketplace-PriceAboveMax}: the operator can reprice while a user's
     * transaction is in flight, so the cap must come from the caller.
     */
    error DrawPriceAboveMax(uint256 price, uint256 maxPrice);
    error DrawPriceBelowFloor();
    error NoEligibleCollection();
    error PoolNotReady();
    error WeightsFrozen();
    error CollectionNotRegistered();
    error OnlyCoordinator();
    error WinNotFound();
    error AlreadySettled();
    error NotWinner();
    error ChoiceExpired();
    error ChoiceNotExpired();
    error NothingToWithdraw();
    error RequestNotFound();
    error RescueTooEarly();
    error InvalidDuration();
    error DrawsInFlight();
    /**
     * @dev {setVrfSubId} target subscription does not list this box as a consumer; draws would fail.
     */
    error NotConsumerOfSubscription(uint256 subId);
    error VoucherSignerNotSet();
    error VoucherExpired();
    error VoucherAlreadyUsed();
    error InvalidVoucher();
    error VoucherAmountOutOfRange();
    error JackpotNotContract();
    error NotAuthorizedPauser();
    /**
     * @dev {drawMany} requires `n` within `[1, MAX_BATCH_DRAWS]`; {keepMany}/{recycleMany} reuse
     * the same error for their `[1, MAX_BATCH_SETTLE]` bound.
     */
    error InvalidBatchSize(uint256 n);
    /**
     * @dev A single item of a {keepMany}/{recycleMany} batch failed its settle check or
     * settlement call; `reason` is the failing item's original revert selector (`0x00000000` if
     * the failure carried no data), and the whole batch reverts with it.
     */
    error BatchItemFailed(uint256 winId, bytes4 reason);
    /**
     * @dev {settleOne} is an internal-use entry point for {_settleMany}'s try/catch and must never
     * be called by anything but this contract itself.
     */
    error NotSelf();
    /**
     * @dev {setRandomnessSource} caller is not the beacon owner.
     */
    error NotPlatform();
    /**
     * @dev {setRandomnessSource} target does not list this box as a consumer.
     */
    error SourceNotConsumer(address source);
    /**
     * @dev {_requestOne}'s adapter branch found a live `DrawRequest` already recorded under
     * (source, requestId) — the adapter reissued an id it has not yet settled. Reverts the draw
     * rather than overwriting the earlier request, whose player would otherwise never be refunded.
     */
    error RequestIdInUse(address source, uint256 requestId);

    // ---------- Events ----------
    event CollectionWeightSet(address indexed collection, uint32 weight);
    event DrawPriceSet(uint256 drawPrice);
    event MinDrawPriceSet(uint256 minDrawPrice);
    event OperatorSet(address indexed account, bool allowed);
    event PauserUpdated(address indexed pauser);
    event VrfSubIdUpdated(uint256 oldSubId, uint256 newSubId);
    /**
     * @dev `paid` is the treasury's net receipt (fee deducted); player total = paid + fee.
     */
    event DrawRequested(uint256 indexed requestId, address indexed player, uint256 paid, uint256 fee);
    /**
     * @dev Emitted alongside {DrawRequested} only when the request went through an adapter, naming
     * it so indexers can key on (source, requestId). A separate event rather than a new field on
     * {DrawRequested}, which would break positional decoding for existing consumers.
     */
    event DrawRequestedVia(uint256 indexed requestId, address indexed source);
    event RandomnessSourceSet(address indexed previous, address indexed current);
    /**
     * @dev Emitted once per {drawMany} call, alongside one {DrawRequested} per opened request;
     * `paidTotal`/`feeTotal` are `n × net` / `n × fee` — see {DrawRequested} for the per-request split.
     */
    event BatchDrawRequested(address indexed player, uint256[] requestIds, uint256 paidTotal, uint256 feeTotal);
    event Won(
        uint256 indexed winId,
        uint256 indexed requestId,
        address indexed winner,
        address collection,
        uint256 tokenId,
        uint256 price
    );
    /**
     * @dev `amount` is the treasury's net receipt, which is what gets refunded; the player bears the fee.
     */
    event DrawRefunded(uint256 indexed requestId, address indexed player, uint256 amount, RefundReason reason);
    event WinKept(uint256 indexed winId, address indexed winner, uint256 stakerPayout);
    event WinRecycled(
        uint256 indexed winId, address indexed winner, uint256 recyclePrice, address staker, uint256 stakerShare
    );
    event Withdrawn(address indexed account, uint256 amount);
    /**
     * @dev Direct payout failed and fell back to pending-balance accounting; signals treasury underfunding, missing allowance, or a blocked recipient.
     */
    event PayoutDeferred(address indexed account, uint256 amount);
    /**
     * @dev `amount` is the treasury's net receipt, which is what gets refunded; the player bears the fee.
     */
    event RequestRescued(uint256 indexed requestId, address indexed player, uint256 amount);
    event TreasuryUpdated(address indexed newTreasury);
    event FeeBpsUpdated(uint16 bps);
    event FeeRecipientUpdated(address indexed newRecipient);
    event BuybackDiscountUpdated(uint16 bps);
    event ProfitShareUpdated(uint16 bps);
    event ChoiceDeadlineUpdated(uint64 duration);
    event VoucherSignerSet(address indexed signer);
    event JackpotSet(address indexed jackpot);
    /**
     * @dev The jackpot hook reverted or ran out of its stipend and the entry was dropped
     * (see README KNOWN-J2). Alert on any occurrence — this replaces the cross-contract
     * DrawRequested/JackpotEntered diff for hook failures. An allowlist miss on the jackpot
     * side is a silent success here and stays covered by config discipline (KNOWN-J5).
     */
    event JackpotEntryFailed(uint256 indexed requestId, address indexed player);
    /**
     * @dev Emitted alongside {DrawRequested} (whose fields stay untouched for indexers), carrying
     * the redemption-time `drawPrice` because the subsidy `drawPrice - payAmount` is otherwise not
     * derivable from this transaction. Off-chain monitors must alert on event frequency and the
     * payAmount/drawPrice spread — the only on-chain signal of a compromised signer key.
     */
    event VoucherRedeemed(address indexed player, uint256 indexed nonce, uint256 payAmount, uint256 drawPrice);

    // ---------- Initialization ----------
    /**
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Split into {_initStorage}/{_initFee} to stay under the EVM 16-slot stack limit.
     * @param initialOwner initial owner, also recorded as the first operator
     * @param stakingPool_ shared-inventory {StakingPool}, non-zero
     * @param settlementToken_ settlement token, non-zero
     * @param treasury_ treasury, non-zero and not this contract
     * @param feeRecipient_ fee recipient, non-zero and not this contract
     * @param feeBps_ initial fee in bps, at most {MAX_FEE_BPS}
     * @param coordinator Chainlink VRF coordinator, non-zero
     * @param keyHash VRF gas lane key hash
     * @param subId VRF subscription id
     * @param callbackGasLimit VRF callback gas limit
     */
    function initialize(
        address initialOwner,
        address stakingPool_,
        address settlementToken_,
        address treasury_,
        address feeRecipient_,
        uint16 feeBps_,
        address coordinator,
        bytes32 keyHash,
        uint256 subId,
        uint32 callbackGasLimit
    ) external initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        if (
            stakingPool_ == address(0) || settlementToken_ == address(0) || treasury_ == address(0)
                || treasury_ == address(this) || feeRecipient_ == address(0) || feeRecipient_ == address(this)
                || coordinator == address(0)
        ) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        _validateVrfConfig(keyHash, subId, callbackGasLimit);
        // The pool's cached prices are both this box's eligibility bound and its payout basis:
        // a box settling in a token on a different decimal scale than the pool's oracle would
        // pay stakers 10^|diff| off with no other signal.
        if (
            IPriceOracle(IStakingPool(stakingPool_).priceOracle()).priceDecimals()
                != IERC20Metadata(settlementToken_).decimals()
        ) revert OracleDecimalsMismatch();

        _initStorage(
            initialOwner, stakingPool_, settlementToken_, treasury_, coordinator, keyHash, subId, callbackGasLimit
        );
        _initFee(feeRecipient_, feeBps_);
    }

    function _initStorage(
        address initialOwner,
        address stakingPool_,
        address settlementToken_,
        address treasury_,
        address coordinator,
        bytes32 keyHash,
        uint256 subId,
        uint32 callbackGasLimit
    ) private {
        BlindBoxStorage storage $ = _getStorage();
        $.stakingPool = IStakingPool(stakingPool_);
        $.settlementToken = IERC20(settlementToken_);
        $.treasury = treasury_;
        $.vrf = VrfConfig(coordinator, keyHash, subId, callbackGasLimit);
        // Hardcoded defaults (initialize is at the stack limit); owner can adjust post-deploy via
        // setChoiceDeadline/setBuybackDiscountBps/setProfitShareBps.
        $.choiceDeadline = 7 days;
        $.buybackDiscountBps = 8000;
        $.profitShareBps = 5000;
        $.nextWinId = 1;
        $.isOperator[initialOwner] = true;
        emit OperatorSet(initialOwner, true);
    }

    function _initFee(address feeRecipient_, uint16 feeBps_) private {
        BlindBoxStorage storage $ = _getStorage();
        $.feeRecipient = feeRecipient_;
        $.feeBps = feeBps_;
    }

    // ---------- Admin ----------
    modifier onlyOperator() {
        if (!_getStorage().isOperator[msg.sender]) revert NotOperator();
        _;
    }

    /**
     * @param account operator address, non-zero
     * @param allowed true to grant, false to revoke
     */
    function setOperator(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        _getStorage().isOperator[account] = allowed;
        emit OperatorSet(account, allowed);
    }

    /**
     * @dev Sets the emergency-pause principal (operationally a 1-of-n Safe). Zero address closes
     * the channel, leaving only operators able to pause.
     */
    function setPauser(address newPauser) external onlyOwner {
        _getStorage().pauser = newPauser;
        emit PauserUpdated(newPauser);
    }

    function pauser() external view returns (address) {
        return _getStorage().pauser;
    }

    /**
     * @dev Pause is hot (pauser or operator), unpause is cold ({onlyOwner}); a leaked key can only
     * DoS, never resume an in-flight exploit.
     */
    function pause() external {
        BlindBoxStorage storage $ = _getStorage();
        if (msg.sender != $.pauser && !$.isOperator[msg.sender]) revert NotAuthorizedPauser();
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------- Weights and member bitmap ----------
    /**
     * @param collection NFT collection address
     * @param weight relative weight; `0` removes the collection from the box (and from {collectionAt})
     */
    function setCollectionWeight(address collection, uint32 weight) external onlyOperator {
        _setCollectionWeight(_getStorage(), collection, weight);
    }

    /**
     * @notice Batch-sets weights for multiple collections in one rebalancing pass.
     * @param collections collection addresses
     * @param weights weights matching `collections`; `0` removes the collection from the box
     */
    function setCollectionWeights(address[] calldata collections, uint32[] calldata weights) external onlyOperator {
        if (collections.length != weights.length) revert ArrayLengthMismatch();
        BlindBoxStorage storage $ = _getStorage();
        for (uint256 i; i < collections.length; i++) {
            _setCollectionWeight($, collections[i], weights[i]);
        }
    }

    /**
     * @dev Weights are relative shares with no per-collection cap and no required sum: a
     * collection's odds are its weight over {totalWeight}. Everything downstream widens to uint256
     * (at most MAX_COLLECTIONS x type(uint32).max), so no sum or product can overflow. The `pendingDraws > 0` freeze
     * keeps the live member set identical to the draw-time set, local to this box only.
     * @dev The list holds exactly the weighted collections: a weight of 0 swap-removes the entry
     * (freeing its MAX_COLLECTIONS slot; re-zeroing a legacy zero-weight entry removes it too) and
     * a 0 for a collection not in the box changes nothing. Removal reorders {collectionAt}, which
     * only shifts which slice of `[0, totalWeight)` maps to each collection — odds are unchanged,
     * and the in-flight freeze above means no pending draw can observe the reorder.
     * @dev No `weight > 0 && cachedPrice == 0` check here by design: the pool-side readiness
     * bitmap already rejects unpriced collections at {IStakingPool-allReady}, before any payment
     * (see README KNOWN-5 for the fee-loss history behind this).
     */
    function _setCollectionWeight(BlindBoxStorage storage $, address collection, uint32 weight) private {
        if ($.pendingDraws > 0) revert WeightsFrozen();
        if (collection == address(0)) revert ZeroAddress();
        if (!$.knownCollection[collection]) {
            // Checked even for a 0 weight (which adds nothing) so a typo'd address always fails
            // loudly instead of looking like a successful removal.
            if ($.stakingPool.collectionIndexOf(collection) == 0) revert CollectionNotRegistered();
            if (weight != 0) {
                if ($.collections.length >= MAX_COLLECTIONS) revert TooManyCollections();
                $.knownCollection[collection] = true;
                $.collections.push(collection);
            }
        }
        uint32 oldW = $.weightOf[collection];
        $.totalWeight = $.totalWeight - oldW + weight;
        $.weightOf[collection] = weight;
        bool wasMember = oldW > 0;
        bool nowMember = weight > 0;
        if (wasMember != nowMember) _setMember($, collection, nowMember);
        if (!nowMember && $.knownCollection[collection]) _removeCollection($, collection);
        emit CollectionWeightSet(collection, weight);
    }

    /**
     * @dev Swap-and-pop; the linear scan is bounded by MAX_COLLECTIONS and only runs on an operator
     * call. Callers guarantee the collection is listed (`knownCollection`).
     */
    function _removeCollection(BlindBoxStorage storage $, address collection) private {
        address[] storage cs = $.collections;
        uint256 last = cs.length - 1;
        for (uint256 i; i <= last; ++i) {
            if (cs[i] == collection) {
                if (i != last) cs[i] = cs[last];
                cs.pop();
                break;
            }
        }
        delete $.knownCollection[collection];
    }

    /**
     * @dev Maintains the sparse member bitmap keyed by the pool's stable
     * {IStakingPool-collectionIndexOf} index; sparsity keeps {draw}'s cost bounded by this box's
     * {MAX_COLLECTIONS}, not by the uncapped pool registry.
     * @dev `memberWordIdx` order is unstable (swap-remove) and the readiness check is
     * order-independent; a word leaves the set only on `next == 0`, since other members may still
     * occupy it.
     */
    function _setMember(BlindBoxStorage storage $, address c, bool member) private {
        uint256 idx1 = $.stakingPool.collectionIndexOf(c);
        if (idx1 == 0) revert CollectionNotRegistered();
        uint256 i = idx1 - 1;
        uint256 w = i / 256;
        uint256 bit = 1 << (i % 256);
        uint256 cur = $.memberBits[w];
        uint256 next = member ? (cur | bit) : (cur & ~bit);
        // Defensive no-op guard, unreachable via the sole caller (which pre-checks
        // wasMember != nowMember); it keeps this function idempotent for future callers, so keep it
        // even though no test exercises it.
        if (next == cur) return;
        if (cur == 0) {
            // 0 -> nonzero: word gains its first member, join the traversal set
            $.memberWordIdx.push(w);
            $.memberWordPos[w] = $.memberWordIdx.length; // 1-based; 0 = not in set
        } else if (next == 0) {
            // nonzero -> 0: last member removed, swap-remove the word from the traversal set
            uint256 pos1 = $.memberWordPos[w];
            uint256 lastWord = $.memberWordIdx[$.memberWordIdx.length - 1];
            $.memberWordIdx[pos1 - 1] = lastWord;
            $.memberWordPos[lastWord] = pos1;
            $.memberWordIdx.pop();
            delete $.memberWordPos[w];
        }
        $.memberBits[w] = next;
    }

    // ---------- Pricing and floor ----------
    /**
     * @dev Deliberately allows raising the floor above the current drawPrice, halting {draw} until
     * the operator reprices — a one-step emergency shutoff for the owner.
     * @param newFloor new floor price in settlement token units
     */
    function setMinDrawPrice(uint256 newFloor) external onlyOwner {
        _getStorage().minDrawPrice = newFloor;
        emit MinDrawPriceSet(newFloor);
    }

    /**
     * @notice Sets the discount-voucher signer; zero address disables vouchers for this box.
     * @dev `onlyOwner` (not operator) because the signer key directly moves money and must be
     * rotatable separately from day-to-day ops keys.
     * @param signer new signer address; zero address disables vouchers
     */
    function setVoucherSigner(address signer) external onlyOwner {
        _getStorage().voucherSigner = signer;
        emit VoucherSignerSet(signer);
    }

    /**
     * @param newPrice new per-draw price in settlement token units; must not be below {minDrawPrice}
     */
    function setDrawPrice(uint256 newPrice) external onlyOperator {
        BlindBoxStorage storage $ = _getStorage();
        if (newPrice < $.minDrawPrice) revert DrawPriceBelowFloor();
        $.drawPrice = newPrice;
        emit DrawPriceSet(newPrice);
    }

    // ---------- Governance: settlement parameters ----------
    /**
     * @dev Existing pendingBalances pull from the new treasury (fund and approve it first), the
     * switch is blocked while draws are in flight to avoid fee/refund treasury mismatch, and this
     * contract itself is forbidden (it never self-approves, so {withdraw} would fail forever).
     * This function makes the box owner a fully trusted party over user funds.
     * @param newTreasury new treasury, non-zero and not this contract; must be funded and approved beforehand
     */
    function setTreasury(address newTreasury) external onlyOwner {
        BlindBoxStorage storage $ = _getStorage();
        if (newTreasury == address(0) || newTreasury == address(this)) revert ZeroAddress();
        if ($.pendingDraws > 0) revert DrawsInFlight();
        $.treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /**
     * @dev Repoints ONLY the subscription id; coordinator, keyHash and callbackGasLimit stay
     * immutable (a mutable coordinator would let the owner pick the randomness source). Requires
     * no draws in flight and that the coordinator already lists this box as a consumer of the
     * target subscription — the one misconfiguration this entry could otherwise cause. Exists so a
     * subscription can be emptied of boxes and cancelled to recover its LINK (audit feedback-2 #3
     * follow-up); ops order: addConsumer on the new sub → setVrfSubId → removeConsumer on the old.
     * @param newSubId target subscription id, non-zero, must already list this box as consumer
     */
    function setVrfSubId(uint256 newSubId) external onlyOwner {
        BlindBoxStorage storage $ = _getStorage();
        if (newSubId == 0) revert InvalidVrfConfig();
        if ($.pendingDraws > 0) revert DrawsInFlight();
        (,,,, address[] memory consumers) = IVRFCoordinatorV2Plus($.vrf.coordinator).getSubscription(newSubId);
        bool listed;
        for (uint256 i; i < consumers.length; ++i) {
            if (consumers[i] == address(this)) {
                listed = true;
                break;
            }
        }
        if (!listed) revert NotConsumerOfSubscription(newSubId);
        uint256 old = $.vrf.subId;
        $.vrf.subId = newSubId;
        emit VrfSubIdUpdated(old, newSubId);
    }

    /**
     * @notice Points this box at a randomness adapter; zero address is rejected — going back to
     * the legacy path is deliberately not a runtime toggle.
     * @dev Authorized by the BEACON owner, not this box's owner: the source is the randomness
     * authority, and the standing rule above {InvalidVrfConfig} requires that authority to stay
     * with the platform. The beacon address comes from this proxy's own ERC-1967 slot, so no
     * factory pointer is needed and nothing can be front-run into it. Frozen while draws are in
     * flight, and the target must already list this box as a consumer — the same two guards
     * {setVrfSubId} uses.
     * @param src adapter implementing {IRandomnessSource}, non-zero, with code
     */
    function setRandomnessSource(address src) external {
        if (msg.sender != Ownable(ERC1967Utils.getBeacon()).owner()) revert NotPlatform();
        if (src == address(0) || src.code.length == 0) revert ZeroAddress();
        BlindBoxStorage storage $ = _getStorage();
        if ($.pendingDraws > 0) revert DrawsInFlight();
        if (!IRandomnessSourceConsumers(src).isConsumer(address(this))) revert SourceNotConsumer(src);
        address previous = address($.randomnessSource);
        $.randomnessSource = IRandomnessSource(src);
        emit RandomnessSourceSet(previous, src);
    }

    /**
     * @return address of the currently configured randomness adapter; zero means this box is
     * still on the legacy Chainlink path ({rawFulfillRandomWords} + `vrf`).
     */
    function randomnessSource() external view returns (address) {
        return address(_getStorage().randomnessSource);
    }

    /**
     * @dev Same tuple shape as the existing {requests} getter, so operator tooling decodes both
     * tables identically.
     * @param source adapter address
     * @param requestId id assigned by that adapter
     * @return player requester, zero when unknown; @return paid net amount; @return requestedAt request timestamp
     */
    function sourceRequestOf(address source, uint256 requestId)
        external
        view
        returns (address player, uint256 paid, uint64 requestedAt)
    {
        DrawRequest memory r = _getStorage().sourceRequests[source][requestId];
        return (r.player, r.paid, r.requestedAt);
    }

    /**
     * @dev Serves only {initialize} (the sole `vrf` write); rejects only unambiguous zeros, see {InvalidVrfConfig}.
     */
    function _validateVrfConfig(bytes32 keyHash, uint256 subId, uint32 callbackGasLimit) private pure {
        if (keyHash == bytes32(0) || subId == 0 || callbackGasLimit == 0) revert InvalidVrfConfig();
    }

    /**
     * @dev No in-flight freeze: `paid` is fixed into {DrawRequest} at draw time, so a rate change
     * cannot affect outstanding requests.
     * @param bps new fee in bps, at most {MAX_FEE_BPS}
     */
    function setFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        _getStorage().feeBps = bps;
        emit FeeBpsUpdated(bps);
    }

    /**
     * @dev Must not be this contract (funds sent here are unrecoverable); may equal {treasury},
     * which merely routes the fee back into it.
     * @param newRecipient new fee recipient, non-zero and not this contract
     */
    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0) || newRecipient == address(this)) revert ZeroAddress();
        _getStorage().feeRecipient = newRecipient;
        emit FeeRecipientUpdated(newRecipient);
    }

    /**
     * @notice Sets the optional jackpot hook target; zero disables.
     * @dev Non-zero targets must have code: {onDraw} returns void, so a try/catch call to an EOA
     * would "succeed" silently and the misconfig would never surface.
     * @param jackpot_ jackpot contract, or zero to disable
     */
    function setJackpot(address jackpot_) external onlyOwner {
        if (jackpot_ != address(0) && jackpot_.code.length == 0) revert JackpotNotContract();
        _getStorage().jackpot = jackpot_;
        emit JackpotSet(jackpot_);
    }

    /**
     * @dev Affects only Wins recorded afterwards — every existing Win settles on its own
     * snapshot ({Win-snapBuybackDiscountBps}), required so the owner cannot retroactively
     * rewrite an unsettled Win's payout; same stance as {ShareRaffle-setBuybackDiscountBps}.
     * (Wins predating the snapshot upgrade have no snapshot and fall back to this live value.)
     * @param bps buyback discount in bps applied to the reserve price on recycle
     */
    function setBuybackDiscountBps(uint16 bps) external onlyOwner {
        if (bps > MAX_BUYBACK_DISCOUNT_BPS) revert InvalidBps();
        _getStorage().buybackDiscountBps = bps;
        emit BuybackDiscountUpdated(bps);
    }

    /**
     * @dev Affects only Wins recorded afterwards — every existing Win settles on its own
     * snapshot ({Win-snapProfitShareBps}); see {setBuybackDiscountBps} for the full in-flight
     * semantics.
     * @param bps staker's share of the recycle spread `price - recyclePrice`, in bps
     */
    function setProfitShareBps(uint16 bps) external onlyOwner {
        if (bps > BPS_DENOMINATOR) revert InvalidBps();
        _getStorage().profitShareBps = bps;
        emit ProfitShareUpdated(bps);
    }

    /**
     * @dev {MAX_CHOICE_DEADLINE} (30 days) is coupled to {StakingPool-ADMIN_UNLOCK_DELAY} (60 days)
     * with nothing on-chain enforcing the relation — re-evaluate that delay before ever raising
     * this cap.
     * @param duration keep/recycle choice window, within `[1 hours, MAX_CHOICE_DEADLINE]`
     */
    function setChoiceDeadline(uint64 duration) external onlyOwner {
        if (duration < 1 hours || duration > MAX_CHOICE_DEADLINE) revert InvalidDuration();
        _getStorage().choiceDeadline = duration;
        emit ChoiceDeadlineUpdated(duration);
    }

    // ---------- Draws ----------
    /**
     * @notice Starts a draw — charges the player, checks readiness, requests VRF randomness; the
     * result lands asynchronously via {rawFulfillRandomWords}.
     * @return requestId Chainlink VRF request id, keyed into {requests}/{rescueRequest}
     */
    function draw() external nonReentrant whenNotPaused returns (uint256 requestId) {
        // Kept only for ABI compatibility with pre-cap integrations; semantics are "at the
        // current price, whatever it is". New integrations must use {draw-uint256-} — this
        // unguarded entry is slated for removal at the next breaking upgrade window.
        BlindBoxStorage storage $ = _getStorage();
        return _draw($, $.drawPrice);
    }

    /**
     * @notice Starts a draw with a caller-declared price cap; the guarded entry integrators
     * should prefer over {draw}.
     * @dev Mirrors {Marketplace-buy}'s required `maxPrice`: the operator can reprice while the
     * caller's transaction is in flight, so without a cap the charge is bounded only by the
     * caller's allowance. A lowered price still settles at the (cheaper) current price.
     * @param maxPrice Highest acceptable price in settlement token units, inclusive
     * @return requestId Chainlink VRF request id, keyed into {requests}/{rescueRequest}
     */
    function draw(uint256 maxPrice) external nonReentrant whenNotPaused returns (uint256 requestId) {
        BlindBoxStorage storage $ = _getStorage();
        if ($.drawPrice > maxPrice) revert DrawPriceAboveMax($.drawPrice, maxPrice);
        return _draw($, $.drawPrice);
    }

    /**
     * @notice Opens a box with an off-chain discount voucher, paying `payAmount` instead of `drawPrice`.
     * @dev Checks run cheapest-first (signature recovery last) and the nonce is marked used before
     * any external call (CEI) to block re-entrant double redemption. The amount is bounded on both
     * sides: the floor caps losses if the signer key leaks, the ceiling stops an old voucher from
     * costing more than the current public price. Zero is rejected unconditionally, even if
     * `minDrawPrice` is itself zero (audit feedback-2 #4) — a free draw is never a valid voucher.
     * @param payAmount amount actually paid, within [minDrawPrice, drawPrice] inclusive, nonzero
     * @param nonce per-player voucher nonce, redeemable once
     * @param deadline expiry timestamp, inclusive
     * @param signature `voucherSigner`'s signature over the EIP-712 digest
     * @return requestId VRF request id
     */
    function drawWithVoucher(uint256 payAmount, uint256 nonce, uint64 deadline, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 requestId)
    {
        BlindBoxStorage storage $ = _getStorage();
        address expected = $.voucherSigner;
        if (expected == address(0)) revert VoucherSignerNotSet();
        if (block.timestamp > deadline) revert VoucherExpired();
        if ($.voucherNonceUsed[msg.sender][nonce]) revert VoucherAlreadyUsed();

        bytes32 structHash = keccak256(abi.encode(_VOUCHER_TYPEHASH, msg.sender, payAmount, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        if (ECDSA.recover(digest, signature) != expected) revert InvalidVoucher();

        $.voucherNonceUsed[msg.sender][nonce] = true;

        if (payAmount == 0 || payAmount < $.minDrawPrice || payAmount > $.drawPrice) {
            revert VoucherAmountOutOfRange();
        }

        emit VoucherRedeemed(msg.sender, nonce, payAmount, $.drawPrice);
        return _draw($, payAmount);
    }

    /**
     * @dev EIP-712 domain separator, recomputed per call and never stored: `EIP712Upgradeable`
     * would require a per-box `reinitializer` pass after upgrade (any missed box silently breaks
     * vouchers), while live `chainid`/`address(this)` kill cross-chain and cross-box replay for a
     * few extra keccaks.
     */
    function _domainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(_DOMAIN_TYPEHASH, keccak256("TopMarket BlindBox"), keccak256("1"), block.chainid, address(this))
        );
    }

    /**
     * @dev Shared body of {draw} and {drawWithVoucher}; `amount` is what the player is actually
     * charged, and both price gates below apply to the voucher path too.
     */
    function _draw(BlindBoxStorage storage $, uint256 amount) private returns (uint256 requestId) {
        _drawGate($);
        // Fee is carved out first; the treasury receives only net.
        uint256 fee = _drawFee($, amount);
        uint256 net = amount - fee;
        _incPendingDraws($);
        $.settlementToken.safeTransferFrom(msg.sender, $.treasury, net); // straight to treasury, never held by the box
        if (fee > 0) $.settlementToken.safeTransferFrom(msg.sender, $.feeRecipient, fee);
        requestId = _requestOne($, net, fee);
    }

    /**
     * @notice Opens `n` draws in one transaction at the public price: one payment of `n × drawPrice`,
     * then `n` independent VRF requests. Each request settles, refunds and rescues exactly like a
     * single {draw}; a collection exhausted mid-batch refunds the affected draws (KNOWN-33).
     * @dev Vouchers are not accepted here (see spec). Gates run once for the batch. Mirrors
     * {draw-uint256-}'s `maxPrice` cap: the operator can reprice while the caller's transaction is
     * in flight, so without a cap the charge is bounded only by the caller's allowance. The size
     * check runs first so an oversized batch always reverts {InvalidBatchSize} regardless of price.
     * @param n number of draws, within [1, MAX_BATCH_DRAWS]
     * @param maxPrice Highest acceptable per-draw price in settlement token units, inclusive
     * @return requestIds VRF request ids in issue order
     */
    function drawMany(uint256 n, uint256 maxPrice)
        external
        nonReentrant
        whenNotPaused
        returns (uint256[] memory requestIds)
    {
        if (n == 0 || n > MAX_BATCH_DRAWS) revert InvalidBatchSize(n);
        BlindBoxStorage storage $ = _getStorage();
        if ($.drawPrice > maxPrice) revert DrawPriceAboveMax($.drawPrice, maxPrice);
        _drawGate($);
        uint256 amount = $.drawPrice;
        uint256 fee = _drawFee($, amount);
        uint256 net = amount - fee;
        $.pendingDraws += n;
        $.settlementToken.safeTransferFrom(msg.sender, $.treasury, net * n);
        if (fee > 0) $.settlementToken.safeTransferFrom(msg.sender, $.feeRecipient, fee * n);
        requestIds = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            requestIds[i] = _requestOne($, net, fee);
        }
        emit BatchDrawRequested(msg.sender, requestIds, net * n, fee * n);
    }

    /**
     * @notice Largest `n` a `drawMany` can use without risking truncation refunds (KNOWN-33): the
     * smallest eligible stock among weighted member collections. Read-only hint for frontends, not
     * a gate; 0 when no weighted collection has stock (the readiness gate blocks draws anyway).
     */
    function maxSafeDraws() external view returns (uint256 safe) {
        BlindBoxStorage storage $ = _getStorage();
        safe = type(uint256).max;
        uint256 n = $.collections.length;
        for (uint256 i; i < n; ++i) {
            address c = $.collections[i];
            if ($.weightOf[c] == 0) continue;
            uint256 s = $.stakingPool.eligibleCount(c);
            if (s < safe) safe = s;
        }
        if (safe == type(uint256).max) safe = 0;
    }

    /**
     * @dev Gates shared by {_draw} and {drawMany}: price configured, at/above the floor, and every
     * member collection ready pool-side. Run once per call regardless of how many draws follow.
     */
    function _drawGate(BlindBoxStorage storage $) private view {
        if ($.drawPrice == 0) revert DrawPriceNotSet();
        // Independent floor gate: setDrawPrice cannot catch a floor later raised above the current
        // price (see setMinDrawPrice), so both checks are required.
        if ($.drawPrice < $.minDrawPrice) revert DrawPriceBelowFloor();
        // Readiness gate: every member collection must be ready pool-side, checked in a single
        // stakingPool call over the sparse traversal set (bounded by MAX_COLLECTIONS, not the pool
        // registry; see _setMember). EDV plays no part here (see expectedDrawValue).
        uint256 n = $.memberWordIdx.length;
        uint256[] memory words = new uint256[](n);
        uint256[] memory masks = new uint256[](n);
        for (uint256 k; k < n; ++k) {
            uint256 w = $.memberWordIdx[k];
            words[k] = w;
            masks[k] = $.memberBits[w];
        }
        if (!$.stakingPool.allReady(words, masks)) revert PoolNotReady();
        if ($.totalWeight == 0) revert NoEligibleCollection();
    }

    /**
     * @dev One VRF request + bookkeeping, shared by {_draw} and {drawMany}'s loop. Does NOT touch
     * `pendingDraws` — callers increment it (once, before payment) so the single-draw path's side
     * effect order stays byte-for-byte identical to pre-batch behavior.
     */
    function _requestOne(BlindBoxStorage storage $, uint256 net, uint256 fee) private returns (uint256 requestId) {
        IRandomnessSource src = $.randomnessSource;
        if (address(src) == address(0)) {
            requestId = IVRFCoordinatorV2Plus($.vrf.coordinator)
                .requestRandomWords(
                    VRFV2PlusClient.RandomWordsRequest({
                        keyHash: $.vrf.keyHash,
                        subId: $.vrf.subId,
                        requestConfirmations: VRF_REQUEST_CONFIRMATIONS,
                        callbackGasLimit: $.vrf.callbackGasLimit,
                        numWords: 2,
                        extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: false}))
                    })
                );
            $.requests[requestId] = DrawRequest({player: msg.sender, paid: net, requestedAt: uint64(block.timestamp)});
        } else {
            requestId = src.requestRandomness();
            if ($.sourceRequests[address(src)][requestId].player != address(0)) {
                revert RequestIdInUse(address(src), requestId);
            }
            $.sourceRequests[address(src)][requestId] =
                DrawRequest({player: msg.sender, paid: net, requestedAt: uint64(block.timestamp)});
            emit DrawRequestedVia(requestId, address(src));
        }
        emit DrawRequested(requestId, msg.sender, net, fee);
    }

    function _incPendingDraws(BlindBoxStorage storage $) private {
        $.pendingDraws += 1;
    }

    /**
     * @dev Single fee formula shared by {draw}/{drawWithVoucher}/{drawFee}: the fee is always
     * computed on the full `drawPrice` (discounts are borne by the treasury alone) and waived
     * entirely when `amount` cannot cover it. Note the revenue discontinuity at that threshold;
     * plain {draw} always covers the fee since {MAX_FEE_BPS} is 10%.
     * @param amount amount actually charged; used only for the coverage check, never in the rate
     */
    function _drawFee(BlindBoxStorage storage $, uint256 amount) private view returns (uint256) {
        uint256 fee = ($.drawPrice * $.feeBps) / BPS_DENOMINATOR;
        return amount >= fee ? fee : 0;
    }

    /**
     * @dev Expected draw value for off-chain monitoring only — it is part of no gate ({draw} does
     * NOT check `drawPrice >= EDV`), and the O(n) view scan is deliberately not maintained
     * incrementally.
     * @return weight-averaged expected payout in settlement token units; 0 when `totalWeight == 0`
     */
    function expectedDrawValue() external view returns (uint256) {
        BlindBoxStorage storage $ = _getStorage();
        uint256 totalW = $.totalWeight;
        if (totalW == 0) return 0;
        uint256 sum;
        uint256 n = $.collections.length;
        for (uint256 i; i < n; ++i) {
            address c = $.collections[i];
            uint32 w = $.weightOf[c];
            if (w == 0) continue;
            (uint256 price,) = $.stakingPool.cachedPriceOf(c);
            sum += uint256(w) * price;
        }
        return sum / totalW;
    }

    // ---------- Fulfillment (VRF callback; business failures refund, never revert) ----------
    /**
     * @dev Callable only by the configured VRF coordinator; business failures refund instead of
     * reverting the callback, see {_settle}/{_lockAndRecordWin}.
     * @param requestId request id returned by {draw}
     * @param randomWords two VRF words: [0] picks the collection, [1] picks the token
     */
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external nonReentrant {
        BlindBoxStorage storage $ = _getStorage();
        if (msg.sender != $.vrf.coordinator) revert OnlyCoordinator();
        DrawRequest memory req = $.requests[requestId];
        if (req.player == address(0)) return; // unknown or already handled: ignore silently
        // Unreachable with numWords: 2 (the coordinator always delivers exactly the requested word
        // count), so this never fires in practice. It is, however, a genuine behavior change from
        // the pre-branch code in a path documented elsewhere as unchanged: before this branch,
        // indexing randomWords[1] a few lines below with fewer than 2 words would REVERT the whole
        // callback; this early return instead no-ops. The observable outcome is the same either
        // way — the return/revert both precede `delete $.requests[requestId]` above, so the
        // request stays live in `$.requests` and remains rescuable via {rescueRequest} — but a
        // revert and a silent return are not the same callback outcome in general, so this is
        // recorded as an unclaimed difference rather than left implicit. See
        // {test_LegacyCallbackShortRandomWordsLeavesRequestRescuable} in
        // test/BlindBoxRandomnessSource.t.sol.
        if (randomWords.length < 2) return;
        delete $.requests[requestId];
        _settle($, req, requestId, randomWords[0], randomWords[1]);
    }

    /**
     * @inheritdoc IRandomnessConsumer
     * @dev Keyed by msg.sender, so only the adapter that made the request can settle it; unknown
     * (source, id) pairs are ignored rather than reverted, because an adapter's upstream never
     * retries a reverted callback. The two words this box needs are derived from the adapter's
     * single word by keccak domain separation — the same construction the Chainlink coordinator
     * uses internally to expand its output seed into `randomWords`.
     */
    function onRandomness(uint256 requestId, uint256 randomWord) external nonReentrant {
        BlindBoxStorage storage $ = _getStorage();
        DrawRequest memory req = $.sourceRequests[msg.sender][requestId];
        if (req.player == address(0)) return;
        delete $.sourceRequests[msg.sender][requestId];
        _settle(
            $,
            req,
            requestId,
            uint256(keccak256(abi.encode(randomWord, uint256(0)))),
            uint256(keccak256(abi.encode(randomWord, uint256(1))))
        );
    }

    function _settle(BlindBoxStorage storage $, DrawRequest memory req, uint256 requestId, uint256 w0, uint256 w1)
        private
    {
        // The request ends here either way, pairing draw()'s _incPendingDraws.
        _decPendingDraws($);

        // The in-flight freeze (WeightsFrozen) keeps totalWeight/weightOf/collections equal to
        // their draw-time values.
        (address collection, bool ok) = _selectCollection($, $.totalWeight, w0);
        if (!ok) {
            _refund($, req, requestId, RefundReason.EligibilitySetChanged);
        } else {
            // _lockAndRecordWin distinguishes ok==false (EligibilitySetChanged) from a pickAndLock
            // revert (StakingPoolCallReverted) for off-chain monitoring.
            (bool won, RefundReason reason) = _lockAndRecordWin($, req.player, collection, requestId, w1);
            if (!won) {
                _refund($, req, requestId, reason);
            }
        }

        // Jackpot entry after settlement, on wins and refunds alike (the fee was paid either way).
        _rollJackpot($, req.player, requestId, w1);
    }

    /**
     * @dev Optional jackpot hook: try/catch + fixed stipend so nothing the jackpot does (revert,
     * gas burn) can affect the draw settlement above; a dropped entry is the accepted failure
     * mode, surfaced via {JackpotEntryFailed} (the catch runs on the caller's retained gas, so
     * the emit survives a stipend OOG). The rand is domain-separated from the card-pick use of
     * words[1].
     */
    function _rollJackpot(BlindBoxStorage storage $, address player, uint256 requestId, uint256 w1) private {
        address jp = $.jackpot;
        if (jp == address(0)) return;
        try IJackpot(jp).onDraw{gas: JACKPOT_CALL_GAS}(
            player, uint256(keccak256(abi.encode(w1, requestId, "jackpot")))
        ) {}
        catch {
            emit JackpotEntryFailed(requestId, player);
        }
    }

    /**
     * @dev Weighted-interval lookup only; readiness was gated at {draw} and final adjudication
     * belongs to {StakingPool-pickAndLock}'s `ok` result.
     * @dev Deliberately makes no external call (e.g. {IStakingPool-cachedPriceOf}): it sits on the
     * VRF callback outside {_lockAndRecordWin}'s try/catch, where a revert would permanently hang
     * the request and freeze {setCollectionWeight} — pure storage reads keep
     * {IStakingPool-pickAndLock} the callback's only external call.
     */
    function _selectCollection(BlindBoxStorage storage $, uint256 totalW, uint256 w0)
        private
        view
        returns (address collection, bool ok)
    {
        if (totalW == 0) return (address(0), false);
        uint256 r = w0 % totalW;
        uint256 acc;
        uint256 n = $.collections.length;
        for (uint256 i; i < n; i++) {
            address c = $.collections[i];
            uint256 w = $.weightOf[c];
            if (w == 0) continue;
            acc += w;
            if (r < acc) {
                return (c, true);
            }
        }
    }

    /**
     * @dev Picks and locks a card from {StakingPool} and records the Win, wrapping
     * {IStakingPool-pickAndLock} in try/catch: it reverts (rather than returning ok=false) when the
     * box is deauthorized or the pool paused, and a reverting VRF callback would hang the request
     * and freeze the box forever.
     * @dev OOG is outside this net (under the 63/64 rule the catch branch usually lacks gas to
     * finish), so {rescueRequest} exists as the residual fallback.
     */
    function _lockAndRecordWin(
        BlindBoxStorage storage $,
        address player,
        address collection,
        uint256 requestId,
        uint256 w1
    ) private returns (bool success, RefundReason reason) {
        try $.stakingPool.pickAndLock(collection, w1) returns (
            uint256 tokenId, uint256 price, address staker, bool ok
        ) {
            if (!ok) {
                return (false, RefundReason.EligibilitySetChanged);
            }

            uint256 winId = $.nextWinId++;
            $.wins[winId] = Win({
                winner: player,
                collection: collection,
                tokenId: tokenId,
                price: price,
                staker: staker,
                deadline: uint64(block.timestamp) + $.choiceDeadline,
                settled: false,
                paramsSnapshotted: true,
                snapBuybackDiscountBps: $.buybackDiscountBps,
                snapProfitShareBps: $.profitShareBps
            });
            emit Won(winId, requestId, player, collection, tokenId, price);
            return (true, RefundReason.EligibilitySetChanged); // reason is unread on the success branch
        } catch {
            return (false, RefundReason.StakingPoolCallReverted);
        }
    }

    function _refund(BlindBoxStorage storage $, DrawRequest memory req, uint256 requestId, RefundReason reason)
        private
    {
        _payOrCredit($, req.player, req.paid);
        emit DrawRefunded(requestId, req.player, req.paid, reason);
    }

    /**
     * @notice Lets the operator manually refund a request whose VRF callback never landed, after
     * {REQUEST_RESCUE_DELAY}, unfreezing player funds and the in-flight counter.
     * @dev The delay avoids pre-empting a callback that may still arrive — a late callback then
     * sees the deleted record and no-ops, but too short a delay would rob the player of a genuine
     * win.
     * @param requestId pending {draw} request id, past {REQUEST_RESCUE_DELAY} and unhandled
     */
    function rescueRequest(uint256 requestId) external onlyOperator nonReentrant {
        BlindBoxStorage storage $ = _getStorage();
        DrawRequest memory req = $.requests[requestId];
        if (req.player == address(0)) revert RequestNotFound();
        if (block.timestamp < req.requestedAt + REQUEST_RESCUE_DELAY) revert RescueTooEarly();

        delete $.requests[requestId];
        _decPendingDraws($);
        _payOrCredit($, req.player, req.paid);
        emit RequestRescued(requestId, req.player, req.paid);
    }

    /**
     * @notice Refunds a draw whose adapter callback never arrived.
     * @dev Overload rather than a signature change: `rescueRequest(uint256)` still serves requests
     * made before the adapter upgrade, and changing its signature would break operator tooling.
     * @param source adapter that issued the request
     * @param requestId id assigned by that adapter
     */
    function rescueRequest(address source, uint256 requestId) external onlyOperator nonReentrant {
        BlindBoxStorage storage $ = _getStorage();
        DrawRequest memory req = $.sourceRequests[source][requestId];
        if (req.player == address(0)) revert RequestNotFound();
        if (block.timestamp < req.requestedAt + REQUEST_RESCUE_DELAY) revert RescueTooEarly();

        delete $.sourceRequests[source][requestId];
        _decPendingDraws($);
        _payOrCredit($, req.player, req.paid);
        emit RequestRescued(requestId, req.player, req.paid);
    }

    function _decPendingDraws(BlindBoxStorage storage $) private {
        $.pendingDraws -= 1;
    }

    // ---------- Winner's choice ----------
    /**
     * @notice Winner claims the prize within the choice window: the staker is paid the full reserve
     * price and the NFT goes to the winner.
     * @param winId win id assigned in {rawFulfillRandomWords}
     */
    function keep(uint256 winId) external nonReentrant {
        BlindBoxStorage storage $ = _getStorage();
        _requireSettleable($, winId, msg.sender);
        _keep($, winId);
    }

    /**
     * @dev Shared settle-eligibility checks for {keep}/{recycle}, both single and via
     * {settleOne}. Order is the documented one and must not change: {WinNotFound},
     * {AlreadySettled}, {NotWinner}, {ChoiceExpired}.
     */
    function _requireSettleable(BlindBoxStorage storage $, uint256 winId, address caller) private view {
        Win storage w = $.wins[winId];
        if (w.winner == address(0)) revert WinNotFound();
        if (w.settled) revert AlreadySettled();
        if (caller != w.winner) revert NotWinner();
        if (block.timestamp > w.deadline) revert ChoiceExpired();
    }

    /**
     * @notice Per-item entry point used by {keepMany}/{recycleMany}'s internal try/catch to
     * capture each item's revert selector; callable only by this contract.
     * @dev Not `nonReentrant` — the outer {keepMany}/{recycleMany} already holds the guard, and a
     * self-call through it would trip `ReentrancyGuardReentrantCall`. Not `whenNotPaused` either,
     * matching {keep}/{recycle} (unpaused by design). `caller` is forwarded explicitly because the
     * external self-call changes `msg.sender` to `address(this)`.
     * @dev The `msg.sender == address(this)` gate is load-bearing for reentrancy safety: this
     * function carries no guard of its own, relying entirely on {keepMany}/{recycleMany}'s
     * `nonReentrant` to bound it. A future change must not relax or remove the gate without adding
     * an equivalent guard here.
     * @param winId win id to settle
     * @param caller the batch's original `msg.sender`, checked as the win's winner
     * @param isKeep true to keep (settle via {_keep}), false to recycle (settle via {_recycle})
     */
    function settleOne(uint256 winId, address caller, bool isKeep) external {
        if (msg.sender != address(this)) revert NotSelf();
        BlindBoxStorage storage $ = _getStorage();
        _requireSettleable($, winId, caller);
        if (isKeep) {
            _keep($, winId);
        } else {
            _recycle($, winId);
        }
    }

    /**
     * @notice Keeps every win in `winIds`: staker paid, NFT to the winner, per {keep}. All-or-
     * nothing — any item's failure reverts the whole batch with {BatchItemFailed}.
     * @param winIds win ids, `[1, MAX_BATCH_SETTLE]` items; duplicate ids revert the whole batch
     * ({AlreadySettled} on the second occurrence)
     */
    function keepMany(uint256[] calldata winIds) external nonReentrant {
        _settleMany(winIds, true);
    }

    /**
     * @notice Recycles every win in `winIds`: winner paid the buyback, staker paid its share, NFT
     * returned to the pool, per {recycle}. All-or-nothing — any item's failure reverts the whole
     * batch with {BatchItemFailed}.
     * @param winIds win ids, `[1, MAX_BATCH_SETTLE]` items; duplicate ids revert the whole batch
     * ({AlreadySettled} on the second occurrence)
     */
    function recycleMany(uint256[] calldata winIds) external nonReentrant {
        _settleMany(winIds, false);
    }

    /**
     * @dev Shared driver for {keepMany}/{recycleMany}: bounds-checks the batch size, then settles
     * each id via a self-call to {settleOne} so a failing item's revert can be caught and
     * rewrapped as {BatchItemFailed} — the whole batch reverts atomically, no partial state.
     */
    function _settleMany(uint256[] calldata winIds, bool isKeep) private {
        uint256 n = winIds.length;
        if (n == 0 || n > MAX_BATCH_SETTLE) revert InvalidBatchSize(n);
        for (uint256 i; i < n; ++i) {
            try this.settleOne(winIds[i], msg.sender, isKeep) {}
            catch (bytes memory err) {
                revert BatchItemFailed(winIds[i], err.length >= 4 ? bytes4(err) : bytes4(0));
            }
        }
    }

    /**
     * @dev CEI-style ordering by convention only (a failure reverts everything atomically), and
     * every re-entry surface is closed: {IStakingPool-releaseTo} uses `transferFrom` (no receiver
     * hook), this box is `nonReentrant`, and {StakingPool} holds a contract-wide lock.
     */
    function _keep(BlindBoxStorage storage $, uint256 winId) private {
        Win storage w = $.wins[winId];
        w.settled = true;
        _payOrCredit($, w.staker, w.price);
        $.stakingPool.releaseTo(w.collection, w.tokenId, w.winner);
        emit WinKept(winId, w.winner, w.price);
    }

    /**
     * @notice Winner forgoes the NFT for a discounted buyback: the winner receives
     * `price * buybackDiscountBps`, the staker gets `profitShareBps` of the spread, and the NFT
     * returns to the pool.
     * @param winId win id assigned in {rawFulfillRandomWords}
     */
    function recycle(uint256 winId) external nonReentrant {
        BlindBoxStorage storage $ = _getStorage();
        // Deadline guard must stay: without it the winner's keep-or-recycle option becomes
        // perpetual, at the stakers' expense. Enforced inside {_requireSettleable}.
        _requireSettleable($, winId, msg.sender);
        _recycle($, winId);
    }

    /**
     * @dev Resolves the recycle split for a Win: the rates snapshotted when it was recorded, or — for a
     * Win that predates the snapshot upgrade (`paramsSnapshotted` unset) — the live global rates, exactly
     * as {_recycle} read them before the upgrade.
     */
    function _recycleSplit(Win storage w, BlindBoxStorage storage $)
        private
        view
        returns (uint16 discountBps, uint16 shareBps)
    {
        if (w.paramsSnapshotted) {
            return (w.snapBuybackDiscountBps, w.snapProfitShareBps);
        }
        return ($.buybackDiscountBps, $.profitShareBps);
    }

    /**
     * @dev Same conventional CEI ordering as {_keep}; {IStakingPool-returnToPool} moves no NFT, so
     * there is no asset-release risk either way.
     */
    function _recycle(BlindBoxStorage storage $, uint256 winId) private {
        Win storage w = $.wins[winId];
        w.settled = true;
        (uint16 discountBps, uint16 shareBps) = _recycleSplit(w, $);
        uint256 recyclePrice = w.price * discountBps / BPS_DENOMINATOR;
        // R + share <= P: share = (P - R) * profitShareBps / BPS <= P - R.
        uint256 stakerShare = (w.price - recyclePrice) * shareBps / BPS_DENOMINATOR;
        _payOrRevert($, w.winner, recyclePrice);
        _payOrCredit($, w.staker, stakerShare);
        $.stakingPool.returnToPool(w.collection, w.tokenId);
        emit WinRecycled(winId, w.winner, recyclePrice, w.staker, stakerShare);
    }

    /**
     * @notice After the deadline anyone may settle; the default is keep — NFT to the winner, full
     * price to the staker.
     * @param winId win id past {choiceDeadline} and unsettled
     */
    function settleExpiredKeep(uint256 winId) external nonReentrant {
        BlindBoxStorage storage $ = _getStorage();
        Win storage w = $.wins[winId];
        if (w.winner == address(0)) revert WinNotFound();
        if (w.settled) revert AlreadySettled();
        if (block.timestamp <= w.deadline) revert ChoiceNotExpired();
        _keep($, winId);
    }

    // ---------- Funds ----------
    /**
     * @notice Withdraws the caller's accrued balance, pulled from the external {treasury}; if the
     * treasury lacks funds or allowance the call reverts and the accounting survives for retry.
     */
    function withdraw() external nonReentrant {
        BlindBoxStorage storage $ = _getStorage();
        uint256 amount = $.pendingBalances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        $.pendingBalances[msg.sender] = 0;
        $.totalPending -= amount;
        $.settlementToken.safeTransferFrom($.treasury, msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /**
     * @dev Pays from {treasury} and reverts the whole transaction on failure — used only for paying
     * `msg.sender` itself ({_recycle}'s `recyclePrice`), where a revert harms only the caller.
     * Third-party staker payouts deliberately use {_payOrCredit} instead; do not unify them —
     * test/BlindBoxStakerPayout.t.sol pins both directions.
     */
    function _payOrRevert(BlindBoxStorage storage $, address to, uint256 amount) private {
        if (amount == 0) return;
        $.settlementToken.safeTransferFrom($.treasury, to, amount);
    }

    /**
     * @dev Pays from {treasury}, falling back to {pendingBalances} accounting on any failure:
     * refund paths must never revert (they run on the VRF callback and its rescue path), and a
     * token-blocked third-party staker must not brick the winner's settlement.
     * @dev This turns treasury underfunding into a silent soft failure — observability rests on
     * {PayoutDeferred} plus off-chain treasury alerts. Success is judged by return-value semantics
     * read in assembly (never by recipient balance diffs, which transfer-hook tokens can spoof into
     * double payment); only standard ERC20s are supported — no fee-on-transfer, rebasing, or
     * transfer hooks.
     */
    function _payOrCredit(BlindBoxStorage storage $, address to, uint256 amount) private {
        if (amount == 0) return;
        address token = address($.settlementToken);
        // Low-level call: every failure mode surfaces only as ok == false.
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transferFrom, ($.treasury, to, amount)));
        if (ok) {
            if (ret.length == 0) {
                if (token.code.length > 0) return; // empty return + has code = success (USDT-style)
            } else if (ret.length >= 32) {
                uint256 word;
                assembly {
                    word := mload(add(ret, 0x20))
                }
                if (word == 1) return;
            }
        }
        _credit($, to, amount);
        emit PayoutDeferred(to, amount);
    }

    function _credit(BlindBoxStorage storage $, address account, uint256 amount) private {
        $.pendingBalances[account] += amount;
        $.totalPending += amount;
    }

    // ---------- Getters (explicit ABI) ----------
    /**
     * @return shared-inventory {StakingPool} address
     */
    function stakingPool() external view returns (address) {
        return address(_getStorage().stakingPool);
    }

    /**
     * @return settlement token address
     */
    function settlementToken() external view returns (address) {
        return address(_getStorage().settlementToken);
    }

    /**
     * @return current treasury address
     */
    function treasury() external view returns (address) {
        return _getStorage().treasury;
    }

    /**
     * @return current fee recipient
     */
    function feeRecipient() external view returns (address) {
        return _getStorage().feeRecipient;
    }

    /**
     * @return current fee in bps
     */
    function feeBps() external view returns (uint16) {
        return _getStorage().feeBps;
    }

    /**
     * @return current per-draw price in settlement token units; `0` = unset
     */
    function drawPrice() external view returns (uint256) {
        return _getStorage().drawPrice;
    }

    /**
     * @return current floor price in settlement token units
     */
    function minDrawPrice() external view returns (uint256) {
        return _getStorage().minDrawPrice;
    }

    /**
     * @return per-draw fee from current drawPrice/feeBps, settlement token units
     */
    function drawFee() external view returns (uint256) {
        BlindBoxStorage storage $ = _getStorage();
        return _drawFee($, $.drawPrice);
    }

    /**
     * @return voucher signer; zero address = vouchers disabled
     */
    function voucherSigner() external view returns (address) {
        return _getStorage().voucherSigner;
    }

    /**
     * @param player player address
     * @param nonce voucher nonce
     * @return whether that player's nonce has been redeemed
     */
    function isVoucherNonceUsed(address player, uint256 nonce) external view returns (bool) {
        return _getStorage().voucherNonceUsed[player][nonce];
    }

    /**
     * @return current buyback discount in bps
     */
    function buybackDiscountBps() external view returns (uint16) {
        return _getStorage().buybackDiscountBps;
    }

    /**
     * @return current staker profit-share in bps
     */
    function profitShareBps() external view returns (uint16) {
        return _getStorage().profitShareBps;
    }

    /**
     * @return current choice-window duration
     */
    function choiceDeadline() external view returns (uint64) {
        return _getStorage().choiceDeadline;
    }

    /**
     * @param collection NFT collection address
     * @return current relative weight; `0` = not in draws
     */
    function weightOf(address collection) external view returns (uint32) {
        return _getStorage().weightOf[collection];
    }

    /**
     * @notice Number of collections in this box (every one has a non-zero weight); paginate with
     * {collectionAt}. Same paging shape as {IStakingPool-collectionCount}.
     * @dev Boxes upgraded from the append-only list may still hold legacy zero-weight entries until
     * an operator sets them to 0 again, so readers should keep filtering by `weightOf(c) > 0`.
     * @return count of listed collections
     */
    function collectionCount() external view returns (uint256) {
        return _getStorage().collections.length;
    }

    /**
     * @notice Returns the `index`-th listed collection (0-based).
     * @dev Order is unstable: removing a collection moves the last entry into its place. Panics on out-of-range rather than returning a zero address that callers could misread
     * as a real entry.
     * @param index 0-based index below {collectionCount}
     * @return collection address at that index
     */
    function collectionAt(uint256 index) external view returns (address) {
        return _getStorage().collections[index];
    }

    /**
     * @return sum of all non-zero weights
     */
    function totalWeight() external view returns (uint256) {
        return _getStorage().totalWeight;
    }

    /**
     * @return in-flight request count (drawn, not yet fulfilled/rescued); non-zero freezes weight and treasury changes
     */
    function pendingDraws() external view returns (uint256) {
        return _getStorage().pendingDraws;
    }

    /**
     * @notice Count of occupied words in the member bitmap — not `max word index + 1`; iterate via
     * {memberWordEntryAt}, never assume contiguous word indices (see docs/integration/README.md).
     * @return traversal-set entry count
     */
    function memberWordEntryCount() external view returns (uint256) {
        return _getStorage().memberWordIdx.length;
    }

    /**
     * @notice Returns the `i`-th traversal-set entry.
     * @dev Order is unstable (swap-remove); do not rely on it.
     * @param i 0-based index below {memberWordEntryCount}
     * @return word word index (`(collectionIndex-1) / 256`)
     * @return bits member bits of that word
     */
    function memberWordEntryAt(uint256 i) external view returns (uint256 word, uint256 bits) {
        BlindBoxStorage storage $ = _getStorage();
        word = $.memberWordIdx[i];
        bits = $.memberBits[word];
    }

    /// @return the jackpot hook target; zero when disabled
    function jackpot() external view returns (address) {
        return _getStorage().jackpot;
    }

    /**
     * @param account address to query
     * @return whether the address is currently an operator
     */
    function isOperator(address account) external view returns (bool) {
        return _getStorage().isOperator[account];
    }

    /**
     * @dev `paid` is the treasury's net receipt, not the player's total outlay.
     * @param requestId request id returned by {draw}
     * @return player requesting player; address(0) if unknown or already handled
     * @return paid treasury net receipt in settlement token units
     * @return requestedAt block timestamp of the {draw}
     */
    function requests(uint256 requestId) external view returns (address player, uint256 paid, uint64 requestedAt) {
        DrawRequest storage r = _getStorage().requests[requestId];
        return (r.player, r.paid, r.requestedAt);
    }

    /**
     * @dev Coordinator, keyHash and callbackGasLimit are fixed at {initialize} from the factory's
     * then-active subscription and stay immutable forever. `subId` alone is repointable via
     * {setVrfSubId}; this is still the sole authority on which subscription this box currently
     * uses — {BlindBoxFactory-isBoxVrfRegistered} relies on it.
     * @return coordinator VRF coordinator address
     * @return keyHash gas lane used by requests
     * @return subId subscription id
     * @return callbackGasLimit callback gas limit
     */
    function vrfConfig()
        external
        view
        returns (address coordinator, bytes32 keyHash, uint256 subId, uint32 callbackGasLimit)
    {
        VrfConfig storage v = _getStorage().vrf;
        return (v.coordinator, v.keyHash, v.subId, v.callbackGasLimit);
    }

    /**
     * @return next win id to assign (starts at 1)
     */
    function nextWinId() external view returns (uint256) {
        return _getStorage().nextWinId;
    }

    /**
     * @param winId win id assigned in {rawFulfillRandomWords}
     * @return winner winner address; address(0) if the winId does not exist
     * @return collection collection of the won NFT
     * @return tokenId won token id
     * @return price reserve price at win time, settlement token units
     * @return staker original staker of the token
     * @return deadline keep/recycle deadline; past it use {settleExpiredKeep}
     * @return settled whether settled (keep/recycle/settleExpiredKeep)
     * @return paramsSnapshotted whether the split snapshot below governs settlement; false = a
     * pre-snapshot-upgrade Win whose snap fields read 0 WITHOUT meaning "0 bps" — {_recycle}
     * falls back to the live globals, so integrators must branch on this flag
     * @return snapBuybackDiscountBps buyback discount snapshotted at win time (QA R51 item 5)
     * @return snapProfitShareBps staker profit share snapshotted at win time
     * @dev NOTE: the tuple grew from 7 to 10 fields — positional decoders must regenerate the
     * ABI (see docs/integration/README.md).
     */
    function wins(uint256 winId)
        external
        view
        returns (
            address winner,
            address collection,
            uint256 tokenId,
            uint256 price,
            address staker,
            uint64 deadline,
            bool settled,
            bool paramsSnapshotted,
            uint16 snapBuybackDiscountBps,
            uint16 snapProfitShareBps
        )
    {
        Win storage w = _getStorage().wins[winId];
        return (
            w.winner,
            w.collection,
            w.tokenId,
            w.price,
            w.staker,
            w.deadline,
            w.settled,
            w.paramsSnapshotted,
            w.snapBuybackDiscountBps,
            w.snapProfitShareBps
        );
    }

    /**
     * @return sum of all accounts' pending balances, settlement token units
     */
    function totalPending() external view returns (uint256) {
        return _getStorage().totalPending;
    }

    /**
     * @param account address to query
     * @return account's pending balance in settlement token units, cleared by {withdraw}
     */
    function pendingBalances(address account) external view returns (uint256) {
        return _getStorage().pendingBalances[account];
    }

    /**
     * @dev Disabled. The beacon can re-point the implementation but cannot restore a box's owner
     * without a global reset hook, and renouncing kills setTreasury / setVoucherSigner /
     * setMinDrawPrice — the documented stop-loss levers (audit feedback-2 #8).
     */
    error RenounceDisabled();

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }
}

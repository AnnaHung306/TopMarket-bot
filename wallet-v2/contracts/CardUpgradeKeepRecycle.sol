// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/utils/PausableUpgradeable.sol";
import {
    ReentrancyGuardUpgradeable
} from "openzeppelin-contracts-upgradeable/contracts/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {ITokenPriceOracle} from "./interfaces/ITokenPriceOracle.sol";
import {IRandomnessSource, IRandomnessConsumer} from "./interfaces/IRandomnessSource.sol";

/**
 * @title CardUpgrade — stake one card, win a pricier prize-pool card at chance stake × (1 − edge) ÷ target
 * @dev Spec: docs/superpowers/specs/2026-10-09-card-upgrade-design.md. Every value that decides a spin
 * is snapshotted at submit and the target is reserved, so nothing a player can do between submit and
 * the randomness callback changes the outcome — a source that publishes its word early (Pyth) gives
 * the player no lever.
 */
contract CardUpgrade is
    Initializable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    IRandomnessConsumer
{
    using SafeERC20 for IERC20;

    // ---------- Constants ----------

    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_EDGE_BPS = 5_000;
    uint16 public constant MIN_CHANCE_FLOOR_BPS = 100;
    uint16 public constant MAX_CHANCE_CEIL_BPS = 9_900;
    uint256 public constant OPERATOR_RESCUE_DELAY = 1 days;
    uint256 public constant PLAYER_RESCUE_DELAY = 7 days;
    uint16 public constant MAX_RECYCLE_DISCOUNT_BPS = 10_000;
    uint64 public constant MIN_CHOICE_WINDOW = 1 hours;
    uint64 public constant MAX_CHOICE_WINDOW = 30 days;
    uint256 public constant MAX_BATCH_SETTLE = 20;

    // ---------- Types ----------

    enum PrizeState {
        None,
        Available,
        Reserved
    }

    enum SpinStatus {
        None,
        Pending,
        Won,
        Lost,
        Rescued,
        AwaitingChoice,
        Kept,
        Recycled
    }

    enum QuoteError {
        None,
        SameCard,
        TargetUnavailable,
        ZeroPrice,
        StalePrice,
        StakeTooSmall,
        TargetNotHigher,
        TargetTooValuable,
        ChanceOutOfRange
    }

    /**
     * @dev Append-only; the layout test pins every slot. Packed: slot 0 player|requestedAt|status,
     * slot 1 stakeCollection|stakeTokenId|edgeBps|chanceBps, slot 2 targetCollection|targetTokenId,
     * slot 3 source, slot 4 requestId, slot 5 stakeValue, slot 6 targetValue.
     */
    struct Spin {
        address player;
        uint64 requestedAt;
        SpinStatus status;
        address stakeCollection;
        uint32 stakeTokenId;
        uint16 edgeBps;
        uint16 chanceBps;
        address targetCollection;
        uint32 targetTokenId;
        address source;
        uint256 requestId;
        uint256 stakeValue;
        uint256 targetValue;
    }

    struct Claim {
        address collection;
        uint32 tokenId;
    }

    /**
     * @dev Per-spin snapshot taken when a spin is won: the keep-or-recycle deadline and the buyback
     * discount in force at that moment.
     */
    struct Choice {
        uint64 deadline;
        uint16 discountBps;
    }

    // ---------- Errors ----------

    error ZeroAddress();
    error NotOperator();
    error NotAuthorizedPauser();
    error InvalidBps();
    error InvalidChanceRange();
    error InvalidValue();
    error RenounceDisabled();
    error SpinsInFlight();
    error SourceNotConsumer(address source);
    error PrizeNotNone(address collection, uint32 tokenId);
    error PrizeNotAvailable(address collection, uint32 tokenId);
    error CannotUpgrade(QuoteError reason);
    error ChanceBelowMinimum();
    error NotStakeOwner();
    error RequestIdInUse(address source, uint256 requestId);
    error SpinNotPending(uint256 spinId);
    error RescueTooEarly(uint256 spinId);
    error NotRescuer();
    error NothingToClaim(uint256 spinId);
    error NotOwedToReceiver(address collection, uint32 tokenId);
    error DecimalsMismatch();
    error InvalidDuration();
    error NotAwaitingChoice(uint256 spinId);
    error NotWinner();
    error ChoiceExpired(uint256 spinId);
    error ChoiceNotExpired(uint256 spinId);
    error InvalidBatchSize(uint256 n);
    error BatchItemFailed(uint256 spinId, bytes4 reason);
    error NotSelf();

    // ---------- Events ----------

    event OperatorSet(address indexed account, bool allowed);
    event PauserUpdated(address indexed pauser);
    event EdgeBpsSet(uint16 edgeBps);
    event ChanceRangeSet(uint16 minBps, uint16 maxBps);
    event MaxTargetValueSet(uint256 value);
    event MinStakeValueSet(uint256 value);
    event MaxPriceAgeSet(uint256 maxAge);
    event CardReceiverSet(address indexed receiver);
    event OracleSet(address indexed oracle);
    event RandomnessSourceSet(address indexed previous, address indexed source);
    event PrizeDeposited(address indexed collection, uint32 indexed tokenId);
    event PrizeWithdrawn(address indexed collection, uint32 indexed tokenId, address to);
    event UpgradeRequested(
        uint256 indexed spinId,
        address indexed player,
        address source,
        uint256 requestId,
        address stakeCollection,
        uint32 stakeTokenId,
        uint256 stakeValue,
        address targetCollection,
        uint32 targetTokenId,
        uint256 targetValue,
        uint16 edgeBps,
        uint16 chanceBps
    );
    event UpgradeSettled(uint256 indexed spinId, bool won, uint256 randomWord);
    event UpgradeRescued(uint256 indexed spinId, address indexed by);
    event CardClaimable(uint256 indexed spinId, address indexed player, address collection, uint32 tokenId);
    event CardClaimed(uint256 indexed spinId, address indexed player, address collection, uint32 tokenId);
    event CardOwedToReceiver(address indexed collection, uint32 indexed tokenId);
    event CardFlushedToReceiver(address indexed collection, uint32 indexed tokenId, address receiver);
    event TreasurySet(address indexed treasury);
    event SettlementTokenSet(address indexed token);
    event RecycleDiscountSet(uint16 discountBps);
    event ChoiceWindowSet(uint64 window);
    event ChoicePending(uint256 indexed spinId, address indexed player, uint64 deadline, uint256 recyclePrice);
    event WinKept(uint256 indexed spinId, address indexed player);
    event WinRecycled(uint256 indexed spinId, address indexed player, uint256 amount);

    // ---------- Storage ----------

    /**
     * @custom:storage-location erc7201:topmarket.storage.CardUpgrade
     * @dev Append-only: never insert, delete, retype or reorder fields.
     */
    struct CardUpgradeStorage {
        ITokenPriceOracle oracle;
        IRandomnessSource randomnessSource;
        address cardReceiver;
        address pauser;
        uint16 edgeBps;
        uint16 chanceMinBps;
        uint16 chanceMaxBps;
        uint256 maxTargetValue;
        uint256 minStakeValue;
        uint256 maxPriceAge;
        mapping(address account => bool) isOperator;
        mapping(address collection => mapping(uint32 tokenId => PrizeState)) prizeState;
        mapping(address collection => mapping(uint32 tokenId => uint256 spinId)) reservedFor;
        mapping(uint256 spinId => Spin) spins;
        mapping(address source => mapping(uint256 requestId => uint256 spinId)) spinOf;
        uint256 pendingSpins;
        uint256 nextSpinId;
        mapping(uint256 spinId => Claim) claimable;
        mapping(address collection => mapping(uint32 tokenId => bool)) owedToReceiver;
        IERC20 settlementToken;
        address treasury;
        uint16 recycleDiscountBps;
        uint64 choiceWindow;
        uint256 awaitingChoice;
        mapping(uint256 spinId => Choice) choices;
    }

    // keccak256(abi.encode(uint256(keccak256("topmarket.storage.CardUpgrade")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0x0c1d25f027ad8286f82cc5d9e26912d50a8f083809efd98fccb4f06084960d00;

    function _getStorage() private pure returns (CardUpgradeStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    // ---------- Initialization ----------

    /**
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev The source need not list this proxy yet (it cannot know the proxy address before
     * deployment); {setRandomnessSource} enforces `isConsumer`. Default limits scale with the oracle's
     * price decimals so they read as 5,000 / 10 settlement units.
     */
    function initialize(address initialOwner, address oracle_, address randomnessSource_, address cardReceiver_)
        external
        initializer
    {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        if (oracle_.code.length == 0 || randomnessSource_.code.length == 0) revert ZeroAddress();
        if (cardReceiver_ == address(0) || cardReceiver_ == address(this)) revert ZeroAddress();

        CardUpgradeStorage storage $ = _getStorage();
        $.oracle = ITokenPriceOracle(oracle_);
        $.randomnessSource = IRandomnessSource(randomnessSource_);
        $.cardReceiver = cardReceiver_;
        $.edgeBps = 800;
        $.chanceMinBps = 1000;
        $.chanceMaxBps = 9000;
        uint256 unit = 10 ** ITokenPriceOracle(oracle_).priceDecimals();
        $.maxTargetValue = 5_000 * unit;
        $.minStakeValue = 10 * unit;
        $.nextSpinId = 1;
        $.isOperator[initialOwner] = true;

        emit OracleSet(oracle_);
        emit RandomnessSourceSet(address(0), randomnessSource_);
        emit CardReceiverSet(cardReceiver_);
        emit EdgeBpsSet(800);
        emit ChanceRangeSet(1000, 9000);
        emit MaxTargetValueSet(5_000 * unit);
        emit MinStakeValueSet(10 * unit);
        emit OperatorSet(initialOwner, true);
    }

    /**
     * @dev One-time V2 setup, needed by every proxy: both those deployed before keep-or-recycle existed and fresh
     * deployments (initialize leaves treasury, token, window and discount unset). Without it a win gets window 0 and
     * discount 0, so recycle is unavailable and the card is only reachable through {settleExpiredKeep}. The settlement token's
     * decimals must match the oracle's price decimals, since the buyback price is an oracle-denominated value
     * paid out in that token.
     */
    function reinitializeV2(address treasury_, address settlementToken_) external reinitializer(2) onlyOwner {
        if (treasury_ == address(0) || treasury_ == address(this)) revert ZeroAddress();
        if (settlementToken_.code.length == 0) revert ZeroAddress();
        CardUpgradeStorage storage $ = _getStorage();
        _checkDecimals(settlementToken_, $.oracle);
        $.treasury = treasury_;
        $.settlementToken = IERC20(settlementToken_);
        $.recycleDiscountBps = 9000;
        $.choiceWindow = 1 days;

        emit TreasurySet(treasury_);
        emit SettlementTokenSet(settlementToken_);
        emit RecycleDiscountSet(9000);
        emit ChoiceWindowSet(1 days);
    }

    function _checkDecimals(address token, ITokenPriceOracle oracle_) private view {
        if (IERC20Metadata(token).decimals() != oracle_.priceDecimals()) revert DecimalsMismatch();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ---------- Roles ----------

    modifier onlyOperator() {
        if (!_getStorage().isOperator[msg.sender]) revert NotOperator();
        _;
    }

    function setOperator(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        _getStorage().isOperator[account] = allowed;
        emit OperatorSet(account, allowed);
    }

    function setPauser(address newPauser) external onlyOwner {
        _getStorage().pauser = newPauser;
        emit PauserUpdated(newPauser);
    }

    /**
     * @dev Pause is hot (pauser or operator); unpause is owner-only. Pause blocks {upgrade},
     * {depositPrizes}, {recycle} and {recycleMany}; settlement, rescue, keep, {settleExpiredKeep}, claim and
     * withdrawals keep working.
     */
    function pause() external {
        CardUpgradeStorage storage $ = _getStorage();
        if (msg.sender != $.pauser && !$.isOperator[msg.sender]) revert NotAuthorizedPauser();
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ---------- Configuration (owner) ----------

    function setEdgeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_EDGE_BPS) revert InvalidBps();
        _getStorage().edgeBps = bps;
        emit EdgeBpsSet(bps);
    }

    function setChanceRange(uint16 minBps, uint16 maxBps) external onlyOwner {
        if (minBps < MIN_CHANCE_FLOOR_BPS || minBps >= maxBps || maxBps > MAX_CHANCE_CEIL_BPS) {
            revert InvalidChanceRange();
        }
        CardUpgradeStorage storage $ = _getStorage();
        $.chanceMinBps = minBps;
        $.chanceMaxBps = maxBps;
        emit ChanceRangeSet(minBps, maxBps);
    }

    function setMaxTargetValue(uint256 value) external onlyOwner {
        if (value == 0) revert InvalidValue();
        _getStorage().maxTargetValue = value;
        emit MaxTargetValueSet(value);
    }

    function setMinStakeValue(uint256 value) external onlyOwner {
        _getStorage().minStakeValue = value;
        emit MinStakeValueSet(value);
    }

    /**
     * @param maxAge seconds; 0 disables the staleness check
     */
    function setMaxPriceAge(uint256 maxAge) external onlyOwner {
        _getStorage().maxPriceAge = maxAge;
        emit MaxPriceAgeSet(maxAge);
    }

    /**
     * @dev Read live at settlement, not snapshotted: it is the platform's own address and changing it
     * mid-flight cannot affect any player.
     */
    function setCardReceiver(address receiver) external onlyOwner {
        if (receiver == address(0) || receiver == address(this)) revert ZeroAddress();
        _getStorage().cardReceiver = receiver;
        emit CardReceiverSet(receiver);
    }

    /**
     * @dev Values are snapshotted per spin, so swapping the oracle never touches an in-flight spin.
     */
    function setOracle(address oracle_) external onlyOwner {
        if (oracle_.code.length == 0) revert ZeroAddress();
        CardUpgradeStorage storage $ = _getStorage();
        if (address($.settlementToken) != address(0)) {
            _checkDecimals(address($.settlementToken), ITokenPriceOracle(oracle_));
        }
        $.oracle = ITokenPriceOracle(oracle_);
        emit OracleSet(oracle_);
    }

    /**
     * @dev Where recycle payouts are drawn from; it must approve this contract for the settlement token.
     * Read live at payment time.
     */
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0) || treasury_ == address(this)) revert ZeroAddress();
        _getStorage().treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /**
     * @dev Decimals must equal the oracle's price decimals so a card value is directly a token amount.
     */
    function setSettlementToken(address token) external onlyOwner {
        if (token.code.length == 0) revert ZeroAddress();
        CardUpgradeStorage storage $ = _getStorage();
        _checkDecimals(token, $.oracle);
        $.settlementToken = IERC20(token);
        emit SettlementTokenSet(token);
    }

    /**
     * @dev Snapshotted per spin when it is won, so a change never touches a spin already awaiting choice.
     */
    function setRecycleDiscountBps(uint16 bps) external onlyOwner {
        if (bps == 0 || bps > MAX_RECYCLE_DISCOUNT_BPS) revert InvalidBps();
        _getStorage().recycleDiscountBps = bps;
        emit RecycleDiscountSet(bps);
    }

    /**
     * @dev Snapshotted per spin when it is won, as an absolute deadline.
     */
    function setChoiceWindow(uint64 window) external onlyOwner {
        if (window < MIN_CHOICE_WINDOW || window > MAX_CHOICE_WINDOW) revert InvalidDuration();
        _getStorage().choiceWindow = window;
        emit ChoiceWindowSet(window);
    }

    /**
     * @dev Only with nothing in flight (a pending request's callback must come from the source it was
     * made on) and only to a source that already lists this contract as a consumer.
     */
    function setRandomnessSource(address src) external onlyOwner {
        if (src.code.length == 0) revert ZeroAddress();
        CardUpgradeStorage storage $ = _getStorage();
        if ($.pendingSpins != 0) revert SpinsInFlight();
        if (!IRandomnessSource(src).isConsumer(address(this))) revert SourceNotConsumer(src);
        address previous = address($.randomnessSource);
        $.randomnessSource = IRandomnessSource(src);
        emit RandomnessSourceSet(previous, src);
    }

    // ---------- Prize pool (operator) ----------

    /**
     * @dev Pulls each card from the caller (the operator multisig approves this contract first).
     * Prices are not checked here: they are read at submit, so an unpriced prize simply cannot be
     * chosen as a target.
     */
    function depositPrizes(address collection, uint32[] calldata tokenIds)
        external
        onlyOperator
        whenNotPaused
        nonReentrant
    {
        CardUpgradeStorage storage $ = _getStorage();
        for (uint256 i; i < tokenIds.length; ++i) {
            uint32 id = tokenIds[i];
            if ($.prizeState[collection][id] != PrizeState.None) revert PrizeNotNone(collection, id);
            $.prizeState[collection][id] = PrizeState.Available;
            IERC721(collection).transferFrom(msg.sender, address(this), id);
            emit PrizeDeposited(collection, id);
        }
    }

    /**
     * @dev Only `Available` cards; a card reserved for an in-flight spin cannot leave. Rejects `to == address(0)`
     * or `address(this)` to prevent stranding. Works while paused.
     */
    function withdrawPrizes(address collection, uint32[] calldata tokenIds, address to)
        external
        onlyOperator
        nonReentrant
    {
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        CardUpgradeStorage storage $ = _getStorage();
        for (uint256 i; i < tokenIds.length; ++i) {
            uint32 id = tokenIds[i];
            if ($.prizeState[collection][id] != PrizeState.Available) revert PrizeNotAvailable(collection, id);
            $.prizeState[collection][id] = PrizeState.None;
            IERC721(collection).transferFrom(address(this), to, id);
            emit PrizeWithdrawn(collection, id, to);
        }
    }

    // ---------- Submit ----------

    /**
     * @dev Chance is num / den with num = stake × (BPS − edge), den = target × BPS; every bound is
     * checked by cross-multiplication so no rounding enters a decision. `chanceBps` is the floored
     * display value only.
     */
    function _evaluate(address sc, uint32 sid, address tc, uint32 tid)
        private
        view
        returns (uint256 sv, uint256 tv, uint256 chanceBps, QuoteError err)
    {
        CardUpgradeStorage storage $ = _getStorage();
        if (sc == tc && sid == tid) return (0, 0, 0, QuoteError.SameCard);
        if ($.prizeState[tc][tid] != PrizeState.Available) return (0, 0, 0, QuoteError.TargetUnavailable);

        (uint256 sPrice, uint256 sAt) = $.oracle.priceOf(sc, sid);
        (uint256 tPrice, uint256 tAt) = $.oracle.priceOf(tc, tid);
        sv = sPrice;
        tv = tPrice;
        if (sv == 0 || tv == 0) return (sv, tv, 0, QuoteError.ZeroPrice);
        uint256 maxAge = $.maxPriceAge;
        if (maxAge != 0 && (block.timestamp - sAt > maxAge || block.timestamp - tAt > maxAge)) {
            return (sv, tv, 0, QuoteError.StalePrice);
        }
        if (sv < $.minStakeValue) return (sv, tv, 0, QuoteError.StakeTooSmall);
        if (tv <= sv) return (sv, tv, 0, QuoteError.TargetNotHigher);
        if (tv > $.maxTargetValue) return (sv, tv, 0, QuoteError.TargetTooValuable);

        uint256 num = sv * (BPS - $.edgeBps);
        chanceBps = num / tv;
        if (num < uint256($.chanceMinBps) * tv || num > uint256($.chanceMaxBps) * tv) {
            return (sv, tv, chanceBps, QuoteError.ChanceOutOfRange);
        }
    }

    function quote(address stakeCollection, uint32 stakeTokenId, address targetCollection, uint32 targetTokenId)
        external
        view
        returns (uint256 stakeValue, uint256 targetValue, uint256 chanceBps, QuoteError err)
    {
        return _evaluate(stakeCollection, stakeTokenId, targetCollection, targetTokenId);
    }

    /**
     * @param minChanceBps the lowest chance the player accepts; protects against a price or edge change
     * landing between the quote and this transaction (same idea as the blind box's `draw(maxPrice)`)
     */
    function upgrade(
        address stakeCollection,
        uint32 stakeTokenId,
        address targetCollection,
        uint32 targetTokenId,
        uint16 minChanceBps
    ) external whenNotPaused nonReentrant returns (uint256 spinId) {
        (uint256 sv, uint256 tv, uint256 chanceBps, QuoteError err) =
            _evaluate(stakeCollection, stakeTokenId, targetCollection, targetTokenId);
        if (err != QuoteError.None) revert CannotUpgrade(err);
        CardUpgradeStorage storage $ = _getStorage();
        uint16 edge = $.edgeBps;
        if (sv * (BPS - edge) < uint256(minChanceBps) * tv) revert ChanceBelowMinimum();
        if (IERC721(stakeCollection).ownerOf(stakeTokenId) != msg.sender) revert NotStakeOwner();

        IERC721(stakeCollection).transferFrom(msg.sender, address(this), stakeTokenId);

        spinId = $.nextSpinId++;
        $.prizeState[targetCollection][targetTokenId] = PrizeState.Reserved;
        $.reservedFor[targetCollection][targetTokenId] = spinId;

        IRandomnessSource src = $.randomnessSource;
        uint256 requestId = src.requestRandomness();
        if ($.spinOf[address(src)][requestId] != 0) revert RequestIdInUse(address(src), requestId);
        $.spinOf[address(src)][requestId] = spinId;
        $.pendingSpins += 1;

        $.spins[spinId] = Spin({
            player: msg.sender,
            requestedAt: uint64(block.timestamp),
            status: SpinStatus.Pending,
            stakeCollection: stakeCollection,
            stakeTokenId: stakeTokenId,
            edgeBps: edge,
            chanceBps: uint16(chanceBps),
            targetCollection: targetCollection,
            targetTokenId: targetTokenId,
            source: address(src),
            requestId: requestId,
            stakeValue: sv,
            targetValue: tv
        });

        _emitRequested(spinId);
    }

    /**
     * @dev Split out of {upgrade} to stay under the stack limit; reads the stored snapshot so the event
     * can never disagree with it.
     */
    function _emitRequested(uint256 spinId) private {
        Spin storage s = _getStorage().spins[spinId];
        emit UpgradeRequested(
            spinId,
            s.player,
            s.source,
            s.requestId,
            s.stakeCollection,
            s.stakeTokenId,
            s.stakeValue,
            s.targetCollection,
            s.targetTokenId,
            s.targetValue,
            s.edgeBps,
            s.chanceBps
        );
    }

    // ---------- Settlement ----------

    /**
     * @dev The win rule, exposed so anyone can recompute a settled spin from its snapshot and the
     * UpgradeSettled random word: the player wins on exactly stakeValue × (10000 − edgeBps) of the
     * targetValue × 10000 residues, so the expected value is exactly (1 − edge) × stake.
     */
    function isWin(uint256 stakeValue, uint256 targetValue, uint16 edgeBps, uint256 randomWord)
        public
        pure
        returns (bool)
    {
        return randomWord % (targetValue * BPS) < stakeValue * (BPS - edgeBps);
    }

    /**
     * @inheritdoc IRandomnessConsumer
     * @dev Never reverts: sources do not retry. Keyed purely on (msg.sender, requestId), which only a
     * source this contract actually requested from can match, so no caller check is needed: any other
     * caller, an unknown request, an already-finished request, or a late callback from a former
     * source (after a rescue and a source switch) returns silently. All state is final before any
     * card moves.
     */
    function onRandomness(uint256 requestId, uint256 randomWord) external nonReentrant {
        CardUpgradeStorage storage $ = _getStorage();
        uint256 spinId = $.spinOf[msg.sender][requestId];
        if (spinId == 0) return;
        delete $.spinOf[msg.sender][requestId];
        Spin storage s = $.spins[spinId];
        if (s.status != SpinStatus.Pending) return;

        bool won = isWin(s.stakeValue, s.targetValue, s.edgeBps, randomWord);
        $.pendingSpins -= 1;
        if (won) {
            // The target stays Reserved for this spin until the winner chooses (or the window lapses).
            uint64 deadline = uint64(block.timestamp) + $.choiceWindow;
            uint16 discountBps = $.recycleDiscountBps;
            s.status = SpinStatus.AwaitingChoice;
            $.choices[spinId] = Choice({deadline: deadline, discountBps: discountBps});
            $.awaitingChoice += 1;
            emit UpgradeSettled(spinId, true, randomWord);
            emit ChoicePending(spinId, s.player, deadline, s.targetValue * discountBps / BPS);
        } else {
            s.status = SpinStatus.Lost;
            delete $.reservedFor[s.targetCollection][s.targetTokenId];
            $.prizeState[s.targetCollection][s.targetTokenId] = PrizeState.Available;
            emit UpgradeSettled(spinId, false, randomWord);
        }

        _sendToReceiver(s.stakeCollection, s.stakeTokenId);
    }

    // ---------- Winner's choice ----------

    /**
     * @dev Winner takes the target card. Not pausable: it only hands the player what they won.
     */
    function keep(uint256 spinId) external nonReentrant {
        CardUpgradeStorage storage $ = _getStorage();
        _requireSettleable($, spinId, msg.sender);
        _keep($, spinId);
    }

    /**
     * @dev Winner forgoes the card for `targetValue × discountBps` paid from the treasury; the card goes
     * back to the pool. A failed payment reverts the whole call and the spin stays awaiting.
     */
    function recycle(uint256 spinId) external nonReentrant whenNotPaused {
        CardUpgradeStorage storage $ = _getStorage();
        _requireSettleable($, spinId, msg.sender);
        _recycle($, spinId);
    }

    /**
     * @dev After the deadline anyone may settle; the default is keep, so the card goes to the recorded
     * player. The deadline is never extended, paused or not.
     */
    function settleExpiredKeep(uint256 spinId) external nonReentrant {
        CardUpgradeStorage storage $ = _getStorage();
        if ($.spins[spinId].status != SpinStatus.AwaitingChoice) revert NotAwaitingChoice(spinId);
        if (block.timestamp <= $.choices[spinId].deadline) revert ChoiceNotExpired(spinId);
        _keep($, spinId);
    }

    /**
     * @dev Order is fixed: {NotAwaitingChoice}, {NotWinner}, {ChoiceExpired}. Only AwaitingChoice is
     * settleable; the legacy Won status (card already sent at win time) is not.
     */
    function _requireSettleable(CardUpgradeStorage storage $, uint256 spinId, address caller) private view {
        Spin storage s = $.spins[spinId];
        if (s.status != SpinStatus.AwaitingChoice) revert NotAwaitingChoice(spinId);
        if (caller != s.player) revert NotWinner();
        if (block.timestamp > $.choices[spinId].deadline) revert ChoiceExpired(spinId);
    }

    /**
     * @dev Self-call entry point for {_settleMany}'s try/catch, which needs it to capture each item's
     * revert selector. The `msg.sender == address(this)` gate is load-bearing: this function carries no
     * reentrancy guard of its own and relies on {keepMany}/{recycleMany}'s. `caller` is forwarded
     * because the self-call changes `msg.sender`. Pause is checked by {recycleMany}, not here.
     */
    function settleOne(uint256 spinId, address caller, bool isKeep) external {
        if (msg.sender != address(this)) revert NotSelf();
        CardUpgradeStorage storage $ = _getStorage();
        _requireSettleable($, spinId, caller);
        if (isKeep) _keep($, spinId);
        else _recycle($, spinId);
    }

    /**
     * @dev All-or-nothing: any item's failure reverts the whole batch with {BatchItemFailed}.
     */
    function keepMany(uint256[] calldata spinIds) external nonReentrant {
        _settleMany(spinIds, true);
    }

    /**
     * @dev All-or-nothing like {keepMany}, and blocked while paused like {recycle}.
     */
    function recycleMany(uint256[] calldata spinIds) external nonReentrant whenNotPaused {
        _settleMany(spinIds, false);
    }

    function _settleMany(uint256[] calldata spinIds, bool isKeep) private {
        uint256 n = spinIds.length;
        if (n == 0 || n > MAX_BATCH_SETTLE) revert InvalidBatchSize(n);
        for (uint256 i; i < n; ++i) {
            try this.settleOne(spinIds[i], msg.sender, isKeep) {}
            catch (bytes memory err) {
                revert BatchItemFailed(spinIds[i], err.length >= 4 ? bytes4(err) : bytes4(0));
            }
        }
    }

    /**
     * @dev Terminal state, counter and prize state are final before the card moves.
     */
    function _keep(CardUpgradeStorage storage $, uint256 spinId) private {
        Spin storage s = $.spins[spinId];
        s.status = SpinStatus.Kept;
        $.awaitingChoice -= 1;
        delete $.reservedFor[s.targetCollection][s.targetTokenId];
        $.prizeState[s.targetCollection][s.targetTokenId] = PrizeState.None;
        emit WinKept(spinId, s.player);
        _sendToPlayer(spinId, s.player, s.targetCollection, s.targetTokenId);
    }

    /**
     * @dev Terminal state, counter and prize state are final before the treasury pays. The price uses the
     * discount snapshotted at the win.
     */
    function _recycle(CardUpgradeStorage storage $, uint256 spinId) private {
        Spin storage s = $.spins[spinId];
        s.status = SpinStatus.Recycled;
        $.awaitingChoice -= 1;
        delete $.reservedFor[s.targetCollection][s.targetTokenId];
        $.prizeState[s.targetCollection][s.targetTokenId] = PrizeState.Available;
        uint256 amount = s.targetValue * $.choices[spinId].discountBps / BPS;
        $.settlementToken.safeTransferFrom($.treasury, s.player, amount);
        emit WinRecycled(spinId, s.player, amount);
    }

    /**
     * @dev transferFrom, not safeTransferFrom: a player contract that rejects NFTs must not be able
     * to stall settlement. A failed transfer (e.g. a paused collection) becomes a claim.
     */
    function _sendToPlayer(uint256 spinId, address player, address collection, uint32 tokenId) private {
        try IERC721(collection).transferFrom(address(this), player, tokenId) {}
        catch {
            _getStorage().claimable[spinId] = Claim({collection: collection, tokenId: tokenId});
            emit CardClaimable(spinId, player, collection, tokenId);
        }
    }

    function _sendToReceiver(address collection, uint32 tokenId) private {
        CardUpgradeStorage storage $ = _getStorage();
        try IERC721(collection).transferFrom(address(this), $.cardReceiver, tokenId) {}
        catch {
            $.owedToReceiver[collection][tokenId] = true;
            emit CardOwedToReceiver(collection, tokenId);
        }
    }

    /**
     * @dev Permissionless retry of a card that could not be pushed during settlement or rescue: anyone
     * may trigger it, and the card always goes to the spin's recorded player, never to the caller.
     * Reverts if the transfer still fails, so the claim survives for a later retry.
     */
    function claim(uint256 spinId) external nonReentrant {
        CardUpgradeStorage storage $ = _getStorage();
        Claim memory c = $.claimable[spinId];
        if (c.collection == address(0)) revert NothingToClaim(spinId);
        address player = $.spins[spinId].player;
        delete $.claimable[spinId];
        IERC721(c.collection).transferFrom(address(this), player, c.tokenId);
        emit CardClaimed(spinId, player, c.collection, c.tokenId);
    }

    function flushToReceiver(address collection, uint32[] calldata tokenIds) external onlyOperator nonReentrant {
        CardUpgradeStorage storage $ = _getStorage();
        address to = $.cardReceiver;
        for (uint256 i; i < tokenIds.length; ++i) {
            uint32 id = tokenIds[i];
            if (!$.owedToReceiver[collection][id]) revert NotOwedToReceiver(collection, id);
            delete $.owedToReceiver[collection][id];
            IERC721(collection).transferFrom(address(this), to, id);
            emit CardFlushedToReceiver(collection, id, to);
        }
    }

    /**
     * @dev For a source that never calls back. Operator after 1 day, the player after 7 days (so a
     * vanished operator cannot strand a card). The request mapping is deleted first, so a late
     * callback returns silently. A rescue refunds a spin whose word may already be public (e.g. a Pyth
     * revelation nobody delivered), so a player who saw a losing word could wait for it; operations
     * therefore reveal a pending Pyth request permissionlessly (revealWithCallback) before any rescue,
     * and rescue only when no revelation can be obtained.
     */
    function rescue(uint256 spinId) external nonReentrant {
        CardUpgradeStorage storage $ = _getStorage();
        Spin storage s = $.spins[spinId];
        if (s.status != SpinStatus.Pending) revert SpinNotPending(spinId);
        uint256 elapsed = block.timestamp - s.requestedAt;
        if ($.isOperator[msg.sender]) {
            if (elapsed < OPERATOR_RESCUE_DELAY) revert RescueTooEarly(spinId);
        } else if (msg.sender == s.player) {
            if (elapsed < PLAYER_RESCUE_DELAY) revert RescueTooEarly(spinId);
        } else {
            revert NotRescuer();
        }

        delete $.spinOf[s.source][s.requestId];
        s.status = SpinStatus.Rescued;
        $.pendingSpins -= 1;
        delete $.reservedFor[s.targetCollection][s.targetTokenId];
        $.prizeState[s.targetCollection][s.targetTokenId] = PrizeState.Available;
        emit UpgradeRescued(spinId, msg.sender);

        _sendToPlayer(spinId, s.player, s.stakeCollection, s.stakeTokenId);
    }

    // ---------- Views ----------

    function oracle() external view returns (address) {
        return address(_getStorage().oracle);
    }

    function randomnessSource() external view returns (address) {
        return address(_getStorage().randomnessSource);
    }

    function cardReceiver() external view returns (address) {
        return _getStorage().cardReceiver;
    }

    function pauser() external view returns (address) {
        return _getStorage().pauser;
    }

    function edgeBps() external view returns (uint16) {
        return _getStorage().edgeBps;
    }

    function chanceRange() external view returns (uint16 minBps, uint16 maxBps) {
        CardUpgradeStorage storage $ = _getStorage();
        return ($.chanceMinBps, $.chanceMaxBps);
    }

    function maxTargetValue() external view returns (uint256) {
        return _getStorage().maxTargetValue;
    }

    function minStakeValue() external view returns (uint256) {
        return _getStorage().minStakeValue;
    }

    function maxPriceAge() external view returns (uint256) {
        return _getStorage().maxPriceAge;
    }

    function isOperator(address account) external view returns (bool) {
        return _getStorage().isOperator[account];
    }

    function pendingSpins() external view returns (uint256) {
        return _getStorage().pendingSpins;
    }

    function nextSpinId() external view returns (uint256) {
        return _getStorage().nextSpinId;
    }

    function spins(uint256 spinId) external view returns (Spin memory) {
        return _getStorage().spins[spinId];
    }

    function claimable(uint256 spinId) external view returns (address collection, uint32 tokenId) {
        Claim memory c = _getStorage().claimable[spinId];
        return (c.collection, c.tokenId);
    }

    function owedToReceiver(address collection, uint32 tokenId) external view returns (bool) {
        return _getStorage().owedToReceiver[collection][tokenId];
    }

    function treasury() external view returns (address) {
        return _getStorage().treasury;
    }

    function settlementToken() external view returns (address) {
        return address(_getStorage().settlementToken);
    }

    function recycleDiscountBps() external view returns (uint16) {
        return _getStorage().recycleDiscountBps;
    }

    function choiceWindow() external view returns (uint64) {
        return _getStorage().choiceWindow;
    }

    function awaitingChoice() external view returns (uint256) {
        return _getStorage().awaitingChoice;
    }

    /**
     * @dev `recyclePrice` is what {recycle} would pay now: the spin's target value at its snapshotted
     * discount (0 for a spin that has no choice snapshot).
     */
    function choiceOf(uint256 spinId)
        external
        view
        returns (uint64 deadline, uint16 discountBps, uint256 recyclePrice)
    {
        CardUpgradeStorage storage $ = _getStorage();
        Choice memory c = $.choices[spinId];
        return (c.deadline, c.discountBps, $.spins[spinId].targetValue * c.discountBps / BPS);
    }

    function prizeStatus(address collection, uint32 tokenId)
        external
        view
        returns (PrizeState state, uint256 reservedForSpin)
    {
        CardUpgradeStorage storage $ = _getStorage();
        return ($.prizeState[collection][tokenId], $.reservedFor[collection][tokenId]);
    }
}

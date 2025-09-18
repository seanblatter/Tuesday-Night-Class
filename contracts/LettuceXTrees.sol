// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Lettuce X Trees
 * @notice Records "Parking to Plant" Stripe sessions and manages staged donations
 *         to Trees.org using a designated stablecoin. Each recorded session
 *         accumulates a donation obligation of $0.35 (expressed in the smallest
 *         units of the configured stablecoin). Donations are paid out in $1,000
 *         batches (or more, if available) to limit the number of on-chain
 *         transfers while preserving a verifiable ledger of all sessions.
 */
contract LettuceXTrees {
    using SafeERC20 for IERC20;

    enum SessionType {
        Hourly,
        Monthly
    }

    struct Session {
        string sessionId;
        address payer;
        SessionType sessionType;
        uint256 treeCount;
        uint256 donationAmount;
        uint256 timestamp;
        bool verified;
    }

    IERC20 public immutable stableCoin;
    address public treesOrg;
    address public owner;

    uint256 public donationPerTree;
    uint256 public payoutThreshold;

    uint256 public totalTreesPlanted;
    uint256 public totalSessions;
    uint256 public totalOwedAmount;

    mapping(bytes32 => Session) private sessions;
    mapping(bytes32 => bool) private sessionRecorded;
    mapping(address => bool) public recorders;

    event SessionRecorded(
        bytes32 indexed sessionKey,
        string sessionId,
        address indexed payer,
        SessionType sessionType,
        uint256 treeCount,
        uint256 donationAmount
    );

    event SessionVerified(bytes32 indexed sessionKey, string sessionId, address verifier);
    event DonationParametersUpdated(uint256 donationPerTree, uint256 payoutThreshold);
    event RecorderUpdated(address indexed recorder, bool isAuthorized);
    event TreesOrgUpdated(address indexed previousRecipient, address indexed newRecipient);
    event DonationPayout(uint256 amount, address indexed recipient);
    event FundsDeposited(address indexed from, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyRecorder() {
        require(recorders[msg.sender], "Not authorized");
        _;
    }

    constructor(
        IERC20 _stableCoin,
        address _treesOrg,
        uint256 _donationPerTree,
        uint256 _payoutThreshold
    ) {
        require(address(_stableCoin) != address(0), "Stablecoin required");
        require(_treesOrg != address(0), "Recipient required");
        require(_donationPerTree > 0, "Donation too small");
        require(_payoutThreshold >= _donationPerTree, "Threshold too small");

        stableCoin = _stableCoin;
        treesOrg = _treesOrg;
        donationPerTree = _donationPerTree;
        payoutThreshold = _payoutThreshold;

        owner = msg.sender;
        recorders[msg.sender] = true;

        emit RecorderUpdated(msg.sender, true);
        emit DonationParametersUpdated(_donationPerTree, _payoutThreshold);
    }

    /**
     * @notice Allows the owner to authorize or revoke recorder accounts. Recorders
     *         are trusted off-chain processors (e.g., back-end Stripe integrations)
     *         that report completed transactions to the contract.
     */
    function setRecorder(address recorder, bool allowed) external onlyOwner {
        require(recorder != address(0), "Invalid recorder");
        recorders[recorder] = allowed;
        emit RecorderUpdated(recorder, allowed);
    }

    /**
     * @notice Updates the Trees.org payout recipient.
     */
    function updateTreesOrg(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "Invalid recipient");
        address previous = treesOrg;
        treesOrg = newRecipient;
        emit TreesOrgUpdated(previous, newRecipient);
    }

    /**
     * @notice Updates donation economics. Values are provided in the smallest
     *         unit of the configured stablecoin (e.g., 6 decimals for USDC,
     *         18 for DAI).
     */
    function updateDonationParameters(uint256 newDonationPerTree, uint256 newPayoutThreshold) external onlyOwner {
        require(newDonationPerTree > 0, "Donation too small");
        require(newPayoutThreshold >= newDonationPerTree, "Threshold too small");
        donationPerTree = newDonationPerTree;
        payoutThreshold = newPayoutThreshold;
        emit DonationParametersUpdated(newDonationPerTree, newPayoutThreshold);
    }

    /**
     * @notice Records a single hourly parking session and accrues the
     *         corresponding donation obligation.
     */
    function recordHourlySession(string calldata sessionId, address payer) external onlyRecorder {
        _recordSession(sessionId, payer, SessionType.Hourly, 1);
    }

    /**
     * @notice Records a monthly parking session. The number of trees planted is
     *         equal to the number of days the parker actively used the service
     *         during that month.
     */
    function recordMonthlySession(
        string calldata sessionId,
        address payer,
        uint256 daysParked
    ) external onlyRecorder {
        require(daysParked > 0 && daysParked <= 31, "Invalid day count");
        _recordSession(sessionId, payer, SessionType.Monthly, daysParked);
    }

    /**
     * @notice Marks a previously recorded session as verified. Trees.org can use
     *         this function to attest that the planted trees have been confirmed.
     */
    function verifySession(string calldata sessionId) external {
        require(msg.sender == treesOrg, "Only Trees.org");
        bytes32 key = _sessionKey(sessionId);
        require(sessionRecorded[key], "Unknown session");
        Session storage session = sessions[key];
        require(!session.verified, "Already verified");
        session.verified = true;
        emit SessionVerified(key, sessionId, msg.sender);
    }

    /**
     * @notice Deposits stablecoins that will later be disbursed to Trees.org once
     *         the $1,000 threshold has been met. Callers must approve the contract
     *         beforehand.
     */
    function depositStable(uint256 amount) external {
        require(amount > 0, "Amount required");
        stableCoin.safeTransferFrom(msg.sender, address(this), amount);
        emit FundsDeposited(msg.sender, amount);
        _attemptPayout();
    }

    /**
     * @notice Returns the recorded data for a Stripe session.
     */
    function getSession(string calldata sessionId) external view returns (Session memory) {
        bytes32 key = _sessionKey(sessionId);
        require(sessionRecorded[key], "Unknown session");
        return sessions[key];
    }

    function _recordSession(
        string calldata sessionId,
        address payer,
        SessionType sessionType,
        uint256 treeCount
    ) internal {
        require(bytes(sessionId).length > 0, "Session ID required");
        bytes32 key = _sessionKey(sessionId);
        require(!sessionRecorded[key], "Session exists");

        uint256 donationAmount = treeCount * donationPerTree;

        sessions[key] = Session({
            sessionId: sessionId,
            payer: payer,
            sessionType: sessionType,
            treeCount: treeCount,
            donationAmount: donationAmount,
            timestamp: block.timestamp,
            verified: false
        });

        sessionRecorded[key] = true;
        totalSessions += 1;
        totalTreesPlanted += treeCount;
        totalOwedAmount += donationAmount;

        emit SessionRecorded(key, sessionId, payer, sessionType, treeCount, donationAmount);

        _attemptPayout();
    }

    function _attemptPayout() internal {
        uint256 balance = stableCoin.balanceOf(address(this));
        uint256 amountToSend = totalOwedAmount;
        if (amountToSend > balance) {
            amountToSend = balance;
        }

        if (amountToSend >= payoutThreshold && treesOrg != address(0)) {
            totalOwedAmount -= amountToSend;
            stableCoin.safeTransfer(treesOrg, amountToSend);
            emit DonationPayout(amountToSend, treesOrg);
        }
    }

    function _sessionKey(string memory sessionId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(sessionId));
    }
}

// OpenZeppelin Contracts (last updated v5.0.0) (token/ERC20/IERC20.sol)
/**
 * @dev Interface of the ERC20 standard as defined in the EIP.
 */
interface IERC20 {
    function totalSupply() external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 value) external returns (bool);

    function allowance(address owner, address spender) external view returns (uint256);

    function approve(address spender, uint256 value) external returns (bool);

    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

// OpenZeppelin Contracts (last updated v5.0.0) (token/ERC20/utils/SafeERC20.sol)
/**
 * @dev Wrappers around ERC20 operations that throw on failure (when the token
 * contract returns false). Tokens that return no value (and instead revert or
 * throw on failure) are also supported, non-reverting calls are assumed to be
 * successful.
 */
library SafeERC20 {
    using Address for address;

    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(token.transfer.selector, to, value));
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(token.transferFrom.selector, from, to, value));
    }

    function _callOptionalReturn(IERC20 token, bytes memory data) private {
        bytes memory returndata = address(token).functionCall(data, "SafeERC20: call failed");
        if (returndata.length > 0) {
            require(abi.decode(returndata, (bool)), "SafeERC20: operation failed");
        }
    }
}

// OpenZeppelin Contracts (last updated v5.0.0) (utils/Address.sol)
/**
 * @dev Collection of functions related to the address type
 */
library Address {
    function functionCall(address target, bytes memory data, string memory errorMessage) internal returns (bytes memory) {
        return functionCallWithValue(target, data, 0, errorMessage);
    }

    function functionCallWithValue(
        address target,
        bytes memory data,
        uint256 value,
        string memory errorMessage
    ) internal returns (bytes memory) {
        require(address(this).balance >= value, "Address: insufficient balance");
        (bool success, bytes memory returndata) = target.call{value: value}(data);
        return verifyCallResultFromTarget(target, success, returndata, errorMessage);
    }

    function verifyCallResultFromTarget(
        address target,
        bool success,
        bytes memory returndata,
        string memory errorMessage
    ) internal view returns (bytes memory) {
        if (success) {
            if (returndata.length == 0) {
                require(isContract(target), "Address: call to non-contract");
            }
            return returndata;
        } else {
            _revert(returndata, errorMessage);
        }
    }

    function isContract(address account) internal view returns (bool) {
        return account.code.length > 0;
    }

    function _revert(bytes memory returndata, string memory errorMessage) private pure {
        if (returndata.length > 0) {
            assembly {
                let returndata_size := mload(returndata)
                revert(add(32, returndata), returndata_size)
            }
        } else {
            revert(errorMessage);
        }
    }
}

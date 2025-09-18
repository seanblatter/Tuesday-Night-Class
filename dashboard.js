(function () {
  const { ethers } = window;
  const elements = {};
  const state = {
    browserProvider: null,
    readProvider: null,
    signer: null,
    account: null,
    contract: null,
    stableCoin: null,
    stableCoinDecimals: 6,
    stableCoinSymbol: 'TOKEN',
    sessionsById: new Map(),
    fundingEvents: [],
    blockTimestampCache: new Map(),
    config: {
      contractAddress: '',
      rpcUrl: '',
      startBlock: null,
      decimalsOverride: null,
    },
  };
  let toastTimeout;

  const CONTRACT_ABI = [
    'event SessionRecorded(bytes32 indexed sessionKey, string sessionId, address indexed payer, uint8 sessionType, uint256 treeCount, uint256 donationAmount)',
    'event SessionVerified(bytes32 indexed sessionKey, string sessionId, address verifier)',
    'event DonationPayout(uint256 amount, address indexed recipient)',
    'event FundsDeposited(address indexed from, uint256 amount)',
    'function totalSessions() view returns (uint256)',
    'function totalTreesPlanted() view returns (uint256)',
    'function donationPerTree() view returns (uint256)',
    'function payoutThreshold() view returns (uint256)',
    'function totalOwedAmount() view returns (uint256)',
    'function treesOrg() view returns (address)',
    'function stableCoin() view returns (address)',
    'function getSession(string sessionId) view returns (tuple(string sessionId, address payer, uint8 sessionType, uint256 treeCount, uint256 donationAmount, uint256 timestamp, bool verified))',
    'function recordHourlySession(string sessionId, address payer)',
    'function recordMonthlySession(string sessionId, address payer, uint256 daysParked)',
    'function verifySession(string sessionId)',
    'function depositStable(uint256 amount)'
  ];

  const ERC20_ABI = [
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
  ];

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    cacheDomReferences();
    loadStoredConfig();
    updateConfigForm();
    updateContractAddressDisplay();

    if (!ethers) {
      handleMissingEthers();
      return;
    }

    attachEventListeners();

    if (state.config.contractAddress) {
      configureDashboard(null, { silent: true }).catch((error) => {
        console.warn('Auto-load skipped:', error);
      });
    }
  }

  function handleMissingEthers() {
    console.error('Ethers.js was not loaded.');

    if (elements.connectionStatus) {
      elements.connectionStatus.textContent = 'Ethers.js failed to load';
      elements.connectionStatus.classList.remove('status-connected');
      elements.connectionStatus.classList.add('status-disconnected');
    }

    if (elements.connectWalletButton) {
      elements.connectWalletButton.disabled = true;
      elements.connectWalletButton.textContent = 'Wallet unavailable';
    }

    if (elements.loadButton) {
      elements.loadButton.disabled = true;
    }

    if (elements.refreshButton) {
      elements.refreshButton.disabled = true;
    }

    showToast('Ethers.js failed to load. Check your connection and refresh the page.', 'error');
  }

  function cacheDomReferences() {
    elements.body = document.body;
    elements.connectWalletButton = document.getElementById('connect-wallet');
    elements.connectionStatus = document.getElementById('connection-status');
    elements.configForm = document.getElementById('config-form');
    elements.loadButton = document.getElementById('load-dashboard');
    elements.refreshButton = document.getElementById('refresh-dashboard');
    elements.contractAddressInput = document.getElementById('contract-address');
    elements.rpcUrlInput = document.getElementById('rpc-url');
    elements.startBlockInput = document.getElementById('start-block');
    elements.decimalsInput = document.getElementById('stablecoin-decimals');

    elements.metricTotalSessions = document.getElementById('metric-total-sessions');
    elements.metricTotalTrees = document.getElementById('metric-total-trees');
    elements.metricVerifiedSessions = document.getElementById('metric-verified-sessions');
    elements.metricVerifiedRate = document.getElementById('metric-verified-rate');
    elements.metricDonation = document.getElementById('metric-donation');
    elements.metricOwed = document.getElementById('metric-owed');
    elements.metricPayoutThreshold = document.getElementById('metric-payout-threshold');
    elements.metricContractBalance = document.getElementById('metric-contract-balance');

    elements.contractAddressDisplay = document.getElementById('contract-address-display');
    elements.treesOrgAddress = document.getElementById('trees-org-address');
    elements.stablecoinSymbol = document.getElementById('stablecoin-symbol');
    elements.stablecoinAddress = document.getElementById('stablecoin-address');
    elements.depositTokenSymbol = document.getElementById('deposit-token-symbol');

    elements.verificationSummary = document.getElementById('verification-summary');
    elements.sessionsTableBody = document.querySelector('#sessions-table tbody');
    elements.sessionsEmpty = document.getElementById('sessions-empty');

    elements.recordHourlyForm = document.getElementById('record-hourly-form');
    elements.recordMonthlyForm = document.getElementById('record-monthly-form');
    elements.verifySessionForm = document.getElementById('verify-session-form');
    elements.depositForm = document.getElementById('deposit-form');

    elements.hourlySessionId = document.getElementById('hourly-session-id');
    elements.hourlyPayer = document.getElementById('hourly-payer');
    elements.monthlySessionId = document.getElementById('monthly-session-id');
    elements.monthlyPayer = document.getElementById('monthly-payer');
    elements.monthlyDays = document.getElementById('monthly-days');
    elements.verifySessionId = document.getElementById('verify-session-id');
    elements.depositAmount = document.getElementById('deposit-amount');

    elements.fundingFeed = document.getElementById('funding-feed');
    elements.toast = document.getElementById('toast');
  }

  function attachEventListeners() {
    elements.connectWalletButton?.addEventListener('click', connectWallet);
    elements.configForm?.addEventListener('submit', (event) => {
      configureDashboard(event).catch((error) => {
        console.warn('Dashboard configuration failed:', error);
      });
    });
    elements.configForm?.addEventListener('reset', handleResetConfig);
    elements.refreshButton?.addEventListener('click', async () => {
      if (!state.contract) {
        showToast('Load the dashboard first.', 'error');
        return;
      }
      setLoading(true);
      try {
        await loadAllData();
        showToast('Dashboard refreshed.', 'success');
      } catch (error) {
        handleError(error, 'refreshing dashboard');
      } finally {
        setLoading(false);
      }
    });

    elements.recordHourlyForm?.addEventListener('submit', handleRecordHourly);
    elements.recordMonthlyForm?.addEventListener('submit', handleRecordMonthly);
    elements.verifySessionForm?.addEventListener('submit', handleVerifySession);
    elements.depositForm?.addEventListener('submit', handleDeposit);

    if (window.ethereum) {
      window.ethereum.on('accountsChanged', handleAccountsChanged);
      window.ethereum.on('chainChanged', () => {
        showToast('Network changed. Reloading data…', 'info');
        configureDashboard(null, { silent: true }).catch((error) => {
          console.warn('Reload after chain change failed:', error);
        });
      });
    }
  }
  async function connectWallet() {
    if (!ethers) {
      handleMissingEthers();
      return;
    }

    if (!window.ethereum) {
      showToast('No Ethereum wallet found. Install MetaMask or provide an RPC endpoint.', 'error');
      return;
    }

    try {
      state.browserProvider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await state.browserProvider.send('eth_requestAccounts', []);
      if (!accounts || accounts.length === 0) {
        throw new Error('No accounts authorized.');
      }
      state.account = ethers.getAddress(accounts[0]);
      state.signer = await state.browserProvider.getSigner();
      updateConnectionStatus();
      showToast('Wallet connected.', 'success');

      if (state.config.contractAddress) {
        await configureDashboard(null, { silent: true });
      }
    } catch (error) {
      handleError(error, 'connecting wallet');
    }
  }

  function updateConnectionStatus() {
    const statusEl = elements.connectionStatus;
    const button = elements.connectWalletButton;
    if (!statusEl || !button) {
      return;
    }

    if (state.account) {
      statusEl.textContent = `Connected: ${shortenAddress(state.account)}`;
      statusEl.classList.remove('status-disconnected');
      statusEl.classList.add('status-connected');
      button.textContent = 'Wallet Connected';
      button.disabled = true;
    } else {
      statusEl.textContent = 'Wallet disconnected';
      statusEl.classList.remove('status-connected');
      statusEl.classList.add('status-disconnected');
      button.textContent = 'Connect Wallet';
      button.disabled = false;
    }
  }

  async function handleAccountsChanged(accounts) {
    if (!accounts || accounts.length === 0) {
      state.account = null;
      state.signer = null;
      updateConnectionStatus();
      showToast('Wallet disconnected.', 'info');
      return;
    }

    try {
      state.account = ethers.getAddress(accounts[0]);
      if (state.browserProvider) {
        state.signer = await state.browserProvider.getSigner();
      }
      updateConnectionStatus();
      showToast('Active account updated.', 'success');
    } catch (error) {
      handleError(error, 'handling account change');
    }
  }

  async function configureDashboard(event, options = {}) {
    event?.preventDefault();
    const { silent = false } = options;

    if (!ethers) {
      if (!silent) {
        showToast('Dashboard tools are unavailable until Ethers.js loads. Refresh the page to retry.', 'error');
      }
      return Promise.reject(new Error('Ethers.js unavailable.'));
    }

    const addressInput = elements.contractAddressInput?.value?.trim() ?? '';
    const rpcUrl = elements.rpcUrlInput?.value?.trim() ?? '';
    const startBlockInput = elements.startBlockInput?.value?.trim() ?? '';
    const decimalsInput = elements.decimalsInput?.value?.trim() ?? '';

    if (!ethers.isAddress(addressInput)) {
      if (!silent) {
        showToast('Enter a valid Lettuce X Trees contract address.', 'error');
      }
      return Promise.reject(new Error('Invalid contract address.'));
    }

    state.config.contractAddress = ethers.getAddress(addressInput);
    state.config.rpcUrl = rpcUrl;

    let parsedStartBlock = null;
    if (startBlockInput !== '') {
      const numericStart = Number(startBlockInput);
      if (!Number.isFinite(numericStart) || numericStart < 0) {
        if (!silent) {
          showToast('Start block must be a positive number.', 'error');
        }
        return Promise.reject(new Error('Invalid start block.'));
      }
      parsedStartBlock = Math.floor(numericStart);
    }
    state.config.startBlock = parsedStartBlock;

    let parsedDecimals = null;
    if (decimalsInput !== '') {
      const numericDecimals = Number(decimalsInput);
      if (!Number.isFinite(numericDecimals) || numericDecimals < 0 || numericDecimals > 36) {
        if (!silent) {
          showToast('Stablecoin decimals override must be between 0 and 36.', 'error');
        }
        return Promise.reject(new Error('Invalid decimals override.'));
      }
      parsedDecimals = Math.floor(numericDecimals);
    }
    state.config.decimalsOverride = parsedDecimals;

    persistConfig();
    updateContractAddressDisplay();

    setLoading(true);
    try {
      await setupReadProvider();
      await initializeContract();
      await loadAllData();
      if (!silent) {
        showToast('Dashboard data loaded.', 'success');
      }
    } catch (error) {
      handleError(error, 'loading dashboard', { silent });
      throw error;
    } finally {
      setLoading(false);
    }
  }

  function handleResetConfig() {
    setTimeout(() => {
      state.config = {
        contractAddress: '',
        rpcUrl: '',
        startBlock: null,
        decimalsOverride: null,
      };
      persistConfig();
      clearDashboard();
      updateContractAddressDisplay();
    }, 0);
  }

  async function setupReadProvider() {
    if (state.contract) {
      try {
        state.contract.removeAllListeners();
      } catch (error) {
        console.warn('Failed to remove listeners:', error);
      }
    }

    state.contract = null;
    state.stableCoin = null;
    state.readProvider = null;

    if (state.config.rpcUrl) {
      state.readProvider = new ethers.JsonRpcProvider(state.config.rpcUrl);
    } else {
      const provider = getBrowserProvider();
      if (!provider) {
        throw new Error('Provide an RPC endpoint or connect a wallet to read on-chain data.');
      }
      state.readProvider = provider;
    }
  }

  function getBrowserProvider() {
    if (!window.ethereum) {
      return null;
    }
    if (!state.browserProvider) {
      state.browserProvider = new ethers.BrowserProvider(window.ethereum);
    }
    return state.browserProvider;
  }

  async function initializeContract() {
    if (!state.readProvider) {
      throw new Error('Provider unavailable.');
    }

    state.contract = new ethers.Contract(state.config.contractAddress, CONTRACT_ABI, state.readProvider);
    const stableCoinAddress = await state.contract.stableCoin();
    state.stableCoin = new ethers.Contract(stableCoinAddress, ERC20_ABI, state.readProvider);

    let decimals = null;
    try {
      decimals = await state.stableCoin.decimals();
    } catch (error) {
      console.warn('Stablecoin decimals unavailable, using override/default.', error);
    }
    if (decimals !== null && decimals !== undefined) {
      state.stableCoinDecimals = Number(decimals);
    } else if (state.config.decimalsOverride !== null && !Number.isNaN(state.config.decimalsOverride)) {
      state.stableCoinDecimals = Number(state.config.decimalsOverride);
    } else {
      state.stableCoinDecimals = 6;
    }

    let symbol = null;
    try {
      symbol = await state.stableCoin.symbol();
    } catch (error) {
      console.warn('Stablecoin symbol unavailable.', error);
    }
    state.stableCoinSymbol = symbol || 'TOKEN';

    elements.stablecoinSymbol.textContent = state.stableCoinSymbol;
    elements.depositTokenSymbol.textContent = state.stableCoinSymbol;
    elements.stablecoinAddress.textContent = stableCoinAddress;
    elements.stablecoinAddress.title = stableCoinAddress;

    subscribeToContractEvents();
  }

  function subscribeToContractEvents() {
    if (!state.contract) {
      return;
    }

    try {
      state.contract.removeAllListeners();
    } catch (error) {
      console.warn('Unable to clear previous listeners:', error);
    }

    state.contract.on('SessionRecorded', handleSessionRecorded);
    state.contract.on('SessionVerified', handleSessionVerified);
    state.contract.on('DonationPayout', handleDonationPayout);
    state.contract.on('FundsDeposited', handleFundsDeposited);
  }

  async function loadAllData() {
    await Promise.all([loadOverview(), loadSessions(), loadFundingEvents()]);
  }

  async function loadOverview() {
    if (!state.contract) {
      return;
    }

    const [
      totalSessions,
      totalTrees,
      donationPerTree,
      payoutThreshold,
      totalOwedAmount,
      treesOrgAddress
    ] = await Promise.all([
      state.contract.totalSessions(),
      state.contract.totalTreesPlanted(),
      state.contract.donationPerTree(),
      state.contract.payoutThreshold(),
      state.contract.totalOwedAmount(),
      state.contract.treesOrg()
    ]);

    let contractBalance = 0n;
    if (state.stableCoin && state.config.contractAddress) {
      try {
        contractBalance = await state.stableCoin.balanceOf(state.config.contractAddress);
      } catch (error) {
        console.warn('Unable to load contract balance.', error);
      }
    }

    setMetric(elements.metricTotalSessions, formatNumber(totalSessions));
    setMetric(elements.metricTotalTrees, formatNumber(totalTrees));
    setMetric(elements.metricDonation, formatCurrency(donationPerTree));
    setMetric(elements.metricOwed, formatCurrency(totalOwedAmount));
    setMetric(elements.metricPayoutThreshold, formatCurrency(payoutThreshold));
    setMetric(elements.metricContractBalance, formatCurrency(contractBalance));

    elements.treesOrgAddress.textContent = treesOrgAddress;
    elements.treesOrgAddress.title = treesOrgAddress;
    updateContractAddressDisplay();
  }

  async function loadSessions() {
    if (!state.contract || !state.readProvider) {
      return;
    }

    state.sessionsById.clear();
    const latestBlock = await state.readProvider.getBlockNumber();
    const startBlock = state.config.startBlock !== null && state.config.startBlock !== undefined
      ? Number(state.config.startBlock)
      : 0;

    const recordedEvents = await state.contract.queryFilter(
      state.contract.filters.SessionRecorded(),
      startBlock,
      latestBlock
    );

    const sessionPromises = recordedEvents.map(async (event) => {
      const sessionId = event?.args?.sessionId ?? event?.args?.[1];
      if (!sessionId) {
        return null;
      }
      try {
        const sessionDetails = await state.contract.getSession(sessionId);
        return await normalizeSession(sessionId, sessionDetails, event);
      } catch (error) {
        console.warn('Unable to load session details for', sessionId, error);
        return null;
      }
    });

    const sessions = (await Promise.all(sessionPromises)).filter(Boolean);
    sessions.forEach((session) => {
      state.sessionsById.set(session.sessionId, session);
    });

    renderSessions();
  }

  async function loadFundingEvents() {
    if (!state.contract || !state.readProvider) {
      return;
    }

    const latestBlock = await state.readProvider.getBlockNumber();
    const startBlock = state.config.startBlock !== null && state.config.startBlock !== undefined
      ? Number(state.config.startBlock)
      : 0;

    const depositEvents = await state.contract.queryFilter(
      state.contract.filters.FundsDeposited(),
      startBlock,
      latestBlock
    );
    const payoutEvents = await state.contract.queryFilter(
      state.contract.filters.DonationPayout(),
      startBlock,
      latestBlock
    );

    const combined = [];

    for (const event of depositEvents) {
      const amount = event?.args?.amount ?? event?.args?.[1];
      const from = event?.args?.from ?? event?.args?.[0];
      const blockNumber = getBlockNumber(event);
      const timestamp = await getBlockTimestamp(blockNumber);
      combined.push({
        type: 'deposit',
        amount,
        counterparty: from,
        blockNumber,
        timestamp,
        txHash: getTransactionHash(event)
      });
    }

    for (const event of payoutEvents) {
      const amount = event?.args?.amount ?? event?.args?.[0];
      const recipient = event?.args?.recipient ?? event?.args?.[1];
      const blockNumber = getBlockNumber(event);
      const timestamp = await getBlockTimestamp(blockNumber);
      combined.push({
        type: 'payout',
        amount,
        counterparty: recipient,
        blockNumber,
        timestamp,
        txHash: getTransactionHash(event)
      });
    }

    combined.sort((a, b) => {
      const timeA = a.timestamp ?? 0;
      const timeB = b.timestamp ?? 0;
      return timeB - timeA;
    });

    state.fundingEvents = combined;
    renderFundingEvents();
  }
  function renderSessions() {
    const tbody = elements.sessionsTableBody;
    if (!tbody) {
      return;
    }
    tbody.innerHTML = '';

    const sessions = Array.from(state.sessionsById.values()).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

    if (!sessions.length) {
      elements.sessionsEmpty?.classList.remove('hidden');
    } else {
      elements.sessionsEmpty?.classList.add('hidden');
      sessions.forEach((session) => {
        const row = document.createElement('tr');

        const idCell = document.createElement('td');
        const idSpan = document.createElement('span');
        idSpan.className = 'mono truncate';
        idSpan.textContent = session.sessionId;
        idSpan.title = session.sessionId;
        idCell.appendChild(idSpan);
        row.appendChild(idCell);

        const typeCell = document.createElement('td');
        typeCell.textContent = session.sessionType;
        row.appendChild(typeCell);

        const treesCell = document.createElement('td');
        treesCell.textContent = formatNumber(session.treeCount);
        row.appendChild(treesCell);

        const donationCell = document.createElement('td');
        donationCell.textContent = session.donationFormatted;
        row.appendChild(donationCell);

        const payerCell = document.createElement('td');
        const payerSpan = document.createElement('span');
        payerSpan.className = 'mono truncate';
        payerSpan.textContent = session.payer;
        payerSpan.title = session.payer;
        payerCell.appendChild(payerSpan);
        row.appendChild(payerCell);

        const timeCell = document.createElement('td');
        timeCell.textContent = session.recordedAt;
        row.appendChild(timeCell);

        const statusCell = document.createElement('td');
        const statusSpan = document.createElement('span');
        statusSpan.className = `status-pill ${session.verified ? 'verified' : 'pending'}`;
        statusSpan.textContent = session.verified ? 'Verified' : 'Awaiting';
        statusCell.appendChild(statusSpan);
        row.appendChild(statusCell);

        tbody.appendChild(row);
      });
    }

    updateVerificationMetrics(sessions);
  }

  function renderFundingEvents() {
    const list = elements.fundingFeed;
    if (!list) {
      return;
    }
    list.innerHTML = '';

    if (!state.fundingEvents.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = 'Funding deposits and payouts will appear here.';
      list.appendChild(empty);
      return;
    }

    state.fundingEvents.forEach((event) => {
      const item = document.createElement('li');
      item.className = `event-item ${event.type}`;
      if (event.txHash) {
        item.title = `Tx: ${event.txHash}`;
      }

      const title = document.createElement('div');
      title.className = 'event-title';
      title.textContent = `${capitalize(event.type)} ${formatCurrency(event.amount)}`;

      const meta = document.createElement('div');
      meta.className = 'event-meta';
      const counterpart = event.type === 'deposit' ? 'From' : 'To';
      meta.textContent = `${counterpart} ${shortenAddress(event.counterparty)} • Block ${event.blockNumber ?? '—'}`;

      const time = document.createElement('time');
      time.className = 'event-time';
      if (event.timestamp) {
        const date = new Date(Number(event.timestamp) * 1000);
        time.dateTime = date.toISOString();
        time.textContent = date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      } else {
        time.textContent = 'Timestamp unavailable';
      }

      item.appendChild(title);
      item.appendChild(meta);
      item.appendChild(time);
      list.appendChild(item);
    });
  }

  function updateVerificationMetrics(sessions) {
    const total = sessions.length;
    const verifiedCount = sessions.filter((session) => session.verified).length;
    const awaiting = total - verifiedCount;

    setMetric(elements.metricVerifiedSessions, total ? formatNumber(verifiedCount) : '0');
    if (elements.metricVerifiedRate) {
      if (total > 0) {
        const rate = ((verifiedCount / total) * 100).toFixed(1);
        elements.metricVerifiedRate.textContent = `${rate}% verified`;
      } else {
        elements.metricVerifiedRate.textContent = '';
      }
    }

    if (elements.verificationSummary) {
      if (total === 0) {
        elements.verificationSummary.textContent = 'No sessions loaded yet';
      } else {
        elements.verificationSummary.textContent = `${formatNumber(verifiedCount)} verified • ${formatNumber(awaiting)} awaiting`;
      }
    }
  }

  async function handleSessionRecorded(sessionKey, sessionId, payer, sessionType, treeCount, donationAmount, event) {
    try {
      const details = await state.contract.getSession(sessionId);
      const session = await normalizeSession(sessionId, details, event);
      state.sessionsById.set(session.sessionId, session);
      renderSessions();
      await loadOverview();
      showToast(`Session ${sessionId} recorded.`, 'success');
    } catch (error) {
      handleError(error, 'processing session record event', { silent: true });
    }
  }

  async function handleSessionVerified(sessionKey, sessionId) {
    try {
      const details = await state.contract.getSession(sessionId);
      const session = await normalizeSession(sessionId, details, null);
      state.sessionsById.set(session.sessionId, session);
      renderSessions();
      showToast(`Session ${sessionId} verified by Trees.org.`, 'success');
    } catch (error) {
      handleError(error, 'processing verification event', { silent: true });
    }
  }

  async function handleDonationPayout(amount, recipient) {
    await loadOverview();
    await loadFundingEvents();
    const recipientLabel = shortenAddress(recipient);
    showToast(`Donation payout of ${formatCurrency(amount)} to ${recipientLabel}.`, 'success');
  }

  async function handleFundsDeposited(from, amount) {
    await loadOverview();
    await loadFundingEvents();
    showToast(`Deposit of ${formatCurrency(amount)} from ${shortenAddress(from)}.`, 'success');
  }

  async function handleRecordHourly(event) {
    event.preventDefault();
    const sessionId = elements.hourlySessionId?.value?.trim();
    const payer = elements.hourlyPayer?.value?.trim();

    if (!sessionId) {
      showToast('Provide the Stripe session ID.', 'error');
      return;
    }
    if (!ethers.isAddress(payer)) {
      showToast('Enter a valid payer address.', 'error');
      return;
    }

    try {
      const contract = getWritableContract();
      const tx = await contract.recordHourlySession(sessionId, ethers.getAddress(payer));
      showToast('Submitting hourly session…', 'info');
      await tx.wait();
      showToast('Hourly session recorded.', 'success');
      event.target.reset();
    } catch (error) {
      handleError(error, 'recording hourly session');
    }
  }

  async function handleRecordMonthly(event) {
    event.preventDefault();
    const sessionId = elements.monthlySessionId?.value?.trim();
    const payer = elements.monthlyPayer?.value?.trim();
    const days = Number(elements.monthlyDays?.value);

    if (!sessionId) {
      showToast('Provide the Stripe session ID.', 'error');
      return;
    }
    if (!ethers.isAddress(payer)) {
      showToast('Enter a valid payer address.', 'error');
      return;
    }
    if (!Number.isInteger(days) || days < 1 || days > 31) {
      showToast('Days parked must be between 1 and 31.', 'error');
      return;
    }

    try {
      const contract = getWritableContract();
      const tx = await contract.recordMonthlySession(sessionId, ethers.getAddress(payer), days);
      showToast('Submitting monthly session…', 'info');
      await tx.wait();
      showToast('Monthly session recorded.', 'success');
      event.target.reset();
    } catch (error) {
      handleError(error, 'recording monthly session');
    }
  }

  async function handleVerifySession(event) {
    event.preventDefault();
    const sessionId = elements.verifySessionId?.value?.trim();
    if (!sessionId) {
      showToast('Provide the Stripe session ID to verify.', 'error');
      return;
    }

    try {
      const contract = getWritableContract();
      const tx = await contract.verifySession(sessionId);
      showToast('Submitting verification…', 'info');
      await tx.wait();
      showToast(`Verification for ${sessionId} confirmed.`, 'success');
      event.target.reset();
    } catch (error) {
      handleError(error, 'verifying session');
    }
  }

  async function handleDeposit(event) {
    event.preventDefault();
    const amountInput = elements.depositAmount?.value?.trim();
    if (!amountInput) {
      showToast('Enter a deposit amount.', 'error');
      return;
    }

    let amount;
    try {
      amount = ethers.parseUnits(amountInput, state.stableCoinDecimals);
    } catch (error) {
      showToast('Invalid deposit amount.', 'error');
      return;
    }
    if (amount <= 0n) {
      showToast('Deposit amount must be greater than zero.', 'error');
      return;
    }

    try {
      const stableCoin = getStablecoinWithSigner();
      const contract = getWritableContract();
      const allowance = await stableCoin.allowance(state.account, state.config.contractAddress);
      if (allowance < amount) {
        showToast('Approving stablecoin spend…', 'info');
        const approveTx = await stableCoin.approve(state.config.contractAddress, amount);
        await approveTx.wait();
      }
      showToast('Depositing funds…', 'info');
      const tx = await contract.depositStable(amount);
      await tx.wait();
      showToast('Stablecoin deposited.', 'success');
      event.target.reset();
      await loadOverview();
      await loadFundingEvents();
    } catch (error) {
      handleError(error, 'depositing stablecoins');
    }
  }

  function getWritableContract() {
    if (!state.contract) {
      throw new Error('Load the Lettuce X Trees contract first.');
    }
    if (!state.signer) {
      throw new Error('Connect a wallet to perform this action.');
    }
    return state.contract.connect(state.signer);
  }

  function getStablecoinWithSigner() {
    if (!state.stableCoin) {
      throw new Error('Load the Lettuce X Trees contract first.');
    }
    if (!state.signer || !state.account) {
      throw new Error('Connect a wallet to manage deposits.');
    }
    return state.stableCoin.connect(state.signer);
  }

  async function normalizeSession(sessionId, sessionDetails, event) {
    const sessionTypeRaw = Number(sessionDetails?.sessionType ?? 0);
    const treeCount = sessionDetails?.treeCount ?? 0;
    const donationAmount = sessionDetails?.donationAmount ?? 0;
    const timestamp = Number(sessionDetails?.timestamp ?? 0);

    return {
      sessionId,
      payer: sessionDetails?.payer ?? ethers.ZeroAddress,
      sessionType: sessionTypeRaw === 1 ? 'Monthly' : 'Hourly',
      treeCount: typeof treeCount === 'bigint' ? treeCount : BigInt(treeCount || 0),
      donationAmount,
      donationFormatted: formatCurrency(donationAmount),
      recordedAt: timestamp ? new Date(timestamp * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—',
      timestamp,
      verified: Boolean(sessionDetails?.verified),
      blockNumber: getBlockNumber(event),
      txHash: getTransactionHash(event),
    };
  }

  function getBlockNumber(event) {
    if (!event) {
      return null;
    }
    if (typeof event.blockNumber === 'number') {
      return event.blockNumber;
    }
    if (typeof event.blockNumber === 'bigint') {
      return Number(event.blockNumber);
    }
    if (event.log && typeof event.log.blockNumber !== 'undefined') {
      return Number(event.log.blockNumber);
    }
    return null;
  }

  function getTransactionHash(event) {
    if (!event) {
      return null;
    }
    if (event.transactionHash) {
      return event.transactionHash;
    }
    if (event.log && event.log.transactionHash) {
      return event.log.transactionHash;
    }
    return null;
  }

  async function getBlockTimestamp(blockNumber) {
    if (blockNumber === null || blockNumber === undefined) {
      return null;
    }
    const key = Number(blockNumber);
    if (state.blockTimestampCache.has(key)) {
      return state.blockTimestampCache.get(key);
    }
    try {
      const block = await state.readProvider.getBlock(blockNumber);
      const timestamp = block?.timestamp ?? null;
      state.blockTimestampCache.set(key, timestamp);
      return timestamp;
    } catch (error) {
      console.warn('Unable to fetch block timestamp:', error);
      return null;
    }
  }

  function setMetric(element, value) {
    if (element) {
      element.textContent = value ?? '—';
    }
  }

  function formatNumber(value) {
    if (value === undefined || value === null) {
      return '—';
    }
    if (typeof value === 'bigint') {
      return value.toLocaleString('en-US');
    }
    const numberValue = Number(value);
    if (Number.isNaN(numberValue)) {
      return String(value);
    }
    return numberValue.toLocaleString('en-US');
  }

  function formatCurrency(value) {
    if (value === undefined || value === null) {
      return '—';
    }
    try {
      const formatted = ethers.formatUnits(value, state.stableCoinDecimals);
      const numberValue = Number(formatted);
      if (!Number.isFinite(numberValue)) {
        return `${formatted} ${state.stableCoinSymbol}`;
      }
      return numberValue.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch (error) {
      return `${value.toString()} ${state.stableCoinSymbol}`;
    }
  }

  function shortenAddress(address) {
    if (!address) {
      return '—';
    }
    try {
      const formatted = ethers.getAddress(address);
      return `${formatted.slice(0, 6)}…${formatted.slice(-4)}`;
    } catch (error) {
      return address;
    }
  }

  function capitalize(value) {
    if (!value) {
      return '';
    }
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function showToast(message, type = 'info') {
    const toast = elements.toast;
    if (!toast) {
      return;
    }
    toast.textContent = message;
    toast.classList.remove('visible', 'success', 'error');
    if (type === 'success') {
      toast.classList.add('success');
    } else if (type === 'error') {
      toast.classList.add('error');
    }
    requestAnimationFrame(() => {
      toast.classList.add('visible');
    });
    clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => {
      toast.classList.remove('visible');
    }, 4500);
  }
  function setLoading(isLoading) {
    elements.body?.classList.toggle('loading', Boolean(isLoading));
    if (elements.loadButton) {
      elements.loadButton.disabled = Boolean(isLoading);
    }
    if (elements.refreshButton) {
      elements.refreshButton.disabled = Boolean(isLoading);
    }
  }

  function handleError(error, context, options = {}) {
    const { silent = false } = options;
    console.error(`Error ${context}:`, error);
    if (!silent) {
      showToast(`${capitalize(context)} failed: ${extractErrorMessage(error)}`, 'error');
    }
  }

  function extractErrorMessage(error) {
    if (!error) {
      return 'Unknown error';
    }
    if (typeof error === 'string') {
      return error;
    }
    if (error.error && error.error.message) {
      return error.error.message;
    }
    if (error.info && error.info.error && error.info.error.message) {
      return error.info.error.message;
    }
    if (error.data && error.data.message) {
      return error.data.message;
    }
    if (error.reason) {
      return error.reason;
    }
    if (error.message) {
      return error.message;
    }
    return 'Unknown error';
  }

  function loadStoredConfig() {
    if (typeof window === 'undefined' || !window.localStorage) {
      return;
    }
    try {
      const raw = window.localStorage.getItem('lettuceDashboardConfig');
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      state.config = {
        contractAddress: parsed.contractAddress || '',
        rpcUrl: parsed.rpcUrl || '',
        startBlock: typeof parsed.startBlock === 'number' ? parsed.startBlock : null,
        decimalsOverride: typeof parsed.decimalsOverride === 'number' ? parsed.decimalsOverride : null,
      };
    } catch (error) {
      console.warn('Unable to load stored configuration.', error);
    }
  }

  function persistConfig() {
    if (typeof window === 'undefined' || !window.localStorage) {
      return;
    }
    try {
      const payload = {
        contractAddress: state.config.contractAddress,
        rpcUrl: state.config.rpcUrl,
        startBlock: state.config.startBlock,
        decimalsOverride: state.config.decimalsOverride,
      };
      window.localStorage.setItem('lettuceDashboardConfig', JSON.stringify(payload));
    } catch (error) {
      console.warn('Unable to persist configuration.', error);
    }
  }

  function updateConfigForm() {
    if (!elements.configForm) {
      return;
    }
    if (state.config.contractAddress && elements.contractAddressInput) {
      elements.contractAddressInput.value = state.config.contractAddress;
    }
    if (state.config.rpcUrl && elements.rpcUrlInput) {
      elements.rpcUrlInput.value = state.config.rpcUrl;
    }
    if (state.config.startBlock !== null && state.config.startBlock !== undefined && elements.startBlockInput) {
      elements.startBlockInput.value = String(state.config.startBlock);
    }
    if (state.config.decimalsOverride !== null && state.config.decimalsOverride !== undefined && elements.decimalsInput) {
      elements.decimalsInput.value = String(state.config.decimalsOverride);
    }
  }

  function updateContractAddressDisplay() {
    if (elements.contractAddressDisplay) {
      if (state.config.contractAddress) {
        elements.contractAddressDisplay.textContent = state.config.contractAddress;
        elements.contractAddressDisplay.title = state.config.contractAddress;
      } else {
        elements.contractAddressDisplay.textContent = '—';
        elements.contractAddressDisplay.title = '';
      }
    }
  }

  function clearDashboard() {
    state.sessionsById.clear();
    state.fundingEvents = [];
    state.blockTimestampCache.clear();
    renderSessions();
    renderFundingEvents();

    setMetric(elements.metricTotalSessions, '—');
    setMetric(elements.metricTotalTrees, '—');
    setMetric(elements.metricDonation, '—');
    setMetric(elements.metricOwed, '—');
    setMetric(elements.metricPayoutThreshold, '—');
    setMetric(elements.metricContractBalance, '—');
    setMetric(elements.metricVerifiedSessions, '—');
    if (elements.metricVerifiedRate) {
      elements.metricVerifiedRate.textContent = '';
    }

    if (elements.verificationSummary) {
      elements.verificationSummary.textContent = 'No sessions loaded yet';
    }
    if (elements.treesOrgAddress) {
      elements.treesOrgAddress.textContent = '—';
      elements.treesOrgAddress.title = '';
    }
    if (elements.stablecoinSymbol) {
      elements.stablecoinSymbol.textContent = '—';
    }
    if (elements.stablecoinAddress) {
      elements.stablecoinAddress.textContent = '—';
      elements.stablecoinAddress.title = '';
    }
    if (elements.depositTokenSymbol) {
      elements.depositTokenSymbol.textContent = 'TOKEN';
    }
  }
})();

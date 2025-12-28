// Simple Betting Exchange Simulator (client-side only)
// Match: Arsenal vs Liverpool
// Notes:
// - All pool inputs are GLOBAL totals (not per user)
// - Live cashout and final settlement are intentionally separated

// -----------------------------
// Utilities
// -----------------------------

// Currency formatter for Nigerian Naira (₦)
const ngn = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
  maximumFractionDigits: 0
});

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function safeNumber(inputValue) {
  // Convert input string to a finite number >= 0.
  const n = Number(inputValue);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}

function safeDivide(numerator, denominator) {
  // Prevent division by zero and negative/invalid denominators.
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return numerator / denominator;
}

function fmtOdds(x) {
  // For display only; odds derived from pools.
  if (!Number.isFinite(x) || x <= 0) return "—";
  return x.toFixed(4);
}

function fmtMoney(x) {
  if (!Number.isFinite(x)) return "—";
  return ngn.format(Math.round(x));
}

// -----------------------------
// State
// -----------------------------

const EXIT_FEE = 0.03;

const state = {
  minute: 1,
  running: false,
  ended: false,
  timerId: null,
  // When true, we keep cashout outputs “live” as the global pools change.
  cashoutArmed: false,
  // Snapshot of user's entry, used for mark-to-market cashout
  cashoutEntry: null,
  // Settlement snapshot
  settlement: null
};

// -----------------------------
// DOM
// -----------------------------

const minuteEl = document.getElementById("minute");
const matchStateEl = document.getElementById("matchState");

const startBtn = document.getElementById("startBtn");
const pauseBtn = document.getElementById("pauseBtn");
const finishBtn = document.getElementById("finishBtn");

const agreePoolInput = document.getElementById("agreePool");
const disagreePoolInput = document.getElementById("disagreePool");

const totalPoolEl = document.getElementById("totalPool");
const agreeOddsEl = document.getElementById("agreeOdds");
const disagreeOddsEl = document.getElementById("disagreeOdds");

const cashoutSideSel = document.getElementById("cashoutSide");
const cashoutStakeInput = document.getElementById("cashoutStake");
const calcCashoutBtn = document.getElementById("calcCashoutBtn");
const execCashoutBtn = document.getElementById("execCashoutBtn");
const cashoutMsgEl = document.getElementById("cashoutMsg");

const cashoutValueEl = document.getElementById("cashoutValue");
const cashoutPLEl = document.getElementById("cashoutPL");
const cashoutCapEl = document.getElementById("cashoutCap");

const finalScoreEl = document.getElementById("finalScore");
const winningSideEl = document.getElementById("winningSide");
const settlementJsonEl = document.getElementById("settlementJson");

const postMatchWrap = document.getElementById("postMatch");
const finalStakeInput = document.getElementById("finalStake");
const calcFinalBtn = document.getElementById("calcFinalBtn");
const finalPayoutEl = document.getElementById("finalPayout");
const finalProfitEl = document.getElementById("finalProfit");
const finalWinningSideEl = document.getElementById("finalWinningSide");
const finalMsgEl = document.getElementById("finalMsg");

// -----------------------------
// Core calculations
// -----------------------------

function getPools() {
  const agreePool = safeNumber(agreePoolInput.value);
  const disagreePool = safeNumber(disagreePoolInput.value);
  const totalPool = agreePool + disagreePool;
  return { agreePool, disagreePool, totalPool };
}

function renderPoolsAndOdds() {
  const { agreePool, disagreePool, totalPool } = getPools();

  totalPoolEl.textContent = fmtMoney(totalPool);

  // Live implied odds (estimated)
  const agreeOdds = safeDivide(totalPool, agreePool);
  const disagreeOdds = safeDivide(totalPool, disagreePool);

  agreeOddsEl.textContent = fmtOdds(agreeOdds);
  disagreeOddsEl.textContent = fmtOdds(disagreeOdds);

  // Keep cashout output dynamic once the user has calculated it at least once.
  if (state.cashoutArmed && !state.ended) {
    renderCashout();
  }
}

function setMessage(el, text, kind) {
  // kind: "error" | "success" | undefined
  el.textContent = text || "";
  el.classList.remove("error", "success");
  if (kind) el.classList.add(kind);
}

function isLiveMatch() {
  // “LIVE” means: started and currently running, and not ended.
  return !state.ended && state.running;
}

function cashoutSideKey(side) {
  return side === "Agree" ? "AGREE" : "DISAGREE";
}

function getSidePools(side, agreePool, disagreePool) {
  const userPool = side === "Agree" ? agreePool : disagreePool;
  const oppositePool = side === "Agree" ? disagreePool : agreePool;
  return { userPool, oppositePool };
}

function getImpliedOdds(totalPool, sidePool) {
  // Matches the UI: Estimated odds = Total / Side
  return safeDivide(totalPool, sidePool);
}

function applyPools(nextAgreePool, nextDisagreePool) {
  // Keep pools as non-negative integers.
  const a = Math.floor(Math.max(0, Number(nextAgreePool) || 0));
  const b = Math.floor(Math.max(0, Number(nextDisagreePool) || 0));
  agreePoolInput.value = String(a);
  disagreePoolInput.value = String(b);
  renderPoolsAndOdds();
}

function calculateCashout(userSide, userStake, agreePool, disagreePool) {
  // EARLY CASHOUT (LIQUIDITY-CAPPED, MARK-TO-MARKET)
  //
  // Why this model:
  // - In a real exchange, you only cash out for a profit if the market price moves in your favor
  //   *after you entered*, and only if there is liquidity.
  // - The earlier simplified formula (stake × opposite/userPool) can overpay massively when a side
  //   has very little money, because it treats high odds as “free cashout value” even without any
  //   market move or counterparty.
  //
  // This implementation:
  // - Locks an "entry odds" snapshot (Total/Side) when you first calculate
  // - Computes a mark-to-market reference value:
  //     referenceValue = stake × (entryOdds / currentOdds)
  //   So if odds improve (currentOdds goes down), you profit; if odds worsen, you lose.
  // - Liquidity cap: you still cannot withdraw more than the opposite pool.

  if (!isLiveMatch()) {
    return { ok: false, reason: "Match must be LIVE (started, not paused, not ended)." };
  }

  if (!(userStake > 0)) {
    return { ok: false, reason: "Stake must be greater than 0." };
  }

  const totalPool = agreePool + disagreePool;
  const { userPool, oppositePool } = getSidePools(userSide, agreePool, disagreePool);

  // A user cannot have staked more than the total pool on that side.
  if (userStake > userPool) {
    return { ok: false, reason: "Stake cannot exceed the available pool on your selected side." };
  }

  // Need both sides to have liquidity to price the market.
  if (userPool <= 0 || oppositePool <= 0 || totalPool <= 0) {
    return { ok: false, reason: "Cashout unavailable (insufficient liquidity)." };
  }

  const currentOdds = getImpliedOdds(totalPool, userPool);
  if (currentOdds <= 0) {
    return { ok: false, reason: "Cashout unavailable (cannot compute odds)." };
  }

  // Ensure we have an entry snapshot for this side + stake.
  // We treat the first click on "Calculate Cashout" as the user's entry reference point.
  if (!state.cashoutEntry) {
    state.cashoutEntry = {
      side: userSide,
      stake: userStake,
      entryOdds: currentOdds
    };
  }

  // If the user changes side or stake, require them to re-calculate to set a new entry snapshot.
  if (state.cashoutEntry.side !== userSide || state.cashoutEntry.stake !== userStake) {
    return { ok: false, reason: "Side/stake changed. Click Calculate Cashout again to set a new entry reference." };
  }

  const entryOdds = state.cashoutEntry.entryOdds;
  if (!(entryOdds > 0)) {
    return { ok: false, reason: "Cashout unavailable (missing entry odds)." };
  }

  // Mark-to-market: profit only if odds moved in your favor.
  const referenceValue = userStake * safeDivide(entryOdds, currentOdds);

  // Liquidity cap (can't take more than what exists on the opposite side)
  const maxAvailable = oppositePool;
  const preFeeExit = Math.min(referenceValue, maxAvailable);
  const exitPayout = preFeeExit * (1 - EXIT_FEE);

  return {
    ok: true,
    side: cashoutSideKey(userSide),
    userPool,
    oppositePool,
    totalPool,
    entryOdds,
    currentOdds,
    referenceValue,
    maxAvailable,
    preFeeExit,
    exitPayout,
    profitLoss: exitPayout - userStake,
    feeCharged: preFeeExit * EXIT_FEE
  };
}

function executeCashout(userSide, userStake) {
  // EXECUTE CASHOUT (UPDATE POOLS)
  //
  // if AGREE: A -= userStake, B -= exitValue
  // if DISAGREE: B -= userStake, A -= exitValue
  // require A >= 0 and B >= 0

  const { agreePool, disagreePool } = getPools();
  const result = calculateCashout(userSide, userStake, agreePool, disagreePool);
  if (!result.ok) return result;

  let nextA = agreePool;
  let nextB = disagreePool;

  if (userSide === "Agree") {
    nextA = agreePool - userStake;
    nextB = disagreePool - result.exitPayout;
  } else {
    nextB = disagreePool - userStake;
    nextA = agreePool - result.exitPayout;
  }

  if (nextA < -1e-9 || nextB < -1e-9) {
    return { ok: false, reason: "Cashout failed: pools would go negative." };
  }

  applyPools(nextA, nextB);
  return result;
}

function renderCashout() {
  const { agreePool, disagreePool } = getPools();
  const side = cashoutSideSel.value;
  const stake = safeNumber(cashoutStakeInput.value);

  const result = calculateCashout(side, stake, agreePool, disagreePool);

  if (!result.ok) {
    cashoutValueEl.textContent = "—";
    cashoutPLEl.textContent = "—";
    cashoutCapEl.textContent = fmtMoney(side === "Agree" ? disagreePool : agreePool);
    cashoutPLEl.classList.remove("pl", "good", "bad");
    setMessage(cashoutMsgEl, result.reason, "error");
    execCashoutBtn.disabled = true;
    return;
  }

  cashoutValueEl.textContent = fmtMoney(result.exitPayout);
  cashoutCapEl.textContent = fmtMoney(result.maxAvailable);

  const plText = fmtMoney(result.profitLoss);
  cashoutPLEl.textContent = plText;
  cashoutPLEl.classList.remove("pl", "good", "bad");
  cashoutPLEl.classList.add("pl", result.profitLoss >= 0 ? "good" : "bad");

  setMessage(
    cashoutMsgEl,
    `Entry odds: ${result.entryOdds.toFixed(4)} · Current odds: ${result.currentOdds.toFixed(4)} · Reference (pre-fee): ${fmtMoney(result.preFeeExit)} · Fee: ${fmtMoney(result.feeCharged)} · Cap: ${fmtMoney(result.maxAvailable)}`,
    undefined
  );

  execCashoutBtn.disabled = false;
}

function renderMatchState() {
  minuteEl.textContent = String(state.minute);

  matchStateEl.classList.remove("live", "ended");

  if (state.ended) {
    matchStateEl.textContent = "Ended";
    matchStateEl.classList.add("badge", "ended");
  } else if (state.running) {
    matchStateEl.textContent = "Live";
    matchStateEl.classList.add("badge", "live");
  } else {
    matchStateEl.textContent = "Not started / Paused";
    matchStateEl.classList.add("badge");
  }

  startBtn.disabled = state.ended;
  pauseBtn.disabled = state.ended || !state.running;
  finishBtn.disabled = state.ended;

  // Disable cashout after match ends (live cashout is a live feature)
  cashoutSideSel.disabled = state.ended;
  cashoutStakeInput.disabled = state.ended;
  calcCashoutBtn.disabled = state.ended;
  execCashoutBtn.disabled = state.ended || !state.cashoutArmed;
}

// -----------------------------
// Match timer
// -----------------------------

function startTimer() {
  if (state.ended) return;
  if (state.running) return;

  state.running = true;
  renderMatchState();

  // Each "minute" here ticks every 1 second for a quick simulation.
  state.timerId = window.setInterval(() => {
    if (!state.running) return;
    if (state.ended) return;

    if (state.minute >= 90) {
      endMatch("timer");
      return;
    }

    state.minute += 1;
    renderMatchState();
  }, 1000);
}

function pauseTimer() {
  if (state.ended) return;
  state.running = false;
  renderMatchState();
}

function stopTimerInterval() {
  if (state.timerId != null) {
    window.clearInterval(state.timerId);
    state.timerId = null;
  }
}

// -----------------------------
// Settlement
// -----------------------------

function randomInt(min, max) {
  // inclusive
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function endMatch(reason) {
  if (state.ended) return;

  state.ended = true;
  state.running = false;
  stopTimerInterval();

  // Freeze pool inputs
  agreePoolInput.disabled = true;
  disagreePoolInput.disabled = true;

  // Generate random score (simple)
  const arsenalGoals = randomInt(0, 4);
  const liverpoolGoals = randomInt(0, 4);

  // Use an en-dash for display: "Arsenal 1 – 2 Liverpool"
  const finalScore = `Arsenal ${arsenalGoals} – ${liverpoolGoals} Liverpool`;

  // Determine winning side:
  // Liverpool win → Agree wins
  // Draw or Arsenal win → Disagree wins
  const winningSide = (liverpoolGoals > arsenalGoals) ? "Agree" : "Disagree";

  // Snapshot pools + final odds at end
  const { agreePool, disagreePool, totalPool } = getPools();
  const finalAgreeOdds = safeDivide(totalPool, agreePool);
  const finalDisagreeOdds = safeDivide(totalPool, disagreePool);

  state.settlement = {
    meta: {
      purpose: "education_and_simulation_only",
      match: "Arsenal vs Liverpool",
      endedAt: new Date().toISOString(),
      endReason: reason,
      minuteEnded: state.minute
    },
    pools: {
      agreePool,
      disagreePool,
      totalPool
    },
    estimatedOdds: {
      agree: Number.isFinite(finalAgreeOdds) ? finalAgreeOdds : 0,
      disagree: Number.isFinite(finalDisagreeOdds) ? finalDisagreeOdds : 0
    },
    result: {
      finalScore,
      arsenalGoals,
      liverpoolGoals,
      winningSide
    },
    fees: {
      exitFeeRate: EXIT_FEE
    }
  };

  finalScoreEl.textContent = finalScore;
  winningSideEl.textContent = winningSide;

  settlementJsonEl.value = JSON.stringify(state.settlement, null, 2);

  // Reveal post-match payout calculator
  postMatchWrap.classList.remove("hide");
  finalWinningSideEl.textContent = winningSide;

  renderMatchState();
}

function calcFinalPayout({ winningSide, stake, agreePool, disagreePool }) {
  // Final payout formula:
  // Final payout = stake × (1 + opposite pool / winning pool) × (1 − 0.03)
  const winningPool = winningSide === "Agree" ? agreePool : disagreePool;
  const oppositePool = winningSide === "Agree" ? disagreePool : agreePool;

  const ratio = safeDivide(oppositePool, winningPool);
  const payout = stake * (1 + ratio) * (1 - EXIT_FEE);
  return {
    winningPool,
    oppositePool,
    payout,
    netProfit: payout - stake
  };
}

function renderFinalPayout() {
  if (!state.settlement) return;

  const winningSide = state.settlement.result.winningSide;
  const stake = safeNumber(finalStakeInput.value);

  const { agreePool, disagreePool } = state.settlement.pools;
  const winningPool = winningSide === "Agree" ? agreePool : disagreePool;

  if (!(stake > 0)) {
    setMessage(finalMsgEl, "Stake must be greater than 0.", "error");
    finalPayoutEl.textContent = "—";
    finalProfitEl.textContent = "—";
    finalProfitEl.classList.remove("pl", "good", "bad");
    return;
  }

  // Prevent unrealistic/invalid stake that exceeds the total winning pool.
  // If stake <= winningPool, then the theoretical gross payout (before fee) is <= totalPool.
  if (stake > winningPool) {
    setMessage(finalMsgEl, "Stake cannot exceed the winning side pool from settlement.", "error");
    finalPayoutEl.textContent = "—";
    finalProfitEl.textContent = "—";
    finalProfitEl.classList.remove("pl", "good", "bad");
    return;
  }

  setMessage(finalMsgEl, "", undefined);

  const result = calcFinalPayout({ winningSide, stake, agreePool, disagreePool });

  finalPayoutEl.textContent = fmtMoney(result.payout);
  finalProfitEl.textContent = fmtMoney(result.netProfit);
  finalProfitEl.classList.remove("pl", "good", "bad");
  finalProfitEl.classList.add("pl", result.netProfit >= 0 ? "good" : "bad");
  finalWinningSideEl.textContent = winningSide;
}

// -----------------------------
// Events
// -----------------------------

startBtn.addEventListener("click", () => startTimer());
pauseBtn.addEventListener("click", () => pauseTimer());
finishBtn.addEventListener("click", () => endMatch("manual"));

function onPoolInputChange() {
  if (state.ended) return;

  // Keep the inputs as non-negative integers-ish.
  agreePoolInput.value = String(Math.floor(safeNumber(agreePoolInput.value)));
  disagreePoolInput.value = String(Math.floor(safeNumber(disagreePoolInput.value)));

  renderPoolsAndOdds();
}

agreePoolInput.addEventListener("input", onPoolInputChange);
disagreePoolInput.addEventListener("input", onPoolInputChange);

calcCashoutBtn.addEventListener("click", () => {
  if (state.ended) return;
  state.cashoutArmed = true; // enables dynamic updates on pool changes
  // Set or refresh entry snapshot for the current side+stake.
  // This prevents "free profit" unless odds actually move after this point.
  state.cashoutEntry = null;
  renderCashout();
});

execCashoutBtn.addEventListener("click", () => {
  if (state.ended) return;

  const side = cashoutSideSel.value;
  const stake = safeNumber(cashoutStakeInput.value);

  const result = executeCashout(side, stake);
  if (!result.ok) {
    setMessage(cashoutMsgEl, result.reason, "error");
    execCashoutBtn.disabled = true;
    return;
  }

  // After execution, show a simple receipt.
  setMessage(
    cashoutMsgEl,
    `Executed cashout: credited ${fmtMoney(result.exitPayout)} (fee ${fmtMoney(result.feeCharged)}). Pools updated.`,
    "success"
  );

  // Keep cashout “armed” so future pool changes continue to refresh the numbers.
  state.cashoutArmed = true;
  renderCashout();
});

// If user changes side/stake, we refresh the displayed cashout *only after* they have calculated once.
cashoutSideSel.addEventListener("change", () => {
  // Changing side invalidates the entry snapshot.
  state.cashoutEntry = null;
  execCashoutBtn.disabled = true;
  if (state.cashoutArmed && !state.ended) renderCashout();
});
cashoutStakeInput.addEventListener("input", () => {
  cashoutStakeInput.value = String(Math.floor(safeNumber(cashoutStakeInput.value)));
  // Changing stake invalidates the entry snapshot.
  state.cashoutEntry = null;
  execCashoutBtn.disabled = true;
  if (state.cashoutArmed && !state.ended) renderCashout();
});

calcFinalBtn.addEventListener("click", () => {
  if (!state.ended) return;
  renderFinalPayout();
});

// -----------------------------
// Init
// -----------------------------

function init() {
  // Ensure numeric inputs are in a clean state
  agreePoolInput.value = String(Math.floor(safeNumber(agreePoolInput.value)));
  disagreePoolInput.value = String(Math.floor(safeNumber(disagreePoolInput.value)));
  cashoutStakeInput.value = String(Math.floor(safeNumber(cashoutStakeInput.value)));
  finalStakeInput.value = String(Math.floor(safeNumber(finalStakeInput.value)));

  renderMatchState();
  renderPoolsAndOdds();

  // Default (pre-calc) cashout outputs are placeholders.
  cashoutValueEl.textContent = "—";
  cashoutPLEl.textContent = "—";
  cashoutCapEl.textContent = "—";
  setMessage(cashoutMsgEl, "", undefined);
  execCashoutBtn.disabled = true;

  finalScoreEl.textContent = "—";
  winningSideEl.textContent = "—";
  settlementJsonEl.value = "";
  setMessage(finalMsgEl, "", undefined);
}

init();

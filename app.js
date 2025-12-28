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

function calcCashout({ side, stake, agreePool, disagreePool }) {
  // side: "Agree" or "Disagree"
  // stake: user's initial stake
  // Formula (live): Cashout = stake × (opposite pool / user side pool) × (1 − 0.03)
  // Constraint: Never exceed available opposite pool.

  const userSidePool = side === "Agree" ? agreePool : disagreePool;
  const oppositePool = side === "Agree" ? disagreePool : agreePool;

  const ratio = safeDivide(oppositePool, userSidePool);
  const rawCashout = stake * ratio * (1 - EXIT_FEE);

  // Cap by available opposite pool (cannot withdraw more than exists on the other side).
  const cappedCashout = clampNumber(rawCashout, 0, oppositePool);

  return {
    userSidePool,
    oppositePool,
    rawCashout,
    cashout: cappedCashout,
    profitLoss: cappedCashout - stake
  };
}

function renderCashout() {
  const { agreePool, disagreePool } = getPools();
  const side = cashoutSideSel.value;
  const stake = safeNumber(cashoutStakeInput.value);

  const result = calcCashout({ side, stake, agreePool, disagreePool });

  cashoutValueEl.textContent = fmtMoney(result.cashout);
  cashoutCapEl.textContent = fmtMoney(result.oppositePool);

  const plText = (Number.isFinite(result.profitLoss)) ? fmtMoney(result.profitLoss) : "—";
  cashoutPLEl.textContent = plText;
  cashoutPLEl.classList.remove("pl", "good", "bad");
  cashoutPLEl.classList.add("pl", result.profitLoss >= 0 ? "good" : "bad");
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
  renderCashout();
});

// If user changes side/stake, we refresh the displayed cashout *only after* they have calculated once.
cashoutSideSel.addEventListener("change", () => {
  if (state.cashoutArmed && !state.ended) renderCashout();
});
cashoutStakeInput.addEventListener("input", () => {
  cashoutStakeInput.value = String(Math.floor(safeNumber(cashoutStakeInput.value)));
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

  finalScoreEl.textContent = "—";
  winningSideEl.textContent = "—";
  settlementJsonEl.value = "";
}

init();

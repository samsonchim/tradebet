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

const arsenalPoolInput = document.getElementById("arsenalPool");
const liverpoolPoolInput = document.getElementById("liverpoolPool");

const totalPoolEl = document.getElementById("totalPool");
const arsenalOddsEl = document.getElementById("arsenalOdds");
const liverpoolOddsEl = document.getElementById("liverpoolOdds");

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
  const arsenalPool = safeNumber(arsenalPoolInput.value);
  const liverpoolPool = safeNumber(liverpoolPoolInput.value);
  const totalPool = arsenalPool + liverpoolPool;
  return { arsenalPool, liverpoolPool, totalPool };
}

function renderPoolsAndOdds() {
  const { arsenalPool, liverpoolPool, totalPool } = getPools();

  totalPoolEl.textContent = fmtMoney(totalPool);

  // Live implied odds (estimated)
  const arsenalOdds = safeDivide(totalPool, arsenalPool);
  const liverpoolOdds = safeDivide(totalPool, liverpoolPool);

  arsenalOddsEl.textContent = fmtOdds(arsenalOdds);
  liverpoolOddsEl.textContent = fmtOdds(liverpoolOdds);
}

function setMessage(el, text, kind) {
  // kind: "error" | "success" | undefined
  el.textContent = text || "";
  el.classList.remove("error", "success");
  if (kind) el.classList.add(kind);
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
  arsenalPoolInput.disabled = true;
  liverpoolPoolInput.disabled = true;

  // Generate random score (simple)
  const arsenalGoals = randomInt(0, 4);
  const liverpoolGoals = randomInt(0, 4);

  // Use an en-dash for display: "Arsenal 1 – 2 Liverpool"
  const finalScore = `Arsenal ${arsenalGoals} – ${liverpoolGoals} Liverpool`;

  // Market: Who will score first? Arsenal or Liverpool
  // If 0–0, the market is void.
  let winningSide = "No goal";
  if (arsenalGoals + liverpoolGoals > 0) {
    if (arsenalGoals === 0) winningSide = "Liverpool";
    else if (liverpoolGoals === 0) winningSide = "Arsenal";
    else winningSide = Math.random() < 0.5 ? "Arsenal" : "Liverpool";
  }

  // Snapshot pools + final odds at end
  const { arsenalPool, liverpoolPool, totalPool } = getPools();
  const finalArsenalOdds = safeDivide(totalPool, arsenalPool);
  const finalLiverpoolOdds = safeDivide(totalPool, liverpoolPool);

  state.settlement = {
    meta: {
      purpose: "education_and_simulation_only",
      match: "Arsenal vs Liverpool",
      endedAt: new Date().toISOString(),
      endReason: reason,
      minuteEnded: state.minute
    },
    pools: {
      arsenalPool,
      liverpoolPool,
      totalPool
    },
    estimatedOdds: {
      arsenal: Number.isFinite(finalArsenalOdds) ? finalArsenalOdds : 0,
      liverpool: Number.isFinite(finalLiverpoolOdds) ? finalLiverpoolOdds : 0
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

  // If the match ended 0–0, treat as void (refund = stake).
  // Keep the calculator available but adjust messaging.
  if (winningSide === "No goal") {
    setMessage(finalMsgEl, "No goal (0–0). Market void: payout is a refund (stake returned).", "success");
  } else {
    setMessage(finalMsgEl, "", undefined);
  }

  renderMatchState();
}

function calcFinalPayout({ winningSide, stake, arsenalPool, liverpoolPool }) {
  // Final payout formula:
  // Final payout = stake × (1 + opposite pool / winning pool) × (1 − 0.03)
  if (winningSide === "No goal") {
    return {
      winningPool: 0,
      oppositePool: 0,
      payout: stake,
      netProfit: 0
    };
  }

  const winningPool = winningSide === "Arsenal" ? arsenalPool : liverpoolPool;
  const oppositePool = winningSide === "Arsenal" ? liverpoolPool : arsenalPool;

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

  const { arsenalPool, liverpoolPool } = state.settlement.pools;
  const winningPool = winningSide === "Arsenal" ? arsenalPool : liverpoolPool;

  if (!(stake > 0)) {
    setMessage(finalMsgEl, "Stake must be greater than 0.", "error");
    finalPayoutEl.textContent = "—";
    finalProfitEl.textContent = "—";
    finalProfitEl.classList.remove("pl", "good", "bad");
    return;
  }

  // For the void market (0–0), payout is refund = stake.
  if (winningSide !== "No goal") {
    // Prevent unrealistic/invalid stake that exceeds the total winning pool.
    // If stake <= winningPool, then the theoretical gross payout (before fee) is <= totalPool.
    if (stake > winningPool) {
      setMessage(finalMsgEl, "Stake cannot exceed the winning side pool from settlement.", "error");
      finalPayoutEl.textContent = "—";
      finalProfitEl.textContent = "—";
      finalProfitEl.classList.remove("pl", "good", "bad");
      return;
    }
  }

  setMessage(finalMsgEl, "", undefined);

  const result = calcFinalPayout({ winningSide, stake, arsenalPool, liverpoolPool });

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
  arsenalPoolInput.value = String(Math.floor(safeNumber(arsenalPoolInput.value)));
  liverpoolPoolInput.value = String(Math.floor(safeNumber(liverpoolPoolInput.value)));

  renderPoolsAndOdds();
}

arsenalPoolInput.addEventListener("input", onPoolInputChange);
liverpoolPoolInput.addEventListener("input", onPoolInputChange);

calcFinalBtn.addEventListener("click", () => {
  if (!state.ended) return;
  renderFinalPayout();
});

// -----------------------------
// Init
// -----------------------------

function init() {
  // Ensure numeric inputs are in a clean state
  arsenalPoolInput.value = String(Math.floor(safeNumber(arsenalPoolInput.value)));
  liverpoolPoolInput.value = String(Math.floor(safeNumber(liverpoolPoolInput.value)));
  finalStakeInput.value = String(Math.floor(safeNumber(finalStakeInput.value)));

  renderMatchState();
  renderPoolsAndOdds();

  finalScoreEl.textContent = "—";
  winningSideEl.textContent = "—";
  settlementJsonEl.value = "";
  setMessage(finalMsgEl, "", undefined);
}

init();

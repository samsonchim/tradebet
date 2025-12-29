// Simple Betting Exchange Simulator (client-side only)
// Match: Arsenal vs Liverpool
// Notes:
// - All pool inputs are GLOBAL totals (not per user)
// - Post-match payout can be "withdrawn" to watch pools reduce

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
  settlement: null,
  // Stores the last computed final payout so we can execute a withdraw step.
  lastFinalCalc: null
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
const withdrawFinalBtn = document.getElementById("withdrawFinalBtn");
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
  // Always show current pool totals (so withdrawals visibly reduce liquidity)
  const { arsenalPool, liverpoolPool, totalPool } = getPools();
  totalPoolEl.textContent = fmtMoney(totalPool);

  // After match ends, odds should be fixed (locked to settlement snapshot),
  // even if pools are being reduced by withdrawals.
  const oddsSource = (state.ended && state.settlement)
    ? state.settlement.pools
    : { arsenalPool, liverpoolPool, totalPool };

  const arsenalOdds = safeDivide(oddsSource.totalPool, oddsSource.arsenalPool);
  const liverpoolOdds = safeDivide(oddsSource.totalPool, oddsSource.liverpoolPool);

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

  // Final withdraw is only available after settlement AND after a successful calculation.
  if (withdrawFinalBtn) {
    withdrawFinalBtn.disabled = !state.ended || !state.lastFinalCalc || !state.lastFinalCalc.ok;
  }
}

function applyPools(nextArsenalPool, nextLiverpoolPool) {
  const a = Math.floor(Math.max(0, Number(nextArsenalPool) || 0));
  const b = Math.floor(Math.max(0, Number(nextLiverpoolPool) || 0));
  arsenalPoolInput.value = String(a);
  liverpoolPoolInput.value = String(b);
  renderPoolsAndOdds();
}

function withdrawFinalPayout() {
  if (!state.ended || !state.settlement) return { ok: false, reason: "Match must be ended to withdraw." };
  if (!state.lastFinalCalc || !state.lastFinalCalc.ok) return { ok: false, reason: "Calculate final payout first." };

  const { payout, stake, winningSide } = state.lastFinalCalc;
  if (winningSide === "No goal") {
    return { ok: false, reason: "No goal (0–0). Market void: no winner withdrawal is applied." };
  }

  // Current pools (these will be reduced as withdrawals happen)
  const { arsenalPool, liverpoolPool } = getPools();
  const currentWinningPool = winningSide === "Arsenal" ? arsenalPool : liverpoolPool;
  const currentLosingPool = winningSide === "Arsenal" ? liverpoolPool : arsenalPool;

  // Withdrawal rules (as requested):
  // - Total pool reduces by payout.
  // - Winning side pool reduces by the user's stake.
  // - Losing side pool reduces by (payout - stake) i.e. the profit part.
  // - If winning side pool hits 0, no more withdrawals.
  if (!(currentWinningPool > 0)) {
    return { ok: false, reason: "Winning side pool is ₦0. No more winner withdrawals remain." };
  }
  if (stake > currentWinningPool) {
    return { ok: false, reason: "Stake cannot exceed the remaining winning side pool." };
  }

  const profitPart = payout - stake;
  if (profitPart > currentLosingPool + 1e-9) {
    return { ok: false, reason: "Insufficient losing pool to pay the profit part of this withdrawal." };
  }

  let nextArsenal = arsenalPool;
  let nextLiverpool = liverpoolPool;
  if (winningSide === "Arsenal") {
    nextArsenal = arsenalPool - stake;
    nextLiverpool = liverpoolPool - profitPart;
  } else {
    nextLiverpool = liverpoolPool - stake;
    nextArsenal = arsenalPool - profitPart;
  }

  if (nextArsenal < -1e-9 || nextLiverpool < -1e-9) {
    return { ok: false, reason: "Withdrawal would make pools negative." };
  }

  applyPools(nextArsenal, nextLiverpool);

  // Require a new calculation for the next withdrawal (pools changed).
  state.lastFinalCalc = null;
  renderMatchState();

  return {
    ok: true,
    stake,
    payout,
    winningSide,
    profitPart
  };
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
      grossPayout: stake,
      fee: 0,
      payout: stake,
      netProfit: 0
    };
  }

  const winningPool = winningSide === "Arsenal" ? arsenalPool : liverpoolPool;
  const oppositePool = winningSide === "Arsenal" ? liverpoolPool : arsenalPool;

  const ratio = safeDivide(oppositePool, winningPool);
  const grossPayout = stake * (1 + ratio);
  const fee = grossPayout * EXIT_FEE;
  const payout = grossPayout - fee;
  return {
    winningPool,
    oppositePool,
    grossPayout,
    fee,
    payout,
    netProfit: payout - stake
  };
}

function renderFinalPayout() {
  if (!state.settlement) return;

  const winningSide = state.settlement.result.winningSide;
  const stake = safeNumber(finalStakeInput.value);

  // Payout odds are fixed at settlement.
  const { arsenalPool: settleArsenal, liverpoolPool: settleLiverpool } = state.settlement.pools;

  // But available "remaining" stakes come from current pools (after prior withdrawals).
  const { arsenalPool: currentArsenal, liverpoolPool: currentLiverpool } = getPools();
  const remainingWinningPool = winningSide === "Arsenal" ? currentArsenal : currentLiverpool;

  if (!(stake > 0)) {
    setMessage(finalMsgEl, "Stake must be greater than 0.", "error");
    finalPayoutEl.textContent = "—";
    finalProfitEl.textContent = "—";
    finalProfitEl.classList.remove("pl", "good", "bad");
    state.lastFinalCalc = null;
    renderMatchState();
    return;
  }

  // For the void market (0–0), payout is refund = stake.
  if (winningSide !== "No goal") {
    // Prevent unrealistic/invalid stake that exceeds the total winning pool.
    if (stake > remainingWinningPool) {
      setMessage(finalMsgEl, "Stake cannot exceed the remaining winning side pool.", "error");
      finalPayoutEl.textContent = "—";
      finalProfitEl.textContent = "—";
      finalProfitEl.classList.remove("pl", "good", "bad");
      state.lastFinalCalc = null;
      renderMatchState();
      return;
    }
  }

  setMessage(finalMsgEl, "", undefined);

  const result = calcFinalPayout({ winningSide, stake, arsenalPool: settleArsenal, liverpoolPool: settleLiverpool });

  finalPayoutEl.textContent = fmtMoney(result.payout);
  finalProfitEl.textContent = fmtMoney(result.netProfit);
  finalProfitEl.classList.remove("pl", "good", "bad");
  finalProfitEl.classList.add("pl", result.netProfit >= 0 ? "good" : "bad");
  finalWinningSideEl.textContent = winningSide;

  state.lastFinalCalc = {
    ok: true,
    winningSide,
    stake,
    payout: result.payout
  };
  renderMatchState();
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

withdrawFinalBtn.addEventListener("click", () => {
  const res = withdrawFinalPayout();
  if (!res.ok) {
    setMessage(finalMsgEl, res.reason, "error");
    return;
  }

  setMessage(
    finalMsgEl,
    `Withdrawn ${fmtMoney(res.payout)} for ${res.winningSide}. Winning pool -${fmtMoney(res.stake)} (stake). Losing pool -${fmtMoney(res.profitPart)} (profit). Pools updated.`,
    "success"
  );
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
  state.lastFinalCalc = null;
}

init();

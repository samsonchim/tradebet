// Liquidity-Based Crash Simulator (browser-only demo)
// Core idea: Liquidity is player-funded. All stakes go into a shared liquidity pool.
// Cashouts are paid from remaining liquidity.
// Crash immediately when currentMultiplier > liquidity / maxActiveStake.
// (Interpretation: the pool only needs to be able to pay at least ONE player;
// we enforce that it can pay the highest staker.)

// Currency formatting (₦)
const ngn = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
  maximumFractionDigits: 0
});

// Simulation settings
// Liquidity is player-funded: it starts at ₦0 and increases only when players add stakes.
// Cashouts are paid from remaining liquidity.
const INITIAL_LIQUIDITY = 0;
const START_MULTIPLIER = 0.50;
const MULTIPLIER_STEP = 0.02;
// Slower ticks so you have time to interact before it reaches ~1.00x.
const TICK_MS = 1200;
const COUNTDOWN_SECONDS = 10;

// Data structures (as required)
/** @type {Array<{id:number, stake:number, entryMultiplier:number, currentPayout:number, status:"active"|"cashed_out"|"lost"}>} */
let playersActive = [];
/** @type {Array<{id:number, stake:number, entryMultiplier:number, currentPayout:number, status:"cashed_out"|"lost", cashoutMultiplier:number, finalPayout:number}>} */
let playersCashedOut = [];

// Game state
const state = {
  phase: "idle", // "idle" | "countdown" | "flying" | "crashed"
  nextPlayerId: 1,
  liquidity: INITIAL_LIQUIDITY,
  reserve: 0,
  multiplier: START_MULTIPLIER,
  timerId: null,
  countdownId: null,
  countdown: COUNTDOWN_SECONDS
};

// DOM
const liquidityEl = document.getElementById("liquidityRemaining");
const multiplierEl = document.getElementById("multiplier");
const statusEl = document.getElementById("gameStatus");
const crashBannerEl = document.getElementById("crashBanner");
const crashAtEl = document.getElementById("crashAt");

const startBtn = document.getElementById("startBtn");
const restartBtn = document.getElementById("restartBtn");
const resetLiquidityBtn = document.getElementById("resetLiquidityBtn");

const countdownMsgEl = document.getElementById("countdownMsg");

const stakeInput = document.getElementById("stakeInput");
const addStakeBtn = document.getElementById("addStakeBtn");
const stakeMsgEl = document.getElementById("stakeMsg");

const activeStakeEl = document.getElementById("activeStake");
const activeCountEl = document.getElementById("activeCount");
const activeTableEl = document.getElementById("activeTable");
const activeMsgEl = document.getElementById("activeMsg");

const cashedTableEl = document.getElementById("cashedTable");

// Helpers
function safeNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}

function fmtMoney(x) {
  if (!Number.isFinite(x)) return "—";
  return ngn.format(Math.round(x));
}

function setMsg(el, text, kind) {
  el.textContent = text || "";
  el.classList.remove("error", "success");
  if (kind) el.classList.add(kind);
}

function activeStakeSum() {
  return playersActive.reduce((sum, p) => sum + p.stake, 0);
}

function maxRequiredPayout() {
  let m = 0;
  for (const p of playersActive) m = Math.max(m, p.stake * p.entryMultiplier);
  return m;
}

function setPhase(phase) {
  state.phase = phase;

  statusEl.classList.remove("live", "crashed", "countdown");
  if (phase === "flying") {
    statusEl.textContent = "Flying";
    statusEl.classList.add("status", "live");
  } else if (phase === "countdown") {
    statusEl.textContent = "Countdown";
    statusEl.classList.add("status", "countdown");
  } else if (phase === "crashed") {
    statusEl.textContent = "Crashed";
    statusEl.classList.add("status", "crashed");
  } else {
    statusEl.textContent = "Waiting";
    statusEl.classList.add("status");
  }

  // Disable actions based on phase
  startBtn.disabled = (phase !== "idle");
  // You can add stake before flight (idle/countdown) and during flight.
  addStakeBtn.disabled = (phase === "crashed");
}

function renderHeader() {
  liquidityEl.textContent = fmtMoney(state.liquidity);
  multiplierEl.textContent = state.multiplier.toFixed(2);

  const activeStake = activeStakeSum();
  activeStakeEl.textContent = fmtMoney(activeStake);
  activeCountEl.textContent = String(playersActive.length);
}

function renderTables() {
  // Active
  activeTableEl.innerHTML = "";
  if (playersActive.length === 0) {
    activeTableEl.innerHTML = "<tr><td colspan=\"5\" style=\"color: var(--muted);\">No active players</td></tr>";
  } else {
    for (const p of playersActive) {
      const payout = p.stake * p.entryMultiplier;
      p.currentPayout = payout;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>User ${p.id}</td>
        <td>${fmtMoney(p.stake)}</td>
        <td>${p.entryMultiplier.toFixed(2)}x</td>
        <td>${fmtMoney(p.currentPayout)}</td>
        <td class="actions"></td>
      `;

      const btn = document.createElement("button");
      btn.textContent = "Cash Out";
      btn.type = "button";
      btn.disabled = (state.phase !== "flying");
      btn.addEventListener("click", () => cashOutPlayer(p.id));

      tr.querySelector("td.actions").appendChild(btn);
      activeTableEl.appendChild(tr);
    }
  }

  // Cashed out
  cashedTableEl.innerHTML = "";
  if (playersCashedOut.length === 0) {
    cashedTableEl.innerHTML = "<tr><td colspan=\"4\" style=\"color: var(--muted);\">No cashed-out players yet</td></tr>";
  } else {
    for (const p of playersCashedOut) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>User ${p.id}</td>
        <td>${fmtMoney(p.stake)}</td>
        <td>${p.status === "lost" ? "—" : p.cashoutMultiplier.toFixed(2) + "x"}</td>
        <td>${p.status === "lost" ? "<span class=\"lost\">LOST</span>" : fmtMoney(p.finalPayout)}</td>
      `;
      cashedTableEl.appendChild(tr);
    }
  }
}

function clearIntervals() {
  if (state.timerId != null) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  if (state.countdownId != null) {
    clearInterval(state.countdownId);
    state.countdownId = null;
  }
}

// -----------------------------
// Core crash logic (VERY IMPORTANT)
// -----------------------------

function shouldCrashNow() {
  const needed = maxRequiredPayout();
  if (!(needed > 0)) return false;
  // Crash when max(stake × playerMultiplier) > liquidity
  return needed > state.liquidity;
}

function crash() {
  // Reserve whatever liquidity is left at the moment of crash,
  // so the next game can start with this carry-over amount.
  state.reserve = state.liquidity;

  setPhase("crashed");
  clearIntervals();

  crashBannerEl.style.display = "inline-flex";
  crashAtEl.textContent = state.multiplier.toFixed(2) + "x";

  // Mark all remaining active players as lost
  for (const p of playersActive) {
    playersCashedOut.unshift({
      id: p.id,
      stake: p.stake,
      entryMultiplier: p.entryMultiplier,
      currentPayout: p.currentPayout,
      status: "lost",
      cashoutMultiplier: p.entryMultiplier,
      finalPayout: 0
    });
  }
  playersActive = [];

  setMsg(activeMsgEl, `CRASHED at ${state.multiplier.toFixed(2)}x. Remaining active players lost.`, "error");
  renderAll();
}

// -----------------------------
// Game flow
// -----------------------------

function startCountdown() {
  if (state.phase !== "idle") return;

  setMsg(stakeMsgEl, "", undefined);
  setMsg(activeMsgEl, "", undefined);

  crashBannerEl.style.display = "none";
  crashAtEl.textContent = "—";

  // Ensure multiplier is reset for countdown/flight.
  state.multiplier = START_MULTIPLIER;

  setPhase("countdown");
  state.countdown = COUNTDOWN_SECONDS;
  setMsg(countdownMsgEl, `Countdown: ${state.countdown} → 0`, "success");
  renderAll();

  state.countdownId = setInterval(() => {
    state.countdown -= 1;
    setMsg(countdownMsgEl, `Countdown: ${Math.max(0, state.countdown)} → 0`, "success");

    if (state.countdown <= 0) {
      clearInterval(state.countdownId);
      state.countdownId = null;
      beginFlight();
    }
  }, 1000);
}

function beginFlight() {
  setPhase("flying");
  state.multiplier = START_MULTIPLIER;

  // Important clarification for this simplified liquidity model:
  // We only require the pool to be able to pay the *largest* staker at the current multiplier.
  // So the game can continue even if it can't cover paying everyone at once.
  setMsg(
    countdownMsgEl,
    "Plane is flying. Each player starts at 0.50x when they join. Crash happens when liquidity can’t pay the highest required payout (stake × player multiplier).",
    undefined
  );

  state.timerId = setInterval(() => {
    // Increase gradually: 0.50, 0.52, 0.54, ...
    state.multiplier = Number((state.multiplier + MULTIPLIER_STEP).toFixed(2));

    // Per-player multiplier counts from scratch (0.50x at join) and ticks upward.
    for (const p of playersActive) {
      p.entryMultiplier = Number((p.entryMultiplier + MULTIPLIER_STEP).toFixed(2));
    }

    // If the current multiplier can no longer pay all active players, crash immediately.
    if (shouldCrashNow()) {
      crash();
      return;
    }

    renderAll();
  }, TICK_MS);

  renderAll();
}

// -----------------------------
// Staking & cashout
// -----------------------------

function addStake() {
  // Allow staking before flight (idle/countdown) and during flight.
  if (state.phase === "crashed") return;

  const stake = Math.floor(safeNumber(stakeInput.value));
  stakeInput.value = String(stake);

  if (!(stake > 0)) {
    setMsg(stakeMsgEl, "Stake must be greater than 0.", "error");
    return;
  }

  // Player-funded liquidity: every new stake increases the shared liquidity pool.
  state.liquidity += stake;

  const player = {
    id: state.nextPlayerId++,
    stake,
    // Per-player multiplier starts from scratch at 0.50x when they join.
    entryMultiplier: START_MULTIPLIER,
    currentPayout: stake * START_MULTIPLIER,
    status: "active"
  };

  // Most recent stakes should appear at the top.
  playersActive.unshift(player);
  setMsg(stakeMsgEl, `Added User ${player.id} with stake ${fmtMoney(stake)}.`, "success");

  // If already flying, adding stake can instantly make crash condition true.
  if (state.phase === "flying" && shouldCrashNow()) {
    crash();
    return;
  }

  renderAll();
}

function cashOutPlayer(playerId) {
  if (state.phase !== "flying") return;

  const idx = playersActive.findIndex(p => p.id === playerId);
  if (idx === -1) return;

  const p = playersActive[idx];
  const payout = p.stake * p.entryMultiplier;

  // Safety: if payout exceeds remaining liquidity, crash immediately.
  // (Normally the crash rule prevents this, but float rounding could cause edge cases.)
  if (payout > state.liquidity) {
    crash();
    return;
  }

  // Remove from active players
  playersActive.splice(idx, 1);

  // Deduct payout from remaining liquidity
  state.liquidity = Math.max(0, state.liquidity - payout);

  // Move to cashed-out section
  playersCashedOut.unshift({
    id: p.id,
    stake: p.stake,
    entryMultiplier: p.entryMultiplier,
    currentPayout: payout,
    status: "cashed_out",
    cashoutMultiplier: p.entryMultiplier,
    finalPayout: payout
  });

  setMsg(activeMsgEl, `User ${p.id} cashed out at ${p.entryMultiplier.toFixed(2)}x for ${fmtMoney(payout)}.`, "success");

  // After liquidity changes, crash might happen on the next tick; also check immediately.
  if (shouldCrashNow()) {
    crash();
    return;
  }

  renderAll();
}

// -----------------------------
// Reset / restart
// -----------------------------

function restartGame() {
  clearIntervals();

  playersActive = [];
  playersCashedOut = [];

  state.nextPlayerId = 1;
  // Carry-over: start the new game with the reserved liquidity from the last crash.
  state.liquidity = state.reserve;
  state.multiplier = START_MULTIPLIER;

  crashBannerEl.style.display = "none";
  crashAtEl.textContent = "—";

  setMsg(countdownMsgEl, "", undefined);
  setMsg(stakeMsgEl, "", undefined);
  setMsg(activeMsgEl, "", undefined);

  setPhase("idle");
  renderAll();
}

// -----------------------------
// Render
// -----------------------------

function renderAll() {
  renderHeader();
  renderTables();
}

// Events
startBtn.addEventListener("click", startCountdown);
restartBtn.addEventListener("click", restartGame);
addStakeBtn.addEventListener("click", addStake);
resetLiquidityBtn.addEventListener("click", () => {
  state.liquidity = 0;
  state.reserve = 0;
  setMsg(countdownMsgEl, "Liquidity reset to ₦0.", "success");

  if (state.phase === "flying" && shouldCrashNow()) {
    crash();
    return;
  }

  renderAll();
});
stakeInput.addEventListener("input", () => {
  stakeInput.value = String(Math.floor(safeNumber(stakeInput.value)));
});

// Init
restartGame();

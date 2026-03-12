/* ============================================================
   Math Drill — app.js
   Pomodoro 25min work / 5min break, 4 operations, streak system
   ============================================================ */

'use strict';

// ── DOM refs ──────────────────────────────────────────────────
const timerLabel      = document.getElementById('timer-label');
const timerDisplay    = document.getElementById('timer-display');
const timerBar        = document.getElementById('timer-bar');
const btnStart        = document.getElementById('btn-start');
const btnPause        = document.getElementById('btn-pause');
const btnReset        = document.getElementById('btn-reset');
const sessionCountEl  = document.getElementById('session-count');
const questionsAns    = document.getElementById('questions-answered');
const correctCountEl  = document.getElementById('correct-count');

const breakModal      = document.getElementById('break-modal');
const breakTimerEl    = document.getElementById('break-timer');
const breakTimerBar   = document.getElementById('break-timer-bar');
const btnContinue     = document.getElementById('btn-continue');
const btnStop         = document.getElementById('btn-stop');

const doneModal       = document.getElementById('done-modal');
const doneSummary     = document.getElementById('done-summary');
const btnRestart      = document.getElementById('btn-restart');

const questionText    = document.getElementById('question-text');
const feedback        = document.getElementById('feedback');
const questionCard    = document.getElementById('question-card');
const answerForm      = document.getElementById('answer-form');
const answerInput     = document.getElementById('answer-input');
const btnSubmit       = document.getElementById('btn-submit');

const streakCountEl   = document.getElementById('streak-count');

const statTotalSessions = document.getElementById('stat-total-sessions');
const statTotalCorrect  = document.getElementById('stat-total-correct');
const statAccuracy      = document.getElementById('stat-accuracy');
const statStreak        = document.getElementById('stat-streak');

// ── Config ────────────────────────────────────────────────────
const WORK_SECONDS  = 25 * 60;
const BREAK_SECONDS = 5 * 60;

// ── State ─────────────────────────────────────────────────────
let timerInterval    = null;
let secondsLeft      = WORK_SECONDS;
let totalSeconds     = WORK_SECONDS;
let isRunning        = false;
let isBreak          = false;
let sessionCount     = 1;
let sessionAnswered  = 0;
let sessionCorrect   = 0;

let currentAnswer    = null;
let questionActive   = false;

// ── Persistent stats (localStorage) ──────────────────────────
function loadStats() {
  return JSON.parse(localStorage.getItem('mathDrillStats') || '{"totalSessions":0,"totalAnswered":0,"totalCorrect":0,"streak":0,"lastActiveDate":""}');
}
function saveStats(s) {
  localStorage.setItem('mathDrillStats', JSON.stringify(s));
}

// ── Streak logic ──────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function updateStreak(stats) {
  const today = todayStr();
  const last  = stats.lastActiveDate;
  if (last === today) return stats;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().slice(0, 10);
  if (last === yStr) {
    stats.streak += 1;
  } else if (last !== today) {
    stats.streak = 1;
  }
  stats.lastActiveDate = today;
  return stats;
}

// ── Init ──────────────────────────────────────────────────────
function init() {
  const s = loadStats();
  streakCountEl.textContent   = s.streak;
  statTotalSessions.textContent = s.totalSessions;
  statTotalCorrect.textContent  = s.totalCorrect;
  statAccuracy.textContent = s.totalAnswered > 0
    ? Math.round(s.totalCorrect / s.totalAnswered * 100) + '%'
    : '0%';
  statStreak.textContent = s.streak;
  renderTimer();
}

// ── Timer helpers ─────────────────────────────────────────────
function fmt(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return m + ':' + s;
}
function renderTimer() {
  timerDisplay.textContent = fmt(secondsLeft);
  const pct = secondsLeft / totalSeconds * 100;
  timerBar.style.width = pct + '%';

  // Warning color last 60s of work
  timerDisplay.classList.toggle('warning', !isBreak && secondsLeft <= 60);
  timerDisplay.classList.toggle('break-mode', isBreak);
  timerLabel.classList.toggle('break-mode', isBreak);
  timerBar.classList.toggle('break-mode', isBreak);
  timerLabel.textContent = isBreak ? 'Istirahat' : 'Sesi Kerja';
}

// ── Timer controls ────────────────────────────────────────────
function startTimer() {
  if (isRunning) return;
  isRunning = true;
  btnStart.disabled = true;
  btnPause.disabled = false;

  if (!questionActive && !isBreak) {
    generateQuestion();
  }

  // Update streak on first start of the day
  let s = loadStats();
  s = updateStreak(s);
  saveStats(s);
  streakCountEl.textContent = s.streak;
  statStreak.textContent    = s.streak;

  timerInterval = setInterval(() => {
    secondsLeft--;
    renderTimer();
    if (secondsLeft <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      isRunning = false;
      onTimerEnd();
    }
  }, 1000);
}

function pauseTimer() {
  if (!isRunning) return;
  clearInterval(timerInterval);
  timerInterval = null;
  isRunning = false;
  btnStart.disabled = false;
  btnPause.disabled = true;
}

function resetTimer() {
  pauseTimer();
  isBreak = false;
  secondsLeft = WORK_SECONDS;
  totalSeconds = WORK_SECONDS;
  sessionCount = 1;
  sessionAnswered = 0;
  sessionCorrect = 0;
  questionActive = false;
  currentAnswer = null;
  sessionCountEl.textContent  = sessionCount;
  questionsAns.textContent    = sessionAnswered;
  correctCountEl.textContent  = sessionCorrect;
  answerInput.disabled  = true;
  btnSubmit.disabled    = true;
  answerInput.value     = '';
  feedback.textContent  = '';
  feedback.className    = 'feedback';
  questionCard.className = 'question-card';
  questionText.innerHTML = 'Tekan <strong>Mulai</strong> untuk memulai sesi!';
  renderTimer();
  btnPause.disabled = true;
  btnStart.disabled = false;
}

function onTimerEnd() {
  disableDrill();
  questionActive = false;
  if (!isBreak) {
    // Work session ended → show break modal
    showBreakModal();
  }
  // Break timer ends automatically in runBreakTimer()
}

// ── Break modal & timer ───────────────────────────────────────
let breakInterval = null;
let breakSecondsLeft = BREAK_SECONDS;

function showBreakModal() {
  breakSecondsLeft = BREAK_SECONDS;
  breakTimerEl.textContent = fmt(breakSecondsLeft);
  breakTimerBar.style.width = '100%';
  breakModal.hidden = false;

  breakInterval = setInterval(() => {
    breakSecondsLeft--;
    breakTimerEl.textContent = fmt(breakSecondsLeft);
    const pct = breakSecondsLeft / BREAK_SECONDS * 100;
    breakTimerBar.style.width = pct + '%';
    if (breakSecondsLeft <= 0) {
      clearInterval(breakInterval);
      breakInterval = null;
      // Auto prompt but don't force — keep modal open for choice
      breakTimerEl.textContent = 'Selesai!';
    }
  }, 1000);
}

btnContinue.addEventListener('click', () => {
  clearInterval(breakInterval);
  breakModal.hidden = true;
  startNewSession();
});

btnStop.addEventListener('click', () => {
  clearInterval(breakInterval);
  breakModal.hidden = true;
  showDoneModal();
});

function startNewSession() {
  sessionCount++;
  sessionAnswered = 0;
  sessionCorrect  = 0;
  sessionCountEl.textContent  = sessionCount;
  questionsAns.textContent    = sessionAnswered;
  correctCountEl.textContent  = sessionCorrect;

  isBreak = false;
  secondsLeft  = WORK_SECONDS;
  totalSeconds = WORK_SECONDS;
  renderTimer();
  startTimer();
}

// ── Done modal ────────────────────────────────────────────────
function showDoneModal() {
  const s = loadStats();
  doneSummary.textContent =
    'Total sesi: ' + s.totalSessions + ' | ' +
    'Total benar: ' + s.totalCorrect + ' | ' +
    'Akurasi: ' + (s.totalAnswered > 0 ? Math.round(s.totalCorrect / s.totalAnswered * 100) : 0) + '%' +
    ' | Streak: ' + s.streak + ' hari';
  doneModal.hidden = false;
}

btnRestart.addEventListener('click', () => {
  doneModal.hidden = true;
  resetTimer();
});

// ── Question generation ───────────────────────────────────────
function getOperations() {
  const checked = [...document.querySelectorAll('.op-selector input:checked')];
  const ops = checked.map(el => el.value);
  return ops.length ? ops : ['+'];
}
function getDifficultyMax() {
  const val = document.querySelector('input[name="difficulty"]:checked').value;
  return val === 'easy' ? 10 : val === 'medium' ? 20 : 50;
}
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateQuestion() {
  const ops = getOperations();
  const op  = ops[Math.floor(Math.random() * ops.length)];
  const max = getDifficultyMax();
  let a, b, answer, display;

  if (op === '+') {
    a = rand(1, max); b = rand(1, max);
    answer = a + b; display = a + ' + ' + b + ' = ?';
  } else if (op === '-') {
    a = rand(1, max); b = rand(1, a);
    answer = a - b; display = a + ' - ' + b + ' = ?';
  } else if (op === 'x') {
    a = rand(1, Math.min(max, 12)); b = rand(1, Math.min(max, 12));
    answer = a * b; display = a + ' x ' + b + ' = ?';
  } else {
    b = rand(1, Math.min(max, 12));
    answer = rand(1, Math.min(max, 12));
    a = b * answer;
    display = a + ' / ' + b + ' = ?';
  }

  currentAnswer = answer;
  questionText.textContent = display;
  feedback.textContent = '';
  feedback.className = 'feedback';
  questionCard.className = 'question-card';
  answerInput.value = '';
  answerInput.disabled = false;
  btnSubmit.disabled = false;
  answerInput.focus();
  questionActive = true;
}

function disableDrill() {
  answerInput.disabled = true;
  btnSubmit.disabled   = true;
  questionActive = false;
}

// ── Answer submission ─────────────────────────────────────────
answerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!questionActive || currentAnswer === null) return;

  const userVal = parseInt(answerInput.value, 10);
  if (isNaN(userVal)) return;

  sessionAnswered++;
  questionsAns.textContent = sessionAnswered;

  let s = loadStats();
  s.totalAnswered++;

  if (userVal === currentAnswer) {
    sessionCorrect++;
    correctCountEl.textContent = sessionCorrect;
    s.totalCorrect++;
    feedback.textContent = 'Benar! +1';
    feedback.className   = 'feedback correct';
    questionCard.className = 'question-card correct';
  } else {
    feedback.textContent = 'Salah. Jawaban: ' + currentAnswer;
    feedback.className   = 'feedback wrong';
    questionCard.className = 'question-card wrong';
  }

  saveStats(s);
  updateStatsUI(s);

  setTimeout(() => {
    if (isRunning) generateQuestion();
  }, 600);
});

function updateStatsUI(s) {
  statTotalSessions.textContent = s.totalSessions;
  statTotalCorrect.textContent  = s.totalCorrect;
  statAccuracy.textContent      = s.totalAnswered > 0
    ? Math.round(s.totalCorrect / s.totalAnswered * 100) + '%'
    : '0%';
  statStreak.textContent = s.streak;
  streakCountEl.textContent = s.streak;
}

// ── Save session on end ───────────────────────────────────────
function finalizeSession() {
  let s = loadStats();
  s.totalSessions++;
  saveStats(s);
  updateStatsUI(s);
}

// Patch onTimerEnd to also finalize
const _origOnTimerEnd = onTimerEnd;
// Redefine cleanly:
function onWorkSessionEnd() {
  disableDrill();
  questionActive = false;
  finalizeSession();
  showBreakModal();
}

// Override the setInterval callback reference:
// (Re-wire start to use correct end handler)
btnStart.addEventListener('click', startTimer);
btnPause.addEventListener('click', pauseTimer);
btnReset.addEventListener('click', resetTimer);

// Re-wire timer tick to use correct end
function startTimerInternal() {
  if (isRunning) return;
  isRunning = true;
  btnStart.disabled = true;
  btnPause.disabled = false;

  if (!questionActive && !isBreak) generateQuestion();

  let s = loadStats();
  s = updateStreak(s);
  saveStats(s);
  streakCountEl.textContent = s.streak;
  statStreak.textContent    = s.streak;

  timerInterval = setInterval(() => {
    secondsLeft--;
    renderTimer();
    if (secondsLeft <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      isRunning = false;
      onWorkSessionEnd();
    }
  }, 1000);
}

// Repoint btnStart to corrected function (remove old listener first via flag)
let startListenerAttached = false;
btnStart.addEventListener('click', () => {
  if (!startListenerAttached) {
    startListenerAttached = true;
    startTimerInternal();
  }
});

// Clean bootstrap — override init's btn binding
btnStart.onclick = startTimerInternal;
btnPause.onclick = pauseTimer;
btnReset.onclick = resetTimer;

// ── Boot ──────────────────────────────────────────────────────
init();
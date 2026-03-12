'use strict';

// DOM refs
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

// Config
const WORK_SECONDS  = 25 * 60;
const BREAK_SECONDS = 5 * 60;

// State
let timerInterval   = null;
let secondsLeft     = WORK_SECONDS;
let totalSeconds    = WORK_SECONDS;
let isRunning       = false;
let isBreak         = false;
let sessionCount    = 1;
let sessionAnswered = 0;
let sessionCorrect  = 0;
let currentAnswer   = null;
let questionActive  = false;

// Persistent stats
function loadStats() {
  return JSON.parse(localStorage.getItem('mathDrillStats') || '{"totalSessions":0,"totalAnswered":0,"totalCorrect":0,"streak":0,"lastActiveDate":""}');
}
function saveStats(s) {
  localStorage.setItem('mathDrillStats', JSON.stringify(s));
}

// Streak
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function updateStreak(stats) {
  const today = todayStr();
  if (stats.lastActiveDate === today) return stats;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().slice(0, 10);
  stats.streak = (stats.lastActiveDate === yStr) ? stats.streak + 1 : 1;
  stats.lastActiveDate = today;
  return stats;
}

// Timer helpers
function fmt(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return m + ':' + s;
}
function renderTimer() {
  timerDisplay.textContent = fmt(secondsLeft);
  const pct = (secondsLeft / totalSeconds) * 100;
  timerBar.style.width = pct + '%';
  timerDisplay.classList.toggle('warning', !isBreak && secondsLeft <= 60);
  timerDisplay.classList.toggle('break-mode', isBreak);
  timerLabel.classList.toggle('break-mode', isBreak);
  timerBar.classList.toggle('break-mode', isBreak);
  timerLabel.textContent = isBreak ? 'Istirahat' : 'Sesi Kerja';
}

// Init
function init() {
  const s = loadStats();
  streakCountEl.textContent      = s.streak;
  statTotalSessions.textContent  = s.totalSessions;
  statTotalCorrect.textContent   = s.totalCorrect;
  statAccuracy.textContent       = s.totalAnswered > 0 ? Math.round(s.totalCorrect / s.totalAnswered * 100) + '%' : '0%';
  statStreak.textContent         = s.streak;
  renderTimer();
}

// Start timer
function startTimer() {
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

// Pause
function pauseTimer() {
  if (!isRunning) return;
  clearInterval(timerInterval);
  timerInterval = null;
  isRunning = false;
  btnStart.disabled = false;
  btnPause.disabled = true;
}

// Reset
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
  sessionCountEl.textContent = sessionCount;
  questionsAns.textContent   = sessionAnswered;
  correctCountEl.textContent = sessionCorrect;
  answerInput.disabled = true;
  btnSubmit.disabled   = true;
  answerInput.value    = '';
  feedback.textContent = '';
  feedback.className   = 'feedback';
  questionCard.className = 'question-card';
  questionText.innerHTML = 'Tekan <strong>Mulai</strong> untuk memulai sesi!';
  renderTimer();
  btnPause.disabled = true;
  btnStart.disabled = false;
}

// Work session ends
function onWorkSessionEnd() {
  disableDrill();
  questionActive = false;
  let s = loadStats();
  s.totalSessions++;
  saveStats(s);
  updateStatsUI(s);
  showBreakModal();
}

// Break modal
let breakInterval    = null;
let breakSecondsLeft = BREAK_SECONDS;

function showBreakModal() {
  breakSecondsLeft = BREAK_SECONDS;
  breakTimerEl.textContent    = fmt(breakSecondsLeft);
  breakTimerBar.style.width   = '100%';
  breakModal.hidden = false;
  breakInterval = setInterval(() => {
    breakSecondsLeft--;
    breakTimerEl.textContent = fmt(breakSecondsLeft);
    breakTimerBar.style.width = (breakSecondsLeft / BREAK_SECONDS * 100) + '%';
    if (breakSecondsLeft <= 0) {
      clearInterval(breakInterval);
      breakInterval = null;
      breakTimerEl.textContent = 'Selesai!';
    }
  }, 1000);
}

btnContinue.addEventListener('click', () => {
  clearInterval(breakInterval);
  breakModal.hidden = true;
  sessionCount++;
  sessionAnswered = 0;
  sessionCorrect  = 0;
  sessionCountEl.textContent = sessionCount;
  questionsAns.textContent   = sessionAnswered;
  correctCountEl.textContent = sessionCorrect;
  isBreak      = false;
  secondsLeft  = WORK_SECONDS;
  totalSeconds = WORK_SECONDS;
  renderTimer();
  startTimer();
});

btnStop.addEventListener('click', () => {
  clearInterval(breakInterval);
  breakModal.hidden = true;
  showDoneModal();
});

// Done modal
function showDoneModal() {
  const s = loadStats();
  const acc = s.totalAnswered > 0 ? Math.round(s.totalCorrect / s.totalAnswered * 100) : 0;
  doneSummary.textContent =
    'Total sesi: ' + s.totalSessions + ' | Benar: ' + s.totalCorrect +
    ' | Akurasi: ' + acc + '% | Streak: ' + s.streak + ' hari';
  doneModal.hidden = false;
}

btnRestart.addEventListener('click', () => {
  doneModal.hidden = true;
  resetTimer();
});

// Generate question
function getOperations() {
  const ops = [...document.querySelectorAll('.op-selector input:checked')].map(el => el.value);
  return ops.length ? ops : ['+'];
}
function getDiffMax() {
  const val = document.querySelector('input[name="difficulty"]:checked').value;
  return val === 'easy' ? 10 : val === 'medium' ? 20 : 50;
}
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateQuestion() {
  const ops = getOperations();
  const op  = ops[Math.floor(Math.random() * ops.length)];
  const max = getDiffMax();
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
  feedback.textContent  = '';
  feedback.className    = 'feedback';
  questionCard.className = 'question-card';
  answerInput.value = '';
  answerInput.disabled = false;
  btnSubmit.disabled   = false;
  answerInput.focus();
  questionActive = true;
}

function disableDrill() {
  answerInput.disabled = true;
  btnSubmit.disabled   = true;
  questionActive = false;
}

// Answer submission
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
    feedback.textContent  = 'Benar! +1';
    feedback.className    = 'feedback correct';
    questionCard.className = 'question-card correct';
  } else {
    feedback.textContent  = 'Salah. Jawaban: ' + currentAnswer;
    feedback.className    = 'feedback wrong';
    questionCard.className = 'question-card wrong';
  }
  saveStats(s);
  updateStatsUI(s);
  setTimeout(() => { if (isRunning) generateQuestion(); }, 600);
});

function updateStatsUI(s) {
  statTotalSessions.textContent = s.totalSessions;
  statTotalCorrect.textContent  = s.totalCorrect;
  statAccuracy.textContent      = s.totalAnswered > 0 ? Math.round(s.totalCorrect / s.totalAnswered * 100) + '%' : '0%';
  statStreak.textContent        = s.streak;
  streakCountEl.textContent     = s.streak;
}

// Button wiring
btnStart.onclick = startTimer;
btnPause.onclick = pauseTimer;
btnReset.onclick = resetTimer;

// Boot
init();

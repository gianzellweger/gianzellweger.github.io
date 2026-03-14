// game.js — orchestrator for game.html
// Config via query string: ?color=white&time=300&depth=10

import { Chess }           from '../vendor/chess.js';
import Engine              from './engine.js';
import Premove             from './premove.js';
import Clock               from './clock.js';
import History             from './history.js';
import { refreshMaterial } from './material.js';

// ── Config ────────────────────────────────────────────────────────────────────

const FALLBACK_MOVETIME = 10000; // ms — used when all premoves fail or are empty
const WHITE_OPENINGS    = ['e2e4', 'd2d4', 'c2c4', 'g1f3'];

// ── Parse query string ────────────────────────────────────────────────────────

const params           = new URLSearchParams(location.search);
const playerColor      = params.get('color') === 'black' ? 'black' : 'white';
const timeControl      = parseInt(params.get('time')  || '300');
const maxDepth         = parseInt(params.get('depth') || '10');
const sfColor          = playerColor === 'white' ? 'b' : 'w';   // engine's chess color char
const playerChessColor = playerColor === 'white' ? 'w' : 'b';   // player's chess color char

// ── Game state ────────────────────────────────────────────────────────────────

let chess       = new Chess();
let board       = null;
let clock       = null;
let history     = null;
let gameActive  = false;
let playerMoved = false; // true from the moment the player drops a piece until
                          // startPremovePhase() resets it, preventing double-moves
let lastFrom = null;
let lastTo   = null;

// Safe stub used before a real Premove instance is created, and after game end.
// Prevents null-checks throughout the rest of the code.
const nullPremover = {
  genericPremove: null, backupPremove: null,
  conditionalFor: new Map(), checkResponseFor: new Map(),
  cancel() {},
};
let premover = nullPremover;

// ── DOM helpers ───────────────────────────────────────────────────────────────

const setPip  = s  => { const el = document.getElementById('epip');     if (el) el.className = 'engine-pip ' + s; };
const setLock = on => { const el = document.getElementById('lock-ind'); if (el) el.className = 'lock-ind' + (on ? ' on' : ''); };

// Highlight the last move's squares
function highlightMove(from, to) {
  document.querySelector(`#board .square-${lastFrom}`)?.classList.remove('sqf');
  document.querySelector(`#board .square-${lastTo}`)?.classList.remove('sqt');
  lastFrom = from; lastTo = to;
  document.querySelector(`#board .square-${from}`)?.classList.add('sqf');
  document.querySelector(`#board .square-${to}`)?.classList.add('sqt');
}

// Show legal-move dots when the player picks up a piece
function showDots(src) {
  clearDots();
  chess.moves({ square: src, verbose: true }).forEach(mv => {
    const el = document.querySelector(`#board .square-${mv.to}`);
    if (!el) return;
    chess.get(mv.to) ? el.classList.add('mcap') : el.classList.add('mdot');
  });
}

function clearDots() {
  document.querySelectorAll('#board [class*="square-"]')
    .forEach(el => el.classList.remove('mdot', 'mcap'));
}

// ── Clock display ─────────────────────────────────────────────────────────────

function onClockTick({ wTime, bTime, active, unlimited }) {
  const playerIsWhite = playerColor === 'white';
  const topTime = playerIsWhite ? bTime : wTime;
  const botTime = playerIsWhite ? wTime : bTime;
  const topColor = playerIsWhite ? 'b' : 'w';
  const botColor = playerIsWhite ? 'w' : 'b';
  const topEl = document.getElementById('clk-top');
  const botEl = document.getElementById('clk-bot');
  topEl.textContent = unlimited ? '∞' : Clock.fmt(topTime);
  botEl.textContent = unlimited ? '∞' : Clock.fmt(botTime);
  topEl.className = 'clock' + (active === topColor ? ' active' : '') + (!unlimited && topTime < 30 ? ' low' : '');
  botEl.className = 'clock' + (active === botColor ? ' active' : '') + (!unlimited && botTime < 30 ? ' low' : '');
}

function onFlag(color) {
  endGame(color === playerChessColor ? 'STOCKFISH WINS' : 'YOU WIN', 'flag fall');
}

// ── Game over ─────────────────────────────────────────────────────────────────

function checkGameOver() {
  if (!chess.isGameOver()) return false;
  let msg = 'DRAW', sub = '';
  if (chess.isCheckmate()) {
    // The side whose turn it is has been mated
    msg = chess.turn() === playerChessColor ? 'STOCKFISH WINS' : 'YOU WIN';
    sub = 'checkmate';
  } else if (chess.isStalemate())          sub = 'stalemate';
  else if (chess.isThreefoldRepetition())  sub = 'repetition';
  else if (chess.isInsufficientMaterial()) sub = 'insufficient material';
  endGame(msg, sub);
  return true;
}

function endGame(msg, sub) {
  console.log(`[Game] Over — ${msg} (${sub})`);
  clock?.stop();
  gameActive = false;
  premover.cancel();
  setLock(false); setPip('ready');
  document.getElementById('game-over').className = 'on';
  const title = document.getElementById('go-title');
  title.style.color = msg === 'YOU WIN' ? 'var(--accent)' : msg === 'STOCKFISH WINS' ? 'var(--accent2)' : '#888';
  title.textContent = msg;
  document.getElementById('go-sub').textContent = sub;
}

// ── Engine responds after the player's move ───────────────────────────────────

async function engineRespond(humanUci) {
  setLock(false); setPip('thinking');

  // Try to apply a UCI move string to the current position
  const tryMove = uci => {
    if (!uci) return null;
    try {
      return chess.move({ from: uci.slice(0,2), to: uci.slice(2,4), promotion: uci[4] || 'q' });
    } catch { return null; }
  };

  let result = null;
  let moveSource = null;

  // Premove hierarchy: conditional → generic → backup → check response → live
  //
  // 1. Conditional: currently-illegal response keyed to the human's move
  //    (e.g. a recapture).  Bounces harmlessly if not applicable.
  if (humanUci) {
    result = tryMove(premover.conditionalFor.get(humanUci));
    if (result) moveSource = 'conditional';
  }
  // 2. Generic: the blind premove — fires 75%+ of the time.
  if (!result) {
    result = tryMove(premover.genericPremove);
    if (result) moveSource = 'generic';
  }
  // 3. Backup: different piece from generic, in case generic's piece was captured.
  if (!result) {
    result = tryMove(premover.backupPremove);
    if (result) moveSource = 'backup';
  }
  // 4. Check response: tried only when generic/backup both fail (usually
  //    because the human played a check and the generic isn't legal).
  if (!result && humanUci) {
    result = tryMove(premover.checkResponseFor.get(humanUci));
    if (result) moveSource = 'check response';
  }
  // 5. Live search: no premove available — think from scratch.
  if (!result) {
    const lines = await Engine.searchTime(chess.fen(), FALLBACK_MOVETIME);
    result = tryMove(Engine.bestMove(lines));
    moveSource = 'live';
  }

  if (result) {
    board.position(chess.fen());
    highlightMove(result.from, result.to);
    history.push(result.san, sfColor === 'w');
    refreshMaterial(chess.fen(), playerColor, 'mat-top', 'mat-bot');
    console.log(`[Game] Engine played ${result.san} (${moveSource})`);
  } else {
    console.error('[Game] Engine could not find any move!');
  }

  clock.stop(); setPip('ready');
  if (checkGameOver()) return;
  clock.start(playerChessColor);
  startPremovePhase();
}

// ── Premove computation ───────────────────────────────────────────────────────

function startPremovePhase() {
  // Reset playerMoved BEFORE the guard so dragging is always re-enabled,
  // even if we return early (e.g. game already over).
  playerMoved = false;

  // Only compute premoves while it is the player's turn — that's when the
  // engine has time to think ahead about its response.
  if (!Engine.isReady() || chess.isGameOver() || chess.turn() !== playerChessColor) return;

  setLock(false); setPip('thinking');

  premover = new Premove({
    engineColor: sfColor,
    maxDepth,
    // Called after each depth round — update the lock indicator as soon as
    // we have at least one safe generic premove ready
    onUpdate: ({ genericPremove }) => {
      if (!playerMoved) setLock(genericPremove !== null);
    },
  });

  premover.compute(chess.fen()).then(() => {
    if (!playerMoved) setPip('ready');
  });
}

// ── Board event handlers ──────────────────────────────────────────────────────

function onDragStart(src, piece) {
  // Reject drags that aren't the player's turn, wrong colour piece, or already moved
  if (!Engine.isReady() || !gameActive || chess.isGameOver()) return false;
  if (chess.turn() !== playerChessColor)           return false;
  if (playerColor === 'white' && piece[0] === 'b') return false;
  if (playerColor === 'black' && piece[0] === 'w') return false;
  if (playerMoved)                                 return false;
  showDots(src);
  return true;
}

function onDrop(src, tgt) {
  clearDots();

  // chess.js v1 throws on illegal moves — catch it so state is never corrupted
  let mv;
  let promo;
  try {
    if (src === tgt) return 'snapback';
    const piece = chess.get(src);
    promo = piece?.type === 'p' && (tgt[1] === '8' || tgt[1] === '1') ? 'q' : undefined;
    mv = chess.move({ from: src, to: tgt, promotion: promo });
    if (!mv) return 'snapback';
  } catch {
    return 'snapback';
  }

  const humanUci = src + tgt + (promo || '');
  console.log(`[Game] Player played ${mv.san}`);
  playerMoved = true;
  premover.cancel(); // stop premove computation — we no longer need it

  highlightMove(src, tgt);
  history.push(mv.san, playerColor === 'white');
  refreshMaterial(chess.fen(), playerColor, 'mat-top', 'mat-bot');
  if (checkGameOver()) return;

  clock.stop();
  clock.start(sfColor);
  setTimeout(() => engineRespond(humanUci), 100);
}

function onSnapEnd() { board.position(chess.fen()); }

// ── Opening move (when the engine plays White) ────────────────────────────────

async function playOpening() {
  setPip('thinking');
  // Pick a random opening move from our list, falling back to engine search
  const uci = WHITE_OPENINGS[Math.floor(Math.random() * WHITE_OPENINGS.length)];
  let mv;
  try   { mv = chess.move({ from: uci.slice(0,2), to: uci.slice(2,4) }); }
  catch { mv = null; }
  if (!mv) {
    const lines = await Engine.search(chess.fen(), 8);
    const bm = Engine.bestMove(lines);
    if (bm) try { mv = chess.move({ from: bm.slice(0,2), to: bm.slice(2,4) }); } catch { mv = null; }
  }
  if (mv) {
    board.position(chess.fen());
    highlightMove(mv.from, mv.to);
    history.push(mv.san, true);
    refreshMaterial(chess.fen(), playerColor, 'mat-top', 'mat-bot');
    console.log(`[Game] Opening: ${mv.san}`);
  }
  clock.stop();
  if (checkGameOver()) return;
  clock.start(playerChessColor);
  setPip('ready');
  startPremovePhase();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
  setPip('thinking');
  console.log(`[Game] Starting — player: ${playerColor}, time: ${timeControl}s, depth: ${maxDepth}`);

  // Label the player bars
  const playerIsWhite = playerColor === 'white';
  document.getElementById('dot-top').className    = 'pdot ' + (playerIsWhite ? 'pdot-b' : 'pdot-w');
  document.getElementById('dot-bot').className    = 'pdot ' + (playerIsWhite ? 'pdot-w' : 'pdot-b');
  document.getElementById('name-top').textContent = 'Stockfish';
  document.getElementById('name-bot').textContent = 'You';

  clock = new Clock(timeControl, onClockTick, onFlag);
  onClockTick({ wTime: clock.wTime, bTime: clock.bTime, active: null, unlimited: clock.unlimited });

  history = new History('move-list');

  board = Chessboard('board', {
    draggable:   true,
    position:    'start',
    orientation: playerColor,
    pieceTheme:  'img/chesspieces/wikipedia/{piece}.png',
    onDragStart, onDrop, onSnapEnd,
  });

  await Engine.init();
  gameActive  = true;
  playerMoved = false;

  if (playerColor === 'white') {
    clock.start('w');
    startPremovePhase(); // begin computing Black's responses while player thinks
  } else {
    clock.start('w');
    await playOpening();
  }
}

// ── UI events ─────────────────────────────────────────────────────────────────

document.getElementById('go-btn-menu').addEventListener('click', () => {
  clock?.stop(); premover.cancel(); location.href = 'index.html';
});
document.getElementById('go-btn-again').addEventListener('click', () => {
  location.reload();
});

init().catch(err => { console.error('[Game] Init failed:', err); setPip('ready'); });

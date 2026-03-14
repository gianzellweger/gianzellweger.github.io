// material.js
// Renders captured-piece indicators and score advantage in the player bars.
// Uses Unicode chess glyphs — no images needed.

const GLYPHS = {
  p: ['♙','♟'], n: ['♘','♞'], b: ['♗','♝'], r: ['♖','♜'], q: ['♕','♛'],
};
const VALUES = { p:1, n:3, b:3, r:5, q:9 };
const START  = { p:8, n:2, b:2, r:2, q:1 };
const ORDER  = ['q','r','b','n','p'];

/**
 * Refresh both material bars from the current FEN.
 * @param {string} fen          Current position FEN
 * @param {string} playerColor  'white' | 'black'
 * @param {string} topElId      Element id for the opponent's bar
 * @param {string} botElId      Element id for the player's bar
 */
export function refreshMaterial(fen, playerColor, topElId, botElId) {
  const boardPart = fen.split(' ')[0];
  const onBoard   = { w:{p:0,n:0,b:0,r:0,q:0}, b:{p:0,n:0,b:0,r:0,q:0} };

  for (const ch of boardPart) {
    if (!'pnbrqPNBRQ'.includes(ch)) continue;
    const color = ch === ch.toUpperCase() ? 'w' : 'b';
    onBoard[color][ch.toLowerCase()]++;
  }

  const capFromW = {}, capFromB = {};
  let materialScore = 0; // positive = White ahead

  for (const pt of ORDER) {
    capFromW[pt] = Math.max(0, START[pt] - onBoard.w[pt]);
    capFromB[pt] = Math.max(0, START[pt] - onBoard.b[pt]);
    materialScore += (capFromB[pt] - capFromW[pt]) * VALUES[pt];
  }

  const piW = playerColor === 'white';
  // Player (bottom) shows pieces they captured (i.e. pieces taken from the opponent)
  const botCaptures = piW ? capFromB : capFromW;
  const topCaptures = piW ? capFromW : capFromB;
  const botGlyph    = piW ? 'b' : 'w'; // color of pieces player captured
  const topGlyph    = piW ? 'w' : 'b';
  const playerAdv   = piW ? materialScore : -materialScore;

  _render(botElId, botCaptures, botGlyph, playerAdv > 0 ? playerAdv : 0);
  _render(topElId, topCaptures, topGlyph, playerAdv < 0 ? -playerAdv : 0);
}

function _render(elId, captures, glyphColor, adv) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '';
  const gi = glyphColor === 'w' ? 0 : 1;

  for (const pt of ORDER) {
    for (let i = 0; i < (captures[pt] || 0); i++) {
      const s = document.createElement('span');
      s.className   = 'mat-piece';
      s.textContent = GLYPHS[pt][gi];
      el.appendChild(s);
    }
  }

  if (adv > 0) {
    const s = document.createElement('span');
    s.className   = 'mat-adv';
    s.textContent = '+' + adv;
    el.appendChild(s);
  }
}

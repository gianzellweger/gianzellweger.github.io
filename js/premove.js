// premove.js
// Computes premoves during the player's turn so the engine can respond
// instantly when the player moves.  The core idea is that the engine commits
// to a "blind" generic premove without knowing what the human will play.
// Two narrow exceptions exist for situations where generic can't work:
//
//   conditionalFor     — Map<humanUci, engineUci>.  Contains responses that
//                        are currently ILLEGAL for the engine (e.g. a recapture
//                        on a square occupied by a friendly piece that the human
//                        might capture).  Tried first: if the conditional is
//                        legal it fires; if not it harmlessly bounces and we
//                        fall through to generic.
//
//   genericPremove     — the main premove.  The best broadly-applicable move,
//                        chosen to be safe and legal across the widest range of
//                        human replies.  This is what fires 75%+ of the time.
//
//   backupPremove      — fires if generic is illegal.  Guaranteed to move a
//                        DIFFERENT piece so both don't fail to the same capture.
//
//   checkResponseFor   — Map<humanUci, engineUci>.  The engine's best reply to
//                        specific human checking moves.  Tried only AFTER
//                        generic and backup both fail, which happens when the
//                        human plays a check (generic was chosen for non-check
//                        scenarios and is usually illegal in check positions).
//
// Uses iterative deepening so partial results are available quickly and
// improve over time until the human moves or max depth is reached.

import Engine from './engine.js';
import { Chess } from '../chess.js';

// ── Tuning constants ──────────────────────────────────────────────────────────

const MAX_HUMAN_MOVES    = 20;   // how many human candidate moves to analyse
const WEIGHT_DECAY       = 0.72; // weight for rank N = WEIGHT_DECAY^N (top move = 1.0)
const PIECE_VALUES       = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const ROUND_DEPTHS       = [1, 3, 6]; // shallow passes before the final maxDepth pass
const COVERAGE_THRESHOLD = 0.5;  // minimum fraction of weighted scenarios a move must
                                  // be legal in to qualify as a high-confidence candidate.
                                  // If nothing clears this, best-effort is used instead
                                  // so generic is never null.

// ─────────────────────────────────────────────────────────────────────────────

export default class Premove {
  constructor({ engineColor, maxDepth, onUpdate }) {
    this.engineColor = engineColor; // 'w' or 'b'
    this.maxDepth    = maxDepth;
    this.onUpdate    = onUpdate;    // called after each depth round with latest results

    this.cancelled = false;

    this.genericPremove   = null;
    this.backupPremove    = null;
    this.conditionalFor   = new Map(); // humanUci → engineUci (currently illegal responses)
    this.checkResponseFor = new Map(); // humanUci → engineUci (responses to checks)
  }

  // Stop an in-progress computation (called when the player moves early)
  cancel() {
    this.cancelled = true;
    Engine.stop();
  }

  // Main entry point. Populates conditionalFor / genericPremove / backupPremove / checkResponseFor.
  async compute(fen) {
    this.cancelled = false;
    this.genericPremove   = null;
    this.backupPremove    = null;
    this.conditionalFor   = new Map();
    this.checkResponseFor = new Map();

    const position         = new Chess(fen);
    const engineCanMoveNow = this.legalMovesFor(fen, this.engineColor);

    // ── Phase A: rank the human's candidate moves by likelihood ───────────────
    // Ask the engine to evaluate the current position to predict the human's
    // most likely move, then score all candidate moves at depth 1 to sort them
    // by how attractive they look from the human's perspective.

    const rankLines = await Engine.search(fen, 4);
    if (this.cancelled) return;

    const predictedMove = Engine.bestMove(rankLines);
    const humanMoves    = position.moves({ verbose: true })
      .map(m => m.from + m.to + (m.promotion || ''));

    if (!humanMoves.length) return;

    const candidates = this.prioritise(humanMoves, predictedMove, fen, MAX_HUMAN_MOVES);

    // Score each candidate at depth 1 so we can rank by human appeal
    const scored = [];
    for (const uci of candidates) {
      if (this.cancelled) return;
      const afterFen = this.applyMove(fen, uci);
      if (!afterFen) continue;
      const lines = await Engine.search(afterFen, 1);
      if (this.cancelled) return;
      // Lower cp = better for the human = more likely to be played
      scored.push({ uci, cp: Engine.cpScore(lines) });
    }

    if (!scored.length) return;

    // Sort ascending by cp (most human-favourable first), then pin the
    // predicted move to the top regardless of its depth-1 score
    scored.sort((a, b) => a.cp - b.cp);
    const predictedIdx = scored.findIndex(m => m.uci === predictedMove);
    if (predictedIdx > 0) {
      const [entry] = scored.splice(predictedIdx, 1);
      scored.unshift(entry);
    }

    // Attach geometric weights: rank 0 = 1.0, rank 1 = 0.72, rank 2 = 0.52, …
    const rankedHuman = scored.map((m, i) => {
      const after = this.applyMove(fen, m.uci);
      return {
        uci:        m.uci,
        weight:     Math.pow(WEIGHT_DECAY, i),
        after,
        givesCheck: after ? this.isInCheck(after) : false,
      };
    }).filter(m => m.after !== null);

    console.log(`[Premove] Phase A done — ${rankedHuman.length} human moves ranked, predicted: ${predictedMove}`);

    // ── Phase B: iterative deepening over ranked human moves ──────────────────
    // For each depth round, ask the engine for its best reply after every ranked
    // human move. After each round, derive and publish the current premoves.

    const responseMap = new Map(); // humanUci → { sfMove, cp, depth }
    const schedule    = [...ROUND_DEPTHS.filter(d => d < this.maxDepth), this.maxDepth];

    for (const depth of schedule) {
      if (this.cancelled) return;

      for (const { uci: humanMove, after } of rankedHuman) {
        if (this.cancelled) return;

        // Skip if we already have a result at this depth or deeper
        const existing = responseMap.get(humanMove);
        if (existing && existing.depth >= depth) continue;

        const lines  = await Engine.search(after, depth);
        if (this.cancelled) return;

        const sfMove = Engine.bestMove(lines);
        const cp     = Engine.cpScore(lines);
        if (sfMove) responseMap.set(humanMove, { sfMove, cp, depth });
      }

      if (!this.cancelled && responseMap.size > 0) {
        this.derive(responseMap, rankedHuman, engineCanMoveNow);
        console.log(`[Premove] Depth ${depth} — generic: ${this.genericPremove}, backup: ${this.backupPremove}, conditionals: ${this.conditionalFor.size}, checks: ${this.checkResponseFor.size}`);
        this.onUpdate({
          genericPremove: this.genericPremove,
          backupPremove:  this.backupPremove,
          depth,
        });
      }
    }

    console.log(`[Premove] Complete — generic: ${this.genericPremove}, backup: ${this.backupPremove}`);
  }

  // ── Derive premoves from the response map ─────────────────────────────────────
  derive(responseMap, rankedHuman, engineCanMoveNow) {
    const totalWeight = rankedHuman.reduce((sum, m) => sum + m.weight, 0);

    // ── Build conditional and check-response maps ──────────────────────────
    // Only two categories get specific (keyed) responses:
    //   • Conditional: engine's reply is currently illegal (e.g. recapture
    //     on a square blocked by a friendly piece the human might capture).
    //   • Check response: human move gives check — generic is usually illegal
    //     in check positions, so we need a tailored escape/block.
    // Everything else feeds only the generic/backup tally.
    this.conditionalFor   = new Map();
    this.checkResponseFor = new Map();

    for (const { uci: humanMove, givesCheck } of rankedHuman) {
      const entry = responseMap.get(humanMove);
      if (!entry) continue;
      if (!engineCanMoveNow.has(entry.sfMove)) {
        // Engine's reply is currently blocked — conditional (highest priority)
        this.conditionalFor.set(humanMove, entry.sfMove);
      } else if (givesCheck) {
        // Human move is a check — store as check-specific response
        this.checkResponseFor.set(humanMove, entry.sfMove);
      }
    }

    // ── Tally weighted score and legal coverage for generic/backup selection ─
    const tally = new Map(); // sfMove → { weightedScore, legalWeight }

    for (const { uci: humanMove, weight, after } of rankedHuman) {
      const entry = responseMap.get(humanMove);
      if (!entry) continue;

      if (!tally.has(entry.sfMove)) {
        tally.set(entry.sfMove, { weightedScore: 0, legalWeight: 0 });
      }
      const t = tally.get(entry.sfMove);
      t.weightedScore += weight * entry.cp;
      if (this.isLegal(after, entry.sfMove)) {
        t.legalWeight += weight;
      }
    }

    // ── Safety pass: penalize moves that blunder material ─────────────────────
    // For each candidate move, check every scenario where it's legal but NOT the
    // engine's chosen response. If it hangs a piece there (capturable by something
    // cheaper, capturable and undefended, or a pawn can advance to attack it),
    // apply a heavy penalty. This prevents moves like Nf6 that are great against
    // the predicted move but walk into a pawn capture in an alternative line.

    for (const [sfMove, data] of tally) {
      for (const { uci: humanMove, weight, after } of rankedHuman) {
        const entry = responseMap.get(humanMove);
        if (entry && entry.sfMove === sfMove) continue;
        if (!this.isLegal(after, sfMove)) continue;
        const penalty = this.blunderPenalty(after, sfMove);
        if (penalty > 0) {
          data.weightedScore -= weight * penalty;
        }
      }
    }

    // ── Generic and backup candidates ─────────────────────────────────────────
    // Coverage = fraction of total weighted probability where a move is legal.
    // Multiplying score by coverage makes broadly-applicable (defensive) moves
    // rank higher than speculative ones that only work in a narrow set of lines.

    const genericCandidates = [];

    for (const [sfMove, data] of tally) {
      const coverage = totalWeight > 0 ? data.legalWeight / totalWeight : 0;
      if (coverage >= COVERAGE_THRESHOLD) {
        genericCandidates.push({ sfMove, score: data.weightedScore * coverage });
      }
    }

    genericCandidates.sort((a, b) => b.score - a.score);

    // Guarantee generic is never null
    if (genericCandidates.length < 2 && tally.size > 0) {
      const bestEffort = [...tally.entries()]
        .map(([sfMove, data]) => ({ sfMove, score: data.weightedScore }))
        .sort((a, b) => b.score - a.score);

      for (const entry of bestEffort) {
        if (genericCandidates.length >= 2) break;
        if (!genericCandidates.find(c => c.sfMove === entry.sfMove)) {
          if (genericCandidates.length === 0) {
            console.log(`[Premove] No high-coverage move — best-effort generic: ${entry.sfMove}`);
          }
          genericCandidates.push(entry);
        }
      }
    }

    this.genericPremove = genericCandidates[0]?.sfMove ?? null;

    // Backup must use a different piece than the generic so that if the generic
    // piece gets captured, the backup is still alive and legal
    const genericFrom = this.genericPremove?.slice(0, 2);
    const backupEntry = genericCandidates.find(
      (c, i) => i > 0 && c.sfMove.slice(0, 2) !== genericFrom
    );
    if (!backupEntry && this.genericPremove) {
      const fallback = [...tally.entries()]
        .map(([sfMove, data]) => ({ sfMove, score: data.weightedScore }))
        .sort((a, b) => b.score - a.score)
        .find(e => e.sfMove.slice(0, 2) !== genericFrom && e.sfMove !== this.genericPremove);
      this.backupPremove = fallback?.sfMove ?? null;
    } else {
      this.backupPremove = backupEntry?.sfMove ?? null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  // Sort candidate human moves so the most tactically interesting ones are
  // evaluated first: predicted best move → captures → checks → everything else.
  // Shuffles within each tier for variety, then caps at `limit`.
  prioritise(moves, predicted, fen, limit) {
    const position = new Chess(fen);
    const byUci    = new Map(
      position.moves({ verbose: true })
        .map(m => [m.from + m.to + (m.promotion || ''), m])
    );

    const best = [], captures = [], checks = [], rest = [];
    for (const uci of moves) {
      if (uci === predicted)         { best.push(uci);   continue; }
      const mv = byUci.get(uci);
      if (!mv)                       { rest.push(uci);   continue; }
      if (mv.captured)                 captures.push(uci);
      else if (mv.san.includes('+'))   checks.push(uci);
      else                             rest.push(uci);
    }
    this.shuffle(captures);
    this.shuffle(checks);
    this.shuffle(rest);
    return [...best, ...captures, ...checks, ...rest].slice(0, limit);
  }

  // Apply a UCI move string to a FEN and return the resulting FEN, or null if illegal
  applyMove(fen, uci) {
    try {
      const g   = new Chess(fen);
      const res = g.move({ from: uci.slice(0,2), to: uci.slice(2,4), promotion: uci[4] || 'q' });
      return res ? g.fen() : null;
    } catch { return null; }
  }

  // Estimate the centipawn penalty for a move that hangs material.
  // After applying `uci` in `fen`, checks whether the moved piece is in danger:
  //   1. Immediately capturable by a cheaper piece (e.g. pawn takes knight → 200cp)
  //   2. Immediately capturable and undefended (value × 100cp)
  //   3. An enemy pawn can advance one move to attack it — in premove context
  //      the engine can't react, so this is effectively the same as hanging it
  // Returns 0 when the move appears safe.
  blunderPenalty(fen, uci) {
    const afterFen = this.applyMove(fen, uci);
    if (!afterFen) return 0;

    const g      = new Chess(afterFen);
    const target = uci.slice(2, 4);
    const moved  = g.get(target);
    if (!moved) return 0; // castling, en-passant edge cases
    const movedValue = PIECE_VALUES[moved.type] || 0;
    if (movedValue === 0) return 0; // king

    // Opponent's legal moves in this position
    const opponentMoves = g.moves({ verbose: true });

    // ── Check 1 & 2: immediate captures on the destination square ──────────
    const captures = opponentMoves.filter(m => m.to === target);
    if (captures.length) {
      const cheapest = Math.min(...captures.map(m => PIECE_VALUES[m.piece] || 0));

      // Attacker is cheaper — always a blunder (e.g. pawn takes knight)
      if (cheapest < movedValue) {
        return (movedValue - cheapest) * 100;
      }

      // Attacker is equal or more expensive — check if the piece is defended
      const cheapCapture = captures.reduce((best, m) =>
        (PIECE_VALUES[m.piece] || 0) < (PIECE_VALUES[best.piece] || 0) ? m : best
      );
      const afterCapture = this.applyMove(afterFen,
        cheapCapture.from + cheapCapture.to + (cheapCapture.promotion || ''));
      if (afterCapture) {
        const g2 = new Chess(afterCapture);
        const recaptures = g2.moves({ verbose: true }).filter(m => m.to === target);
        if (recaptures.length === 0) {
          return movedValue * 100; // undefended — captured for free
        }
      }
    }

    // ── Check 3: pawn advance threat ───────────────────────────────────────
    // Can an enemy pawn legally advance so that it attacks the piece?
    // e.g. Nf6 with a white pawn on e4: e4→e5 creates an attack on f6.
    // In premove context the engine can't dodge, so this effectively hangs
    // the piece.  Only checked for pieces (value > 1), not pawns.
    if (movedValue > 1) {
      const targetFile = target.charCodeAt(0);
      const targetRank = parseInt(target[1]);
      const pawnAdvances = opponentMoves.filter(m => m.piece === 'p' && !m.captured);

      for (const pm of pawnAdvances) {
        const advFile = pm.to.charCodeAt(0);
        const advRank = parseInt(pm.to[1]);
        if (Math.abs(advFile - targetFile) !== 1) continue;
        // White pawns attack one rank above, black pawns one rank below
        const attackRank = pm.color === 'w' ? advRank + 1 : advRank - 1;
        if (attackRank === targetRank) {
          return (movedValue - 1) * 100; // pawn(1) will attack piece
        }
      }
    }

    return 0;
  }

  // Return true if a UCI move is legal in the given FEN
  isLegal(fen, uci) {
    try {
      const g = new Chess(fen);
      return !!g.move({ from: uci.slice(0,2), to: uci.slice(2,4), promotion: uci[4] || 'q' });
    } catch { return false; }
  }

  // Return true if the side to move in the given FEN is in check
  isInCheck(fen) {
    try {
      return new Chess(fen).isCheck();
    } catch { return false; }
  }

  // Return the set of UCI moves legal for `color` in the given FEN.
  // If the FEN has the other side to move, temporarily flip the active color
  // so chess.js generates moves for the right side.
  legalMovesFor(fen, color) {
    const parts = fen.split(' ');
    if (parts[1] !== color) {
      const patched = [...parts];
      patched[1] = color;
      patched[3] = '-'; // clear en-passant square since the turn is being faked
      fen = patched.join(' ');
    }
    try {
      const g = new Chess(fen);
      return new Set(g.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || '')));
    } catch { return new Set(); }
  }

  // Fisher-Yates shuffle in place
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
}

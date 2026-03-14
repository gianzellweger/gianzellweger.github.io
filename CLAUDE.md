# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

PREMOVE is a browser-based chess game where you play against Stockfish WASM. The twist: Stockfish commits its reply move **before** the player moves ("premove"), then plays it instantly. This creates a unique dynamic where the engine must predict the human's move and choose a broadly-safe response in advance.

## Running Locally

The app requires `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers for Stockfish WASM's `SharedArrayBuffer`. Use the included server:

```
python3 server.py
# Serves on http://localhost:8000
```

Do **not** use a plain `python3 -m http.server` — the missing COOP/COEP headers will cause Stockfish to fail silently.

## Architecture

The app is a two-page static site (no build step, no bundler):

- **`index.html`** — Setup screen (color, time control, engine depth). Navigates to `game.html` with query params `?color=white&time=300&depth=10`.
- **`game.html`** — Game board. Loads `js/game.js` as an ES module entry point.

### Core Modules (`js/`)

- **`game.js`** — Orchestrator. Wires together the board (chessboard.js), chess logic (chess.js), engine, premove system, clock, history, and material display. Handles the full game lifecycle: init → player move → engine respond → premove phase → repeat.
- **`premove.js`** — The key differentiating logic. During the player's turn, computes what Stockfish should play *before* knowing the human's move. Uses iterative deepening across ranked human candidate moves. Produces a hierarchy of responses:
  1. `conditionalFor` — Map of currently-illegal responses keyed to specific human moves (e.g., recaptures)
  2. `genericPremove` — The main blind premove, chosen for broad legality across many human replies
  3. `backupPremove` — Uses a different piece than generic, in case generic's piece gets captured
  4. `checkResponseFor` — Map of responses to human checking moves
- **`engine.js`** — Stockfish WASM wrapper. Serializes searches into a queue with generation-counter cancellation to prevent stale `bestmove` results from corrupting state. Exposes `search(fen, depth)`, `searchTime(fen, ms)`, `stop()`, `bestMove(lines)`, `cpScore(lines)`.
- **`clock.js`** — Dual chess clock with 100ms tick interval. Supports unlimited mode (time=0).
- **`material.js`** — Renders captured pieces and material advantage using Unicode glyphs.
- **`history.js`** — Incremental move list renderer for the side panel.

### Vendored Libraries

- `chess.js` — Chess logic (move generation, validation, FEN). ES module import.
- `jquery.js` + `js/chessboard-1.0.0.js` — Board UI (drag-and-drop pieces). Loaded as global scripts, accessed via `Chessboard()` global.
- `stockfish.js` / `stockfish.wasm` / `stockfish.worker.js` — Stockfish WASM engine. Loaded dynamically by `engine.js` via script injection; accessed via `Stockfish()` global.

### Key Constants (tuning)

In `premove.js`: `MAX_HUMAN_MOVES` (20), `WEIGHT_DECAY` (0.72), `COVERAGE_THRESHOLD` (0.5), `ROUND_DEPTHS` ([1, 3, 6]).
In `game.js`: `FALLBACK_MOVETIME` (10000ms), `WHITE_OPENINGS` (e2e4, d2d4, c2c4, g1f3).

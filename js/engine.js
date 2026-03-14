// engine.js
// Wraps Stockfish WASM. Ensures only one search runs at a time by serialising
// requests into a queue. Handles cancellation safely via a generation counter:
// each search owns a generation ID, so any stale "bestmove" Stockfish emits
// after a stop command is silently ignored rather than corrupting the next search.

const Engine = (() => {
  let sf      = null;
  let ready   = false;
  let onReady = null; // resolves the init() promise once "readyok" arrives

  // Search queue state
  let busy   = false; // true while Stockfish is actively searching
  let queue  = [];    // functions waiting to start when the engine is free
  let gen    = 0;     // incremented on every new search and on stop()
  let cb     = null;  // resolve function for the currently active search promise
  let cbGen  = -1;    // generation that cb belongs to
  let buf    = [];    // accumulates output lines for the current search

  // Called for every line Stockfish sends back
  function onLine(line) {
    if (!line) return;

    if (line === 'uciok')   { sf.postMessage('isready'); return; }
    if (line === 'readyok') {
      ready = true;
      console.log('[Engine] Ready');
      if (onReady) { onReady(); onReady = null; }
      return;
    }

    // Only process lines belonging to the current generation.
    // A "bestmove" from a cancelled/stopped search will have a mismatched
    // generation and be dropped here, preventing result corruption.
    if (cb && cbGen === gen) {
      buf.push(line);
      if (line.startsWith('bestmove')) {
        const resolve = cb;
        const lines   = buf.slice();
        cb   = null;
        buf  = [];
        busy = false;
        resolve(lines);
        // Start the next queued search if one is waiting
        if (queue.length) queue.shift()();
      }
    } else if (line.startsWith('bestmove')) {
      console.warn('[Engine] Stale bestmove dropped (search was cancelled)');
    }
  }

  // Internal: post a search command to Stockfish and return a promise that
  // resolves with all output lines when "bestmove" arrives.
  function run(fen, command) {
    return new Promise(resolve => {
      const myGen = ++gen; // claim a generation ID for this search
      const go = () => {
        busy  = true;
        cb    = resolve;
        cbGen = myGen;
        buf   = [];
        sf.postMessage('position fen ' + fen);
        sf.postMessage(command);
      };
      if (busy) queue.push(go);
      else      go();
    });
  }

  return {
    async init() {
      // Dynamically load stockfish.js then wait for it to signal readiness
      await new Promise((res, rej) => {
        const s   = document.createElement('script');
        s.src     = './stockfish.js';
        s.onload  = res;
        s.onerror = () => rej(new Error('stockfish.js not found'));
        document.head.appendChild(s);
      });
      sf = await Stockfish();
      sf.addMessageListener(onLine);
      await new Promise(res => { onReady = res; sf.postMessage('uci'); });
    },

    isReady() { return ready; },

    // Depth-limited search — returns all UCI output lines including bestmove
    search(fen, depth) {
      return run(fen, 'go depth ' + depth);
    },

    // Time-limited search
    searchTime(fen, ms) {
      return run(fen, 'go movetime ' + ms);
    },

    // Cancel the current search and clear the queue. Resolves any waiting
    // promise with [] so the caller can unblock and check its cancelled flag.
    // Bumps the generation so Stockfish's stop-acknowledgement bestmove is dropped.
    stop() {
      queue = [];
      gen++;
      if (busy) {
        const resolve = cb;
        cb   = null;
        buf  = [];
        busy = false;
        sf.postMessage('stop');
        if (resolve) resolve([]);
      }
    },

    // Extract the best move UCI string from a set of search output lines
    bestMove(lines) {
      for (const line of lines) {
        if (line.startsWith('bestmove')) {
          const move = line.split(' ')[1];
          return (move && move !== '(none)') ? move : null;
        }
      }
      return null;
    },

    // Extract the final centipawn score from search output (side-to-move POV).
    // Forced mate is represented as ±99999.
    cpScore(lines) {
      let score = 0;
      for (const line of lines) {
        if (!line.startsWith('info')) continue;
        const mateMatch = line.match(/score mate (-?\d+)/);
        const cpMatch   = line.match(/score cp (-?\d+)/);
        if      (mateMatch) score = parseInt(mateMatch[1]) > 0 ? 99999 : -99999;
        else if (cpMatch)   score = parseInt(cpMatch[1]);
      }
      return score;
    },
  };
})();

export default Engine;

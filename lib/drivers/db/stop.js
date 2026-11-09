// STOPPING A QUERY — the part every driver shares.
//
// A query nobody is waiting for must not run (see CLAUDE.md, "No query runs
// that nobody needs"). Every driver's query() and fetchStream() take
//
//   signal      an AbortSignal: when it fires, the query is CANCELLED IN THE
//               DATABASE (each driver's own way), not just abandoned here —
//               a GROUP BY the database is still working on would otherwise
//               keep its CPU and its connection until it finished
//   timeoutMs   a time limit; past it the query is cancelled the same way
//
// and reject with one of two errors a caller can tell apart:
//
//   code QUERY_STOPPED   the signal fired; the message is its reason's
//   code QUERY_TIMEOUT   the time limit passed
//
// Neither is given: the query runs as it always did.

/** The error a stopped query rejects with. */
function stoppedError(signal) {
  var reason = signal && signal.reason;
  // abort() with no reason gives a generic AbortError: say it in our words.
  var said = reason && reason.name !== 'AbortError' && reason.message;
  var err = new Error(said || 'The query was stopped');
  err.code = 'QUERY_STOPPED';
  return err;
}

/** "45 seconds", "2 minutes" — how long a limit is, as a person says it. */
function durationText(ms) {
  var secs = Math.max(1, Math.round(ms / 1000));
  if (secs < 60) return secs + ' second' + (secs === 1 ? '' : 's');
  var mins = Math.round(secs / 60);
  return mins + ' minute' + (mins === 1 ? '' : 's');
}

/** The error a query past its time limit rejects with. */
function timeoutError(timeoutMs) {
  var err = new Error('The database stopped this query after ' + durationText(timeoutMs) +
    ', its time limit. Narrow it with a filter or a shorter date range, then run it again.');
  err.code = 'QUERY_TIMEOUT';
  return err;
}

/** A positive whole number of milliseconds, or 0 for no limit. */
function limitOf(timeoutMs) {
  var n = Math.floor(Number(timeoutMs));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Watch one query: call `cancel()` once — when `signal` fires or `timeoutMs`
 * passes, whichever is first — and remember why. `why()` is the error to
 * reject with after the database has given up the query (null: not stopped).
 * `done()` stops watching; call it in a finally.
 */
function watch(signal, timeoutMs, cancel) {
  var limit = limitOf(timeoutMs);
  var reason = null;
  var timer = null;
  function fire(err) {
    if (reason) return;
    reason = err;
    try { cancel(); } catch (_) { /* the driver's cancel reports its own failures */ }
  }
  function onAbort() { fire(stoppedError(signal)); }
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  if (limit && !reason) {
    timer = setTimeout(function() { fire(timeoutError(limit)); }, limit);
    if (timer.unref) timer.unref();
  }
  return {
    why: function() { return reason; },
    done: function() {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };
}

/** Throw now when the signal has already fired: never start a query nobody wants. */
function throwIfStopped(signal) {
  if (signal && signal.aborted) throw stoppedError(signal);
}

module.exports = { watch: watch, throwIfStopped: throwIfStopped, stoppedError: stoppedError, timeoutError: timeoutError, limitOf: limitOf, durationText: durationText };

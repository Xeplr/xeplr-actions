// Small building blocks used by spool.js. No external deps.

// Semaphore that gates concurrency to `n` (default 1).
// acquire() returns a release() function that MUST be called (finally block).
function semaphore(n) {
  var slots = n;
  var queue = [];
  return {
    async acquire() {
      if (slots > 0) { slots--; return release; }
      await new Promise(function(resolve) { queue.push(resolve); });
      slots--;
      return release;
    },
    inFlight() { return n - slots; }
  };
  function release() {
    slots++;
    var next = queue.shift();
    if (next) next();
  }
}

// Simple leaky-bucket rate limiter. `perSecond=null` disables (no-op).
function rateLimiter(perSecond) {
  if (!perSecond || perSecond <= 0) {
    return { async take(_n) { /* no-op */ } };
  }
  var tokens = perSecond;
  var lastRefill = Date.now();
  return {
    async take(n) {
      n = n || 1;
      while (true) {
        // Refill based on elapsed time.
        var now = Date.now();
        var elapsed = (now - lastRefill) / 1000;
        tokens = Math.min(perSecond, tokens + elapsed * perSecond);
        lastRefill = now;
        if (tokens >= n) { tokens -= n; return; }
        // Wait for enough tokens.
        var need = (n - tokens) / perSecond * 1000;
        await new Promise(function(r) { setTimeout(r, Math.max(1, Math.ceil(need))); });
      }
    }
  };
}

// Coarse memory tracker. Bytes added via .add(n); throws with a clear message
// when the running total crosses the ceiling. Consumer decrements via .sub()
// when a batch is released (file flushed + onBatch settled).
function memoryMonitor(maxMB) {
  if (!maxMB || maxMB <= 0) {
    return { add() {}, sub() {}, current() { return 0; } };
  }
  var ceiling = maxMB * 1024 * 1024;
  var used = 0;
  return {
    add(n) {
      used += n;
      if (used > ceiling) {
        var mb = Math.round(used / 1024 / 1024);
        throw new Error('Streaming memory ceiling exceeded: ' + mb + 'MB > ' + maxMB + 'MB (raise maxMemoryMB or lower batchSize)');
      }
    },
    sub(n) { used = Math.max(0, used - n); },
    current() { return used; }
  };
}

// Serialize a row to a NDJSON line. Replaces embedded newlines so each row is
// exactly one line — the invariant `readNDJSONLines` relies on.
function toNDJSON(row) {
  return JSON.stringify(row).replace(/\r?\n/g, ' ') + '\n';
}

module.exports = {
  semaphore: semaphore,
  rateLimiter: rateLimiter,
  memoryMonitor: memoryMonitor,
  toNDJSON: toNDJSON
};

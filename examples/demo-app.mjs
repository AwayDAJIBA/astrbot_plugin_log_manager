// Demo app used by README screenshots / quick start. Prints fake access logs.
let i = 0;
console.log('[INFO] demo-app started');
setInterval(() => {
  i += 1;
  const ms = 20 + ((i * 37) % 180);
  console.log('[INFO] request #' + i + ' handled in ' + ms + 'ms');
  if (i % 5 === 0) console.warn('[WARN] demo cache miss for /api/items/' + i);
  if (i % 11 === 0) console.error('[ERROR] demo upstream timeout (simulated)');
}, 900);

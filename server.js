// Entry point. Kept free of top-level await so hosts that load it with require()
// (LiteSpeed/Passenger on shared hosting) can start it too; server.cjs is the CommonJS launcher.
import http from 'node:http';

const REQUIRED_ENV = ['SESSION_SECRET', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'BASE_URL'];

async function start() {
  const { config } = await import('./src/config.js');
  const { migrate } = await import('./src/migrate.js');
  const { bootstrap } = await import('./src/bootstrap.js');
  const { createApp } = await import('./src/app.js');

  if (config.autoMigrate) await migrate();
  // first deploy on hosting without SSH: load the programme and create the first admin from env vars
  await bootstrap();

  createApp().listen(config.port, () => {
    console.log(`9 TO 9 MEET running on port ${config.port} (${config.baseUrl})`);
  });
}

/**
 * When startup fails, serve a plain "setup problem" page instead of exiting, so the cause is visible
 * without server logs. It names missing variables and the error type, never any values.
 */
function serveSetupError(err) {
  const missing = process.env.NODE_ENV === 'production' ? REQUIRED_ENV.filter((k) => !process.env[k]) : [];
  const message = String(err?.message || err)
    .replace(/'[^']*'/g, "'…'") // hide user names, database names and paths
    .slice(0, 300);
  const hints = {
    ER_ACCESS_DENIED_ERROR: 'The database user name or password is wrong (DB_USER / DB_PASSWORD).',
    ER_BAD_DB_ERROR: 'The database does not exist — check DB_NAME, including the u123456789_ prefix.',
    ECONNREFUSED: 'Cannot reach the database server — check DB_HOST (usually localhost) and DB_PORT.',
    ENOTFOUND: 'The database host name is wrong — check DB_HOST.',
    ER_DBACCESS_DENIED_ERROR: 'The database user has no access to this database — add the user to the database in hPanel.',
  };
  const hint = hints[err?.code] || (missing.length ? 'Add the missing environment variables in the Node.js app settings and restart.' : 'See the app log for details.');
  // safe clues for database login failures: short previews only, never the password
  const env = process.env;
  const t = (v) => (typeof v === 'string' ? v.trim() : '');
  const preview = (v) => (v ? `${v.slice(0, 5)}… (${v.length} chars)` : '(not set)');
  const denied = /Access denied for user '([^']*)'@'([^']*)'(?: \(using password: (YES|NO)\))?/.exec(err?.message || '');
  const clues = err?.code && /^(ER_|ECONN|ENOTFOUND|ETIMEDOUT)/.test(err.code) ? [
    ['Connecting to', t(env.DB_SOCKET) ? `socket ${t(env.DB_SOCKET)}` : `${t(env.DB_HOST) || 'localhost'}:${t(env.DB_PORT) || 3306}`],
    ['MySQL saw the app connecting from', denied ? denied[2] : '—'],
    ['Password sent', denied ? denied[3] : (t(env.DB_PASSWORD) ? 'YES' : 'NO')],
    ['DB_USER', `${preview(t(env.DB_USER))} ${/^u\d+_/.test(t(env.DB_USER)) ? '✓ has Hostinger prefix' : '✗ no u123…_ prefix'}`],
    ['DB_NAME', `${preview(t(env.DB_NAME))} ${/^u\d+_/.test(t(env.DB_NAME)) ? '✓ has Hostinger prefix' : '✗ no u123…_ prefix'}`],
    ['Stray spaces in', ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].filter((k) => typeof env[k] === 'string' && env[k] !== env[k].trim()).join(', ') || 'none'],
  ] : [];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Setup needed · 9 TO 9 Meet</title>
<style>body{font:16px/1.6 system-ui,sans-serif;background:#f2f3f5;color:#3b4450;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}
main{background:#fff;border-radius:10px;padding:28px;max-width:640px;box-shadow:0 10px 30px rgb(0 0 0/.08)}h1{color:#525f6d;margin-top:0}
code{background:#eef0f3;padding:2px 6px;border-radius:4px}li{margin:4px 0}</style></head><body><main>
<h1>9 TO 9 Meet is not running yet</h1><p>The application could not start. This page is shown instead so the problem is visible.</p>
${missing.length ? `<p><strong>Missing environment variables:</strong></p><ul>${missing.map((k) => `<li><code>${k}</code></li>`).join('')}</ul>` : ''}
<p><strong>Error:</strong> <code>${esc(err?.code || err?.name || 'Error')}</code> — ${esc(message)}</p>
<p><strong>What to do:</strong> ${esc(hint)}</p>
${clues.length ? `<p><strong>Database connection details</strong> (no passwords shown):</p><ul>${clues.map(([k, v]) => `<li>${esc(k)}: <code>${esc(v)}</code></li>`).join('')}</ul>
<p>If the names look right, reset the database user's password in hPanel → Databases, paste it into <code>DB_PASSWORD</code>, and check that the user is linked to the database.</p>` : ''}
</main></body></html>`;
  const port = Number(process.env.PORT || 3000);
  http.createServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '60', 'Cache-Control': 'no-store' });
    res.end(html);
  }).listen(port, () => console.log(`Setup error page listening on port ${port}`));
}

start().catch((err) => {
  console.error('STARTUP FAILED:', err);
  serveSetupError(err);
});

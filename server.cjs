// CommonJS launcher for hosts that start Node apps with require() (e.g. LiteSpeed on Hostinger).
// The app itself is an ES module, so load it with a dynamic import.
import('./server.js').catch((err) => {
  console.error('Could not load server.js:', err);
  process.exitCode = 1;
});

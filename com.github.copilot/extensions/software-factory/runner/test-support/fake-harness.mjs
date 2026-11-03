// Fake harness CLI: echoes argv + stdin as JSON. FAKE_MODE=fail|hang changes behavior.
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const mode = process.env.FAKE_MODE;
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'fail') { process.stderr.write('boom'); process.exit(3); }
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin }));
});
if (process.env.FAKE_MODE === 'hang') setInterval(() => {}, 1000);

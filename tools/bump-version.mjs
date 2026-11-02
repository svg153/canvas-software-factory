// Bumps plugin.json + extension package.json and adds a CHANGELOG stub.
// Usage: node tools/bump-version.mjs <patch|minor|major|x.y.z> [root]
import fs from 'node:fs';
import path from 'node:path';

const [, , arg, rootArg] = process.argv;
const root = path.resolve(rootArg || '.');
const files = ['plugin.json', 'com.github.copilot/extensions/software-factory/package.json'];

const current = JSON.parse(fs.readFileSync(path.join(root, files[0]), 'utf8')).version;
const [maj, min, pat] = current.split('.').map(Number);
const next = { patch: `${maj}.${min}.${pat + 1}`, minor: `${maj}.${min + 1}.0`, major: `${maj + 1}.0.0` }[arg]
  ?? (/^\d+\.\d+\.\d+$/.test(arg || '') ? arg : null);
if (!next) { console.error('Usage: bump-version.mjs <patch|minor|major|x.y.z> [root]'); process.exit(2); }

for (const f of files) {
  const p = path.join(root, f);
  const text = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`));
}
const cl = path.join(root, 'CHANGELOG.md');
const changelog = fs.readFileSync(cl, 'utf8');
fs.writeFileSync(cl, changelog.replace(/^# Changelog\s*\n/, `# Changelog\n\n## v${next}\n\n### Changed\n- TODO: describe this release.\n`));
console.log(next);
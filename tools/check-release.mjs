// Release gate: versions agree, CHANGELOG has the section, skill is present.
// Usage: node tools/check-release.mjs [root]   (prints the version on success)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(process.argv[2] || '.');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const errors = [];

const plugin = readJson('plugin.json');
const pkg = readJson('com.github.copilot/extensions/software-factory/package.json');
const meta = readJson('canvas-meta.json');
const version = plugin.version;

if (!/^\d+\.\d+\.\d+$/.test(version || '')) errors.push(`plugin.json version is not semver: ${version}`);
if (pkg.version !== version) errors.push(`package.json version ${pkg.version} != plugin.json ${version}`);
if (meta.version && meta.version !== version) errors.push(`canvas-meta.json version ${meta.version} != plugin.json ${version}`);

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const heading = new RegExp(`^## v?${version.replace(/\./g, '\\.')}\\s*$`, 'm');
if (!heading.test(changelog)) errors.push(`CHANGELOG.md has no "## v${version}" section`);

const skillPath = path.join(root, 'skills/software-factory/SKILL.md');
if (!fs.existsSync(skillPath)) errors.push('skills/software-factory/SKILL.md is missing');
else {
  const skill = fs.readFileSync(skillPath);
  if (!skill.toString('utf8').startsWith('---')) errors.push('SKILL.md lacks frontmatter');
  console.error(`skill sha256 ${crypto.createHash('sha256').update(skill).digest('hex')}`);
}

if (errors.length) {
  for (const e of errors) console.error(`ERROR: ${e}`);
  process.exit(1);
}
console.log(version);
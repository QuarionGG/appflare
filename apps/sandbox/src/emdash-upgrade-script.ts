/** The build may regenerate this tracked output, but must not change its configuration. */
export function validateDerivedEmdashManifest(
  originalText: string,
  generatedText: string,
  identity: { emdashVersion: string; names: readonly string[]; fingerprint: string },
): void {
  const original = JSON.parse(originalText);
  const generated = JSON.parse(generatedText);
  if (
    original === null ||
    typeof original !== "object" ||
    original.schemaVersion !== 1 ||
    original.migrationSet === null ||
    typeof original.migrationSet !== "object" ||
    !/^[0-9a-f]{64}$/.test(identity.fingerprint)
  ) {
    throw new Error("The generated migration manifest cannot be verified");
  }
  const expected = {
    ...original,
    emdashVersion: identity.emdashVersion,
    migrationSet: {
      ...original.migrationSet,
      names: [...identity.names],
      fingerprint: identity.fingerprint,
    },
  };
  function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, sorted(item)]),
      );
    }
    return value;
  }
  if (JSON.stringify(sorted(expected)) !== JSON.stringify(sorted(generated))) {
    throw new Error(
      "The build changed migration database/configuration beyond the generated core identity",
    );
  }
}

/** Runs only in the credential-free build container, outside the repository. */
export const EMDASH_UPGRADE_SCRIPT = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = '/workspace/appflare-build/source';
const statePath = '/workspace/appflare-build/emdash-before.json';
const snapshotPath = '/workspace/appflare-build/emdash-package-before.json';
const requireProject = createRequire(path.join(root, 'package.json'));
const allowed = ['package.json', 'pnpm-lock.yaml'];
const target = process.argv[3];
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const pkgPath = path.join(root, 'package.json');
const installed = (name) => json(path.join(root, 'node_modules', name, 'package.json'));
const fail = (message) => { throw new Error(message); };
const out = (value) => process.stdout.write(JSON.stringify(value));
function regular(file) {
  const stat = fs.lstatSync(path.join(root, file));
  if (!stat.isFile() || stat.isSymbolicLink()) fail(file + ' must be a regular file');
  if (stat.size > 2 * 1024 * 1024) fail(file + ' exceeds the 2 MiB limit');
  return stat;
}
function coreEntries(pkg) {
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies'];
  return ['emdash', '@emdash-cms/cloudflare'].map((name) => {
    const found = sections.filter((section) => Object.hasOwn(pkg[section] || {}, name));
    if (found.length !== 1) fail(name + ' must appear in exactly one direct dependency section');
    const section = found[0];
    const spec = pkg[section][name];
    if (typeof spec !== 'string' || !/^[~^]?\d+\.\d+\.\d+$/.test(spec)) {
      fail(name + ' must use a stable exact, caret or tilde version');
    }
    return {name, section, spec};
  });
}
// Strip comments without changing quoted content, then trailing JSONC commas.
function jsonc(text) {
  let result = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (quoted) {
      result += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; result += c; }
    else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      result += '\n';
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      result += ' ';
    } else result += c;
  }
  // No regex over strings: only remove a comma followed by whitespace and a closing token.
  let clean = ''; quoted = false; escaped = false;
  for (let i = 0; i < result.length; i++) {
    const c = result[i];
    if (quoted) {
      clean += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; clean += c; }
    else if (c === ',' && /^[\s]*[}\]]/.test(result.slice(i + 1))) continue;
    else clean += c;
  }
  return JSON.parse(clean);
}
function plugins(pkg) {
  const names = [...new Set(['dependencies', 'devDependencies', 'optionalDependencies']
    .flatMap((section) => Object.keys(pkg[section] || {})))].sort();
  const found = [];
  for (const name of names) {
    if (name === 'emdash' || name === '@emdash-cms/cloudflare') continue;
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) fail('Invalid dependency name');
    const meta = installed(name);
    const directory = path.join(root, 'node_modules', name);
    const manifestFile = ['emdash-plugin.json', 'emdash-plugin.jsonc']
      .map((file) => path.join(directory, file)).find((file) => fs.existsSync(file));
    const peer = meta.peerDependencies?.emdash;
    let manifestRange;
    if (manifestFile) {
      if (fs.statSync(manifestFile).size > 256 * 1024) fail(name + ' plugin manifest is too large');
      manifestRange = jsonc(fs.readFileSync(manifestFile, 'utf8')).release?.requires?.['env:emdash'];
    }
    if (peer === undefined && !manifestFile && !name.startsWith('@emdash-cms/plugin-')) continue;
    const ranges = [...new Set([peer, manifestRange].filter((value) => value !== undefined))];
    if (ranges.some((value) => typeof value !== 'string' || value.length > 512)) {
      fail(name + ' has an invalid EmDash compatibility range');
    }
    found.push({name, version: meta.version, ranges});
  }
  return found;
}
async function identity() {
  const module = await import(pathToFileURL(requireProject.resolve('emdash/migrations')).href);
  return await module.getCoreMigrationIdentity();
}
function preflight() {
  for (const file of allowed) regular(file);
  execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', ...allowed], {stdio:'pipe'});
  const pkg = json(pkgPath);
  const workspaceFile = path.join(root, 'pnpm-workspace.yaml');
  let workspaceProject = Boolean(pkg.workspaces);
  if (fs.existsSync(workspaceFile)) {
    // pnpm also stores root-only supply-chain policy here. Accept those
    // settings unchanged, while refusing package lists, catalogs, YAML
    // aliases/flow mappings and unknown root keys that could hide a workspace.
    const stat = fs.lstatSync(workspaceFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) {
      fail('pnpm-workspace.yaml must be a small regular configuration file');
    }
    const lines = fs.readFileSync(workspaceFile, 'utf8').split(/\r?\n/)
      .filter((line) => line.trim() && !line.trimStart().startsWith('#'));
    const policyKeys = new Set(['allowBuilds','minimumReleaseAge','minimumReleaseAgeExclude','blockExoticSubdeps']);
    const indent = lines.length ? Math.min(...lines.map((line) => /^ */.exec(line)[0].length)) : 0;
    for (const line of lines) {
      if (line.includes('\t')) workspaceProject = true;
      if (/^ */.exec(line)[0].length !== indent) continue;
      const key = /^([A-Za-z][A-Za-z0-9]*):(?:\s|$)/.exec(line.slice(indent))?.[1];
      if (!key || !policyKeys.has(key)) workspaceProject = true;
    }
  }
  if (workspaceProject) {
    fail('This updater supports a single root pnpm project; workspaces require a manual upgrade');
  }
  if (!/^pnpm@\d+\.\d+\.\d+(?:\+.+)?$/.test(pkg.packageManager || '')) {
    fail('This updater requires a pinned pnpm packageManager at the repository root');
  }
  if (['package-lock.json','yarn.lock','bun.lock','bun.lockb'].some((file) => fs.existsSync(path.join(root,file)))) {
    fail('Multiple package manager lockfiles are not supported');
  }
  if (typeof pkg.scripts?.build !== 'string' || !pkg.scripts.build.trim()) fail('A root build script is required');
  coreEntries(pkg);
  fs.copyFileSync(pkgPath, snapshotPath);
  out({ready:true});
}
if (process.argv[2] === 'preflight') preflight();
else if (process.argv[2] === 'before') {
  const core = installed('emdash'), adapter = installed('@emdash-cms/cloudflare');
  if (core.version !== adapter.version) fail('EmDash and its Cloudflare adapter must start at the same version');
  const state = {fromVersion:core.version, identity:await identity(), plugins:plugins(json(pkgPath))};
  fs.writeFileSync(statePath, JSON.stringify(state));
  out(state);
} else if (process.argv[2] === 'mutate') {
  if (!/^\d+\.\d+\.\d+$/.test(target || '')) fail('A stable exact target version is required');
  const pkg = json(snapshotPath);
  for (const entry of coreEntries(pkg)) {
    const prefix = /^[~^]/.exec(entry.spec)?.[0] || '';
    pkg[entry.section][entry.name] = prefix + target;
  }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  out({changed:true});
} else if (process.argv[2] === 'after') {
  for (const file of allowed) regular(file);
  const core = installed('emdash'), adapter = installed('@emdash-cms/cloudflare');
  if (core.version !== target || adapter.version !== target) fail('Installed versions differ from the approved exact target');
  const afterIdentity = await identity();
  const changedPaths = () => execFileSync('git', ['-C',root,'diff','--name-only','-z','HEAD','--'], {encoding:'utf8'})
    .split('\0').filter(Boolean);
  const changed = changedPaths();
  const derived = '.emdash/migrations.json';
  let derivedManifest = null;
  if (changed.some((file) => !allowed.includes(file) && file !== derived)) {
    fail('The upgrade changed files outside package.json and pnpm-lock.yaml: ' + changed.join(', '));
  }
  if (changed.includes(derived)) {
    if (regular(derived).size > 65536) fail('The generated migration manifest is too large to verify');
    const originalManifest = execFileSync('git', ['-C',root,'show','HEAD:' + derived], {encoding:'utf8'});
    if (Buffer.byteLength(originalManifest) > 65536) fail('The original migration manifest is too large to verify');
    derivedManifest = {originalText:originalManifest,generatedText:fs.readFileSync(path.join(root,derived),'utf8')};
  }
  const sourceChanges = changed.filter((file) => file !== derived);
  if (sourceChanges.length !== 2 || sourceChanges.some((file) => !allowed.includes(file))) {
    fail('The upgrade changed files outside package.json and pnpm-lock.yaml: ' + changed.join(', '));
  }
  const modes = execFileSync('git', ['-C',root,'diff','--summary','HEAD','--'], {encoding:'utf8'});
  if (modes.trim()) fail('The upgrade changed tracked file modes or file types');
  const before = json(snapshotPath), actual = json(pkgPath), expected = structuredClone(before);
  for (const entry of coreEntries(before)) {
    expected[entry.section][entry.name] = (/^[~^]/.exec(entry.spec)?.[0] || '') + target;
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('package.json changed beyond the two approved dependency versions');
  }
  const original = json(statePath), currentPlugins = plugins(actual);
  if (JSON.stringify(original.plugins) !== JSON.stringify(currentPlugins)) {
    fail('Installed plugin versions or compatibility requirements changed; review them manually');
  }
  out({before:original, afterMigrations:afterIdentity, plugins:currentPlugins, derivedManifest,
    sizes:Object.fromEntries(allowed.map((file) => [file,regular(file).size]))});
} else if (process.argv[2] === 'restore-derived') {
  const derived = '.emdash/migrations.json';
  regular(derived);
  // The trusted Worker has verified that only generated identity fields
  // changed. A normal source build regenerates the target manifest again.
  execFileSync('git', ['-C',root,'checkout','HEAD','--',derived], {stdio:'pipe'});
  out({restored:true});
} else if (process.argv[2] === 'verify-diff') {
  const changed = execFileSync('git', ['-C',root,'diff','--name-only','-z','HEAD','--'], {encoding:'utf8'})
    .split('\0').filter(Boolean);
  if (changed.length !== 2 || changed.some((file) => !allowed.includes(file))) {
    fail('The upgrade changed files outside package.json and pnpm-lock.yaml: ' + changed.join(', '));
  }
  const modes = execFileSync('git', ['-C',root,'diff','--summary','HEAD','--'], {encoding:'utf8'});
  if (modes.trim()) fail('The upgrade changed tracked file modes or file types');
  out({verified:true});
} else if (process.argv[2] === 'read') {
  const file = process.argv[3], offset = Number(process.argv[4]);
  if (!allowed.includes(file) || !Number.isSafeInteger(offset) || offset < 0) fail('Invalid file read');
  regular(file);
  out(fs.readFileSync(path.join(root,file)).subarray(offset,offset+65536).toString('base64'));
} else fail('Unknown upgrade step');
`;

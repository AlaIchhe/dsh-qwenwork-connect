import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function fail(message) {
  failures.push(message);
}

async function walkFiles(dir, exts) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full, exts)));
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function memberNameOf(node) {
  if (!node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) {
    return node.name.text;
  }
  return null;
}

function hasPrivateModifier(node) {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword));
}

async function checkNoPrivateAccessInTests() {
  const srcFiles = await walkFiles(path.join(rootDir, 'src'), ['.ts', '.tsx']);
  const privateMethodDecls = new Map();
  const publicNames = new Set();

  for (const file of srcFiles) {
    const text = await fs.readFile(file, 'utf8');
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);

    const visit = (node) => {
      if (ts.isClassLike(node)) {
        for (const member of node.members) {
          const name = memberNameOf(member);
          if (!name) continue;
          if (ts.isMethodDeclaration(member) && hasPrivateModifier(member)) {
            if (!privateMethodDecls.has(name)) {
              const { line } = sf.getLineAndCharacterOfPosition(member.getStart(sf));
              privateMethodDecls.set(name, `${path.relative(rootDir, file)}:${line + 1}`);
            }
          } else if (
            ts.isMethodDeclaration(member) ||
            ts.isPropertyDeclaration(member) ||
            ts.isGetAccessorDeclaration(member) ||
            ts.isSetAccessorDeclaration(member)
          ) {
            publicNames.add(name);
          }
        }
      } else if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
        for (const member of node.members) {
          const name = memberNameOf(member);
          if (name) publicNames.add(name);
        }
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        publicNames.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  for (const name of publicNames) {
    privateMethodDecls.delete(name);
  }

  const testFiles = await walkFiles(path.join(rootDir, 'tests'), ['.js', '.mjs', '.cjs', '.ts', '.mts']);
  for (const file of testFiles) {
    const text = await fs.readFile(file, 'utf8');
    const kind = file.endsWith('.ts') || file.endsWith('.mts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);

    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        let calledName = null;
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.expression.kind !== ts.SyntaxKind.ThisKeyword
        ) {
          calledName = callee.name.text;
        } else if (
          ts.isElementAccessExpression(callee) &&
          callee.expression.kind !== ts.SyntaxKind.ThisKeyword &&
          callee.argumentExpression &&
          ts.isStringLiteral(callee.argumentExpression)
        ) {
          calledName = callee.argumentExpression.text;
        }

        if (calledName && privateMethodDecls.has(calledName)) {
          const { line } = sf.getLineAndCharacterOfPosition(callee.getStart(sf));
          const relTest = path.relative(rootDir, file);
          fail(
            `[private-access] ${relTest}:${line + 1} calls private method "${calledName}()" (declared at ${privateMethodDecls.get(calledName)}). Test through public APIs instead.`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

async function checkBuildExportsAndBin() {
  const pkgRaw = await fs.readFile(path.join(rootDir, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgRaw);

  const targets = new Set();
  if (typeof pkg.main === 'string') targets.add(pkg.main);
  if (typeof pkg.bin === 'string') {
    targets.add(pkg.bin);
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const rel of Object.values(pkg.bin)) {
      if (typeof rel === 'string') targets.add(rel);
    }
  }
  if (pkg.exports && typeof pkg.exports === 'object') {
    for (const val of Object.values(pkg.exports)) {
      if (typeof val === 'string' && !val.includes('*')) {
        targets.add(val);
      }
    }
  }

  for (const rel of targets) {
    const abs = path.resolve(rootDir, rel);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size === 0) {
        fail(`[package-exports] Missing or empty target file: ${rel}`);
      }
    } catch {
      fail(`[package-exports] Missing target file declared in package.json: ${rel}`);
    }
  }

  const cliPath = path.join(rootDir, 'dist/cli/login.mjs');
  try {
    const [stat, head] = await Promise.all([
      fs.stat(cliPath),
      fs.readFile(cliPath, 'utf8'),
    ]);
    if (!head.startsWith('#!/usr/bin/env node\n')) {
      fail('[cli-bin] dist/cli/login.mjs must start with #!/usr/bin/env node');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) {
      fail('[cli-bin] dist/cli/login.mjs must be executable');
    }
  } catch {
    fail('[cli-bin] dist/cli/login.mjs not found');
  }
}

function collectLocaleKeys(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...collectLocaleKeys(v, next));
    } else {
      if (typeof v !== 'string' || v.trim() === '') {
        fail(`[locale] Empty or non-string value for key "${next}"`);
      }
      keys.push(next);
    }
  }
  return keys.sort();
}

async function checkLocales() {
  const enRaw = await fs.readFile(path.join(rootDir, 'locale/en.json'), 'utf8');
  const zhRaw = await fs.readFile(path.join(rootDir, 'locale/zh.json'), 'utf8');
  const enKeys = collectLocaleKeys(JSON.parse(enRaw));
  const zhKeys = collectLocaleKeys(JSON.parse(zhRaw));

  const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));
  const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
  if (missingInZh.length > 0) {
    fail(`[locale] Keys missing in locale/zh.json: ${missingInZh.join(', ')}`);
  }
  if (missingInEn.length > 0) {
    fail(`[locale] Keys missing in locale/en.json: ${missingInEn.join(', ')}`);
  }
}

function checkNpmPackManifest() {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json', '--silent'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(stdout);
  const files = new Set((parsed?.[0]?.files ?? []).map((f) => f.path));

  const required = [
    'package.json',
    'README.md',
    'LICENSE',
    'cordis.patch.yml',
    'icon.svg',
    'locale/en.json',
    'locale/zh.json',
    'dist/host/index.js',
    'dist/client/index.js',
    'dist/core/index.js',
    'dist/cli/login.mjs',
  ];
  for (const req of required) {
    if (!files.has(req)) {
      fail(`[npm-pack] Required file missing from published tarball: ${req}`);
    }
  }

  const forbiddenPatterns = [
    /^\.dsh\//,
    /^\.env(\.|$)/,
    /^tests\//,
    /^src\//,
    /\.(pem|key|p12)$/i,
    /qwenwork-(desktop|global)\.json$/i,
  ];
  for (const file of files) {
    if (forbiddenPatterns.some((re) => re.test(file))) {
      fail(`[npm-pack] Forbidden file included in tarball: ${file}`);
    }
  }
}

async function main() {
  await Promise.all([
    checkNoPrivateAccessInTests(),
    checkBuildExportsAndBin(),
    checkLocales(),
  ]);
  checkNpmPackManifest();

  if (failures.length > 0) {
    console.error('Repository verification failed:');
    for (const msg of failures) {
      console.error(`  - ${msg}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Repository verification passed (private-access, package-exports, locales, npm-pack).');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

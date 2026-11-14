/**
 * 发布到 npmjs 的辅助脚本。
 *
 * 处理发布前的检查，并给出明确的失败原因（尤其是 2FA / token 权限问题）。
 *
 * 用法：
 *   node scripts/publish-npm.mjs              # 发布当前版本
 *   node scripts/publish-npm.mjs --dry        # 只检查，不发
 *   node scripts/publish-npm.mjs --otp 123456  # 带一次性密码（账号开了 2FA 时）
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const otpIndex = args.indexOf('--otp');
const otp = otpIndex >= 0 ? args[otpIndex + 1] : null;

const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { cwd: root, encoding: 'utf8', stdio: opts.stdio ?? 'pipe', ...opts });

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

console.log(`包名     : ${pkg.name}`);
console.log(`版本     : ${pkg.version}`);
console.log(`registry : ${pkg.publishConfig?.registry ?? '(未配置)'}`);
console.log(`access   : ${pkg.publishConfig?.access ?? '(默认)'}`);

// ---------- 1. 前置检查 ----------
if (pkg.name.startsWith('@')) {
  console.error('\n✗ 当前是作用域包，npmjs 上作用域包默认私有，需要额外确认。脚本按无作用域包设计。');
  process.exit(1);
}

if (!pkg.publishConfig || pkg.publishConfig.registry !== 'https://registry.npmjs.org') {
  console.error('\n✗ publishConfig.registry 不是 npmjs 官方源，发布目标可能不对。');
  process.exit(1);
}

for (const f of ['dist/index.js', 'dist/index.d.ts', 'dist/pdf-h5-react.css']) {
  if (!existsSync(join(root, f))) {
    console.error(`\n✗ 缺少构建产物 ${f}，请先 npm run build`);
    process.exit(1);
  }
}
console.log('产物     : 齐全');

// ---------- 2. 登录态 ----------
let whoami = '';
try {
  whoami = run('npm', ['whoami']).trim();
  console.log(`登录用户 : ${whoami}`);
} catch {
  console.error('\n✗ 未登录 npmjs，请先 npm login');
  process.exit(1);
}

// ---------- 3. 判断包名占用 ----------
try {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`, {
    headers: { 'User-Agent': 'pdf-h5-react-publish' },
  });
  if (res.ok) {
    const meta = await res.json();
    const versions = Object.keys(meta.versions ?? {});
    const exists = versions.includes(pkg.version);
    console.log(`包状态   : 已存在（${versions.length} 个版本${exists ? `，含 ${pkg.version}` : ''}）`);
    if (exists) {
      console.error(`\n✗ 版本 ${pkg.version} 已发布过，请先升级版本号（npm version patch）`);
      process.exit(1);
    }
  } else if (res.status === 404) {
    console.log('包状态   : 首次发布（名字可用）');
  }
} catch {
  console.log('包状态   : 查询失败（跳过检查）');
}

// ---------- 4. 发布 ----------
if (dryRun) {
  console.log('\n(--dry) 跳过实际发布');
  process.exit(0);
}

console.log('\n开始发布…');
const publishArgs = ['publish'];
if (otp) publishArgs.push('--otp', otp);

try {
  const out = run('npm', publishArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(out);
  console.log(`\n✓ 发布成功：https://www.npmjs.com/package/${pkg.name}`);
} catch (error) {
  const stderr = (error.stderr?.toString?.() ?? '') + (error.stdout?.toString?.() ?? '');
  if (stderr.includes('Two-factor') || stderr.includes('EOTP') || stderr.includes('2fa')) {
    console.error(
      [
        '',
        '✗ 发布被 2FA 拦截。你的 npm 账号开启了两步验证，发布需要以下任一条件：',
        '',
        '  方案 A（推荐）：创建带 bypass 2FA 的 Granular Access Token',
        '    1. 打开 https://www.npmjs.com/settings/~/tokens/granular-access-tokens/new',
        '    2. Permissions 选 Read and write',
        '    3. 勾选 "Bypass 2FA"（关键）',
        '    4. 生成后写入用户 .npmrc：',
        '         //registry.npmjs.org/:_authToken=<新token>',
        '    5. 重新运行本脚本',
        '',
        '  方案 B：发布时带上一次性密码',
        `         node scripts/publish-npm.mjs --otp 123456`,
        '',
        '  方案 C：在 npmjs 网页端关闭 2FA（不推荐，会降低账号安全性）',
      ].join('\n'),
    );
  } else if (stderr.includes('E403') || stderr.includes('403')) {
    console.error('\n✗ 403 无权限。确认 token 有 read/write 权限，且包名未被他人占用。');
    console.error(stderr.split('\n').slice(0, 6).join('\n'));
  } else {
    console.error('\n✗ 发布失败：');
    console.error(stderr.split('\n').slice(0, 15).join('\n'));
  }
  process.exit(1);
}

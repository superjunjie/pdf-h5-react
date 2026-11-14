/**
 * 推送并触发发布的收尾脚本。
 *
 * 前提：GitHub 上已存在空仓库 superjunjie/pdf-h5-react。
 * 该脚本只做「联网 + git」动作，不做任何构建；构建与发布由 GitHub Actions 完成。
 *
 * 用法：
 *   node scripts/publish-gh.mjs              # 推送 main
 *   node scripts/publish-gh.mjs --tag 0.1.0  # 推送 main 并打 v0.1.0 tag 触发发布
 *   node scripts/publish-gh.mjs --dry        # 只检查前置条件，不做任何写操作
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const tagIndex = args.indexOf('--tag');
const explicitTag = tagIndex >= 0 ? args[tagIndex + 1] : null;

const OWNER = 'superjunjie';
const REPO = 'pdf-h5-react';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

function run(cmd, argv, options = {}) {
  return execFileSync(cmd, argv, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20' },
  });
}

function log(msg) {
  console.log(msg);
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

// ---------- 1. 读取本地版本 ----------
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
log(`包名   : ${pkg.name}`);
log(`版本   : ${pkg.version}`);
log(`registry: ${pkg.publishConfig?.registry ?? '(未配置)'}`);

// ---------- 2. 前置检查：仓库是否已创建 ----------
log('\n[1/4] 检查远端仓库…');
let repoInfo = null;
try {
  const res = await fetch(API, { headers: { 'User-Agent': 'pdf-h5-react-publish', Accept: 'application/vnd.github+json' } });
  if (res.status === 404) {
    fail(
      [
        '仓库尚未创建：' + `https://github.com/${OWNER}/${REPO} 返回 404`,
        '',
        '请先在网页上创建【空】仓库（不要勾 README / .gitignore / LICENSE）：',
        '  https://github.com/new',
        `  Repository name: ${REPO}`,
        '  Visibility: Public',
        '',
        '创建完成后重新运行：node scripts/publish-gh.mjs --tag ' + pkg.version,
      ].join('\n'),
    );
  }
  if (!res.ok) fail(`GitHub API 返回 ${res.status}`);
  repoInfo = await res.json();
  log(`      ✓ ${repoInfo.full_name} (${repoInfo.private ? 'private' : 'public'})`);
  if (repoInfo.size > 0) {
    log(`      ! 仓库已有内容（size=${repoInfo.size}KB），将尝试直接推送，若有历史冲突需手动处理`);
  }
} catch (error) {
  if (String(error.message).includes('仓库尚未创建')) throw error;
  fail(`访问 GitHub API 失败：${error.message}`);
}

// ---------- 3. 检查工作区干净 ----------
log('\n[2/4] 检查工作区…');
const status = run('git', ['status', '--porcelain']).trim();
if (status) {
  log('      有待提交改动：');
  log(status.split('\n').map((l) => '        ' + l).join('\n'));
  fail('请先提交或 stash，避免推送不完整的状态');
}
log('      ✓ 工作区干净');

const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
log(`      当前分支：${branch}`);
if (branch !== 'main') log('      ! 当前不是 main，推送时会显式推到 main');

// ---------- 4. 推送 ----------
log('\n[3/4] 推送代码…');
if (dryRun) {
  log('      (--dry) 跳过实际推送');
} else {
  try {
    const out = run('git', ['push', '-u', 'origin', `HEAD:main`], { stdio: ['ignore', 'pipe', 'pipe'] });
    log('      ✓ 推送完成');
    if (out.trim()) log(out.trim().split('\n').map((l) => '        ' + l).join('\n'));
  } catch (error) {
    const stderr = error.stderr?.toString?.() ?? '';
    if (stderr.includes('non-fast-forward') || stderr.includes('fetch first')) {
      fail(
        [
          '远端已有提交，与本地历史冲突。',
          '若远端是新建的空仓库，请确认没有勾选 README / license 初始化文件。',
          '确认后可用：git push -u origin HEAD:main --force',
        ].join('\n'),
      );
    }
    fail(`推送失败：${stderr || error.message}`);
  }
}

// ---------- 5. 打 tag 触发发布 ----------
const tag = explicitTag ? `v${explicitTag.replace(/^v/, '')}` : null;
log('\n[4/4] 打 tag 触发发布…');
if (!tag) {
  log('      未指定 --tag，跳过。需要发布时运行：');
  log(`        node scripts/publish-gh.mjs --tag ${pkg.version}`);
} else {
  const expected = `v${pkg.version}`;
  if (tag !== expected) {
    fail(`tag ${tag} 与 package.json 版本 (${pkg.version}) 不一致，CI 会拒绝发布。请先改版本号或使用 --tag ${pkg.version}`);
  }
  if (dryRun) {
    log(`      (--dry) 将创建并推送 tag ${tag}`);
  } else {
    const exists = (() => {
      try {
        return run('git', ['tag', '--list', tag]).trim() === tag;
      } catch {
        return false;
      }
    })();
    if (!exists) {
      run('git', ['tag', '-a', tag, '-m', `release ${tag}`]);
      log(`      ✓ 本地创建 tag ${tag}`);
    } else {
      log(`      tag ${tag} 已存在，直接推送`);
    }
    run('git', ['push', 'origin', tag]);
    log(`      ✓ tag 已推送，GitHub Actions 开始构建并发布`);
    log('');
    log('  查看进度：');
    log(`    https://github.com/${OWNER}/${REPO}/actions`);
    log('  发布产物：');
    log(`    https://github.com/${OWNER}/${REPO}/pkgs/npm/pdf-h5-react`);
  }
}

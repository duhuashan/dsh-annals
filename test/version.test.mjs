// 发布前的一致性检查：版本号与打包清单。
//
// 为什么单独开一个文件：README.md 的版本行、README.md 里那条安装命令的 tgz 文件名、
// package.json 的 version —— 三个字面量各写各的，升版本时漏改一处**不会报错**，
// 只会让 README 上写着旧版本号，或者让用户照着抄一个不存在的文件名。
// 仓库没有 CI，这类不一致本来就只能靠人发现；放进测试就变成「跑一遍就发现」。
//
// 同理检查 files 白名单：白名单里列了但文件不存在，打出来的包会静默缺文件，
// 而 npm/pnpm pack 不会为此报错。
//
// 这两类都属于「沉默地错」，正是最该用测试钉住的那种。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

/** 版本号形状：主.次.修订，三段数字。 */
const VERSION_SHAPE = /^\d+\.\d+\.\d+$/;

test('package.json 的 version 形状合法', () => {
  assert.match(pkg.version, VERSION_SHAPE);
});

test('README 顶部横幅的版本号与 package.json 一致', () => {
  const m = readme.match(/\|\s*版本\s+(\d+\.\d+\.\d+)\s*\|/);
  assert.ok(m, 'README 里找不到「| 版本 X.Y.Z |」这一行 —— 横幅结构变了，测试要跟着改');
  assert.equal(
    m[1],
    pkg.version,
    `README 横幅写 ${m[1]}，package.json 是 ${pkg.version} —— 升版本时漏改了一处`,
  );
});

test('README 安装命令里的 tgz 文件名与 package.json 一致', () => {
  const found = [...readme.matchAll(/dsh-worklog-(\d+\.\d+\.\d+)\.tgz/g)].map((m) => m[1]);
  assert.ok(
    found.length > 0,
    'README 里找不到 dsh-worklog-X.Y.Z.tgz —— 安装命令换了写法，测试要跟着改',
  );
  for (const v of new Set(found)) {
    assert.equal(
      v,
      pkg.version,
      `README 里出现 dsh-worklog-${v}.tgz，package.json 是 ${pkg.version}`,
    );
  }
});

test('files 白名单里的每一项都真实存在', () => {
  assert.ok(Array.isArray(pkg.files), 'package.json 没有 files 白名单 —— 打包会把整个仓库塞进去');
  const missing = pkg.files.filter((p) => !existsSync(join(ROOT, p)));
  assert.deepEqual(
    missing,
    [],
    `白名单里这些条目在磁盘上不存在，打出的 tgz 会静默缺文件：${missing.join(', ')}`,
  );
});

test('files 白名单覆盖了所有对外文档', () => {
  // 这三个文档是 README 里明确链过去的。不在白名单 = 打出的包里没有 = GitHub 上点过去 404。
  for (const doc of ['README.md', 'ARCHITECTURE.md', 'LIMITATIONS.md']) {
    assert.ok(
      pkg.files.includes(doc),
      `${doc} 不在 files 白名单里 —— 从 tgz 安装的人点不到它`,
    );
  }
});

test('files 里列出的 Markdown 文档都不是空文件', () => {
  for (const p of pkg.files.filter((f) => f.endsWith('.md'))) {
    const stat = statSync(join(ROOT, p));
    assert.ok(stat.size > 1000, `${p} 只有 ${stat.size} 字节，像是不小心被清空了`);
  }
});

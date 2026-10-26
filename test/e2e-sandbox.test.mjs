// e2e-sandbox.mjs 的 node:test 包装器。
//
// 为什么需要这一层：e2e-sandbox.mjs 是个独立脚本（自己 console.log、自己设
// process.exitCode），不是 node:test 文件 —— 放在 test/ 目录里也匹配不到
// `test/*.test.mjs`。而实际发布前要跑的东西必须能一条命令全跑完，所以把
// 「调用它、断言它退出码为 0、断言输出含『全部通过』」包成一条用例。
//
// 顺带解决另一个问题：e2e-sandbox.mjs 的默认目标目录是
// `%TEMP%\annals-e2e-<pid>`，每次 PID 不同，跑完不自删 —— 会一直攒垃圾。
// 这里给它一个 mkdtemp 出来的目录，finally 里删掉。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'e2e-sandbox.mjs');

test('端到端：真实磁盘上初始化一个新工作区', () => {
  const root = mkdtempSync(join(tmpdir(), 'annals-e2e-'));
  try {
    const out = execFileSync(process.execPath, [SCRIPT, root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(out, /✓ 全部通过/, `e2e 脚本没有报告全部通过：\n${out}`);
    // 脚本自己会打印检查项总数，跟着它走，别在这里写死数字 ——
    // 加了检查项而这里没改，会变成一条永远通过的空断言。
    const m = out.match(/✓ 全部通过（(\d+) 项检查）/);
    assert.ok(m, 'e2e 输出的检查数格式变了');
    assert.ok(Number(m[1]) >= 16, `检查项只有 ${m[1]} 个，比预期少 —— 有检查被跳过了？`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * evidence.mjs 的单元测试：证据留痕的**判定规则**。
 *
 * 这里钉的是三处真实踩过的坑：
 *  1. 负向对照只要"退出码非 0"就判可信 —— 但退出码 1 可能来自"没找到测试文件"，
 *     断言从未执行。必须同时要求**明确的失败证据**。
 *  2. 多模块/多测试类逐类打印汇总行，只取第一行会把 15 个测试记成 4 个。
 *  3. 环境受限（缺 DB、无网络）与"代码失败"必须区分，否则使用者收到矛盾结论。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { tail, matchCount, hasFailureEvidence, detectEnvRestricted } from '../scripts/lib/evidence.mjs';
import { envFailureReason } from '../scripts/lib/env-failure.mjs';

test('tail：只保留尾部非空行，并按 maxChars 从尾部截断', () => {
  assert.equal(tail('a\n\nb\n\nc'), 'a\nb\nc');
  assert.equal(tail('1\n2\n3\n4\n5', 2), '4\n5');
  assert.equal(tail('x'.repeat(50), 12, 10), 'x'.repeat(10));
  assert.equal(tail(''), '');
  assert.equal(tail(null), '');
});

test('hasFailureEvidence：断言失败/编译错误/测试失败都要认出', () => {
  const positives = [
    'Tests run: 4, Failures: 1, Errors: 0',
    'AssertionError [ERR_ASSERTION]: expected 1 to equal 2',
    'BUILD FAILURE',
    '2 tests failed',
    'Traceback (most recent call last):',
    '--- FAIL: TestAdd (0.00s)',
    'src/x.ts(2,7): error TS2322: Type string is not assignable',
    '✖ 3 problems (3 errors, 0 warnings)',
    'COMPILATION ERROR',
    '[ERROR] Failed to execute goal',
  ];
  for (const raw of positives) assert.equal(hasFailureEvidence(raw), true, `应识别为失败证据：${raw}`);
});

test('hasFailureEvidence：全绿/空输出不算失败证据', () => {
  const negatives = [
    '',
    'Tests run: 15, Failures: 0, Errors: 0',
    'BUILD SUCCESS',
    'ok 12 tests',
    'No test files found, exiting with code 1', // 退出码 1，但没有失败证据 ⇒ 负向对照空转
  ];
  for (const raw of negatives) assert.equal(hasFailureEvidence(raw), false, `不应识别为失败证据：${raw}`);
});

test('matchCount：累加所有匹配（多模块 4+4+7 必须等于 15，而不是 4）', () => {
  const maven = [
    'Tests run: 4, Failures: 0, Errors: 0 -- in com.x.A',
    'Tests run: 4, Failures: 0, Errors: 0 -- in com.x.B',
    'Tests run: 7, Failures: 0, Errors: 0 -- in com.x.C',
  ].join('\n');
  assert.equal(matchCount(maven, 'Tests run: (\\d+)'), 15);
  assert.equal(matchCount('Tests run: 12, Failures: 0', 'Tests run: (\\d+)'), 12);
});

test('matchCount：无匹配、无捕获组、非法正则都返回 null（不抛）', () => {
  assert.equal(matchCount('no numbers', 'Tests run: (\\d+)'), null);
  assert.equal(matchCount('Tests run: 3', 'Tests run: \\d+'), null);
  assert.equal(matchCount('Tests run: 3', '(unclosed'), null);
  assert.equal(matchCount('', 'Tests run: (\\d+)'), null);
});

test('环境受限判定：网络/权限/缺工具/缺 DB 各归其类', () => {
  assert.equal(envFailureReason('Could not resolve dependencies for project x'), '依赖解析/网络不可达');
  assert.equal(envFailureReason('Permission denied: ~/.m2/repository'), '权限/沙箱限制（如 ~/.m2 不可写）');
  assert.equal(envFailureReason('command not found: mvn'), '工具未安装');
  assert.equal(
    envFailureReason('Failed to load ApplicationContext'),
    '集成测试所需外部依赖不可用（DB/配置服务等）',
  );
  assert.equal(envFailureReason('Tests run: 4, Failures: 1'), null);
  assert.equal(detectEnvRestricted('ETIMEDOUT'), true);
  assert.equal(detectEnvRestricted('BUILD SUCCESS'), false);
});

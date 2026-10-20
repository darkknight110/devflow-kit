/**
 * gate.mjs 的单元测试：门禁判定的**判据**本身。
 *
 * 重点不是"函数能跑"，而是钉住三条曾经出错的判据：
 *  1. 模板指引里的「独立复核」字样不能被当成作者声称（否则还没复核就被判"声称无留痕"）；
 *  2. 写在正文引用块里的声称**必须**被认（曾因"剥掉全部引用块"而放过）；
 *  3. 状态链从实际状态起飞，跳过的状态不得变成隐性强制（否则轻档被迫产出契约）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stripNonClaims,
  isIndependentClaim,
  hasReviewEvidence,
  stateChain,
  summarize,
} from '../scripts/lib/gate.mjs';
import { loadKitSpec } from '../scripts/lib/manifest.mjs';

const states = loadKitSpec('states');

test('stripNonClaims：剥 HTML 注释与「首章之前」的引用块', () => {
  const md = [
    '<!-- 模板说明：这里要写独立复核 -->',
    '> 模板指引：请填写独立复核',
    '',
    '## 复核记录',
    '',
    '> 正文里的引用是作者声称，必须保留',
    '子代理 377575de 复核完成',
  ].join('\n');
  const got = stripNonClaims(md);
  assert.equal(got.includes('模板说明'), false, 'HTML 注释必须被剥掉');
  assert.equal(got.includes('模板指引'), false, '首章之前的引用块必须被剥掉');
  assert.equal(got.includes('正文里的引用是作者声称'), true, '首章之后的引用块必须保留');
});

test('isIndependentClaim：只认剥除模板指引之后的「独立…」字样', () => {
  assert.equal(isIndependentClaim('> 模板指引：请做独立复核\n\n## 记录\n无'), false);
  assert.equal(isIndependentClaim('## 记录\n\n> 已做独立复核'), true);
});

test('hasReviewEvidence：一句"我复核过了"不算留痕', () => {
  assert.equal(hasReviewEvidence('## 复核记录\n我复核过了，没问题'), false);
  assert.equal(hasReviewEvidence(''), false);
  // 声称 + 具体复核方 + 时间戳 + 实测证据 ⇒ 才算
  const good = '## 复核记录\n子代理 377575de 复核 2026-10-13 14:20，实测 exit=0，BUILD SUCCESS';
  assert.equal(hasReviewEvidence(good), true);
  // 有复核方和实测、但没有任何时间戳：仍算（判据是"时间戳或实测"二选一）
  assert.equal(hasReviewEvidence('## 记录\n复核方：子代理 377575de，实测 exit=0'), true);
});

test('summarize：统计各判定，G5 未知状态记为 fatal', () => {
  const results = [
    { gate: 'G1', verdict: 'pass', notes: [] },
    { gate: 'G2', verdict: 'pass', notes: [] },
    { gate: 'G3', verdict: 'unverified', notes: [] },
    { gate: 'G5', verdict: 'blocked', notes: ['未知状态：deploying'] },
  ];
  const s = summarize(results);
  assert.equal(s.pass, 2);
  assert.equal(s.unverified, 1);
  assert.equal(s.blocked, 1);
  assert.equal(s.blocking, true);
  assert.equal(s.fatal, true);
  assert.deepEqual(s.blockingGates, ['G5']);
});

test('summarize：无阻断时 blocking=false，fatal=false', () => {
  const s = summarize([{ gate: 'G1', verdict: 'pass', notes: [] }]);
  assert.equal(s.blocking, false);
  assert.equal(s.fatal, false);
});

test('stateChain：标准档从 spec_ready 起飞，包含 contracted', () => {
  assert.deepEqual(stateChain(states, 'implementing', 'standard', 'spec_ready'), [
    'spec_ready',
    'contracted',
    'implementing',
  ]);
});

test('stateChain：跳过的状态不算产物（轻档没有契约，不得隐性强制）', () => {
  assert.deepEqual(stateChain(states, 'verified', 'light', 'implementing'), [
    'implementing',
    'tested',
    'verified',
  ]);
});

test('stateChain：未知目标状态返回空数组', () => {
  assert.deepEqual(stateChain(states, 'deploying', 'standard', 'draft'), []);
});

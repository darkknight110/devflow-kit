/**
 * adapter.mjs 的单元测试：适配器自检（"配了但抓不到"的防线）。
 *
 * auditAdapterRegex 存在的理由：栈适配器里的 count_regex 是对着"某个版本的输出"写的，
 * 一旦样本与正则脱节，门禁会读到 count=0 却仍然 pass —— 静默失真。
 * selfcheck 只覆盖了"四个真实适配器自洽"，这里补的是**反例**：坏正则必须被点名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadAdapters, auditAdapterRegex } from '../scripts/lib/adapter.mjs';

const KIT_ROOT = path_resolve();

function path_resolve() {
  const here = new URL('.', import.meta.url).pathname;
  return here.replace(/\/test\/$/, '');
}

test('真实适配器全部自洽（count_regex 抓得到自己的样本输出）', () => {
  const adapters = loadAdapters(KIT_ROOT);
  assert.ok(Object.keys(adapters).length >= 4, '至少四个栈适配器');
  assert.deepEqual(auditAdapterRegex(adapters), []);
});

test('反例：正则抓不到样本 ⇒ 点名', () => {
  const problems = auditAdapterRegex({
    x: { test: { count_regex: 'Tests run: (\\d+)', sample_output: '没有数字' } },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /抓不到自己声明的样本输出/);
});

test('反例：捕获组不是数字 ⇒ 点名', () => {
  const problems = auditAdapterRegex({
    x: { test: { count_regex: 'Tests run: (\\w+)', sample_output: 'Tests run: many' } },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /第 1 个捕获组不是数字/);
});

test('反例：样本计数低于 require_min_tests ⇒ 点名', () => {
  const problems = auditAdapterRegex({
    x: { test: { count_regex: 'Tests run: (\\d+)', sample_output: 'Tests run: 2', require_min_tests: 3 } },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /低于 require_min_tests=3/);
});

test('反例：正则语法错误 ⇒ 点名而不是抛异常', () => {
  const problems = auditAdapterRegex({
    x: { test: { count_regex: '(unclosed', sample_output: 'anything' } },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /语法错误/);
});

test('没有 count_regex 或没有样本时跳过（不算问题）', () => {
  assert.deepEqual(auditAdapterRegex({ x: { test: {} } }), []);
  assert.deepEqual(auditAdapterRegex({ x: { test: { count_regex: '(\\d+)' } } }), []);
});

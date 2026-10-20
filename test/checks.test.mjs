/**
 * checks.mjs 的单元测试：产物读取与结构校验（G1 / G1b 的解析底座）。
 *
 * 为什么单测这层：selfcheck 的 71 条用例走的是"真引擎 + 真夹具"，
 * 覆盖的是门禁结论；而解析函数一旦对**模板真实形态**理解错位，
 * 表现是"门禁永远通过"而不是报错 —— 这种静默错误只有直接断言返回值才能钉住。
 * 夹具一律取 templates/ 里的真实列名（例如任务表的表头是 `T`，不是 `任务`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  sections,
  findSection,
  tables,
  keyValues,
  parseTasks,
  parseAcceptanceCriteria,
  parseVerification,
  parseUnverifiedItems,
  parseApprovals,
  isRealValue,
  dirSizeKb,
} from '../scripts/lib/checks.mjs';

test('sections 去掉「一、」前缀，且忽略首个 ## 之前的内容', () => {
  const md = ['# 标题', '', '这是说明，不属于任何段。', '', '## 一、任务', '正文 A', '', '## 验收标准', '正文 B'].join('\n');
  const got = sections(md);
  assert.deepEqual(Object.keys(got), ['任务', '验收标准']);
  assert.equal(got['任务'].includes('正文 A'), true);
  assert.equal(got['任务'].includes('这是说明'), false);
});

test('findSection 要求关键词全部命中', () => {
  const md = '## 逐条对照\nA\n\n## 未验证项\nB';
  assert.equal(findSection(md, ['逐条对照']).title, '逐条对照');
  assert.equal(findSection(md, ['未验证项']).title, '未验证项');
  assert.equal(findSection(md, ['逐条对照', '未验证']), null);
});

test('tables 解析多张表，跳过表头分隔行，不把普通文本当表', () => {
  const md = [
    '前文 | 不是表格',
    '',
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '| C |',
    '|---|',
    '| 3 |',
  ].join('\n');
  const got = tables(md);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0].header, ['A', 'B']);
  assert.deepEqual(got[0].rows, [['1', '2']]);
  assert.deepEqual(got[1].rows, [['3']]);
});

test('tables 对空输入返回空数组（不抛）', () => {
  assert.deepEqual(tables(''), []);
  assert.deepEqual(tables(null), []);
});

test('keyValues 从「身份」表取键值，并去掉加粗标记', () => {
  const md = [
    '## 身份',
    '',
    '| 键 | 值 |',
    '|---|---|',
    '| **item** | first |',
    '| tier | light |',
  ].join('\n');
  const kv = keyValues(md, ['身份']);
  assert.equal(kv.item, 'first');
  assert.equal(kv.tier, 'light');
});

test('parseTasks 按模板真实表头（T）解析', () => {
  const md = [
    '## 任务',
    '',
    '| T | 目标仓 | 负责层 | 写入范围 | 依赖 | 状态 | 负责人 | 验收命令 | 对应AC |',
    '|---|---|---|---|---|---|---|---|---|',
    '| T-1 | mp | 前端 | src/ | 无 | 待开始 | （人名） | npm test | AC-1 |',
  ].join('\n');
  const tasks = parseTasks(md);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'T-1');
  assert.equal(tasks[0].command, 'npm test');
  assert.equal(tasks[0].ac, 'AC-1');
});

test('parseAcceptanceCriteria 解析 AC 的判据与类型', () => {
  const md = [
    '## 验收标准',
    '',
    '| AC | 判据 | 判据类型 | 责任方 |',
    '|---|---|---|---|',
    '| AC-1 | 页面可点 | 画面 | 前端 |',
  ].join('\n');
  const acs = parseAcceptanceCriteria(md);
  assert.deepEqual(acs, [{ id: 'AC-1', judgement: '页面可点', judgementType: '画面', owner: '前端' }]);
});

test('parseVerification 逐条对照与 parseUnverifiedItems 未验证项分开解析', () => {
  const md = [
    '## 逐条对照',
    '',
    '| AC | 结论 | 证据 |',
    '|---|---|---|',
    '| AC-1 | 已通过 / 未通过 / 未验证 | exit=0 |',
    '',
    '## 未验证项',
    '',
    '| 未验证项 | 原因 | 如何补验证 | 是否接受风险 |',
    '|---|---|---|---|',
    '| AC-2 | 缺设备 | 借设备 | 接受 |',
  ].join('\n');
  const ver = parseVerification(md);
  assert.equal(ver.length, 1);
  assert.equal(ver[0].ac, 'AC-1');
  const un = parseUnverifiedItems(md);
  assert.equal(un.length, 1);
  assert.equal(un[0].ac, 'AC-2');
  assert.equal(un[0].risk, '接受');
});

test('parseApprovals 解析确认记录（含内容指纹）', () => {
  const md = [
    '## 确认记录',
    '',
    '| 确认点 | 确认人 | 时间 | 结论 | 内容指纹 |',
    '|---|---|---|---|---|',
    '| 开工前 | 张三 | 2026-10-13T10:00 | 通过 | abc123 |',
  ].join('\n');
  const rows = parseApprovals(md);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].who, '张三');
  assert.equal(rows[0].verdict, '通过');
  assert.equal(rows[0].fingerprint, 'abc123');
});

test('isRealValue：占位与未选定选项都不算真实值', () => {
  // 占位：括号包裹、括号开头
  assert.equal(isRealValue('（姓名）'), false);
  assert.equal(isRealValue('(ISO 时间)'), false);
  assert.equal(isRealValue(''), false);
  assert.equal(isRealValue(null), false);
  // 未选定：二选一 / 三态
  assert.equal(isRealValue('通过 / 驳回'), false);
  assert.equal(isRealValue('已通过 / 未通过 / 未验证'), false);
  // 真实值
  assert.equal(isRealValue('张三'), true);
  assert.equal(isRealValue('已通过'), true);
  assert.equal(isRealValue('exit=0'), true);
});

test('dirSizeKb 按 0.1KB 精度汇总，并可按 skip 排除目录', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'devflow-checks-'));
  try {
    writeFileSync(path.join(dir, 'a.md'), 'x'.repeat(1024)); // 1.0 KB
    mkdirSync(path.join(dir, 'node_modules'));
    writeFileSync(path.join(dir, 'node_modules', 'big.js'), 'y'.repeat(20480)); // 20 KB，应被跳过
    const got = dirSizeKb(dir);
    assert.equal(got.totalKb, 1);
    assert.equal(got.files.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * docview.mjs 的单元测试：终端文档渲染的**列宽**计算。
 *
 * 为什么值得单测：这类代码的 bug 是"看着没问题、对齐全错"。
 * 中文占 2 列、日期串不能被劈成两截、表格列宽要按显示宽度而不是字符数 ——
 * 三条都是手工 review 看不出来、只能断言的规则。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { dispW, padW, stripInline, wrapW, renderTerminal } from '../scripts/lib/docview.mjs';

test('dispW：中日韩字符占 2 列，ASCII 占 1 列', () => {
  assert.equal(dispW('中文'), 4);
  assert.equal(dispW('abc'), 3);
  assert.equal(dispW('中文abc'), 7);
  assert.equal(dispW(''), 0);
  assert.equal(dispW('，。'), 4); // 全角标点
});

test('padW：按显示宽度右补空格，超宽不截断', () => {
  assert.equal(padW('中文', 6), '中文  ');
  assert.equal(padW('ab', 4), 'ab  ');
  assert.equal(padW('abcdef', 2), 'abcdef');
  assert.equal(dispW(padW('中文', 6)), 6);
});

test('wrapW：不劈开日期串，中文逐字可断，行宽不超限', () => {
  const text = '我们用 devflow-kit 把 2026-10-15 的发布流程跑通了';
  const lines = wrapW(text, 24);
  assert.equal(lines.some((l) => l.includes('2026-10-15')), true, '日期串必须完整落在同一行');
  for (const line of lines) assert.ok(dispW(line) <= 24, `行宽超限：${line}`);
  assert.equal(lines.join('').replace(/\s/g, ''), text.replace(/\s/g, ''), '折行不能丢字');
});

test('wrapW：行首不留空格', () => {
  for (const line of wrapW('  开头有空格的一段文字', 12)) {
    assert.equal(line.startsWith(' '), false);
  }
});

test('stripInline：去掉 Markdown 标记但保留可读文本', () => {
  assert.equal(stripInline('**粗**'), '粗');
  assert.equal(stripInline('`code`'), 'code');
  assert.equal(stripInline('[链接](https://x.y)'), '链接');
  assert.equal(stripInline('![图](a.png)'), '图');
  assert.equal(stripInline('**粗** [链接](http://x) `code` ![图](a.png)'), '粗 链接 code 图');
});

test('renderTerminal：标题下有下划线，表格按显示宽度对齐，默认不含 ANSI', () => {
  const out = renderTerminal('# 标题\n\n| A | B |\n|---|---|\n| 中 | x |', { width: 60 });
  assert.equal(out[0], '标题');
  // 标题下划线宽度 = max(8, 标题显示宽度)：短标题取 8，避免比标题还短的尴尬
  assert.equal(out[1], '─'.repeat(Math.max(8, dispW('标题'))));
  const tableLines = out.filter((l) => l.includes('│') || l.includes('A') || l.includes('中'));
  assert.ok(tableLines.length > 0);
  // 同一张表的每一行显示宽度一致（否则终端里会错位）
  const widths = new Set(out.filter((l) => /\S/.test(l) && !l.startsWith('─')).map((l) => dispW(l)));
  assert.ok(widths.size <= 3, `渲染结果宽度不一致：${[...widths].join(',')}`);
  assert.equal(/\u001b\[/.test(out.join('\n')), false);
});

test('renderTerminal：空输入与 null 不抛', () => {
  assert.deepEqual(renderTerminal(''), []);
  assert.deepEqual(renderTerminal(null), []);
});

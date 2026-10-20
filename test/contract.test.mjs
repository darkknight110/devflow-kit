/**
 * contract.mjs 的单元测试：契约规范化与破坏性变更判定。
 *
 * 这层错了的后果最贵：契约没能判出"接口被删"，G7 就不会提示，跨端就被静默破坏。
 * 两侧输入（Markdown / JSON）都要覆盖 —— 历史缺陷是只测了其中一种，
 * 另一种的路径规范化（空格、末尾斜杠）不一致，导致"同一接口换个写法就比对不上"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeContract, diffContracts } from '../scripts/lib/contract.mjs';
import { loadKitSpec } from '../scripts/lib/manifest.mjs';

const rules = loadKitSpec('breaking-rules');

const markdown = [
  '## 端点所有权',
  '',
  '| 端点 | 方法 | owner | surface |',
  '|---|---|---|---|',
  '| /api/orders/ | get | 前端 | mp |',
  '| （端点） | （方法） | （owner） | （surface） |',
  '',
  '## 消费者',
  '',
  '| 消费方 | 需要的兼容 |',
  '|---|---|',
  '| web | 必填字段不变 |',
  '',
  '## 校验方式',
  '',
  '| 校验方式 | 命令 |',
  '|---|---|',
  '| 契约 | npm run contract |',
].join('\n');

test('normalizeContract(markdown)：方法大写、路径去尾斜杠、占位行被过滤', () => {
  const c = normalizeContract(markdown);
  assert.equal(c.format, 'markdown');
  assert.equal(c.endpoints.length, 1, '占位行不是真实端点');
  assert.equal(c.endpoints[0].method, 'GET');
  assert.equal(c.endpoints[0].path, '/api/orders');
  assert.equal(c.endpoints[0].key, 'GET /api/orders');
  assert.equal(c.consumers[0].who, 'web');
  assert.equal(c.assertions[0].cmd, 'npm run contract');
});

test('normalizeContract(json)：method 大写、path 规范化、surface 数组合并', () => {
  const c = normalizeContract({
    endpoints: [{ method: 'post', path: ' /api/pay/ ', owner: '后端', surface: ['mp', 'web'] }],
    consumers: [{ who: 'app', compat: '只增不改' }],
    assertions: [{ name: '契约', command: 'npm run c' }],
  });
  assert.equal(c.format, 'json');
  assert.deepEqual(c.endpoints[0], {
    method: 'POST',
    path: '/api/pay',
    owner: '后端',
    surface: 'mp/web',
    key: 'POST /api/pay',
  });
  assert.deepEqual(c.consumers[0], { who: 'app', needs: '只增不改' });
  assert.deepEqual(c.assertions[0], { name: '契约', cmd: 'npm run c' });
});

test('diffContracts：删端点判 BREAKING，删方法也要判', () => {
  const base = normalizeContract({ endpoints: [{ method: 'GET', path: '/a' }, { method: 'POST', path: '/b' }] });
  const cur = normalizeContract({ endpoints: [{ method: 'GET', path: '/a' }] });
  const findings = diffContracts(base, cur, rules);
  const removed = findings.find((f) => f.id === 'endpoint-removed');
  assert.equal(removed.severity, 'BREAKING');
  assert.equal(removed.detail, 'POST /b');

  const cur2 = normalizeContract({ endpoints: [{ method: 'GET', path: '/b' }, { method: 'GET', path: '/a' }] });
  const f2 = diffContracts(base, cur2, rules);
  assert.equal(f2.some((f) => f.id === 'method-removed'), true);
});

test('diffContracts：新增端点只是 INFO，不阻断', () => {
  const base = normalizeContract({ endpoints: [{ method: 'GET', path: '/a' }] });
  const cur = normalizeContract({
    endpoints: [{ method: 'GET', path: '/a' }, { method: 'GET', path: '/b' }],
    assertions: [{ cmd: 'npm t' }],
  });
  const findings = diffContracts(base, cur, rules);
  const added = findings.filter((f) => f.id === 'endpoint-added');
  assert.equal(added.length, 1);
  assert.equal(added[0].severity, 'INFO');
});

test('diffContracts：owner/surface 变化判 WARN', () => {
  const base = normalizeContract({ endpoints: [{ method: 'GET', path: '/a', owner: '前端', surface: 'mp' }] });
  const cur = normalizeContract({ endpoints: [{ method: 'GET', path: '/a', owner: '后端', surface: 'web' }] });
  const ids = diffContracts(base, cur, rules).map((f) => f.id).sort();
  assert.deepEqual(ids, ['endpoint-owner-changed', 'endpoint-surface-changed', 'no-assertion-command']);
});

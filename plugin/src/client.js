/**
 * devflow 看板的 DSH 薄框 —— 客户端插件本体。
 *
 * 定位（必须守住，否则会变成"第二份看板实现"）：
 *   · 本插件**只做窗口**：一个 iframe 指向 devflow board 的本地服务；
 *   · 看板的全部渲染、数据、刷新逻辑仍在 `devflow board`（单一事实源）；
 *   · **删掉本插件不影响任何工作流能力** —— 它只是可选的呈现方式。
 *
 * 产物格式（照 dsh-context 的真实 client.js 对齐，**这里踩过坑**）：
 *   · 宿主用普通 `<script>` 加载 client.js，**不支持 ESM** ⇒ 必须包成
 *     `window.__ModuleLoader__.load({ id, factory })`（第一版用了 `export default`，
 *     浏览器报 `Unexpected token 'export'`，导致整个 web boot 失败）；
 *   · 插件必须是**对象** `{ name, inject, apply }`，不是函数；
 *   · React 由宿主 `require` 注入，**不要内联**，否则会出现两份 React。
 *
 * 契约来源（核对过真实源码）：`ctx.sidebarRightTabs.register(...)` 与
 * `ctx.slots.inject('sidebar.right.pane.tab', ...)`，都包在 `ctx.effect(...)` 里。
 */
import { createElement as h } from 'react';

const BOARD_URL = 'http://127.0.0.1:8787';
const TAB_ID = 'devflow/board';

/** 看板面板：一个 iframe，指向 devflow board 的本地服务 */
function BoardFrame() {
  return h('div', { style: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column' } },
    h('iframe', {
      src: BOARD_URL,
      title: 'devflow 看板',
      style: { flex: '1 1 auto', width: '100%', border: '0', background: '#0b1120' },
      // 不给 allow-same-origin：内嵌页拿不到 DSH 的源，降低风险
      sandbox: 'allow-scripts allow-popups allow-forms',
    }),
    h('div', {
      style: { padding: '6px 10px', fontSize: '11px', opacity: 0.72, borderTop: '1px solid rgba(128,128,128,.25)' },
    }, `看板地址：${BOARD_URL}`),
  );
}

function apply(ctx) {
  // ① 注册标签页类型 + **guide 入口**。
  //    踩过的坑：只注册类型不写 guide ⇒ 标签页存在但**界面上没有任何入口**，
  //    用户看到的是"什么都没有"（实测）。guide 条目才会渲染成侧栏里的按钮。
  //    形状照 dsh-context 的真实调用：{ order, title(), description(), icon? }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: 'devflow-board',
    title: () => 'devflow 看板',
    guide: [{
      order: 30,                                   // 与 dsh-context(20) 相邻，便于在 guide 里找到
      title: () => 'devflow 看板',
      description: () => '研发工作流：需求到发布的进展、任务与阻塞（只读）',
    }],
  }), 'devflow: board tab type');

  // ② 注册该标签页的内容（props 由框架注入；原样透传）
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
  }, (props) => h(BoardFrame, props))), 'devflow: board tab body');
}

/** 插件对象：宿主按 name / inject / apply 三件套识别（不是函数导出） */
const plugin = {
  name: 'dsh-plugin-devflow',
  inject: ['slots', 'sidebarRightTabs'],
  apply,
};

export default plugin;
export { plugin, BoardFrame };

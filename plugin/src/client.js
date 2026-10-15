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
import React, { createElement as h } from 'react';

// 端口由插件 config 传入（plugin/package.json 里声明一次），避免宿主与客户端各写一份
const BOARD_URL = (() => {
  const port = (typeof __DEVFLOW_PORT__ === 'number' && __DEVFLOW_PORT__) || 8787;
  return `http://127.0.0.1:${port}`;
})();
const TAB_ID = 'devflow/board';

/**
 * 看板面板：一个 iframe，指向 devflow board 的本地服务。
 *
 * 必须处理"服务没在跑"的情形：**否则面板是纯空白，用户不知道原因**
 * （实测就踩到了这个 —— 打开右栏看到一片空白，其实是没启动服务）。
 */
function BoardFrame() {
  const [state, setState] = React.useState('loading');   // loading | ok | unreachable

  // 探测服务是否可达：iframe 的 onLoad 在成功与"连接失败页"都会触发，
  // 所以另外用 fetch 判断（失败即视为没启动）。
  React.useEffect(() => {
    let alive = true;
    fetch(BOARD_URL + '/api/state', { mode: 'no-cors' })
      .then(() => { if (alive) setState('ok'); })
      .catch(() => { if (alive) setState('unreachable'); });
    return () => { alive = false; };
  }, []);

  const hint = h('div', {
    style: {
      padding: '18px 20px', fontSize: '12.5px', lineHeight: 1.8,
      borderBottom: '1px solid rgba(128,128,128,.25)',
    },
  },
    h('div', { style: { fontWeight: 600, marginBottom: '6px' } },
      state === 'loading' ? '正在检查看板服务…' : '看板服务没有在运行'),
    state === 'unreachable' ? h('div', null,
      h('div', { style: { opacity: 0.8 } }, '自动启动没有成功。请在项目目录里手动执行：'),
      h('code', {
        style: {
          display: 'block', margin: '6px 0', padding: '7px 10px',
          background: 'rgba(128,128,128,.14)', borderRadius: '6px',
          fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '11.5px',
        },
      }, 'devflow board'),
      h('div', { style: { opacity: 0.72, fontSize: '11.5px' } },
        `若提示找不到命令，请用 kit 目录下的 bin/devflow。启动后刷新本面板即可显示（地址：${BOARD_URL}）。`),
    ) : null,
  );

  return h('div', { style: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column' } },
    state === 'unreachable' ? hint : null,
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

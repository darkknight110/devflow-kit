#!/usr/bin/env node
/**
 * 把 plugin/src/client.js 打包成 DSH 期望的 lib/client.js。
 *
 * 为什么需要打包这一步：DSH 的客户端插件是 React 插件，React 由**各插件在构建期打进自己的产物**
 * （已核对：`dsh-client-ui-renderer` 的 client 产物里有 `require("react")`）。
 * 我们刻意用 `React.createElement` 而不写 JSX，所以**不需要 JSX 编译器**，只要一层打包。
 *
 * 依赖来源：复用 **DSH 自带的 esbuild**，不新增任何 npm 依赖（保持主仓零依赖）。
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname);
const pluginRoot = path.resolve(here, '..');
const outDir = path.join(pluginRoot, 'lib');
mkdirSync(outDir, { recursive: true });

/** 找 DSH 安装位置（用于借用它的 esbuild） */
function findDshRoot() {
  const cands = [
    process.env.DSH_ROOT,
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh',
    path.join(process.env.HOME || '', '.dsh'),
  ].filter(Boolean);
  return cands.find((c) => existsSync(c)) || null;
}

const dshRoot = findDshRoot();
// 优先用 plugin/ 自己装的 esbuild（隔离在子目录里，主仓仍零依赖）；
// DSH 自带的不作指望 —— 实测它**没有**打包 esbuild。
const esbuildCands = [
  path.join(pluginRoot, 'node_modules'),
  dshRoot && path.join(dshRoot, 'node_modules'),
].filter(Boolean);

let esbuildEntry = null;
for (const base of esbuildCands) {
  if (!base || !existsSync(base)) continue;
  try {
    const req = createRequire(pathToFileURL(path.join(base, 'noop.js')).href);
    esbuildEntry = req.resolve('esbuild');
    break;
  } catch { /* 继续找 */ }
}

if (!esbuildEntry) {
  process.stderr.write([
    '找不到 esbuild —— 无法打包插件。三种办法：',
    '  ① 在本目录执行：npm i -D esbuild 然后重跑（依赖隔离在 plugin/，不影响主仓）',
    '  ② 设置 DSH_ROOT 指向含 esbuild 的目录（若你的 DSH 版本自带）',
    '  ③ 手工把 src/client.js 拷贝为 lib/client.js（若目标环境能直接加载 ESM）',
    '',
  ].join('\n'));
  process.exit(2);
}

const mod = await import(pathToFileURL(esbuildEntry).href);
// ESM 导入 esbuild 时，函数挂在 default 上（不同版本包装不同，两种都兼容）
const esbuildBuild = typeof mod.build === 'function' ? mod.build
  : (mod.default && typeof mod.default.build === 'function' ? mod.default.build : null);
if (!esbuildBuild) {
  process.stderr.write(`esbuild 导入成功但找不到 build 函数：${Object.keys(mod).join(',')}\n`);
  process.exit(2);
}
await esbuildBuild({
  entryPoints: [path.join(pluginRoot, 'src', 'client.js')],
  outfile: path.join(outDir, 'client.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  // react 由插件自带（与官方插件一致的做法），其余 DSH 包由宿主提供
  external: ['@deepseek-ai/*'],
  logLevel: 'info',
});
process.stdout.write(`✓ 已打包：${path.relative(pluginRoot, path.join(outDir, 'client.js'))}\n`);

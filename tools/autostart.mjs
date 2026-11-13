#!/usr/bin/env node
// 开机自启动管理（只影响当前用户，不需要管理员权限）。
//
//   node tools/autostart.mjs install   安装：登录后静默启动服务（不开浏览器）
//   node tools/autostart.mjs remove    卸载
//   node tools/autostart.mjs status    看现在装没装、服务在不在跑
//   node tools/autostart.mjs stop      停掉正在跑的服务
//
// 原理：在「启动」文件夹放一个 .lnk，指向 wscript.exe 执行 _autostart.vbs，
// VBS 用隐藏窗口跑 _autostart.cmd。三层套娃是为了两件事：
//   1) 开机时不要弹黑窗口（wscript 的 Run 窗口参数 0 = 隐藏）
//   2) 快捷方式里不写死路径，VBS 自己按所在目录推导，搬家不用改

import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { status as fwStatus } from './firewall.mjs';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 7788);
const VBS = path.join(ROOT, '_autostart.vbs');
const CMD = path.join(ROOT, '_autostart.cmd');
const ICON = path.join(ROOT, 'assets', 'icon.ico');
const WSCRIPT = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');

const STARTUP_DIR = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup'
);
const LNK = path.join(STARTUP_DIR, '错题中枢.lnk');

/** PowerShell 单引号字符串转义 */
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function ps(script) {
  return execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8' }
  ).trim();
}

async function portIsUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/meta`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function shortcutInfo() {
  if (!existsSync(LNK)) return null;
  const out = ps(`
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut(${q(LNK)})
"TARGET=$($sc.TargetPath)"
"ARGS=$($sc.Arguments)"
"WORKDIR=$($sc.WorkingDirectory)"
`);
  const pick = (key) => (out.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1] || '';
  return { target: pick('TARGET'), args: pick('ARGS'), workdir: pick('WORKDIR') };
}

/** 问一句 y/N；非交互环境（管道/CI）直接拒绝，绝不默认装 */
async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question(question + ' [y/N] ', res));
  rl.close();
  return /^y(es)?$/i.test(String(ans).trim());
}

async function install() {
  if (!process.argv.includes('--yes')) {
    console.log('');
    console.log('  开机自启动会在「启动」文件夹放一个快捷方式，登录 Windows 后自动在后台起服务。');
    console.log('  它不会弹窗口、不会自动开浏览器；卸载：npm run autostart:remove');
    const ok = await confirm('  要装吗？');
    if (!ok) {
      console.log('  已取消，什么都没改。');
      process.exit(0);
    }
  }

  // 手机要连就得放行入站端口；没规则时提醒一次（不自动提权，权限得用户点）
  const fw = fwStatus();
  if (fw.present === false) {
    console.log('');
    console.log('  提示：防火墙里还没有 ' + PORT + ' 的入站规则，手机会连不上。');
    console.log('        需要时运行：npm run firewall:add（会弹 UAC，你点「是」）');
  }

  for (const f of [VBS, CMD]) {
    if (!existsSync(f)) {
      console.error(`缺少文件：${f}`);
      process.exit(1);
    }
  }
  if (!existsSync(STARTUP_DIR)) {
    console.error(`找不到启动文件夹：${STARTUP_DIR}`);
    process.exit(1);
  }

  ps(`
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut(${q(LNK)})
$sc.TargetPath = ${q(WSCRIPT)}
$sc.Arguments = ${q(`"${VBS}"`)}
$sc.WorkingDirectory = ${q(ROOT)}
$sc.WindowStyle = 7
$sc.IconLocation = ${q(`${ICON},0`)}
$sc.Description = '学习闭环 · 错题中枢（开机自启）'
$sc.Save()
`);

  const info = shortcutInfo();
  console.log('');
  console.log('  已安装开机自启动');
  console.log(`  快捷方式  ${LNK}`);
  console.log(`  启动内容  ${info?.target}`);
  console.log(`  参数      ${info?.args}`);
  console.log(`  工作目录  ${info?.workdir}`);
  console.log('');
  console.log('  下次登录 Windows 会自动在后台起服务（不弹窗口、不开浏览器）。');
  console.log('  想马上生效：双击桌面「错题中枢」图标即可。');
  console.log('');
}

function remove() {
  if (!existsSync(LNK)) {
    console.log('  没有安装开机自启动，无需卸载。');
    return;
  }
  ps(`Remove-Item -LiteralPath ${q(LNK)} -Force`);
  console.log(`  已卸载：删除了 ${LNK}`);
  console.log('  （服务器如果正在跑，不会受影响；要停用 stop.cmd）');
}

async function status() {
  const info = shortcutInfo();
  const up = await portIsUp();
  console.log('');
  console.log(`  开机自启动  ${info ? '已安装' : '未安装'}`);
  if (info) {
    console.log(`  快捷方式    ${LNK}`);
    console.log(`  指向        ${info.target} ${info.args}`);
  }
  console.log(`  服务状态    ${up ? `正在运行（http://127.0.0.1:${PORT}）` : '未运行'}`);
  console.log('');
}

/** 关掉「_autostart.cmd」留下的控制台窗口；不碰别的 cmd，更不碰编辑器/终端 */
function closeOrphanWindows() {
  try {
    const script = 'Get-CimInstance Win32_Process -Filter "Name=\'cmd.exe\'" | ' +
      'Where-Object { $_.CommandLine -like \'*_autostart.cmd*\' } | ' +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }';
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();
    return out ? out.split(/\s+/).filter(Boolean).length : 0;
  } catch { return 0; }
}

function stop() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
      ],
      { encoding: 'utf8' }
    ).trim();
    if (!out) {
      console.log(`  ${PORT} 端口没有进程在监听。`);
      return;
    }
    execFileSync('taskkill', ['/PID', out, '/F'], { stdio: 'ignore' });
    console.log(`  已停止 PID ${out}`);
    const closed = closeOrphanWindows();
    if (closed) console.log(`  顺手关掉了 ${closed} 个残留的命令行窗口`);
  } catch (e) {
    console.error(`  停止失败：${e.message}`);
    process.exit(1);
  }
}

const action = process.argv[2];
switch (action) {
  case 'install':
    await install();
    break;
  case 'remove':
    remove();
    break;
  case 'status':
    await status();
    break;
  case 'stop':
    stop();
    break;
  default:
    console.log('用法：node tools/autostart.mjs install|remove|status|stop');
    process.exit(action ? 1 : 0);
}

// 安装时顺带写一份说明，万一以后忘了这层套娃是干嘛的
if (action === 'install') {
  writeFileSync(
    path.join(ROOT, 'data', 'autostart.txt'),
    [
      '开机自启动由 tools/autostart.mjs 安装：',
      `  启动文件夹快捷方式  ${LNK}`,
      `  指向                ${WSCRIPT} "${VBS}"`,
      `  VBS 再隐藏运行      ${CMD}`,
      '卸载：npm run autostart:remove',
      '',
    ].join('\r\n'),
    'utf8'
  );
}
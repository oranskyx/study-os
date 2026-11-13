#!/usr/bin/env node
// 防火墙放行（Windows，需要管理员权限）。
//
//   node tools/firewall.mjs status   看规则在不在
//   node tools/firewall.mjs add      放行 TCP 7788（会弹 UAC，用户点「是」才生效）
//   node tools/firewall.mjs remove   删掉规则
//
// 为什么单独一个工具：手机要连，就必须放行入站；但普通权限改不了防火墙。
// 这里用 Start-Process -Verb RunAs 主动申请提权 —— 系统会弹一个 UAC 确认框，
// 用户点确认才会执行。不点、或拒绝，命令就以非零码退出，程序不会假装成功。

import { execFileSync } from 'node:child_process';

const PORT = Number(process.env.PORT || 7788);
const NAME = 'study-os';

const ps = (script, { admin = false } = {}) => {
  const args = admin
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',\`${script}\``]
    : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  try {
    return { ok: true, out: execFileSync('powershell', args, { encoding: 'utf8' }).trim() };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '').trim(), err: String(e.stderr || e.message).slice(0, 400) };
  }
};

/** 现有规则（同名 + 同端口） */
export function status() {
  const r = ps(`
    $r = Get-NetFirewallRule -DisplayName '${NAME}' -ErrorAction SilentlyContinue |
         Where-Object Direction -eq 'Inbound'
    if ($r) {
      $f = $r | Get-NetFirewallPortFilter
      "present|" + ($f.LocalPort -join ',')
    } else { "absent" }
  `);
  if (!r.ok) return { present: null, detail: r.err };
  const [state, ports] = r.out.split('|');
  return { present: state === 'present', ports: ports || null };
}

/** 放行：走 UAC 提权；用户拒绝时返回 ok:false */
export function add() {
  const r = ps(`
    New-NetFirewallRule -DisplayName '${NAME}' -Direction Inbound -Action Allow ` +
    `-Protocol TCP -LocalPort ${PORT} -Profile Any -ErrorAction Stop | Out-Null
  `, { admin: true });
  return r;
}

export function remove() {
  const r = ps(`Remove-NetFirewallRule -DisplayName '${NAME}' -ErrorAction SilentlyContinue`, { admin: true });
  return r;
}

// 直接执行（被 import 时不跑）
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/firewall.mjs')) {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'status') {
    const s = status();
    console.log(s.present === null
      ? `  查不到（${s.detail}）`
      : s.present ? `  已放行：TCP ${s.ports}` : '  没有规则：手机连不上，需要 add');
    process.exit(0);
  }
  if (cmd === 'add') {
    const s = status();
    if (s.present) { console.log(`  已经有规则（TCP ${s.ports}），不用重复加`); process.exit(0); }
    console.log('  申请管理员权限放行 TCP ' + PORT + '…（会弹 UAC，请点「是」）');
    const r = add();
    if (!r.ok) { console.error('  失败：' + (r.err || '用户取消了提权')); process.exit(2); }
    const after = status();
    console.log(after.present ? '  已放行，手机现在可以连了' : '  命令执行了，但规则没查到，请到防火墙设置里确认');
    process.exit(after.present ? 0 : 1);
  }
  if (cmd === 'remove') {
    const r = remove();
    if (!r.ok) { console.error('  失败：' + (r.err || '用户取消了提权')); process.exit(2); }
    console.log('  已删除规则（手机将连不上）');
    process.exit(0);
  }
  console.error('  用法：node tools/firewall.mjs [status|add|remove]');
  process.exit(1);
}

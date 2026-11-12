// 报表图表：纯 SVG，无第三方库、无网络依赖。
// 只做三件事：折线/柱、环形、进度条。颜色直接写死成与主题一致的色值。

const INK = '#141413';
const ACCENT = '#c96442';
const LINE = '#e6e3da';
const MUTED = '#6e6e66';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);

function path(points) {
  return points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
}

/** 每日节奏：柱=做题量，线=当日正确率（样本 <3 的点画空心） */
export function dailyChart(days) {
  if (!days || !days.length) return '';
  const W = 640, H = 168, pl = 30, pr = 12, pt = 14, pb = 24;
  const iw = W - pl - pr, ih = H - pt - pb;
  const max = Math.max(1, ...days.map((d) => d.attempts));
  const n = days.length;
  const step = iw / n;
  const x = (i) => pl + step * (i + 0.5);
  const yA = (v) => pt + ih * (1 - v / 100);

  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" role="img" aria-label="每日做题量">';
  for (let g = 0; g <= 2; g++) {
    const y = pt + (ih * g) / 2;
    s += '<line x1="' + pl + '" y1="' + y + '" x2="' + (W - pr) + '" y2="' + y + '" stroke="' + LINE + '" stroke-width="1"/>';
  }
  days.forEach((d, i) => {
    const h = (d.attempts / max) * ih;
    if (h > 0) {
      s += '<rect x="' + (x(i) - step * 0.28).toFixed(1) + '" y="' + (pt + ih - h).toFixed(1) +
           '" width="' + (step * 0.56).toFixed(1) + '" height="' + h.toFixed(1) +
           '" fill="' + LINE + '" rx="1"/>';
    }
  });
  const pts = [];
  days.forEach((d, i) => {
    if (d.attempts >= 3) pts.push([x(i), yA(pct(d.correct, d.attempts))]);
  });
  if (pts.length > 1) s += '<path d="' + path(pts) + '" fill="none" stroke="' + ACCENT + '" stroke-width="2" stroke-linejoin="round"/>';
  for (const p of pts) s += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="2.6" fill="' + ACCENT + '"/>';
  const every = Math.max(1, Math.ceil(n / 6));
  days.forEach((d, i) => {
    if (i % every) return;
    s += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" font-size="10" fill="' + MUTED + '" text-anchor="middle">' + esc(d.date.slice(5)) + '</text>';
  });
  s += '<text x="' + pl + '" y="' + (pt - 4) + '" font-size="10" fill="' + MUTED + '">峰值 ' + max + '</text>';
  return s + '</svg>';
}

/** 环形图：items = [{label, n}] */
export function donutChart(items, size = 148) {
  const list = (items || []).filter((i) => i.n > 0);
  if (!list.length) return '';
  const total = list.reduce((a, b) => a + b.n, 0);
  const r = size / 2 - 14, cx = size / 2, cy = size / 2;
  const C = 2 * Math.PI * r;
  const shades = ['#141413', '#4a4a45', '#8a887f', '#c96442', '#e0b5a2', '#d6d2c6'];
  let off = 0, s = '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '" role="img" aria-label="分布">';
  list.forEach((it, i) => {
    const frac = it.n / total;
    const dash = frac * C;
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + shades[i % shades.length] +
         '" stroke-width="18" stroke-dasharray="' + dash.toFixed(2) + ' ' + (C - dash).toFixed(2) +
         '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/>';
    off += dash;
  });
  s += '<text x="' + cx + '" y="' + (cy - 2) + '" text-anchor="middle" font-size="22" font-weight="600" fill="' + INK + '">' + total + '</text>';
  s += '<text x="' + cx + '" y="' + (cy + 16) + '" text-anchor="middle" font-size="11" fill="' + MUTED + '">道</text>';
  return s + '</svg>';
}

export function legend(items) {
  const shades = ['#141413', '#4a4a45', '#8a887f', '#c96442', '#e0b5a2', '#d6d2c6'];
  const total = (items || []).reduce((a, b) => a + b.n, 0) || 1;
  return '<div class="legend">' + (items || []).map((it, i) =>
    '<div class="lg"><i style="background:' + shades[i % shades.length] + '"></i>' +
    '<span>' + esc(it.label) + '</span><b>' + it.n + '</b>' +
    '<em>' + Math.round((it.n / total) * 100) + '%</em></div>').join('') + '</div>';
}

/** 横向条形列表（HTML，比 SVG 更好读） */
export function barList(items, opts = {}) {
  if (!items || !items.length) return '<p class="muted">这段时间没有数据。</p>';
  const max = Math.max(1, ...items.map((i) => i.n));
  const unit = opts.unit || '道';
  return '<div class="bars">' + items.map((it) =>
    '<div class="bar"><span class="bl">' + esc(it.label) + '</span>' +
    '<span class="bt"><i style="width:' + Math.max(3, Math.round((it.n / max) * 100)) + '%"></i></span>' +
    '<span class="bv">' + it.n + ' ' + unit + '</span></div>').join('') + '</div>';
}

/** 进度条（完成率） */
export function progress(label, done, total, note) {
  const p = total > 0 ? Math.round((done / total) * 100) : 0;
  return '<div class="prog"><div class="ph"><span>' + esc(label) + '</span><b>' + p + '%</b></div>' +
    '<div class="pt"><i style="width:' + p + '%"></i></div>' +
    (note ? '<div class="pn">' + esc(note) + '</div>' : '') + '</div>';
}

/** 近 N 个月：柱=新增错题，线=正确率 */
export function longTermChart(series) {
  if (!series || !series.length) return '';
  const W = 640, H = 150, pl = 26, pr = 12, pt = 14, pb = 24;
  const iw = W - pl - pr, ih = H - pt - pb;
  const max = Math.max(1, ...series.map((m) => m.new_questions));
  const step = iw / series.length;
  const x = (i) => pl + step * (i + 0.5);
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" role="img" aria-label="长期趋势">';
  for (let g = 0; g <= 2; g++) {
    const y = pt + (ih * g) / 2;
    s += '<line x1="' + pl + '" y1="' + y + '" x2="' + (W - pr) + '" y2="' + y + '" stroke="' + LINE + '" stroke-width="1"/>';
  }
  series.forEach((m, i) => {
    const h = (m.new_questions / max) * ih;
    if (h > 0) s += '<rect x="' + (x(i) - step * 0.3).toFixed(1) + '" y="' + (pt + ih - h).toFixed(1) + '" width="' + (step * 0.6).toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + LINE + '" rx="1"/>';
  });
  const pts = series.filter((m) => m.accuracy != null).map((m, i) => {
    const idx = series.indexOf(m);
    return [x(idx), pt + ih * (1 - m.accuracy / 100)];
  });
  if (pts.length > 1) s += '<path d="' + path(pts) + '" fill="none" stroke="' + ACCENT + '" stroke-width="2"/>';
  series.forEach((m, i) => {
    s += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" font-size="10" fill="' + MUTED + '" text-anchor="middle">' + esc(m.label) + '</text>';
    if (m.accuracy != null) s += '<circle cx="' + x(i).toFixed(1) + '" cy="' + (pt + ih * (1 - m.accuracy / 100)).toFixed(1) + '" r="2.6" fill="' + ACCENT + '"/>';
  });
  return s + '</svg>';
}

const SUBJ = { math: '数学', chinese: '语文', english: '英语', physics: '物理', chemistry: '化学', biology: '生物' };

/** 整块报表看板 */
export function reportDashboard(st, monthMode) {
  const out = [];
  const days = st.daily || [];
  const comp = st.completion || {};

  if (days.length) {
    out.push('<div class="card"><h2><span class="dot"></span>' + (monthMode ? '这个月每天的节奏' : '这一周每天的节奏') +
      '</h2><p class="muted" style="margin:-4px 0 8px;font-size:12.5px">柱=当天重做次数，红线=当天正确率（少于 3 次的点不画，样本太少会误导）。</p>' +
      dailyChart(days) + '</div>');
  }

  if (comp.total) {
    out.push('<div class="card"><h2><span class="dot"></span>复习单完成度</h2>' +
      progress('排进单子的题，做完了多少', comp.done, comp.total,
        '做对 ' + comp.correct + ' · 做错 ' + comp.wrong + ' · 还没回填 ' + comp.pending) +
      (comp.completion != null && comp.completion < 50
        ? '<p class="hint warn" style="margin:10px 0 0">完成率不到一半。要么单子排多了，要么这周没时间——先减量，别硬撑。</p>'
        : '') + '</div>');
  }

  if (st.by_subject && st.by_subject.length) {
    out.push('<div class="card"><h2><span class="dot"></span>科目分布</h2><div class="donut">' +
      donutChart(st.by_subject.map((x) => ({ n: x.n, label: SUBJ[x.subject_id] || x.subject_id }))) +
      legend(st.by_subject.map((x) => ({ n: x.n, label: SUBJ[x.subject_id] || x.subject_id }))) +
      '</div></div>');
  }

  if (monthMode && st.by_error_type && st.by_error_type.length) {
    out.push('<div class="card"><h2><span class="dot"></span>错因构成</h2>' +
      barList(st.by_error_type.map((x) => ({ n: x.n, label: x.type }))) + '</div>');
  }

  if (st.by_kp && st.by_kp.length) {
    out.push('<div class="card"><h2><span class="dot"></span>' + (monthMode ? '本月' : '本周') + '错得最多的考点</h2>' +
      barList(st.by_kp.map((x) => ({ n: x.n, label: x.kp }))) + '</div>');
  }

  if (monthMode && st.by_difficulty && st.by_difficulty.length) {
    out.push('<div class="card"><h2><span class="dot"></span>难度分布</h2>' +
      barList(st.by_difficulty.map((x) => ({ n: x.n, label: '难度 ' + (x.difficulty || '?') }))) + '</div>');
  }

  if (monthMode && st.long_term && st.long_term.length > 1) {
    out.push('<div class="card"><h2><span class="dot"></span>近 6 个月</h2><p class="muted" style="margin:-4px 0 8px;font-size:12.5px">柱=当月新增错题，红线=当月正确率。看的是趋势，不是单月好坏。</p>' +
      longTermChart(st.long_term) + '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>月份</th><th>新增</th><th>重做</th><th>正确率</th></tr></thead><tbody>' +
      st.long_term.map((m) => '<tr><td>' + esc(m.month) + '</td><td>' + m.new_questions + '</td><td>' + m.attempts + '</td><td>' + (m.accuracy == null ? '—' : m.accuracy + '%') + '</td></tr>').join('') +
      '</tbody></table></div></div>');
  }

  if (monthMode) {
    const cmp = [
      ['新增错题', st.new_questions, st.new_questions_prev],
      ['重做次数', st.attempts, st.attempts_prev],
      ['正确率', st.accuracy, st.accuracy_prev],
    ];
    out.push('<div class="card"><h2><span class="dot"></span>本月 vs 上月</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>指标</th><th>上月</th><th>本月</th><th>变化</th></tr></thead><tbody>' +
      cmp.map((r) => {
        const [label, now, prev] = r;
        const isPct = label === '正确率';
        const dv = now == null || prev == null ? null : now - prev;
        const arrow = dv == null ? '—' : dv === 0 ? '持平' : (dv > 0 ? '▲ +' : '▼ ') + dv + (isPct ? 'pt' : '');
        const cls = dv == null ? '' : (label === '正确率' ? (dv >= 0 ? 'up' : 'down') : (dv <= 0 ? 'up' : 'down'));
        return '<tr><td>' + label + '</td><td>' + (prev == null ? '—' : prev + (isPct ? '%' : '')) + '</td><td>' + (now == null ? '—' : now + (isPct ? '%' : '')) + '</td><td class="' + cls + '">' + arrow + '</td></tr>';
      }).join('') + '</tbody></table></div></div>');
  }

  return out.join('');
}

if (typeof window !== 'undefined') window.__charts = { reportDashboard };

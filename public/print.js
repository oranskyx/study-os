// 复习单打印页

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function normMath(s) {
  return String(s ?? '')
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, x) => '$$' + x + '$$')
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, x) => '$' + x + '$');
}

function mEsc(s) {
  const parts = normMath(s).split(/(\$\$[\s\S]*?\$\$|\$[^$\n]*?\$)/g);
  return parts
    .map((p) => {
      if (/^\$\$[\s\S]*\$\$$/.test(p) || /^\$[^$\n]*\$$/.test(p)) return p;
      return esc(p);
    })
    .join('');
}

const dayNames = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五' };

function prettyStem(stem) {
  // 只在句号/分号后换行，避免把 LaTeX 里的东西弄断
  return mEsc(stem || '')
    .replace(/([。；;])\s*/g, '$1<br>')
    .replace(/\n+/g, '<br>');
}

(async function main() {
  const id = Number(new URLSearchParams(location.search).get('id'));
  const root = document.getElementById('root');
  if (!id) {
    root.innerHTML = '<p style="text-align:center">缺少复习单编号</p>';
    return;
  }

  let d;
  try {
    const res = await fetch(`/api/sheet/${id}`);
    d = await res.json();
    if (!res.ok) throw new Error(d.error || '加载失败');
  } catch (e) {
    root.innerHTML = `<p style="text-align:center">${esc(e.message)}</p>`;
    return;
  }

  const items = d.items || [];
  if (!items.length) {
    root.innerHTML = '<p style="text-align:center">这张复习单是空的</p>';
    return;
  }

  const byDay = {};
  for (const it of items) (byDay[it.day] ||= []).push(it);

  const today = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  // ---- 正面：题目
  const front = Object.keys(byDay)
    .sort()
    .map(
      (day) => `
    <section class="day">
      <h2><span>${dayNames[day] || '第' + day + '天'}</span><span>${byDay[day].length} 题</span></h2>
      ${byDay[day]
        .map(
          (it) => `
        <div class="item">
          <div class="no">
            <span class="chk"></span>${it.position}. 【${esc(it.kp_name || '未标注')}】
            难度 ${it.difficulty || '?'} · 编号 #${it.question_id}
          </div>
          <div class="stem">${prettyStem(it.stem)}</div>
          <div class="blank"></div>
          <div class="blank short"></div>
        </div>`
        )
        .join('')}
    </section>`
    )
    .join('');

  // ---- 背面：答案与解析
  const back = `
    <section class="answers">
      <h1 style="border-bottom:1.5px solid #000;padding-bottom:4px">答案与解析</h1>
      <div class="meta">对答案用。做完再看，别偷看。</div>
      ${items
        .map(
          (it) => `
        <div class="item">
          <div class="no">#${it.question_id} · ${esc(it.kp_name || '未标注')}</div>
          <div class="ans">
            <span class="k">答案：</span>${mEsc(it.correct_answer || '—（未记录）')}
          </div>
          ${it.solution ? `<div class="ans"><span class="k">解析：</span>${prettyStem(it.solution)}</div>` : ''}
          ${it.error_cause ? `<div class="ans" style="color:#555"><span class="k">当时错因：</span>${esc(it.error_cause)}</div>` : ''}
        </div>`
        )
        .join('')}
    </section>`;

  root.innerHTML = `
    <div class="sheet">
      <h1>错题复习单 · ${esc(d.sheet.week)}</h1>
      <div class="meta">共 ${items.length} 题 · 生成 ${today}</div>
      <div class="tip">
        <strong>用法：</strong>每天按上面指定的日子，把这天的题在纸上重做一遍，做完在方框里画 √ 或 ×。
        周五放学把这张纸带回家，拍照或按勾回填到系统里——系统会自动排下一轮。<br>
        <strong>规矩：</strong>不会就先空着，别翻答案。周五统一对答案，这样才知道哪道是真没掌握。
      </div>
      ${front}
    </div>
    <div class="sheet">
      ${back}
    </div>
  `;

  if (window.renderMathInElement) {
    try {
      window.renderMathInElement(document.body, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
        ],
        throwOnError: false,
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
      });
    } catch { /* 忽略 */ }
  }
})();

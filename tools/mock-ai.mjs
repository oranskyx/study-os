// 本地模拟的 OpenAI 兼容服务 —— 不用充钱就能把整条链路点一遍。
//
//   node tools/mock-ai.mjs            # 默认 http://127.0.0.1:7799/v1
//
// 然后在网页「设置」里填：
//   Base URL : http://127.0.0.1:7799/v1
//   API Key  : mock
//   模型     : mock-vl-1（识题） / mock-text-1（写文）
//
// 它返回的是**写死的示例数据**，只用来验证页面、排版和流程串不串得通，
// 不代表真实识别效果。所有返回内容里都带了"模拟"标记。

import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 7799);
const DELAY = Number(process.env.MOCK_DELAY ?? 450);

const MODELS = [
  { id: 'mock-vl-1', object: 'model' },
  { id: 'mock-text-1', object: 'model' },
  { id: 'mock-flash', object: 'model' },
];

const MOCK_NOTE = '（模拟数据 · 本地 mock 服务返回，用于预览流程，不是真实识别结果）';

// ---------------------------------------------------------------- 示例题目
const QUESTIONS = [
  {
    stem: '已知集合 $A=\\{x\\mid x^{2}-3x+2<0\\}$，$B=\\{x\\mid x>a\\}$，若 $A\\subseteq B$，求实数 $a$ 的取值范围。',
    my_answer: '$a<1$',
    correct_answer: '$a\\le 1$',
    solution:
      '由 $x^{2}-3x+2<0$ 解得 $1<x<2$，即 $A=(1,2)$。\n' +
      '要使 $A\\subseteq B$，即 $(1,2)\\subseteq(a,+\\infty)$，需要 $a\\le 1$。\n' +
      '注意端点是开区间，$a=1$ 时 $B=(1,+\\infty)$ 仍然包含 $A$，所以取等成立。',
    error_cause: '手写：端点能不能取等没想清楚',
    error_type: '概念不清',
    difficulty: 3,
    kp: ['一元二次不等式'],
    confidence: 0.86,
  },
  {
    stem: '判断函数 $f(x)=x^{3}+x$ 的奇偶性，并说明理由。',
    my_answer: '$f(-x)=(-x)^{3}+x$',
    correct_answer: '奇函数',
    solution:
      '定义域为 $\\mathbb{R}$，关于原点对称。\n' +
      '$f(-x)=(-x)^{3}+(-x)=-(x^{3}+x)=-f(x)$，\n' +
      '所以 $f(x)$ 是奇函数。',
    error_cause: '手写：忘了写定义域对称',
    error_type: '表达不规范',
    difficulty: 2,
    kp: ['函数的奇偶性'],
    confidence: 0.91,
  },
  {
    stem: '已知 $\\tan\\alpha=2$，求 $\\dfrac{\\sin\\alpha+2\\cos\\alpha}{2\\sin\\alpha-\\cos\\alpha}$ 的值。',
    my_answer: null,
    correct_answer: '$\\dfrac{4}{3}$',
    solution:
      '分子分母同除 $\\cos\\alpha$（$\\cos\\alpha\\ne0$）：\n' +
      '原式 $=\\dfrac{\\tan\\alpha+2}{2\\tan\\alpha-1}=\\dfrac{2+2}{4-1}=\\dfrac{4}{3}$。',
    error_cause: null,
    error_type: null,
    difficulty: 2,
    kp: ['同角三角函数的基本关系'],
    confidence: 0.72,
  },
];

// ---------------------------------------------------------------- 变式题
const VARIANT_META = {
  same: { tier: '基础', tag: '同型' },
  trap: { tier: '提高', tag: '陷阱' },
  layered: { tier: '提高', tag: '加一层' },
  cross: { tier: '综合', tag: '跨考点' },
};

function variantsPayload(text) {
  const kinds = [...new Set([...text.matchAll(/kind="(\w+)"/g)].map((m) => m[1]))];
  const list = (kinds.length ? kinds : ['same']).map((kind, i) => {
    const meta = VARIANT_META[kind] || { tier: '基础', tag: kind };
    return {
      kind,
      tier: meta.tier,
      stem:
        kind === 'trap'
          ? `（${meta.tag}变体）若把上题的条件改成“$A \\subsetneq B$”（真子集），$a$ 的取值范围变不变？说明理由。`
          : kind === 'layered'
            ? `（${meta.tag}变体）在第 ${i + 1} 问基础上，再求使 $A\\cap B=\\varnothing$ 的 $a$ 的范围。`
            : kind === 'cross'
              ? `（${meta.tag}变体）结合函数 $f(x)=x^{2}-3x+2$ 的图象，说明上题解集与该函数图象的关系。`
              : `（${meta.tag}变体）把上题的不等号方向反过来，重新求解 $A$，再判断同样的包含关系。`,
      answer: kind === 'trap' ? '不变，仍为 $a\\le 1$' : '（模拟答案，仅供演示）',
      solution:
        '1. 先解出集合 $A$ 的最简区间；\n' +
        '2. 把包含关系翻译成端点不等式；\n' +
        '3. 逐个检查端点能否取等 —— 这一步是失分点。',
      why: '对应原题在「端点取等」上的薄弱点',
    };
  });
  return { variants: list };
}

// ---------------------------------------------------------------- 周报 / 月报
function weeklyPayload(weekLabel) {
  return {
    summary_md:
      `> ⚠️ ${MOCK_NOTE}\n\n` +
      `## 本周趋势\n` +
      `本周新增错题集中在**不等式与集合的端点处理**上。\n` +
      `重做正确率较上周有回升，但“概念不清”类错因占比仍然偏高。\n\n` +
      `## 三个最该补的洞\n` +
      `1. **一元二次不等式** — 端点能否取等反复出错，本质是没把“开闭区间”和“包含关系”对应起来。\n` +
      `2. **函数的奇偶性** — 每次都漏写定义域对称，属于表达不规范，会被扣过程分。\n` +
      `3. **同角三角函数** — 齐次式除以 $\\cos\\alpha$ 的套路不熟。\n\n` +
      `## 下周行动清单\n` +
      `- 端点取等专项：8 道，做完对着答案只检查端点那一步。\n` +
      `- 奇偶性判断：5 道，每题必须写出“定义域关于原点对称”这一句。\n` +
      `- 齐次式化简：6 道，统一用“分子分母同除 $\\cos\\alpha$”。\n\n` +
      `## 方法论更新\n` +
      `**集合包含关系 → 端点处理三步法**：解集合 → 画数轴 → 单独验端点。\n` +
      `周期：${weekLabel}`,
    top_weak_kps: [
      { kp: '一元二次不等式', evidence: '本周 2 次错在同一处：端点取等', action: '专项 8 道，只查端点' },
      { kp: '函数的奇偶性', evidence: '1 次错，漏写定义域', action: '5 道，强制写定义域' },
    ],
    method_updates: [
      {
        title: '集合包含关系的端点三步法',
        body: '① 把集合解成最简区间 ② 画数轴标出两个区间 ③ 单独判断端点能否取等（开区间对开区间往往能取等）。',
      },
    ],
  };
}

function monthlyPayload(monthLabel) {
  return {
    summary_md:
      `> ⚠️ ${MOCK_NOTE}\n\n` +
      `## 本月整体趋势\n` +
      `错题总量与重做正确率都在向好的方向走，但结构性缺口没有变化。\n\n` +
      `## 结构性缺口（反复错的）\n` +
      `- **一元二次不等式**：本月 3 次，全部错在端点。\n` +
      `- **奇偶性判断**：2 次，全部漏写定义域。\n\n` +
      `## 偶发失分（不用管）\n` +
      `- 计算失误 1 次（抄错符号），不构成模式。\n\n` +
      `## 下月三条策略\n` +
      `1. 端点问题做成一个固定检查动作，写进每道不等式题的解题流程。\n` +
      `2. 奇偶性模板化：定义域 → 对称 → 代换 → 结论，四行不能少。\n` +
      `3. 每周留 15 分钟只看“反复错”的那两个考点。\n\n` +
      `## 方法论沉淀\n` +
      `**模板化不是为了省事，是为了不漏步骤。**\n\n` +
      `周期：${monthLabel}`,
    structural_weak: [
      { kp: '一元二次不等式', times: 3, pattern: '端点能否取等', action: '把验端点写进流程' },
      { kp: '函数的奇偶性', times: 2, pattern: '漏写定义域对称', action: '四行模板' },
    ],
    incidental: ['计算失误 1 次（抄错符号）'],
    method_updates: [
      { title: '奇偶性四行模板', body: '定义域 → 是否对称 → 计算 f(-x) → 与 f(x) 比较得结论。' },
    ],
  };
}

function diagnosePayload() {
  return {
    root_cause: '把“开区间包含”直接当成了“端点可以取等”，没有单独验证端点。',
    error_type: '概念不清',
    chain: [
      '解出 A=(1,2)，B=(a,+∞)',
      '画出数轴后直接写 a<1',
      '没有单独检验 a=1 的情形',
      '忽略了 B 是开区间、端点 1 不在其中但 A 也不含 1',
    ],
    trap: '命题人故意让两个区间都是开区间，使端点取等成立，专治“只比数字大小”。',
    fix: '今天就把“验端点”写成固定一步：解完区间后，单独把端点代进去看是否仍满足包含关系。',
    related_kp: ['集合的包含关系', '区间的开闭'],
  };
}

// ---------------------------------------------------------------- HTTP
const readJson = (req) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });

const sendJson = (res, obj, status = 200) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function completion(res, content, model) {
  sendJson(res, {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'mock-text-1',
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 1200, completion_tokens: 800, total_tokens: 2000 },
  });
}

/** 根据 prompt 判断这次要什么，返回对应的 JSON 字符串 */
function routeIntent(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = String(messages.find((m) => m.role === 'system')?.content || '');
  const userMsg = messages.find((m) => m.role === 'user');
  const user = typeof userMsg?.content === 'string'
    ? userMsg.content
    : JSON.stringify(userMsg?.content ?? '');

  // 变式题的 kind 清单在 user 里，所以两段都要搜
  const all = `${system}\n${user}`;
  let intent = 'unknown';
  let payload;

  if (/错题本数字化助手/.test(system)) {
    intent = 'extract';
    payload = { questions: QUESTIONS, page_note: MOCK_NOTE };
  } else if (/高考阅卷组/.test(system)) {
    // 试卷页识别：给一张"批改过的整卷"，带选择题、计算题和批改痕迹
    intent = 'exam';
    payload = {
      page_role: 'graded',
      role_confidence: 0.88,
      role_reason: '页面上既有印刷题干，也有手写作答和红笔批改',
      page_note: MOCK_NOTE,
      questions: [
        {
          q_no: '1', qtype: 'choice', stem: '已知集合 $A=\\{x \\mid x>0\\}$，求 $A \\cap B$。',
          options: { A: '$\\varnothing$', B: '$\\{1\\}$', C: '$\\{x\\mid x>1\\}$', D: '全体实数' },
          my_answer: 'A', correct_answer: 'C', solution: null,
          grading_note: '× 3分', score_full: 5, score_got: 0, verdict: 'wrong',
          kp: ['集合的基本运算'], difficulty: 2, handwriting: 'mixed', incomplete: false, confidence: 0.92,
        },
        {
          q_no: '2', qtype: 'calc', stem: '证明函数 $f(x)=x^3+x$ 在 $\\mathbf{R}$ 上单调递增。',
          options: null, my_answer: '设 $x_1<x_2$，则 $f(x_1)-f(x_2)<0$',
          correct_answer: null, solution: null,
          grading_note: '√ 少一步因式分解 -2', score_full: 10, score_got: 8, verdict: 'partial',
          kp: ['函数的单调性与最值'], difficulty: 3, handwriting: 'handwritten', incomplete: false, confidence: 0.9,
        },
      ],
    };
  } else if (/错误根源/.test(system)) {
    intent = 'diagnose';
    payload = diagnosePayload();
  } else if (/命题老师/.test(system)) {
    intent = 'variants';
    payload = variantsPayload(all);
  } else {
    // 周报/月报靠 user 里的「周期：xxx」区分：周是 2026-W45，月是 2026-11
    const label = (user.match(/周期：\s*([^\n（(]+)/) || [])[1]?.trim() || '';
    if (/W\d{2}/.test(label)) {
      intent = 'weekly';
      payload = weeklyPayload(label);
    } else if (label) {
      intent = 'monthly';
      payload = monthlyPayload(label);
    } else {
      // 兜底：说清楚是 mock，而不是编一段像模像样的分析
      payload = { message: `${MOCK_NOTE} 没认出这是哪类请求，请检查 prompt。` };
    }
  }

  const kindCount = intent === 'variants'
    ? ` · kinds=${[...new Set([...all.matchAll(/kind="(\w+)"/g)].map((m) => m[1]))].join(',')}`
    : '';
  console.log(`[mock] ${intent}${kindCount}`);

  return JSON.stringify(payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  if (req.method === 'GET' && /\/models$/.test(url.pathname)) {
    return sendJson(res, { object: 'list', data: MODELS });
  }

  if (req.method === 'POST' && /\/chat\/completions$/.test(url.pathname)) {
    let body;
    try { body = await readJson(req); } catch { return sendJson(res, { error: 'bad json' }, 400); }
    await sleep(DELAY);
    return completion(res, routeIntent(body), body.model);
  }

  sendJson(res, { error: `mock 服务没有这个路由：${req.method} ${url.pathname}` }, 404);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────────────────────┐');
  console.log('  │  模拟模型服务已启动（返回写死的示例数据，不花钱）      │');
  console.log('  └─────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`   Base URL : http://127.0.0.1:${PORT}/v1`);
  console.log('   API Key  : mock');
  console.log('   识题模型 : mock-vl-1');
  console.log('   写文模型 : mock-text-1');
  console.log('');
  console.log('   可用模型 : ' + MODELS.map((m) => m.id).join(', '));
  console.log('   Ctrl+C 停止');
  console.log('');
});

// 运行时配置：界面里填的值优先于 .env，存在 SQLite 的 settings 表里。
// 原则：不绑定任何一家厂商，只要兼容 OpenAI 的 /chat/completions 就能接。

import { get, run } from './db.mjs';

const DEFAULTS = {
  effort: 'high',
  baseUrl: 'https://api.deepseek.com',
  visionModel: 'deepseek-flash',
  textModel: 'deepseek-flash',
};

const KEYS = [
  'vision_base_url', 'vision_api_key', 'vision_model',
  'text_base_url', 'text_api_key', 'text_model',
  'text_effort', 'vision_effort',
];

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');
const env = (k) => (process.env[k] ?? '').trim();

// ---------------------------------------------------------------- 读写
export function getSetting(key) {
  const row = get('SELECT value FROM settings WHERE key=?', key);
  const v = row?.value;
  return v === null || v === undefined ? '' : String(v);
}

export function setSetting(key, value) {
  const v = value === null || value === undefined ? '' : String(value);
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key, v
  );
}

// ---------------------------------------------------------------- 解析
/**
 * 解析某一类的实际生效配置。
 * 优先级：界面里填的 > .env > 内置默认。
 * 文本模型留空时整体继承识题模型（同一家服务商就不用填两遍）。
 */
export function resolveConfig(kind = 'text') {
  const vBase = getSetting('vision_base_url') || env('VISION_BASE_URL') || DEFAULTS.baseUrl;
  const vKey = getSetting('vision_api_key') || env('VISION_API_KEY');
  const vModel = getSetting('vision_model') || env('VISION_MODEL') || DEFAULTS.visionModel;

  if (kind === 'vision') {
    return {
      kind: 'vision',
      baseUrl: trimSlash(vBase),
      apiKey: vKey,
      model: vModel,
      effort: getSetting('vision_effort') || env('VISION_EFFORT') || DEFAULTS.effort,
      source: {
        baseUrl: getSetting('vision_base_url') ? 'ui' : env('VISION_BASE_URL') ? 'env' : 'default',
        apiKey: getSetting('vision_api_key') ? 'ui' : vKey ? 'env' : 'none',
        model: getSetting('vision_model') ? 'ui' : env('VISION_MODEL') ? 'env' : 'default',
      },
    };
  }

  const tBase = getSetting('text_base_url') || env('TEXT_BASE_URL') || '';
  const base = trimSlash(tBase || vBase);
  // 只有和识题模型同一家时，才允许借用它的 key —— 否则会把 key 发给别的服务商
  const inheritKey = base === trimSlash(vBase);
  const tKey = getSetting('text_api_key') || env('TEXT_API_KEY') || (inheritKey ? vKey : '');
  const tModel = getSetting('text_model') || env('TEXT_MODEL') || (inheritKey ? vModel : DEFAULTS.textModel);

  return {
    kind: 'text',
    baseUrl: base,
    apiKey: tKey,
    model: tModel,
    effort: getSetting('text_effort') || env('TEXT_EFFORT') || DEFAULTS.effort,
    source: {
      baseUrl: getSetting('text_base_url') ? 'ui' : env('TEXT_BASE_URL') ? 'env' : inheritKey ? 'inherit' : 'default',
      apiKey: getSetting('text_api_key') ? 'ui' : env('TEXT_API_KEY') ? 'env' : inheritKey && vKey ? 'inherit' : 'none',
      model: getSetting('text_model') ? 'ui' : env('TEXT_MODEL') ? 'env' : inheritKey ? 'inherit' : 'default',
    },
  };
}

export function configStatus() {
  const out = {};
  for (const kind of ['vision', 'text']) {
    const c = resolveConfig(kind);
    out[kind] = {
      baseUrl: c.baseUrl,
      model: c.model,
      ready: Boolean(c.apiKey),
      keyTail: c.apiKey ? c.apiKey.slice(-4) : null,
      keyLength: c.apiKey ? c.apiKey.length : 0,
      source: c.source,
    };
  }
  return out;
}

/** 界面保存：只覆盖传了值的字段，避免把没动的 key 清空 */
export function applySettings(payload = {}) {
  for (const kind of ['vision', 'text']) {
    const block = payload[kind];
    if (!block || typeof block !== 'object') continue;
    if ('baseUrl' in block) setSetting(`${kind}_base_url`, block.baseUrl);
    if ('model' in block) setSetting(`${kind}_model`, block.model);
    if ('apiKey' in block) {
      const v = String(block.apiKey ?? '').trim();
      // 传空字符串 = 显式清除；不传 = 保持原样
      if (v === '' || v === null) {
        if (block.clearKey) setSetting(`${kind}_api_key`, '');
      } else {
        setSetting(`${kind}_api_key`, v);
      }
    }
  }
}

export function clearKey(kind) {
  setSetting(`${kind}_api_key`, '');
}

// ---------------------------------------------------------------- 服务商预设
// 只是"一键填表"的便捷按钮，不是白名单。任何 OpenAI 兼容接口都能手填。
export const PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    vision: 'deepseek-flash',
    text: 'deepseek-flash',
    note: '识题必须用 deepseek-flash（支持图片）；deepseek-v4-pro 不支持图片',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    vision: 'glm-4v-flash',
    text: 'glm-4-flash',
    note: 'glm-4v-flash 有免费额度，适合先零成本跑通流程',
  },
  {
    id: 'dashscope',
    name: '阿里百炼 / 通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    vision: 'qwen-vl-plus',
    text: 'qwen-plus',
    note: '中文和手写识别较强，价格相近',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    vision: 'Qwen/Qwen2.5-VL-72B-Instruct',
    text: 'deepseek-ai/DeepSeek-V3',
    note: '聚合平台，部分模型有免费额度；模型名以列表为准',
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    vision: '',
    text: 'kimi-latest',
    note: '视觉模型名以 /models 列表为准',
  },
  {
    id: 'ark',
    name: '火山方舟 / 豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    vision: '',
    text: '',
    note: '模型要填你创建的推理接入点 ID，不是模型名',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    vision: 'gpt-4o-mini',
    text: 'gpt-4o-mini',
    note: '',
  },
  {
    id: 'custom',
    name: '自定义 / 其他 OpenAI 兼容接口',
    baseUrl: '',
    vision: '',
    text: '',
    note: '只要能响应 {baseUrl}/chat/completions 就能接',
  },
];

// ---------------------------------------------------------------- 拉模型列表
/**
 * 调 {baseUrl}/models 拿可用模型。
 * 有些服务商不开放这个接口，那就明确告诉用户手填。
 */
export async function listModels({ kind = 'text', baseUrl, apiKey } = {}) {
  const saved = resolveConfig(kind === 'vision' ? 'vision' : 'text');
  const base = trimSlash(baseUrl || saved.baseUrl);
  const explicitKey = (apiKey || '').trim();
  const sameBase = base === trimSlash(saved.baseUrl);

  // 只有「地址还是库里那个」才允许沿用已存的 key。
  // 否则等于「你给我一个 URL，我就把你的 key 发过去」——
  // 服务默认监听 0.0.0.0，局域网里谁都能这么把 key 钓到自己的服务器。
  const key = explicitKey || (sameBase ? saved.apiKey : '');

  if (!base) throw new Error('还没填 Base URL');
  if (!explicitKey && !sameBase) {
    throw new Error('换了 Base URL，就要把这家对应的 API Key 一起填上（不会把已存的 key 发往新地址）');
  }
  if (!key) throw new Error('还没填 API Key，填完才能拉模型列表');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  const url = `${base}/models`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const hint =
        res.status === 401 ? '\n→ key 不对，或者这个 key 没有该服务的权限'
        : res.status === 404 ? '\n→ Base URL 可能少了 /v1 之类的后缀，或者这家不提供 /models'
        : res.status === 402 ? '\n→ 账户余额不足'
        : '';
      const e = new Error(`HTTP ${res.status}${hint}\n请求地址：${url}\n返回内容：${text.slice(0, 300)}`);
      e.status = res.status;
      throw e;
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`返回的不是 JSON\n请求地址：${url}`); }

    const raw = Array.isArray(data) ? data : data?.data ?? data?.models ?? [];
    const ids = raw
      .map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name ?? m?.model))
      .filter((x) => typeof x === 'string' && x.trim())
      .map((x) => x.trim());

    const uniq = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    if (!uniq.length) {
      throw new Error(`这个服务返回了空列表（${url}）。它可能不开放 /models，请手动填模型名。`);
    }
    return { baseUrl: base, models: uniq };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`拉取模型列表超时（20 秒）\n请求地址：${url}`);
    if (e.status) throw e;
    const m = String(e.message || e);
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|certificate|getaddrinfo/i.test(m)) {
      throw new Error(
        `连不上 ${url}\n` +
        `常见原因：Base URL 写错（有的服务商必须带 /v1）、本机没网、或该地址需要代理。\n` +
        `原始错误：${m}`
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const RESERVED_KEYS = KEYS;

// 模型调用层：OpenAI 兼容协议，支持识图与 JSON 输出
//
// 设计要点
// - 配置全部来自 settings.mjs（界面里填的 > .env > 默认），不绑定任何一家厂商
// - 识题与写文可以指向不同服务商：识题必须是视觉模型，写文纯文本即可
// - 统一走 {baseUrl}/chat/completions，百炼/智谱/火山/DeepSeek/硅基流动/OpenAI 通吃

import { readFile } from 'node:fs/promises';
import { resolveConfig } from './settings.mjs';

const FRIENDLY_HTTP = {
  401: '鉴权失败（401）：API Key 不对，或者这个 key 没有该模型的权限',
  402: '账户余额不足（402）：去服务商后台充值，或换一个有免费额度的模型',
  403: '被拒绝（403）：key 没有访问该模型的权限',
  404: '接口不存在（404）：Base URL 填错了，注意有的服务商要带 /v1',
  429: '请求过多或超出配额（429）：稍等再试，或检查账户余额',
};

/**
 * 调用 chat/completions
 * @param {object} o
 * @param {'vision'|'text'} o.kind
 * @param {Array} o.messages       OpenAI 格式 messages
 * @param {boolean} [o.json]       要求返回 JSON 对象
 * @param {number} [o.maxTokens]
 * @param {boolean} [o.thinking]   是否开启思考模式（默认关）
 */
export async function chat({
  kind = 'text',
  messages,
  json = false,
  maxTokens = 8000,
  thinking = false,
  timeoutMs = 180_000,
  temperature = 0.3,
  signal,
}) {
  const cfg = resolveConfig(kind);
  if (!cfg.apiKey) {
    const err = new Error(
      `「${kind === 'vision' ? '识题' : '写文'}」模型还没配 API Key。到页面的「设置」里填 Base URL、Key 和模型名。`
    );
    err.code = 'NO_KEY';
    throw err;
  }

  const body = {
    model: cfg.model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
  };
  if (json) body.response_format = { type: 'json_object' };
  // DeepSeek 文档支持显式 disabled；其他厂商不认这个字段时会自动去掉重试
  if (thinking === false) body.thinking = { type: 'disabled' };
  if (thinking === true) body.thinking = { type: 'enabled' };

  const doFetch = async (payload) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const friendly = FRIENDLY_HTTP[res.status];
        const e = new Error(`${friendly || `模型返回 HTTP ${res.status}`}\n${text.slice(0, 400)}`);
        e.status = res.status;
        e.body = text;
        throw e;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`模型返回的不是 JSON：${text.slice(0, 300)}`);
      }
      const msg = data?.choices?.[0]?.message;
      return {
        content: msg?.content ?? '',
        reasoning: msg?.reasoning_content ?? null,
        usage: data?.usage ?? null,
        model: data?.model ?? cfg.model,
      };
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await doFetch(body);
  } catch (e) {
    // 有些厂商不认 thinking 字段，去掉再试一次
    if (e.status === 400 && /think/i.test(e.body || '')) {
      const { thinking: _drop, ...rest } = body;
      return await doFetch(rest);
    }
    throw e;
  }
}

/** 把本地图片转成 data URL */
export async function imageToDataUrl(absPath, mime = 'image/jpeg') {
  const buf = await readFile(absPath);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 从模型输出里抠出 JSON。容忍 ```json 围栏、前后废话、尾逗号。
 * @param {string} raw
 * @param {'object'|'array'} expect
 */
export function parseLooseJson(raw, expect = 'object') {
  if (!raw) throw new Error('模型返回为空');
  let s = String(raw).trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1;
  let open = '{';
  let close = '}';
  if (expect === 'array') {
    if (firstArr >= 0 && (firstObj < 0 || firstArr < firstObj)) {
      start = firstArr; open = '['; close = ']';
    } else if (firstObj >= 0) {
      start = firstObj; open = '{'; close = '}';
    }
  } else {
    start = firstObj >= 0 ? firstObj : firstArr;
    if (start === firstArr && firstArr >= 0) { open = '['; close = ']'; }
  }
  if (start < 0) throw new Error('模型输出里找不到 JSON');

  const end = s.lastIndexOf(close);
  if (end > start) s = s.slice(start, end + 1);
  s = s.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(s);
  } catch (e) {
    if (open === '[') {
      try { return JSON.parse(s.replace(/,\s*$/, '') + ']'); } catch { /* fallthrough */ }
    }
    throw new Error(`JSON 解析失败：${e.message}\n原文片段：${s.slice(0, 400)}`);
  }
}

/**
 * Node 模块钩子（仅服务 bench/pipeline.bench.mjs）：把 `src/safety/outbound.ts`
 * 替换为「内存即回合」的确定性出站替身——fetchPipeline 的 T1 静态抓取腿由此
 * 获得离线、零网络、逐字节可复现的响应体。合成模块导出面与真 outbound 对齐：
 * `outboundFetch(req)` → `{ status, finalUrl, headers, bytes, text() }`。
 *
 * 响应体按 URL 派生固定 HTML（约 22 KB，含 title/nav/script/style/aside/footer
 * 噪声块与 40 个正文节），足以让 renderExtract 回退链（raw→fit、噪声剥离、
 * 预算裁剪）做真实量级的正则与字符串功。
 *
 * 本目录不进入 vitest / tsc / biome / 构建链（bench 在四者扫描范围之外）。
 *
 * @module bench/outbound-mock.loader
 */

/** 注入给加载器的合成模块源码（内层只用字符串拼接，避免嵌套模板串）。 */
const SYNTHETIC_OUTBOUND_SOURCE = [
  'const cache = new Map();',
  'function pageFor(url) {',
  '  let body = cache.get(url);',
  '  if (body === undefined) {',
  '    const parts = [];',
  "    parts.push('<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">');",
  "    parts.push('<title>Bench Fixture Page</title>');",
  "    parts.push('<style>.sidebar{display:none}</style>');",
  "    parts.push('<script>window.tracking = 1;<\\/script>');",
  "    parts.push('</head><body>');",
  "    parts.push('<nav><a href=\"/\">home</a><a href=\"/tags\">tags</a></nav>');",
  "    parts.push('<aside>related links</aside>');",
  "    parts.push('<article><h1>' + url + '</h1>');",
  '    for (let i = 0; i < 40; i++) {',
  "      parts.push('<h2>Section ' + i + '</h2>');",
  '      parts.push(',
  "        '<p>Deterministic fixture paragraph ' +",
  '          i +',
  "          ' for ' +",
  '          url +',
  "'. The quick brown fox jumps over the lazy dog while the benchmark measures the static extraction fallback chain end to end.</p>',",
  '      );',
  '    }',
  "    parts.push('</article><footer>copyright fixture</footer></body></html>');",
  '    body = parts.join("");',
  '    cache.set(url, body);',
  '  }',
  '  return body;',
  '}',
  'export async function outboundFetch(req) {',
  '  const body = pageFor(req.url);',
  '  const clipped = body.length > req.maxBytes ? body.slice(0, req.maxBytes) : body;',
  '  return {',
  '    status: 200,',
  '    finalUrl: req.url,',
  "    headers: { 'content-type': 'text/html; charset=utf-8' },",
  '    bytes: clipped.length,',
  '    text: async () => clipped,',
  '  };',
  '}',
].join('\n');

/** load 钩子：命中真实 outbound 路径即短路替换为替身，其余交给默认解析链。 */
export function load(url, context, nextLoad) {
  if (url.endsWith('/src/safety/outbound.ts')) {
    return { format: 'module', source: SYNTHETIC_OUTBOUND_SOURCE, shortCircuit: true };
  }
  return nextLoad(url, context);
}

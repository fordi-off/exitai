import { clip } from './util.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// Many sites (DuckDuckGo included) serve a bot challenge to header-less clients; look like a browser.
const BROWSER_HEADERS = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
  'accept-language': 'en-US,en;q=0.9',
  'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'upgrade-insecure-requests': '1',
};

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', middot: '·', bull: '•' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html, baseUrl) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (m, _q, d, sq, inner) => {
      const href = d ?? sq ?? '';
      const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!text || href.startsWith('#') || href.startsWith('javascript:')) return text;
      let abs = href;
      try { abs = new URL(href, baseUrl).href; } catch { /* keep */ }
      return `[${text}](${abs})`;
    })
    .replace(/<h([1-6])\b[^>]*>/gi, (m, n) => '\n\n' + '#'.repeat(+n) + ' ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|table|ul|ol|h[1-6]|blockquote|pre|form|header|main)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return (title ? `Title: ${decodeEntities(title).trim()}\n\n` : '') + s;
}

export const webTools = [
  {
    name: 'web_fetch',
    risk: 'safe',
    description: 'Fetch a URL over HTTP and return readable text (HTML is converted to text with markdown links; JSON is pretty-printed). Fast and cheap; use browser_* tools instead for JavaScript-heavy pages, logins, console or DOM inspection. Use offset to page through long pages.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_chars: { type: 'integer', description: 'Default 12000' },
        offset: { type: 'integer', description: 'Character offset for paging' },
        method: { type: 'string', enum: ['GET', 'POST', 'HEAD'] },
        headers: { type: 'object', description: 'Extra request headers' },
        body: { type: 'string' },
        raw: { type: 'boolean', description: 'Return the raw body without HTML conversion' },
      },
      required: ['url'],
    },
    async run({ url, max_chars = 12000, offset = 0, method = 'GET', headers = {}, body, raw = false }, ctx) {
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      const signal = AbortSignal.any([AbortSignal.timeout(25000), ...(ctx.signal ? [ctx.signal] : [])]);
      const res = await fetch(url, { method, headers: { ...BROWSER_HEADERS, ...headers }, body, redirect: 'follow', signal });
      const type = res.headers.get('content-type') || '';
      const head = `[${res.status} ${res.statusText} · ${type.split(';')[0] || 'unknown type'} · ${res.url}]`;
      if (method === 'HEAD') return head + '\n' + [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
      if (/^(image|video|audio)\/|octet-stream|zip|pdf/i.test(type)) return `${head}\nBinary content (${res.headers.get('content-length') || '?'} bytes) — download it with run_command (Invoke-WebRequest -OutFile ...).`;
      let text = await res.text();
      if (!raw) {
        if (/json/i.test(type)) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep */ } }
        else if (/html|xml/i.test(type) || /^\s*<(!doctype|html)/i.test(text)) text = htmlToText(text, res.url);
      }
      const total = text.length;
      const slice = text.slice(offset, offset + max_chars);
      const more = offset + max_chars < total ? `\n[showing ${offset}-${offset + slice.length} of ${total} chars; use offset=${offset + max_chars} for more]` : '';
      return `${head}\n${slice}${more}`;
    },
  },
  {
    name: 'web_search',
    risk: 'safe',
    description: 'Search the web (DuckDuckGo) and return titles, URLs and snippets. Follow up with web_fetch or browser_navigate to read pages.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, max_results: { type: 'integer', description: 'Default 8' } },
      required: ['query'],
    },
    async run({ query, max_results = 8 }, ctx) {
      const signal = AbortSignal.any([AbortSignal.timeout(20000), ...(ctx.signal ? [ctx.signal] : [])]);
      const max = Math.min(20, Math.max(1, max_results | 0));
      const strip = (x) => decodeEntities((x || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      const providers = [
        // Bing: reliable over plain HTTP
        async () => {
          const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en&count=${max}`, { headers: BROWSER_HEADERS, signal });
          const html = await r.text();
          const out = [];
          for (const chunk of html.split(/<li class="b_algo"/).slice(1)) {
            const a = chunk.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
            if (!a) continue;
            let href = decodeEntities(a[1]);
            try {
              const u = new URL(href);
              if (/bing\.com$/.test(u.hostname) && u.pathname.startsWith('/ck/')) {
                const enc = (u.searchParams.get('u') || '').replace(/^a1/, '');
                if (enc) href = Buffer.from(enc.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
              }
            } catch { /* keep */ }
            const sn = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
            out.push({ title: strip(a[2]), url: href, snippet: strip(sn?.[1]) });
            if (out.length >= max) break;
          }
          return out;
        },
        // DuckDuckGo HTML endpoint (sometimes serves a bot challenge)
        async () => {
          const r = await fetch('https://html.duckduckgo.com/html/', {
            method: 'POST', signal,
            headers: { ...BROWSER_HEADERS, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://html.duckduckgo.com', referer: 'https://html.duckduckgo.com/', 'sec-fetch-site': 'same-origin' },
            body: new URLSearchParams({ q: query, b: '' }).toString(),
          });
          const html = await r.text();
          const out = [];
          const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
          let m;
          while ((m = re.exec(html)) && out.length < max) {
            let href = decodeEntities(m[1]);
            const u = href.match(/[?&]uddg=([^&]+)/);
            if (u) href = decodeURIComponent(u[1]); else if (href.startsWith('//')) href = 'https:' + href;
            const rest = html.slice(m.index, m.index + 3000);
            const sn = rest.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/);
            out.push({ title: strip(m[2]), url: href, snippet: strip(sn?.[1]) });
          }
          return out;
        },
      ];
      const errors = [];
      for (const p of providers) {
        try {
          const results = await p();
          if (results.length) return clip(results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n'), 8000);
        } catch (e) { errors.push(e.message); }
      }
      return `No search results (providers blocked or changed layout${errors.length ? ': ' + errors.join('; ') : ''}). Try browser_navigate to https://www.bing.com/search?q=${encodeURIComponent(query)} instead.`;
    },
  },
];

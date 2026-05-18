// ─────────────────────────────────────────────────────────────────────
// BalletSchedule ─ API + storage (Cloudflare Worker + KV)
// ─────────────────────────────────────────────────────────────────────
// Endpoints:
//   GET  /api/data/YYYY-MM    → KV から該当月の events JSON を返す
//   POST /api/upload?month=YYYY-MM   (X-Upload-Key 認証)
//                             → events JSON を KV に保存
//   GET  /                    → 簡易ヘルプ
//
// デプロイ手順は ./README.md 参照
// ─────────────────────────────────────────────────────────────────────

const ALLOW_ORIGIN = '*';
const MAX_BYTES = 256 * 1024;     // 1 月分 = 数十KB 想定、 余裕で 256KB
const MAX_EVENTS = 200;            // 1 月あたり最大イベント数
const VALID_TYPES = new Set(['lesson', 'rehearsal', 'choreography']);
const VALID_STUDIOS = new Set(['kawagoe', 'tokorozawa', 'miyoshino', 'joint']);

function corsHeaders() {
  return {
    'access-control-allow-origin': ALLOW_ORIGIN,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, X-Upload-Key',
    'access-control-max-age': '86400',
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      ...corsHeaders(),
    },
  });
}

function isValidMonth(s) {
  return /^\d{4}-\d{2}$/.test(s);
}

function validateEvents(events) {
  if (!Array.isArray(events)) return 'events must be an array';
  if (events.length > MAX_EVENTS) return `too many events (max ${MAX_EVENTS})`;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || typeof e !== 'object') return `events[${i}] not an object`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) return `events[${i}].date invalid`;
    if (!/^\d{1,2}:\d{2}$/.test(e.start || '')) return `events[${i}].start invalid`;
    if (!/^\d{1,2}:\d{2}$/.test(e.end || '')) return `events[${i}].end invalid`;
    if (!VALID_STUDIOS.has(e.studio)) return `events[${i}].studio invalid`;
    if (!VALID_TYPES.has(e.type)) return `events[${i}].type invalid`;
    if (typeof e.label !== 'string' || e.label.length === 0) return `events[${i}].label required`;
    if (e.label.length > 200) return `events[${i}].label too long`;
    if (e.note && (typeof e.note !== 'string' || e.note.length > 500)) return `events[${i}].note invalid`;
  }
  return null;
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ─── GET /api/data/YYYY-MM ───
    const dataMatch = path.match(/^\/api\/data\/(\d{4}-\d{2})$/);
    if (dataMatch && request.method === 'GET') {
      const month = dataMatch[1];
      const stored = await env.BALLET_KV.get(month);
      if (stored) {
        return new Response(stored, {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-cache',
            ...corsHeaders(),
          },
        });
      }
      return jsonResponse({ error: 'not_in_kv', month }, 404);
    }

    // ─── POST /api/upload?month=YYYY-MM ───
    if (path === '/api/upload' && request.method === 'POST') {
      const key = request.headers.get('x-upload-key');
      if (!env.UPLOAD_KEY) {
        return jsonResponse({ error: 'server_misconfigured (no UPLOAD_KEY)' }, 500);
      }
      if (!key || key !== env.UPLOAD_KEY) {
        return jsonResponse({ error: 'auth_required_or_invalid' }, 401);
      }
      const month = url.searchParams.get('month');
      if (!month || !isValidMonth(month)) {
        return jsonResponse({ error: 'invalid_month_param' }, 400);
      }
      const cl = parseInt(request.headers.get('content-length') || '0', 10);
      if (cl > MAX_BYTES) {
        return jsonResponse({ error: 'too_large', max: MAX_BYTES }, 413);
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return jsonResponse({ error: 'invalid_json' }, 400);
      }
      if (!body || typeof body !== 'object') {
        return jsonResponse({ error: 'invalid_payload' }, 400);
      }
      const validation = validateEvents(body.events);
      if (validation) return jsonResponse({ error: 'invalid_events', detail: validation }, 400);

      const payload = {
        month,
        month_label: body.month_label || `${month.split('-')[0]}年${parseInt(month.split('-')[1])}月`,
        generated_at: new Date().toISOString().slice(0, 10),
        source: body.source || 'uploaded via app',
        events: body.events,
        _uploaded_at: new Date().toISOString(),
      };
      await env.BALLET_KV.put(month, JSON.stringify(payload));
      return jsonResponse({ ok: true, month, count: body.events.length });
    }

    // ─── GET / ヘルプ ───
    if (path === '/' || path === '') {
      return textResponse(
        '# BalletSchedule API\n\n' +
        'GET  /api/data/YYYY-MM            (read events for the month)\n' +
        'POST /api/upload?month=YYYY-MM    (write, X-Upload-Key auth)\n\n' +
        'See https://github.com/Dai-hydrangea/ballet-schedule\n'
      );
    }

    return jsonResponse({ error: 'not_found', path }, 404);
  },
};

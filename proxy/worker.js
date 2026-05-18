// ─────────────────────────────────────────────────────────────────────
// BalletSchedule ─ API + storage (Cloudflare Worker + KV)
// ─────────────────────────────────────────────────────────────────────
// Endpoints:
//   GET  /api/data/YYYY-MM        → KV から該当月の events JSON を返す
//   POST /api/upload?month=YYYY-MM  (X-Upload-Key 認証)
//                                 → events JSON を KV に保存 + history 追加
//   GET  /api/templates           → 演目テンプレートのリストを返す
//   POST /api/templates  (auth)   → テンプレートリストを更新
//   GET  /api/history             → 変更履歴 (最新 100 件) を返す
//   GET  /                        → 簡易ヘルプ
//
// デプロイ手順は ./README.md 参照
// ─────────────────────────────────────────────────────────────────────

const ALLOW_ORIGIN = '*';
const MAX_BYTES = 256 * 1024;
const MAX_EVENTS = 200;
const MAX_HISTORY = 100;
const MAX_TEMPLATES = 200;
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

async function pushHistory(env, entry) {
  const stored = await env.BALLET_KV.get('history');
  let entries = [];
  if (stored) {
    try { entries = JSON.parse(stored).entries || []; } catch (e) {}
  }
  entries.unshift({ ...entry, ts: new Date().toISOString() });
  if (entries.length > MAX_HISTORY) entries = entries.slice(0, MAX_HISTORY);
  await env.BALLET_KV.put('history', JSON.stringify({ entries }));
}

function formatEventLine(ev) {
  const mo = parseInt(ev.date.split('-')[1], 10);
  const d = parseInt(ev.date.split('-')[2], 10);
  return `${mo}/${d} ${ev.start} ${ev.label}`;
}

const SUMMARY_DETAIL_CAP = 5;

function summarizeChange(prev, next) {
  const prevEvents = (prev && prev.events) ? prev.events : [];
  const nextEvents = next.events || [];
  const keyOf = (ev) => `${ev.date}|${ev.start}|${ev.end}|${ev.label}|${ev.studio}`;
  const prevMap = new Map(prevEvents.map(ev => [keyOf(ev), ev]));
  const nextMap = new Map(nextEvents.map(ev => [keyOf(ev), ev]));
  const added = [];
  const removed = [];
  for (const [k, ev] of nextMap) if (!prevMap.has(k)) added.push(ev);
  for (const [k, ev] of prevMap) if (!nextMap.has(k)) removed.push(ev);

  const parts = [];
  for (const ev of added.slice(0, SUMMARY_DETAIL_CAP)) {
    parts.push(`+ ${formatEventLine(ev)} 追加`);
  }
  for (const ev of removed.slice(0, SUMMARY_DETAIL_CAP)) {
    parts.push(`− ${formatEventLine(ev)} 削除`);
  }
  const moreAdd = Math.max(0, added.length - SUMMARY_DETAIL_CAP);
  const moreRemove = Math.max(0, removed.length - SUMMARY_DETAIL_CAP);
  if (moreAdd + moreRemove > 0) {
    parts.push(`... 他 ${moreAdd + moreRemove} 件`);
  }
  const summary = parts.length > 0
    ? parts.join('\n')
    : '変更なし (内容は同じ)';

  return {
    summary,
    counts: { added: added.length, removed: removed.length, before: prevEvents.length, after: nextEvents.length },
  };
}

export default {
  async fetch(request, env) {
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
      if (!env.UPLOAD_KEY) return jsonResponse({ error: 'server_misconfigured' }, 500);
      const key = request.headers.get('x-upload-key');
      if (!key || key !== env.UPLOAD_KEY) return jsonResponse({ error: 'auth_required_or_invalid' }, 401);

      const month = url.searchParams.get('month');
      if (!month || !isValidMonth(month)) return jsonResponse({ error: 'invalid_month_param' }, 400);

      const cl = parseInt(request.headers.get('content-length') || '0', 10);
      if (cl > MAX_BYTES) return jsonResponse({ error: 'too_large', max: MAX_BYTES }, 413);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      if (!body || typeof body !== 'object') return jsonResponse({ error: 'invalid_payload' }, 400);

      const validation = validateEvents(body.events);
      if (validation) return jsonResponse({ error: 'invalid_events', detail: validation }, 400);

      // Load previous version for conflict detection & summary
      const prevStored = await env.BALLET_KV.get(month);
      let prev = null;
      if (prevStored) { try { prev = JSON.parse(prevStored); } catch (e) {} }

      const prevVersion = prev && prev._version ? prev._version : 0;
      const newVersion = prevVersion + 1;

      // Optimistic locking: if client supplied prev_version and it doesn't match, return 409
      const clientPrev = body.prev_version;
      if (clientPrev !== undefined && clientPrev !== null && clientPrev !== prevVersion) {
        return jsonResponse({
          error: 'conflict',
          detail: `この月のデータは別の人が更新しています (server v${prevVersion}, your v${clientPrev})。 リロードして最新を確認してから再保存してください`,
          server_version: prevVersion,
        }, 409);
      }

      const payload = {
        month,
        month_label: body.month_label || `${month.split('-')[0]}年${parseInt(month.split('-')[1])}月`,
        generated_at: new Date().toISOString().slice(0, 10),
        source: body.source || 'uploaded via app',
        events: body.events,
        _uploaded_at: new Date().toISOString(),
        _version: newVersion,
      };
      await env.BALLET_KV.put(month, JSON.stringify(payload));

      // History entry
      const change = summarizeChange(prev, payload);
      await pushHistory(env, {
        action: 'upload',
        month,
        summary: change.summary,
        counts: change.counts,
      });

      return jsonResponse({ ok: true, month, count: body.events.length, version: newVersion });
    }

    // ─── GET /api/templates ───
    if (path === '/api/templates' && request.method === 'GET') {
      const stored = await env.BALLET_KV.get('templates');
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
      // Default starter templates
      const defaults = {
        items: [
          { label: '海賊',       studio: 'joint',   type: 'rehearsal' },
          { label: '海賊 Va',    studio: 'joint',   type: 'rehearsal' },
          { label: 'オーロラ',   studio: 'kawagoe', type: 'rehearsal' },
          { label: '道化',       studio: 'kawagoe', type: 'rehearsal' },
          { label: '貴婦人',     studio: 'kawagoe', type: 'rehearsal' },
          { label: '宝石',       studio: 'kawagoe', type: 'rehearsal' },
          { label: 'ピラティス', studio: 'kawagoe', type: 'lesson' },
          { label: '合同クラス', studio: 'joint',   type: 'lesson' },
          { label: 'ポワント強化', studio: 'kawagoe', type: 'lesson' },
          { label: '振付のみ',   studio: 'kawagoe', type: 'choreography' },
        ],
      };
      return jsonResponse(defaults);
    }

    // ─── POST /api/templates ───
    if (path === '/api/templates' && request.method === 'POST') {
      if (!env.UPLOAD_KEY) return jsonResponse({ error: 'server_misconfigured' }, 500);
      const key = request.headers.get('x-upload-key');
      if (!key || key !== env.UPLOAD_KEY) return jsonResponse({ error: 'auth_required_or_invalid' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      if (!body || !Array.isArray(body.items)) return jsonResponse({ error: 'invalid_payload (expected { items: [] })' }, 400);
      if (body.items.length > MAX_TEMPLATES) return jsonResponse({ error: 'too_many_templates' }, 400);

      // Validate each template
      for (const t of body.items) {
        if (!t || typeof t !== 'object') return jsonResponse({ error: 'invalid_template_item' }, 400);
        if (typeof t.label !== 'string' || !t.label.trim() || t.label.length > 100)
          return jsonResponse({ error: 'invalid_template_label' }, 400);
        if (t.studio && !VALID_STUDIOS.has(t.studio)) return jsonResponse({ error: 'invalid_template_studio' }, 400);
        if (t.type && !VALID_TYPES.has(t.type)) return jsonResponse({ error: 'invalid_template_type' }, 400);
      }

      const payload = { items: body.items, _updated_at: new Date().toISOString() };
      await env.BALLET_KV.put('templates', JSON.stringify(payload));

      await pushHistory(env, {
        action: 'templates',
        month: null,
        summary: `テンプレート更新: ${body.items.length} 件`,
      });

      return jsonResponse({ ok: true, count: body.items.length });
    }

    // ─── GET /api/export (auth, full backup) ───
    if (path === '/api/export' && request.method === 'GET') {
      if (!env.UPLOAD_KEY) return jsonResponse({ error: 'server_misconfigured' }, 500);
      const key = request.headers.get('x-upload-key') || url.searchParams.get('key');
      if (!key || key !== env.UPLOAD_KEY) return jsonResponse({ error: 'auth_required_or_invalid' }, 401);

      const list = await env.BALLET_KV.list();
      const monthKeys = list.keys.filter(k => /^\d{4}-\d{2}$/.test(k.name));

      const months = {};
      for (const k of monthKeys) {
        const stored = await env.BALLET_KV.get(k.name);
        if (stored) {
          try { months[k.name] = JSON.parse(stored); }
          catch (e) { months[k.name] = { _parse_error: true, raw: stored }; }
        }
      }

      const templatesRaw = await env.BALLET_KV.get('templates');
      const historyRaw = await env.BALLET_KV.get('history');
      const templates = templatesRaw ? JSON.parse(templatesRaw) : null;
      const history = historyRaw ? JSON.parse(historyRaw) : null;

      const backup = {
        version: 1,
        exported_at: new Date().toISOString(),
        worker: 'ballet-schedule-api',
        months,
        templates,
        history,
        meta: {
          month_count: Object.keys(months).length,
          history_count: history && history.entries ? history.entries.length : 0,
          template_count: templates && templates.items ? templates.items.length : 0,
        },
      };

      return new Response(JSON.stringify(backup, null, 2), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="ballet-schedule-backup-${new Date().toISOString().slice(0,10)}.json"`,
          ...corsHeaders(),
        },
      });
    }

    // ─── GET /api/history ───
    if (path === '/api/history' && request.method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), MAX_HISTORY);
      const stored = await env.BALLET_KV.get('history');
      let entries = [];
      if (stored) {
        try { entries = JSON.parse(stored).entries || []; } catch (e) {}
      }
      return jsonResponse({ entries: entries.slice(0, limit), total: entries.length });
    }

    // ─── GET / ヘルプ ───
    if (path === '/' || path === '') {
      return textResponse(
        '# BalletSchedule API\n\n' +
        'GET  /api/data/YYYY-MM            (read events for month)\n' +
        'POST /api/upload?month=YYYY-MM    (write events, X-Upload-Key auth)\n' +
        'GET  /api/templates               (read templates)\n' +
        'POST /api/templates               (write templates, auth)\n' +
        'GET  /api/history?limit=50        (read history)\n' +
        'GET  /api/export                  (full backup, auth)\n\n' +
        'See https://github.com/Dai-hydrangea/ballet-schedule\n'
      );
    }

    return jsonResponse({ error: 'not_found', path }, 404);
  },
};

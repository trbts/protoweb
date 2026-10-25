// ProtoWeb API (Cloudflare Workers + D1). Perfis e permissões vêm sempre do D1. Arquivos ficam no D1 em Base64.
const PROJECT = 'protoweb-4f4b1';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const MIMES = { 'image/webp': [0x52, 0x49, 0x46, 0x46] }; // só WebP: o navegador converte e compacta antes de enviar
const MAX_FILE_BYTES = 150 * 1024; // alvo de 100 KB no navegador, com folga
const MAX_FILES = 3;
const PAGE_SIZE = 50;
const D1_MAX_BYTES = 1.4 * 1048576; // limite de linha do D1 (2 MB) já considerando o Base64
const STATUSES = ['enviado', 'recebido', 'visualizado', 'respondido'];

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const now = () => new Date().toISOString();
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const clean = (s, max) => String(s ?? '').trim().slice(0, max);

let jwks = null, jwksAt = 0;
async function verifyToken(tok) {
  const [h, p, s] = (tok || '').split('.');
  if (!s) throw new HttpError(401, 'Sessão inválida');
  try {
    const dec = (x) => JSON.parse(new TextDecoder().decode(b64u(x)));
    const head = dec(h), pl = dec(p);
    if (!jwks || Date.now() - jwksAt > 3.6e6) { jwks = (await (await fetch(JWKS_URL)).json()).keys; jwksAt = Date.now(); }
    const jwk = jwks.find((k) => k.kid === head.kid);
    if (!jwk || head.alg !== 'RS256') throw 0;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(s), new TextEncoder().encode(h + '.' + p));
    if (!ok || pl.aud !== PROJECT || pl.iss !== 'https://securetoken.google.com/' + PROJECT || pl.exp < Date.now() / 1e3 || !pl.sub) throw 0;
    return pl;
  } catch { throw new HttpError(401, 'Sessão inválida ou expirada'); }
}

// Identifica o usuário; cria cadastro com perfil 'user' se for o primeiro acesso.
async function authUser(req, env) {
  const tok = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const pl = await verifyToken(tok);
  if (!pl.email) throw new HttpError(403, 'Conta sem e-mail');
  let u = await env.DB.prepare('SELECT * FROM users WHERE firebase_uid=?').bind(pl.sub).first();
  if (!u) {
    const t = now();
    await env.DB.prepare("INSERT OR IGNORE INTO users(firebase_uid,name,email,role,created_at,updated_at) VALUES(?,?,?,'user',?,?)")
      .bind(pl.sub, clean(pl.name || pl.email, 120), pl.email.toLowerCase(), t, t).run();
    u = await env.DB.prepare('SELECT * FROM users WHERE firebase_uid=?').bind(pl.sub).first();
  }
  if (!u || !u.active) throw new HttpError(403, 'Acesso desativado. Procure a administração.');
  return u;
}
const needAdm = (u) => { if (u.role !== 'adm') throw new HttpError(403, 'Acesso restrito à administração'); };
const inSector = async (env, u, sid) => !!(await env.DB.prepare('SELECT 1 FROM user_sectors us JOIN sectors s ON s.id=us.sector_id WHERE us.user_id=? AND us.sector_id=? AND s.active=1').bind(u.id, sid).first());

async function getRecipient(env, u, rid) {
  const r = await env.DB.prepare('SELECT r.*, s.name sector_name FROM protocol_recipients r JOIN sectors s ON s.id=r.sector_id WHERE r.id=?').bind(rid).first();
  if (!r || (u.role !== 'adm' && !(await inSector(env, u, r.sector_id)))) throw new HttpError(404, 'Protocolo não encontrado');
  return r;
}

// Valida tipo, tamanho e assinatura (magic bytes) dos arquivos recebidos em Base64.
function prepFiles(env, files) {
  if (!files) return [];
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new HttpError(400, `Envie no máximo ${MAX_FILES} arquivos`);
  const max = MAX_FILE_BYTES;
  return files.map((f) => {
    const sig = MIMES[f?.type];
    if (!sig || typeof f.data !== 'string') throw new HttpError(400, 'Formato não permitido. Envie apenas imagens.');
    let bytes;
    try { bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)); } catch { throw new HttpError(400, 'Arquivo corrompido'); }
    if (bytes.length > max) throw new HttpError(413, `Imagem acima de ${Math.round(max / 1024)} KB`);
    if (!sig.every((b, i) => bytes[i] === b) || String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP') throw new HttpError(400, 'O conteúdo não corresponde ao tipo do arquivo');
    return { name: clean(f.name, 120) || 'arquivo', type: f.type, size: bytes.length, b64: f.data.replace(/\s/g, '') };
  });
}
function storeFiles(env, list, { pid, rid = null, mid = null, uid }) {
  const stmts = [];
  for (const f of list) {
    const key = crypto.randomUUID();
    stmts.push(env.DB.prepare('INSERT INTO protocol_files(protocol_id,recipient_id,message_id,uploaded_by,file_name,mime_type,file_size,storage_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(pid, rid, mid, uid, f.name, f.type, f.size, key, now()));
    stmts.push(env.DB.prepare('INSERT INTO protocol_file_data(storage_key,content) VALUES(?,?)').bind(key, f.b64));
  }
  return stmts;
}
const event = (env, pid, rid, uid, type, details) =>
  env.DB.prepare('INSERT INTO protocol_events(protocol_id,recipient_id,user_id,event_type,details,created_at) VALUES(?,?,?,?,?,?)').bind(pid, rid, uid, type, details ?? null, now());

// ---- Arquivos e telefone
async function fileResponse(env, f, disp = 'inline') {
  const d = await env.DB.prepare('SELECT content FROM protocol_file_data WHERE storage_key=?').bind(f.storage_key).first();
  if (!d) throw new HttpError(404, 'Arquivo indisponível');
  return new Response(Uint8Array.from(atob(d.content), (c) => c.charCodeAt(0)), { headers: { 'Content-Type': f.mime_type, 'Content-Disposition': `${disp}; filename*=UTF-8''${encodeURIComponent(f.file_name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' } });
}
// Celular brasileiro com DDD (10 ou 11 dígitos); guarda com o 55 na frente, pronto para o wa.me.
function normPhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  return /^[1-9]{2}9?\d{8}$/.test(d) ? '55' + d : null;
}

// ---- Push (Firebase Cloud Messaging v1). Requer o segredo FCM_SERVICE_ACCOUNT; sem ele, só o aviso com o app aberto funciona.
let fcmTok = null, fcmExp = 0;
const b64url = (x) => (typeof x === 'string' ? btoa(x) : btoa(String.fromCharCode(...x))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
async function fcmAccess(sa) {
  if (fcmTok && Date.now() < fcmExp) return fcmTok;
  const iat = Math.floor(Date.now() / 1e3);
  const unsigned = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const r = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + unsigned + '.' + b64url(sig) })).json();
  if (!r.access_token) throw new Error('FCM: falha ao obter token de acesso');
  fcmTok = r.access_token; fcmExp = Date.now() + 3.3e6;
  return fcmTok;
}
// Avisa usuários dos setores (kind 'sector') ou todos os administradores (kind 'adm'), exceto quem gerou o evento.
// O texto não traz o assunto do documento (LGPD): a notificação pode aparecer na tela para quem está por perto.
async function pushTo(env, kind, sids, exclude, title, body) {
  if (!env.FCM_SERVICE_ACCOUNT) return;
  try {
    const rows = kind === 'adm'
      ? await env.DB.prepare("SELECT DISTINCT t.token FROM push_tokens t JOIN users u ON u.id=t.user_id WHERE u.role='adm' AND u.active=1 AND t.user_id<>?").bind(exclude).all()
      : await env.DB.prepare(`SELECT DISTINCT t.token FROM push_tokens t JOIN users u ON u.id=t.user_id JOIN user_sectors us ON us.user_id=u.id WHERE u.active=1 AND t.user_id<>? AND us.sector_id IN (${sids.map(() => '?').join(',')})`).bind(exclude, ...sids).all();
    if (!rows.results.length) return;
    const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT), at = await fcmAccess(sa), app = env.APP_URL || '';
    await Promise.all(rows.results.map(async ({ token }) => {
      const webpush = { headers: { Urgency: 'high', TTL: '86400' }, notification: { tag: 'protoweb', ...(app && { icon: app + 'icon-192.png' }) }, ...(app.startsWith('https://') && { fcm_options: { link: app } }) };
      const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, { method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { token, notification: { title, body }, webpush } }) });
      if (r.status === 404) await env.DB.prepare('DELETE FROM push_tokens WHERE token=?').bind(token).run(); // computador que não recebe mais avisos
      else if (!r.ok) console.error('push', r.status, await r.text()); // aparece em Logs do Worker
    }));
  } catch (e) { console.error('push', e); }
}

async function route(req, env, u, url, ctx) {
  const m = req.method, path = url.pathname, db = env.DB;
  let x;

  if (m === 'GET' && path === '/api/me') {
    const sectors = u.role === 'adm'
      ? await db.prepare('SELECT id,name,description FROM sectors WHERE active=1 ORDER BY name').all()
      : await db.prepare('SELECT s.id,s.name,s.description FROM sectors s JOIN user_sectors us ON us.sector_id=s.id WHERE us.user_id=? AND s.active=1 ORDER BY s.name').bind(u.id).all();
    return { user: { id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone || '' }, sectors: sectors.results };
  }

  if (m === 'PUT' && path === '/api/me/profile') {
    const b = await req.json(), name = clean(b.name, 120), phone = normPhone(b.phone);
    if (name.length < 3) throw new HttpError(400, 'Informe seu nome completo');
    if (!phone) throw new HttpError(400, 'Informe um celular com DDD, por exemplo (92) 99999-9999');
    await db.prepare('UPDATE users SET name=?, phone=?, updated_at=? WHERE id=?').bind(name, phone, now(), u.id).run();
    return { ok: true, name, phone };
  }

  // Dados para o aviso por WhatsApp: destinatários (rid, usado no link do painel) e contatos dos usuários de cada setor.
  if ((x = path.match(/^\/api\/protocols\/(\d+)\/share$/)) && m === 'GET') {
    needAdm(u);
    const p = await db.prepare('SELECT id,protocol_number FROM protocols WHERE id=?').bind(x[1]).first();
    if (!p) throw new HttpError(404, 'Protocolo não encontrado');
    const secs = (await db.prepare('SELECT r.id rid,s.id sid,s.name FROM protocol_recipients r JOIN sectors s ON s.id=r.sector_id WHERE r.protocol_id=? ORDER BY s.name').bind(p.id).all()).results;
    const us = (await db.prepare(`SELECT us.sector_id,u.name,u.phone FROM user_sectors us JOIN users u ON u.id=us.user_id WHERE u.active=1 AND us.sector_id IN (${secs.map(() => '?').join(',') || 'NULL'}) ORDER BY u.name`).bind(...secs.map((q) => q.sid)).all()).results;
    return { protocol_number: p.protocol_number, sectors: secs.map((q) => ({ sector: q.name, rid: q.rid, users: us.filter((r) => r.sector_id === q.sid).map((r) => ({ name: r.name, phone: r.phone })) })) };
  }

  // ---- Notificações
  if (m === 'GET' && path === '/api/notifications') {
    if (u.role === 'adm') return { count: (await db.prepare('SELECT COUNT(*) n FROM protocol_recipients WHERE reply_unseen=1').first()).n, sectors: {} };
    const rows = (await db.prepare('SELECT r.sector_id sid, COUNT(*) n FROM protocol_recipients r JOIN user_sectors us ON us.sector_id=r.sector_id JOIN sectors s ON s.id=r.sector_id WHERE us.user_id=? AND s.active=1 AND (r.first_viewed_at IS NULL OR r.sector_unseen=1) GROUP BY r.sector_id').bind(u.id).all()).results;
    return { count: rows.reduce((a, r) => a + r.n, 0), sectors: Object.fromEntries(rows.map((r) => [r.sid, r.n])) };
  }
  if (m === 'POST' && path === '/api/push/register') {
    const t = clean((await req.json()).token, 4096);
    if (t.length < 20) throw new HttpError(400, 'Token inválido');
    await db.prepare('INSERT INTO push_tokens(user_id,token,created_at) VALUES(?,?,?) ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id, created_at=excluded.created_at').bind(u.id, t, now()).run();
    return { ok: true };
  }
  if (m === 'POST' && path === '/api/push/unregister') {
    await db.prepare('DELETE FROM push_tokens WHERE token=? AND user_id=?').bind(clean((await req.json()).token, 4096), u.id).run();
    return { ok: true };
  }

  // ---- Setores
  if (path === '/api/sectors') {
    needAdm(u);
    if (m === 'GET') return (await db.prepare('SELECT s.*, (SELECT COUNT(*) FROM user_sectors WHERE sector_id=s.id) users FROM sectors s ORDER BY name').all()).results;
    if (m === 'POST') {
      const b = await req.json(), name = clean(b.name, 80);
      if (!name) throw new HttpError(400, 'Informe o nome do setor');
      try { await db.prepare('INSERT INTO sectors(name,description,created_at) VALUES(?,?,?)').bind(name, clean(b.description, 300), now()).run(); }
      catch { throw new HttpError(409, 'Já existe um setor com esse nome'); }
      return { ok: true };
    }
  }
  if ((x = path.match(/^\/api\/sectors\/(\d+)$/)) && m === 'PUT') {
    needAdm(u);
    const b = await req.json(), name = clean(b.name, 80);
    if (!name) throw new HttpError(400, 'Informe o nome do setor');
    try { await db.prepare('UPDATE sectors SET name=?,description=?,active=? WHERE id=?').bind(name, clean(b.description, 300), b.active ? 1 : 0, x[1]).run(); }
    catch { throw new HttpError(409, 'Já existe um setor com esse nome'); }
    return { ok: true };
  }

  // ---- Usuários (o perfil NÃO pode ser alterado por aqui)
  if (m === 'GET' && path === '/api/users') {
    needAdm(u);
    const us = (await db.prepare('SELECT id,name,email,role,active,phone FROM users ORDER BY name').all()).results;
    const links = (await db.prepare('SELECT user_id,sector_id FROM user_sectors').all()).results;
    return us.map((r) => ({ ...r, sector_ids: links.filter((l) => l.user_id === r.id).map((l) => l.sector_id) }));
  }
  if ((x = path.match(/^\/api\/users\/(\d+)$/)) && m === 'PUT') {
    needAdm(u);
    const b = await req.json(), ids = [...new Set((b.sector_ids || []).map(Number).filter(Number.isInteger))];
    const st = [db.prepare('UPDATE users SET active=?,updated_at=? WHERE id=?').bind(b.active ? 1 : 0, now(), x[1]), db.prepare('DELETE FROM user_sectors WHERE user_id=?').bind(x[1])];
    for (const sid of ids) st.push(db.prepare('INSERT INTO user_sectors(user_id,sector_id,created_at) SELECT ?,id,? FROM sectors WHERE id=?').bind(x[1], now(), sid));
    await db.batch(st);
    return { ok: true };
  }

  // ---- Painel
  if (m === 'GET' && path === '/api/dashboard') {
    needAdm(u);
    const c = await db.prepare(`SELECT COUNT(*) enviados, COUNT(received_at) recebidos, COUNT(first_viewed_at) visualizados, COUNT(responded_at) respondidos, SUM(responded_at IS NULL) pendentes FROM protocol_recipients`).first();
    const total = (await db.prepare('SELECT COUNT(*) n FROM protocols').first()).n;
    const porSetor = (await db.prepare('SELECT s.id,s.name, COUNT(r.id) total, COUNT(r.responded_at) respondidos, COUNT(r.id)-COUNT(r.responded_at) pendentes FROM sectors s LEFT JOIN protocol_recipients r ON r.sector_id=s.id WHERE s.active=1 GROUP BY s.id ORDER BY total DESC, s.name').all()).results;
    return { total, ...c, pendentes: c.pendentes || 0, porSetor };
  }

  // ---- Protocolos
  if (path === '/api/protocols' && m === 'POST') {
    needAdm(u);
    const b = await req.json(), subject = clean(b.subject, 200), desc = clean(b.description, 5000);
    const sids = [...new Set((b.sector_ids || []).map(Number).filter(Number.isInteger))];
    if (!subject || !sids.length) throw new HttpError(400, 'Informe o assunto e ao menos um setor');
    const ph = sids.map(() => '?').join(',');
    const ok = await db.prepare(`SELECT COUNT(*) n FROM sectors WHERE active=1 AND id IN (${ph})`).bind(...sids).first();
    if (ok.n !== sids.length) throw new HttpError(400, 'Há setores inválidos ou desativados');
    const files = prepFiles(env, b.files);
    const t = now();
    const p = await db.prepare('INSERT INTO protocols(protocol_number,subject,description,created_by,created_at) VALUES(?,?,?,?,?) RETURNING id').bind('tmp-' + crypto.randomUUID(), subject, desc, u.id, t).first();
    const num = `PW-${new Date().getFullYear()}-${String(p.id).padStart(6, '0')}`;
    const st = [db.prepare('UPDATE protocols SET protocol_number=? WHERE id=?').bind(num, p.id), event(env, p.id, null, u.id, 'criado', num)];
    for (const sid of sids) {
      st.push(db.prepare("INSERT INTO protocol_recipients(protocol_id,sector_id,sent_at,received_at,status) VALUES(?,?,?,?,'recebido')").bind(p.id, sid, t, t));
      for (const ev of ['enviado', 'recebido'])
        st.push(db.prepare('INSERT INTO protocol_events(protocol_id,recipient_id,user_id,event_type,created_at) SELECT ?,id,?,?,? FROM protocol_recipients WHERE protocol_id=? AND sector_id=?').bind(p.id, u.id, ev, t, p.id, sid));
    }
    st.push(...(storeFiles(env, files, { pid: p.id, uid: u.id })));
    await db.batch(st);
    ctx.waitUntil(pushTo(env, 'sector', sids, u.id, 'Novo protocolo recebido', `Protocolo ${num} encaminhado ao seu setor.`));
    return { id: p.id, protocol_number: num };
  }

  if (path === '/api/protocols' && m === 'GET') {
    const q = url.searchParams, sid = Number(q.get('sector_id')) || null;
    if (u.role !== 'adm' && (!sid || !(await inSector(env, u, sid)))) throw new HttpError(403, 'Setor não autorizado');
    let sql = ` FROM protocol_recipients r JOIN protocols p ON p.id=r.protocol_id JOIN sectors s ON s.id=r.sector_id WHERE 1=1`;
    const a = [];
    if (sid) { sql += ' AND r.sector_id=?'; a.push(sid); }
    if (q.get('q')) { sql += ' AND (p.protocol_number LIKE ? OR p.subject LIKE ?)'; const l = `%${clean(q.get('q'), 100).replace(/[%_]/g, '')}%`; a.push(l, l); }
    if (STATUSES.includes(q.get('status'))) { sql += ' AND r.status=?'; a.push(q.get('status')); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.get('from') || '')) { sql += ' AND r.sent_at>=?'; a.push(q.get('from')); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.get('to') || '')) { sql += ' AND r.sent_at<=?'; a.push(q.get('to') + 'T23:59:59.999Z'); }
    const total = (await db.prepare('SELECT COUNT(*) n' + sql).bind(...a).first()).n;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)), page = Math.min(Math.max(1, Math.floor(Number(q.get('page'))) || 1), pages);
    const rows = (await db.prepare('SELECT r.id rid,p.protocol_number,p.subject,r.sent_at,r.received_at,r.first_viewed_at,r.responded_at,r.status,r.reply_unseen ru,r.sector_unseen su,s.name sector' + sql + ' ORDER BY r.sent_at DESC, r.id DESC LIMIT ? OFFSET ?').bind(...a, PAGE_SIZE, (page - 1) * PAGE_SIZE).all()).results;
    return { rows, total, page, pages };
  }

  if ((x = path.match(/^\/api\/recipients\/(\d+)$/)) && m === 'GET') {
    const r = await getRecipient(env, u, x[1]);
    // Ao abrir, zera o aviso de "novo" de quem está olhando (setor ou central).
    const flag = u.role === 'adm' ? 'reply_unseen' : 'sector_unseen';
    if (r[flag]) await db.prepare(`UPDATE protocol_recipients SET ${flag}=0 WHERE id=?`).bind(r.id).run();
    // A visualização é registrada aqui, no backend, apenas quando um usuário do setor abre o protocolo.
    if (u.role !== 'adm' && !r.first_viewed_at) {
      const t = now();
      await db.batch([
        db.prepare("UPDATE protocol_recipients SET first_viewed_at=?, status=CASE WHEN status='respondido' THEN status ELSE 'visualizado' END WHERE id=? AND first_viewed_at IS NULL").bind(t, r.id),
        event(env, r.protocol_id, r.id, u.id, 'visualizado', null),
      ]);
      r.first_viewed_at = t; if (r.status !== 'respondido') r.status = 'visualizado';
    }
    const protocol = await db.prepare('SELECT id,protocol_number,subject,description,created_at FROM protocols WHERE id=?').bind(r.protocol_id).first();
    const messages = (await db.prepare('SELECT m.id,m.message,m.created_at,u.name author,u.role FROM protocol_messages m JOIN users u ON u.id=m.sender_user_id WHERE m.recipient_id=? ORDER BY m.id').bind(r.id).all()).results;
    const files = (await db.prepare('SELECT id,message_id,file_name,mime_type,file_size,created_at FROM protocol_files WHERE protocol_id=? AND (recipient_id IS NULL OR recipient_id=?) ORDER BY id').bind(r.protocol_id, r.id).all()).results;
    const events = (await db.prepare('SELECT e.event_type,e.details,e.created_at,u.name author FROM protocol_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.protocol_id=? AND (e.recipient_id IS NULL OR e.recipient_id=?) ORDER BY e.id').bind(r.protocol_id, r.id).all()).results;
    return { protocol, recipient: r, messages, files, events };
  }

  if ((x = path.match(/^\/api\/recipients\/(\d+)\/messages$/)) && m === 'POST') {
    const r = await getRecipient(env, u, x[1]);
    const b = await req.json(), text = clean(b.message, 5000), files = prepFiles(env, b.files);
    if (!text && !files.length) throw new HttpError(400, 'Escreva uma mensagem ou anexe um arquivo');
    const t = now(), fromSector = u.role !== 'adm';
    const msg = await db.prepare('INSERT INTO protocol_messages(protocol_id,recipient_id,sender_user_id,message,created_at) VALUES(?,?,?,?,?) RETURNING id').bind(r.protocol_id, r.id, u.id, text, t).first();
    const st = [event(env, r.protocol_id, r.id, u.id, fromSector ? 'resposta' : 'mensagem_central', text.slice(0, 120))];
    st.push(fromSector
      ? db.prepare("UPDATE protocol_recipients SET status='respondido', responded_at=COALESCE(responded_at,?), reply_unseen=1 WHERE id=?").bind(t, r.id)
      : db.prepare('UPDATE protocol_recipients SET sector_unseen=1 WHERE id=?').bind(r.id));
    if (files.length) st.push(event(env, r.protocol_id, r.id, u.id, 'anexo', `${files.length} arquivo(s)`));
    st.push(...(storeFiles(env, files, { pid: r.protocol_id, rid: r.id, mid: msg.id, uid: u.id })));
    await db.batch(st);
    const num = (await db.prepare('SELECT protocol_number FROM protocols WHERE id=?').bind(r.protocol_id).first()).protocol_number;
    ctx.waitUntil(fromSector
      ? pushTo(env, 'adm', null, u.id, 'Nova resposta', `${r.sector_name} respondeu ao protocolo ${num}.`)
      : pushTo(env, 'sector', [r.sector_id], u.id, 'Nova mensagem da central', `Há uma nova mensagem no protocolo ${num}.`));
    return { ok: true };
  }

  if ((x = path.match(/^\/api\/files\/(\d+)$/)) && m === 'GET') {
    const f = await db.prepare('SELECT * FROM protocol_files WHERE id=?').bind(x[1]).first();
    if (!f) throw new HttpError(404, 'Arquivo não encontrado');
    if (u.role !== 'adm') {
      const ok = f.recipient_id
        ? (await getRecipient(env, u, f.recipient_id), true)
        : !!(await db.prepare('SELECT 1 FROM protocol_recipients r JOIN user_sectors us ON us.sector_id=r.sector_id JOIN sectors s ON s.id=r.sector_id WHERE r.protocol_id=? AND us.user_id=? AND s.active=1').bind(f.protocol_id, u.id).first());
      if (!ok) throw new HttpError(404, 'Arquivo não encontrado');
    }
    return fileResponse(env, f);
  }

  throw new HttpError(404, 'Rota não encontrada');
}

export default {
  async fetch(req, env, ctx) {
    const cors = { 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', Vary: 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const url = new URL(req.url);
      if (url.pathname === '/') return new Response('ProtoWeb API', { headers: cors });
      const u = await authUser(req, env);
      const out = await route(req, env, u, url, ctx);
      if (out instanceof Response) { Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v)); return out; }
      return Response.json(out, { headers: cors });
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      const status = e instanceof HttpError ? e.status : 500;
      return Response.json({ error: e instanceof HttpError ? e.message : 'Erro interno. Tente novamente.' }, { status, headers: cors });
    }
  },
};

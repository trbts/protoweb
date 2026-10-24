import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBZLo5U4JkQvzFYoig8L-wRfe2DDuLLLWg",
  authDomain: "protoweb-4f4b1.firebaseapp.com",
  projectId: "protoweb-4f4b1",
  storageBucket: "protoweb-4f4b1.firebasestorage.app",
  messagingSenderId: "18056559923",
  appId: "1:18056559923:web:649b5ce4824e7a94c51246"
};
const API = "https://protoweb.dw0mc7.workers.dev";
const MAX_MB = 1;
const auth = getAuth(initializeApp(firebaseConfig));

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (d) => (d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");
const LABEL = { enviado: "Enviado", recebido: "Recebido", visualizado: "Visualizado", respondido: "Respondido" };
const EVENT = { criado: "Protocolo criado", enviado: "Enviado pela central", recebido: "Recebimento registrado na caixa de entrada", visualizado: "Primeira visualização", resposta: "Resposta do setor", mensagem_central: "Mensagem da central", anexo: "Documento anexado" };
const two = (d) => (d ? `<span class="d">${new Date(d).toLocaleDateString("pt-BR")}</span><span class="t">${new Date(d).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>` : "—");
const chip = (s) => `<span class="chip ${s}">${LABEL[s] || s}</span>`;

let me = null, sectors = [], busy = 0;

// ---------- utilidades
function toast(msg, err) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : ""); t.textContent = msg;
  $("#toasts").append(t); setTimeout(() => t.remove(), 4500);
}
async function api(path, { method = "GET", body, blob } = {}) {
  busy++; $("#bar").hidden = false;
  try {
    const token = await auth.currentUser.getIdToken();
    const r = await fetch(API + path, { method, headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (blob && r.ok) return await r.blob();
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Erro " + r.status);
    return j;
  } finally { if (!--busy) $("#bar").hidden = true; }
}
function dialog(html, { ok = "Confirmar", onOk, big } = {}) {
  const m = document.createElement("div");
  m.className = "modal" + (big ? " big" : "");
  m.innerHTML = `<div role="dialog">${html}<div class="acts"><button class="btn sec" data-x>${onOk ? "Cancelar" : "Fechar"}</button>${onOk ? `<button class="btn" data-ok>${ok}</button>` : ""}</div></div>`;
  document.body.append(m);
  const close = () => m.remove();
  m.addEventListener("click", (e) => { if (e.target === m || e.target.dataset.x !== undefined) close(); });
  const b = $("[data-ok]", m);
  if (b) b.onclick = async () => { b.disabled = true; try { if ((await onOk(m)) !== false) close(); } catch (e) { toast(e.message, true); } b.disabled = false; };
  return m;
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

// Lê arquivos: valida o formato e, se passar de 1 MB, compacta antes de enviar (Base64 no D1).
const LIMIT = MAX_MB * 1048576, TARGET = Math.floor(LIMIT * 0.95);
async function readFiles(list) {
  const out = [];
  for (const f of list) {
    if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(f.type)) throw new Error(`"${f.name}": use PDF, JPG, PNG ou WebP`);
    let blob = f, name = f.name;
    if (f.size > LIMIT) {
      toast(`Compactando "${f.name}"...`);
      blob = f.type === "application/pdf" ? await packPdf(f) : await packImage(f);
      if (!blob) throw new Error(`Não foi possível reduzir "${f.name}" para menos de ${MAX_MB} MB sem perder muita qualidade. Divida o documento em partes.`);
      if (blob.type === "image/jpeg" && f.type !== "image/jpeg") name = name.replace(/\.\w+$/, "") + ".jpg";
      toast(`"${f.name}" compactado: ${(f.size / 1048576).toFixed(1)} MB para ${(blob.size / 1048576).toFixed(2)} MB`);
    }
    out.push({ name, type: blob.type, data: await toB64(blob) });
  }
  return out;
}
// Imagem: mantém o tamanho original e baixa a qualidade aos poucos; só reduz as dimensões se for preciso.
async function packImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const c = document.createElement("canvas"), g = c.getContext("2d");
  for (const k of [1, 0.9, 0.8, 0.7, 0.6, 0.5]) {
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    for (const q of [0.9, 0.82, 0.75, 0.68]) {
      const b = await new Promise((r) => c.toBlob(r, "image/jpeg", q));
      if (b && b.size <= TARGET) return b;
    }
  }
  return null;
}
const loadScript = (src) => new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => no(new Error("Não foi possível carregar a biblioteca de compactação")); document.head.append(s); });
// PDF: 1) re-salva sem mexer no conteúdo (mantém o texto); 2) se ainda passar, refaz as páginas como imagens JPEG.
async function packPdf(file) {
  const CDN = "https://cdnjs.cloudflare.com/ajax/libs/";
  if (!window.PDFLib) await loadScript(CDN + "pdf-lib/1.17.1/pdf-lib.min.js");
  const buf = await file.arrayBuffer();
  try {
    const out = await (await PDFLib.PDFDocument.load(buf, { ignoreEncryption: true })).save({ useObjectStreams: true });
    if (out.length <= TARGET) return new Blob([out], { type: "application/pdf" });
  } catch { /* segue para a etapa 2 */ }
  if (!window.pdfjsLib) { await loadScript(CDN + "pdf.js/3.11.174/pdf.min.js"); pdfjsLib.GlobalWorkerOptions.workerSrc = CDN + "pdf.js/3.11.174/pdf.worker.min.js"; }
  const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
  const c = document.createElement("canvas"), g = c.getContext("2d");
  for (const [scale, q] of [[2.5, 0.8], [2, 0.75], [2, 0.62], [1.6, 0.62], [1.4, 0.55]]) {
    const doc = await PDFLib.PDFDocument.create();
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i), vp = page.getViewport({ scale }), base = page.getViewport({ scale: 1 });
      c.width = vp.width; c.height = vp.height; g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      const jpg = await new Promise((r) => c.toBlob(r, "image/jpeg", q));
      const img = await doc.embedJpg(await jpg.arrayBuffer());
      doc.addPage([base.width, base.height]).drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
    }
    const out = await doc.save();
    if (out.length <= TARGET) { toast("Páginas do PDF convertidas em imagem para reduzir o tamanho (o texto deixa de ser selecionável)."); return new Blob([out], { type: "application/pdf" }); }
  }
  return null;
}
// Compacta assim que os arquivos são escolhidos e guarda o resultado no próprio campo.
function watchFiles(input) {
  const info = document.createElement("div"); info.className = "muted"; input.after(info);
  input._files = []; input._n = 0; input._job = Promise.resolve();
  input.addEventListener("change", () => {
    const id = ++input._n, picked = [...input.files];
    input._files = []; info.textContent = picked.length ? "Preparando arquivos..." : "";
    input._job = (async () => {
      try {
        const files = await readFiles(picked);
        if (id !== input._n) return;
        input._files = files;
        info.textContent = "Pronto para enviar: " + files.map((f) => `${f.name} (${Math.ceil((f.data.length * 0.75) / 1024)} KB)`).join(", ");
      } catch (e) {
        if (id !== input._n) return;
        input.value = ""; input._files = []; info.textContent = ""; toast(e.message, true);
      }
    })();
  });
}
const getFiles = async (input) => { await input._job; return input._files; };
const toB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });

async function openFile(id, name, type) {
  const blob = await api("/api/files/" + id, { blob: true }), url = URL.createObjectURL(blob);
  const m = dialog(`<h2>${esc(name)}</h2>${type === "application/pdf" ? `<iframe src="${url}" title="${esc(name)}"></iframe>` : `<img src="${url}" alt="${esc(name)}">`}`, { big: true });
  new MutationObserver(() => { if (!document.body.contains(m)) URL.revokeObjectURL(url); }).observe(document.body, { childList: true });
}
const fileList = (files) => files.length ? `<ul>${files.map((f) => `<li><button class="link" data-file="${f.id}" data-name="${esc(f.file_name)}" data-type="${f.mime_type}">${esc(f.file_name)}</button> <span class="muted">(${Math.ceil(f.file_size / 1024)} KB)</span></li>`).join("")}</ul>` : "";
const bindFiles = (root) => root.querySelectorAll("[data-file]").forEach((b) => (b.onclick = guard(() => openFile(b.dataset.file, b.dataset.name, b.dataset.type))));

// ---------- estrutura
function shell(inner, active) {
  const adm = me.role === "adm", sec = JSON.parse(sessionStorage.getItem("sector") || "null");
  const nav = (h, t, k) => `<a href="${h}" class="${active === k ? "on" : ""}">${t}</a>`;
  $("#app").innerHTML = `<div class="shell"><aside class="side"><div class="brand">ProtoWeb</div><nav>
    ${adm ? nav("#/central", "Painel", "p") + nav("#/central/protocolos", "Protocolos", "l") + nav("#/central/novo", "Novo protocolo", "n") + nav("#/central/setores", "Setores", "s") + nav("#/central/usuarios", "Usuários", "u") : ""}
    ${nav("#/setores", adm ? "Ver como setor" : "Meus setores", "m")}</nav></aside>
    <div><header class="top"><span><span class="org">Prefeitura Municipal de Careiro</span>${sec ? `<span class="tag">Setor: ${esc(sec.name)}</span>` : ""}</span><span class="who">${esc(me.name)} (${esc(me.email)}) <button class="link" id="out">Sair</button></span></header>
    <main>${inner}</main></div></div>`;
  $("#out").onclick = () => signOut(auth);
}
const loginView = () => {
  $("#app").innerHTML = `<div class="login"><div class="panel"><h1>ProtoWeb</h1><p class="org-l">Prefeitura Municipal de Careiro</p><p class="muted">Protocolos e documentos</p><button class="btn" id="g">Entrar com Google</button></div></div>`;
  $("#g").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => toast("Não foi possível entrar: " + e.code, true));
};

// ---------- telas
const views = {
  async setores() {
    sectors = (await api("/api/me")).sectors;
    shell(`<h1>Escolha o setor</h1>${sectors.length ? `<div class="cards">${sectors.map((s) => `<button class="card" data-id="${s.id}" data-name="${esc(s.name)}"><b>${esc(s.name)}</b><span class="muted">${esc(s.description || "")}</span></button>`).join("")}</div>` : `<div class="panel empty">Você ainda não tem acesso a nenhum setor. Peça à administração para liberar.</div>`}`, "m");
    document.querySelectorAll(".card").forEach((c) => (c.onclick = () => { sessionStorage.setItem("sector", JSON.stringify({ id: c.dataset.id, name: c.dataset.name })); location.hash = "#/setor/" + c.dataset.id; }));
  },
  async setor(id) { await listView(id, `Caixa de entrada`, "m"); },
  async central() {
    const d = await api("/api/dashboard"), k = (n, l, c = "") => `<div class="kpi ${c}"><b>${n}</b><span>${l}</span></div>`;
    shell(`<h1>Painel central</h1><div class="kpis">${k(d.total, "Protocolos")}${k(d.enviados, "Enviados")}${k(d.recebidos, "Recebidos")}${k(d.visualizados, "Visualizados")}${k(d.respondidos, "Respondidos")}${k(d.pendentes, "Pendentes de resposta", "pend")}</div>
    <div class="two"><div class="panel"><h2>Enviados recentemente</h2>${d.recentes.length ? `<ul>${d.recentes.map((p) => `<li>${esc(p.protocol_number)} — ${esc(p.subject)} <span class="muted">(${p.setores} setor(es), ${fmt(p.created_at)})</span></li>`).join("")}</ul>` : `<p class="muted">Nenhum protocolo ainda.</p>`}</div>
    <div class="panel"><h2>Últimas movimentações</h2>${d.movs.length ? `<ul>${d.movs.map((e) => `<li>${esc(e.protocol_number)}: ${esc(EVENT[e.event_type] || e.event_type)}${e.sector ? " · " + esc(e.sector) : ""}<br><small class="muted">${fmt(e.created_at)}</small></li>`).join("")}</ul>` : `<p class="muted">Sem movimentações.</p>`}</div></div>`, "p");
  },
  async protocolos() { await listView(null, "Protocolos", "l"); },
  async novo() {
    const list = (await api("/api/sectors")).filter((s) => s.active);
    shell(`<h1>Novo protocolo</h1><form class="panel" id="f"><div class="field"><label for="s">Assunto</label><input id="s" required maxlength="200"></div>
    <div class="field"><label for="d">Conteúdo do documento</label><textarea id="d" maxlength="5000"></textarea></div>
    <div class="field"><label>Setores destinatários</label>${list.length ? `<div class="checks">${list.map((s) => `<label><input type="checkbox" name="sec" value="${s.id}"> ${esc(s.name)}</label>`).join("")}</div>` : `<p class="muted">Cadastre setores antes de enviar.</p>`}</div>
    <div class="field"><label for="a">Anexos (PDF ou imagem; arquivos acima de ${MAX_MB} MB são compactados automaticamente)</label><input id="a" type="file" multiple accept="application/pdf,image/*"></div>
    <p class="muted">Ao enviar, o protocolo entra na caixa de entrada de cada setor e o recebimento é registrado automaticamente. A visualização só é registrada quando alguém do setor abrir o protocolo.</p>
    <button class="btn">Enviar protocolo</button></form>`, "n");
    watchFiles($("#a"));
    $("#f").onsubmit = (e) => {
      e.preventDefault();
      const ids = [...document.querySelectorAll("[name=sec]:checked")].map((c) => +c.value);
      if (!ids.length) return toast("Selecione ao menos um setor", true);
      dialog(`<h2>Confirmar envio</h2><p>Enviar o protocolo para ${ids.length} setor(es)? Essa ação não pode ser desfeita.</p>`, { ok: "Enviar", onOk: async () => {
        const files = await getFiles($("#a"));
        const r = await api("/api/protocols", { method: "POST", body: { subject: $("#s").value, description: $("#d").value, sector_ids: ids, files } });
        toast("Protocolo enviado: " + r.protocol_number); location.hash = "#/central/protocolos";
      } });
    };
  },
  async "central-setores"() {
    const list = await api("/api/sectors");
    shell(`<h1>Setores</h1><form class="panel filters" id="f" style="grid-template-columns:1fr 2fr auto"><div><label for="n">Nome</label><input id="n" required maxlength="80"></div><div><label for="e">Descrição</label><input id="e" maxlength="300"></div><button class="btn">Cadastrar setor</button></form>
    <div class="wrap"><table><tr><th>Nome</th><th>Descrição</th><th>Usuários</th><th>Situação</th><th></th></tr>${list.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.description)}</td><td>${s.users}</td><td>${s.active ? "Ativo" : "Desativado"}</td><td><button class="btn sec sm" data-e="${s.id}">Editar</button></td></tr>`).join("") || `<tr><td colspan="5" class="empty">Nenhum setor cadastrado.</td></tr>`}</table></div>`, "s");
    $("#f").onsubmit = guard(async (e) => { e.preventDefault(); await api("/api/sectors", { method: "POST", body: { name: $("#n").value, description: $("#e").value } }); toast("Setor cadastrado"); route(); });
    document.querySelectorAll("[data-e]").forEach((b) => (b.onclick = () => {
      const s = list.find((x) => x.id == b.dataset.e);
      dialog(`<h2>Editar setor</h2><div class="field"><label>Nome</label><input id="m1" value="${esc(s.name)}"></div><div class="field"><label>Descrição</label><input id="m2" value="${esc(s.description)}"></div><label class="checks"><span><input type="checkbox" id="m3" ${s.active ? "checked" : ""}> Setor ativo</span></label>`, { ok: "Salvar", onOk: async () => { await api("/api/sectors/" + s.id, { method: "PUT", body: { name: $("#m1").value, description: $("#m2").value, active: $("#m3").checked } }); toast("Setor atualizado"); route(); } });
    }));
  },
  async "central-usuarios"() {
    const [users, secs] = await Promise.all([api("/api/users"), api("/api/sectors")]);
    const name = (id) => secs.find((s) => s.id === id)?.name || "";
    shell(`<h1>Usuários</h1><p class="muted">Usuários entram pelo Google. O perfil de administrador só pode ser concedido diretamente no banco de dados.</p><div class="wrap"><table><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Setores autorizados</th><th>Acesso</th><th></th></tr>${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role === "adm" ? "Administrador" : "Usuário"}</td><td>${u.sector_ids.map((i) => esc(name(i))).join(", ") || "—"}</td><td>${u.active ? "Ativo" : "Bloqueado"}</td><td><button class="btn sec sm" data-u="${u.id}">Editar</button></td></tr>`).join("")}</table></div>`, "u");
    document.querySelectorAll("[data-u]").forEach((b) => (b.onclick = () => {
      const u = users.find((x) => x.id == b.dataset.u);
      dialog(`<h2>${esc(u.name)}</h2><label class="checks"><span><input type="checkbox" id="ua" ${u.active ? "checked" : ""}> Acesso ao sistema ativo</span></label><br><label>Setores que pode acessar</label><div class="checks">${secs.map((s) => `<label><input type="checkbox" name="us" value="${s.id}" ${u.sector_ids.includes(s.id) ? "checked" : ""}> ${esc(s.name)}${s.active ? "" : " (desativado)"}</label>`).join("")}</div>`, { ok: "Salvar", onOk: async () => { await api("/api/users/" + u.id, { method: "PUT", body: { active: $("#ua").checked, sector_ids: [...document.querySelectorAll("[name=us]:checked")].map((c) => +c.value) } }); toast("Permissões salvas"); route(); } });
    }));
  },
  async p(rid) {
    const d = await api("/api/recipients/" + rid), { protocol: p, recipient: r } = d, adm = me.role === "adm";
    const orig = d.files.filter((f) => !f.message_id);
    const back = adm ? "#/central/protocolos" : "#/setor/" + r.sector_id;
    shell(`<p><a href="${back}">Voltar à lista</a></p><h1>${esc(p.protocol_number)} — ${esc(p.subject)}</h1>
    <div class="two"><div><div class="panel"><p><b>Destinatário:</b> ${esc(r.sector_name)} &nbsp; ${chip(r.status)}</p><p class="muted">Enviado ${fmt(r.sent_at)} · Recebido ${fmt(r.received_at)} · Visualizado ${fmt(r.first_viewed_at)} · Respondido ${fmt(r.responded_at)}</p><p style="white-space:pre-wrap">${esc(p.description)}</p>${fileList(orig)}</div>
    <div class="panel"><h2>Comunicação</h2>${d.messages.map((m) => `<div class="msg ${m.role === "adm" ? "adm" : ""}"><small><b>${esc(m.author)}</b> · ${m.role === "adm" ? "Central" : esc(r.sector_name)} · ${fmt(m.created_at)}</small><div style="white-space:pre-wrap">${esc(m.message)}</div>${fileList(d.files.filter((f) => f.message_id === m.id))}</div>`).join("") || `<p class="muted">Nenhuma mensagem ainda.</p>`}
    <form id="rf"><div class="field"><label for="t">${adm ? "Enviar mensagem ao setor" : "Responder à central"}</label><textarea id="t" maxlength="5000"></textarea></div><div class="field"><input id="rfile" type="file" multiple accept="application/pdf,image/*" aria-label="Anexos"></div><button class="btn">${adm ? "Enviar mensagem" : "Enviar resposta"}</button></form></div></div>
    <div class="panel"><h2>Histórico</h2><ul class="tl">${d.events.map((e) => `<li>${esc(EVENT[e.event_type] || e.event_type)}${e.author ? " · " + esc(e.author) : ""}<br><small class="muted">${fmt(e.created_at)}</small></li>`).join("")}</ul></div></div>`, adm ? "l" : "m");
    bindFiles($("main"));
    watchFiles($("#rfile"));
    $("#rf").onsubmit = guard(async (e) => {
      e.preventDefault();
      const files = await getFiles($("#rfile"));
      await api(`/api/recipients/${rid}/messages`, { method: "POST", body: { message: $("#t").value, files } });
      toast(adm ? "Mensagem enviada" : "Resposta enviada"); route();
    });
  },
};

async function listView(sid, title, active) {
  const adm = me.role === "adm";
  if (adm && !sectors.length) sectors = (await api("/api/sectors")).filter((s) => s.active);
  shell(`<h1>${title}</h1><form class="panel filters ${adm ? "c" : ""}" id="ff"><div><label for="q">Número ou assunto</label><input id="q"></div>
    ${adm && !sid ? `<div><label for="sc">Setor destinatário</label><select id="sc"><option value="">Todos</option>${sectors.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></div>` : ""}
    <div><label for="st">Status</label><select id="st"><option value="">Todos</option>${Object.entries(LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
    <div><label for="fr">De</label><input id="fr" type="date"></div><div><label for="to">Até</label><input id="to" type="date"></div><button class="btn">Pesquisar</button></form><div id="res"></div>`, active);
  const load = guard(async () => {
    const q = new URLSearchParams({ q: $("#q").value, status: $("#st").value, from: $("#fr").value, to: $("#to").value });
    const s = sid || ($("#sc") && $("#sc").value); if (s) q.set("sector_id", s);
    const rows = await api("/api/protocols?" + q);
    $("#res").innerHTML = `<div class="wrap"><table><tr><th>Número</th><th>Assunto</th><th>${adm ? "Destinatário" : "Origem"}</th><th>Enviado</th><th>Recebido</th><th>Visualização</th><th>Resposta</th><th></th></tr>${rows.map((r) => `<tr><td class="num">${esc(r.protocol_number)}</td><td class="subj">${esc(r.subject)}</td><td>${adm ? esc(r.sector) : "Central"}</td><td>${two(r.sent_at)}</td><td>${two(r.received_at)}</td><td><div class="st">${r.first_viewed_at ? chip("visualizado") + `<span class="t">${fmt(r.first_viewed_at)}</span>` : `<span class="chip">Não visualizado</span>`}</div></td><td>${r.responded_at ? chip("respondido") : `<span class="chip">Sem resposta</span>`}</td><td class="nw"><a class="btn sec sm" style="text-decoration:none" href="#/p/${r.rid}">Abrir</a></td></tr>`).join("") || `<tr><td colspan="8" class="empty">Nenhum protocolo encontrado.</td></tr>`}</table></div>`;
  });
  $("#ff").onsubmit = (e) => { e.preventDefault(); load(); };
  load();
}

async function route() {
  if (!me) return;
  const h = location.hash.replace(/^#\//, "").split("/");
  try {
    if (!h[0]) return (location.hash = me.role === "adm" ? "#/central" : "#/setores");
    if (h[0] === "central") {
      if (me.role !== "adm") throw new Error("Acesso restrito à administração");
      const fn = views[h[1] ? "central-" + h[1] : "central"] || views.central;
      return await fn();
    }
    if (!views[h[0]] || h[0].startsWith("central-")) return (location.hash = "#/setores");
    await views[h[0]](h[1]);
  } catch (e) { toast(e.message, true); if (!$("#app").innerHTML) $("#app").innerHTML = ""; }
}
// "protocolos" e "novo" ficam em #/central/...; mapeia para as telas acima
views["central-protocolos"] = views.protocolos; views["central-novo"] = views.novo;
addEventListener("hashchange", route);

onAuthStateChanged(auth, async (user) => {
  if (!user) { me = null; sessionStorage.clear(); return loginView(); }
  try {
    const r = await api("/api/me"); me = r.user; sectors = r.sectors; route();
  } catch (e) { toast(e.message, true); await signOut(auth); }
});

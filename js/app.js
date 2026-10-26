import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getMessaging, getToken, onMessage, deleteToken, isSupported } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";
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
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Chave pública do Firebase: Project settings > Cloud Messaging > Web Push certificates > Generate key pair.
const VAPID_KEY = "BL6Gd6JAaUQXJF-I2Y4fczJATe3O87oao4LQbRB3uKb1vSxLTFjC4cbOhTTJLfiIDv_j5_2SmX4ODgblAbeGFFg";
const swReady = "serviceWorker" in navigator ? navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).catch(() => null) : Promise.resolve(null);

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (d) => (d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");
const LABEL = { enviado: "Enviado", recebido: "Recebido", visualizado: "Visualizado", respondido: "Respondido" };
const EVENT = { criado: "Protocolo criado", enviado: "Enviado pela central", recebido: "Recebimento registrado na caixa de entrada", visualizado: "Primeira visualização", resposta: "Resposta do setor", mensagem_central: "Mensagem da central", anexo: "Documento anexado" };
const two = (d) => (d ? `<span class="d">${new Date(d).toLocaleDateString("pt-BR")}</span><span class="t">${new Date(d).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>` : "—");
const chip = (s) => `<span class="chip ${s}">${LABEL[s] || s}</span>`;

let me = null, sectors = [], busy = 0, pvUrl = null;
const revokePv = () => { if (pvUrl) URL.revokeObjectURL(pvUrl); pvUrl = null; };
const fmtDay = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "—");
const secKey = (id) => (sectors.length > 1 ? "m" + id : "m"); // item ativo do menu do usuário de setor

// ---------- utilidades
function toast(msg, err) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : ""); t.textContent = msg;
  $("#toasts").append(t); setTimeout(() => t.remove(), 4500);
}
async function api(path, { method = "GET", body, blob, quiet } = {}) {
  if (!quiet) { busy++; $("#bar").hidden = false; }
  try {
    const token = await auth.currentUser.getIdToken();
    const r = await fetch(API + path, { method, headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (blob && r.ok) return await r.blob();
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Erro " + r.status);
    return j;
  } finally { if (!quiet && !--busy) $("#bar").hidden = true; }
}
function dialog(html, { ok = "Confirmar", cancel, onOk, big, required } = {}) {
  const m = document.createElement("div");
  m.className = "modal" + (big ? " big" : "");
  m.innerHTML = `<div role="dialog">${html}<div class="acts">${required ? "" : `<button class="btn sec" data-x>${cancel || (onOk ? "Cancelar" : "Fechar")}</button>`}${onOk ? `<button class="btn" data-ok>${ok}</button>` : ""}</div></div>`;
  document.body.append(m);
  const close = () => m.remove();
  m.addEventListener("click", (e) => { if (!required && (e.target === m || e.target.dataset.x !== undefined)) close(); });
  const b = $("[data-ok]", m);
  if (b) b.onclick = async () => { b.disabled = true; try { if ((await onOk(m)) !== false) close(); } catch (e) { toast(e.message, true); } b.disabled = false; };
  return m;
}
// Com um modal aberto, o fundo fica bloqueado (cliques, foco e rolagem).
new MutationObserver(() => { const open = !!document.querySelector(".modal"), app = $("#app"); if (app) app.inert = open; document.body.classList.toggle("modal-open", open); }).observe(document.body, { childList: true });
document.addEventListener("click", (e) => { const m = $("#umenu"); if (m && !m.hidden && !m.contains(e.target)) { m.hidden = true; $("#um")?.setAttribute("aria-expanded", "false"); } });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { const m = $("#umenu"); if (m) m.hidden = true; } });
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

// Anexos: só PDF. Cada arquivo é compactado em até 35% (fica com ~65% do tamanho) e vai em Base64.
const MAX_FILES = 3, MAX_BYTES = Math.floor(1.4 * 1048576), KEEP = 0.65, CDN = "https://cdnjs.cloudflare.com/ajax/libs/";
const tick = () => new Promise((r) => setTimeout(r));
const kb = (n) => Math.ceil(n / 1024) + " KB";
// 1) re-salva o PDF sem mexer no conteúdo (mantém o texto); 2) se não bastar, refaz as páginas como imagens JPEG, só se isso atingir a meta.
async function compressPdf(file, onStep) {
  if (!window.PDFLib) await loadScript(CDN + "pdf-lib/1.17.1/pdf-lib.min.js");
  const buf = await file.arrayBuffer(), goal = Math.floor(file.size * KEEP);
  let resaved = null, raster = null;
  try {
    const out = await (await PDFLib.PDFDocument.load(buf, { ignoreEncryption: true })).save({ useObjectStreams: true });
    if (out.length < file.size) resaved = new Blob([out], { type: "application/pdf" });
  } catch { /* segue para a etapa 2 */ }
  onStep(0.1);
  if (resaved && resaved.size <= goal) return { blob: resaved, mode: "texto" };
  if (!window.pdfjsLib) { await loadScript(CDN + "pdf.js/3.11.174/pdf.min.js"); pdfjsLib.GlobalWorkerOptions.workerSrc = CDN + "pdf.js/3.11.174/pdf.worker.min.js"; }
  const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
  const c = document.createElement("canvas"), g = c.getContext("2d"), tries = [[2, 0.75], [1.7, 0.65], [1.4, 0.55], [1.2, 0.5], [1, 0.42]];
  for (let t = 0; t < tries.length; t++) {
    const [scale, q] = tries[t], doc = await PDFLib.PDFDocument.create();
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i), vp = page.getViewport({ scale }), base = page.getViewport({ scale: 1 });
      c.width = vp.width; c.height = vp.height; g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      const jpg = await new Promise((r) => c.toBlob(r, "image/jpeg", q)), img = await doc.embedJpg(await jpg.arrayBuffer());
      doc.addPage([base.width, base.height]).drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
      onStep(0.1 + 0.9 * ((t + i / pdf.numPages) / tries.length)); await tick();
    }
    const out = new Blob([await doc.save()], { type: "application/pdf" });
    if (!raster || out.size < raster.size) raster = out;
    if (out.size <= goal) return { blob: out, mode: "imagem" };
  }
  // meta não atingida: prefere manter o texto selecionável; a versão em imagem só entra se for a única que cabe no limite do banco
  const text = resaved || file;
  if (text.size > MAX_BYTES && raster && raster.size < text.size && raster.size <= MAX_BYTES) return { blob: raster, mode: "imagem" };
  return { blob: text, mode: resaved ? "texto" : "original" };
}
async function readFiles(list, onProgress) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i], step = (p) => onProgress((i + Math.min(p, 0.99)) / list.length);
    if (f.type !== "application/pdf") throw new Error(`"${f.name}": envie apenas arquivos PDF`);
    const r = await compressPdf(f, step);
    if (r.blob.size > MAX_BYTES) throw new Error(`"${f.name}" ficou com ${kb(r.blob.size)} mesmo após compactar. O limite é ${(MAX_BYTES / 1048576).toFixed(1)} MB por arquivo: divida o documento em partes.`);
    out.push({ name: f.name, type: "application/pdf", data: await toB64(r.blob), orig: f.size, size: r.blob.size, mode: r.mode });
    onProgress((i + 1) / list.length);
  }
  return out;
}
const sizeInfo = (f) => `${f.name} (${kb(f.orig)} → ${kb(f.size)}${f.size < f.orig ? `, −${Math.round((1 - f.size / f.orig) * 100)}%` : ", não foi possível reduzir"}${f.mode === "imagem" ? ", páginas convertidas em imagem" : ""})`;
// Ao escolher os PDFs, abre um modal com o progresso que bloqueia o sistema até terminar a compactação.
function watchFiles(input) {
  const info = document.createElement("div"); info.className = "muted"; input.after(info);
  input._files = []; input._n = 0; input._job = Promise.resolve();
  input.addEventListener("change", () => {
    const id = ++input._n, picked = [...input.files];
    input._files = []; info.textContent = "";
    if (!picked.length) return;
    if (picked.length > MAX_FILES) { input.value = ""; return toast(`Envie no máximo ${MAX_FILES} arquivos`, true); }
    const m = dialog(`<div class="conv"><div class="spin" aria-hidden="true"></div><h2>Compactando PDF…</h2><p class="muted">Aguarde até chegar a 100%. O sistema fica bloqueado durante a compactação.</p><div class="pbar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></div><b class="pct">0%</b></div>`, { required: true });
    const bar = $(".pbar i", m), pct = $(".pct", m), bx = $(".pbar", m);
    const set = (p) => { const v = Math.round(p * 100); bar.style.width = v + "%"; pct.textContent = v + "%"; bx.setAttribute("aria-valuenow", v); };
    input._job = (async () => {
      try {
        const files = await readFiles(picked, set);
        set(1); await new Promise((r) => setTimeout(r, 400));
        if (id !== input._n) return;
        input._files = files;
        info.textContent = "Pronto para enviar: " + files.map(sizeInfo).join("; ");
      } catch (e) {
        if (id !== input._n) return;
        input.value = ""; input._files = []; info.textContent = ""; toast(e.message, true);
      } finally { m.remove(); }
    })();
  });
}
const getFiles = async (input) => { await input._job; return input._files; };
const toB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });

async function downloadFile(id, name) {
  const blob = await api("/api/files/" + id, { blob: true }), url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function openFile(id, name, type) {
  const blob = await api("/api/files/" + id, { blob: true }), url = URL.createObjectURL(blob);
  const m = dialog(`<h2>${esc(name)} <button class="btn sec sm" data-dl2>Baixar</button></h2>${type === "application/pdf" ? `<iframe src="${url}" title="${esc(name)}"></iframe>` : `<img src="${url}" alt="${esc(name)}">`}`, { big: true });
  new MutationObserver(() => { if (!document.body.contains(m)) URL.revokeObjectURL(url); }).observe(document.body, { childList: true });
  $("[data-dl2]", m).onclick = guard(() => downloadFile(id, name));
}
const fileList = (files) => files.length ? `<ul>${files.map((f) => f.archived_at ? `<li><span class="muted">${esc(f.file_name)} — arquivo removido em ${new Date(f.archived_at).toLocaleDateString("pt-BR")} (arquivamento mensal)</span></li>` : `<li><button class="link" data-file="${f.id}" data-name="${esc(f.file_name)}" data-type="${f.mime_type}">${esc(f.file_name)}</button> <span class="muted">(${Math.ceil(f.file_size / 1024)} KB)</span> · <button class="link" data-dl="${f.id}" data-name="${esc(f.file_name)}">Baixar</button></li>`).join("")}</ul>` : "";
const bindFiles = (root) => {
  root.querySelectorAll("[data-file]").forEach((b) => (b.onclick = guard(() => openFile(b.dataset.file, b.dataset.name, b.dataset.type))));
  root.querySelectorAll("[data-dl]").forEach((b) => (b.onclick = guard(() => downloadFile(b.dataset.dl, b.dataset.name))));
};

// ---------- cadastro do usuário (nome e WhatsApp)
const fmtPhone = (p) => { const d = String(p || "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, ""); return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : ""; };
function maskPhone(el) {
  el.addEventListener("input", () => {
    const d = el.value.replace(/\D/g, "").slice(0, 11), k = d.length > 10 ? 7 : 6;
    el.value = d.length > 6 ? `(${d.slice(0, 2)}) ${d.slice(2, k)}-${d.slice(k)}` : d.length > 2 ? `(${d.slice(0, 2)}) ${d.slice(2)}` : d;
  });
}
const profileFields = () => `<div class="field"><label for="pn">Nome completo</label><input id="pn" value="${esc(me.name)}" maxlength="120" autocomplete="name"></div>
  <div class="field"><label for="pp">Celular com WhatsApp</label><input id="pp" value="${esc(fmtPhone(me.phone))}" inputmode="tel" placeholder="(92) 99999-9999" autocomplete="tel"><div class="note">Informe um número com <b>WhatsApp ativo</b>: é nele que você vai receber os documentos protocolados.</div></div>`;
async function saveProfile() {
  const name = $("#pn").value.trim(), digits = $("#pp").value.replace(/\D/g, "");
  if (name.length < 3) throw new Error("Informe seu nome completo");
  if (digits.length < 10) throw new Error("Informe o celular com DDD");
  const r = await api("/api/me/profile", { method: "PUT", body: { name, phone: $("#pp").value } });
  me.name = r.name; me.phone = r.phone;
}
function profileModal() { // aparece no login do usuário de setor até o cadastro ser concluído
  const m = dialog(`<h2>Complete seu cadastro</h2><p class="muted">Antes de continuar, confirme seus dados.</p>${profileFields()}`, { ok: "Salvar e continuar", required: true, onOk: async () => {
    await saveProfile(); toast("Dados salvos"); route();
    if (pref() === null && canNotify() && Notification.permission !== "denied") askOnce();
  } });
  maskPhone($("#pp", m));
}
// Depois do envio, a central abre o WhatsApp de cada usuário do setor com a mensagem pronta e o link do painel.
// O link só abre o protocolo para quem estiver conectado com uma conta com acesso ao setor.
async function shareModal(pid) {
  const d = await api(`/api/protocols/${pid}/share`), base = location.origin + location.pathname;
  const tpl = "Olá, {nome}! A Prefeitura Municipal de Careiro encaminhou o protocolo {protocolo} ao setor {setor}.\n\nPara ver o documento, acesse o ProtoWeb: {link}\n(É preciso entrar com a sua conta Google.)";
  const build = (u, sector, rid) => tpl.replace(/\{nome\}/g, () => u.name || "").replace(/\{setor\}/g, () => sector).replace(/\{protocolo\}/g, () => d.protocol_number).replace(/\{link\}/g, () => `${base}#/p/${rid}`);
  const contacts = [];
  const rows = d.sectors.map((sc) => `<h2 style="margin-top:14px;font-size:15px">${esc(sc.sector)}</h2>` + (sc.users.length ? sc.users.map((u) => {
    if (!u.phone) return `<div class="ct"><div><b>${esc(u.name)}</b><div class="muted">sem número cadastrado</div></div></div>`;
    contacts.push({ u, sector: sc.sector, rid: sc.rid });
    return `<div class="ct"><div class="ci"><b>${esc(u.name)}</b> <span class="muted">${esc(fmtPhone(u.phone))}</span><div class="wmsg">${esc(build(u, sc.sector, sc.rid))}</div></div><button class="btn sm" data-c="${contacts.length - 1}">Enviar no WhatsApp</button></div>`;
  }).join("") : `<p class="muted">Nenhum usuário vinculado a este setor.</p>`)).join("");
  const m = dialog(`<h2>Avisar por WhatsApp</h2><p class="muted">Protocolo ${esc(d.protocol_number)} enviado. Cada botão abre o WhatsApp com a mensagem pronta.</p>${rows}`, {});
  m.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => {
    const { u, sector, rid } = contacts[b.dataset.c];
    window.open(`https://wa.me/${u.phone}?text=${encodeURIComponent(build(u, sector, rid))}`, "_blank", "noopener");
    m.remove(); // fecha o modal: ao voltar do WhatsApp a tela já está limpa
  }));
}

// ---------- arquivamento mensal (administrador)
const monthName = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" }); };
const loadScript = (src) => new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => no(new Error("Não foi possível carregar a biblioteca de ZIP. Verifique a conexão.")); document.head.append(s); });
function progressModal(title, text) {
  const m = dialog(`<div class="conv"><div class="spin" aria-hidden="true"></div><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p><div class="pbar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></div><b class="pct">0%</b><p class="muted plabel"></p></div>`, { required: true });
  const bar = $(".pbar i", m), pct = $(".pct", m), bx = $(".pbar", m), lb = $(".plabel", m);
  return { set(p, label) { const v = Math.round(Math.min(1, p) * 100); bar.style.width = v + "%"; pct.textContent = v + "%"; bx.setAttribute("aria-valuenow", v); if (label) lb.textContent = label; }, close() { m.remove(); } };
}
const safe = (s) => String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 100) || "_";
const csvq = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const saveParts = (parts) => parts.forEach((p, i) => setTimeout(() => { const u = URL.createObjectURL(p.blob), a = document.createElement("a"); a.href = u; a.download = p.name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000); }, i * 800));
async function buildZips(month, files, pm) {
  if (!window.JSZip) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
  const groups = []; let cur = [], size = 0; // cada ZIP tem no máximo ~200 MB
  for (const f of files) { if (size + f.file_size > 200 * 1048576 && cur.length) { groups.push(cur); cur = []; size = 0; } cur.push(f); size += f.file_size; }
  if (cur.length) groups.push(cur);
  const parts = []; let done = 0;
  for (let g = 0; g < groups.length; g++) {
    const list = groups[g], zip = new JSZip(), rows = [["caminho", "protocolo", "setor", "enviado_em", "tamanho_kb"]]; let idx = 0;
    const work = async () => {
      while (idx < list.length) {
        const f = list[idx++], blob = await api("/api/files/" + f.id, { blob: true, quiet: true });
        if (!blob || !blob.size) throw new Error(`Falha ao baixar "${f.file_name}". Nada foi apagado; tente novamente.`);
        const path = `${month}/${safe(f.sector || "Central")}/${safe(f.protocol_number)}/${f.id}_${safe(f.file_name)}`;
        zip.file(path, blob, { compression: f.mime_type === "application/pdf" ? "DEFLATE" : "STORE" });
        rows.push([path, f.protocol_number, f.sector || "Central", fmt(f.created_at), Math.ceil(f.file_size / 1024)]);
        pm.set((++done / files.length) * 0.9, `Baixando imagem ${done} de ${files.length}`);
      }
    };
    await Promise.all([work(), work(), work(), work()]);
    zip.file("lista.csv", "\ufeff" + rows.map((r) => r.map(csvq).join(";")).join("\r\n"));
    const out = await zip.generateAsync({ type: "blob" }, (mt) => pm.set(0.9 + 0.1 * ((g + mt.percent / 100) / groups.length), "Gerando o ZIP…"));
    if (!out.size) throw new Error("Não foi possível gerar o ZIP. Nada foi apagado.");
    parts.push({ name: `protoweb-${month}${groups.length > 1 ? `-parte${g + 1}` : ""}.zip`, blob: out, ids: list.map((f) => f.id) });
  }
  return parts;
}
async function archiveFlow(p) {
  const month = p.month, label = monthName(month), { files } = await api(`/api/archive/${month}/files`);
  if (!files.length) { toast("Não há anexos pendentes neste mês."); return poll(); }
  const mb = (files.reduce((a, f) => a + f.file_size, 0) / 1048576).toFixed(1);
  const wipe = async (parts) => {
    const ids = parts.flatMap((x) => x.ids), pm = progressModal("Apagando imagens do sistema", "Aguarde até chegar a 100%.");
    try {
      for (let i = 0; i < ids.length; i += 50) { await api(`/api/archive/${month}/confirm`, { method: "POST", body: { ids: ids.slice(i, i + 50) }, quiet: true }); pm.set(Math.min(i + 50, ids.length) / ids.length, `${Math.min(i + 50, ids.length)} de ${ids.length}`); }
      toast(`Arquivamento de ${label} concluído`);
    } finally { pm.close(); poll(); route(); }
  };
  const run = guard(async () => {
    const pm = progressModal(`Arquivando ${label}`, "Não feche esta janela até chegar a 100%."); let parts;
    try { parts = await buildZips(month, files, pm); pm.set(1); } finally { pm.close(); }
    saveParts(parts);
    const m = dialog(`<h2>Confirmar arquivamento</h2><p>O ZIP de <b>${esc(label)}</b> (${parts.length > 1 ? parts.length + " partes" : "1 arquivo"}, ${files.length} imagens) foi gerado e enviado para download.</p><p>Confira na pasta de Downloads se ${parts.length > 1 ? "todos os arquivos foram salvos" : "o arquivo foi salvo"} e se ${parts.length > 1 ? "abrem" : "abre"} normalmente. <b>Só confirme com o download completo:</b> ao confirmar, as imagens de ${esc(label)} são apagadas do sistema. Protocolos, mensagens e histórico permanecem.</p><p><button class="link" id="dl-again">Baixar novamente</button></p>`, { ok: "Sim, apagar as imagens", cancel: "Ainda não apagar", onOk: () => { setTimeout(guard(() => wipe(parts)), 50); } });
    $("#dl-again", m).onclick = () => saveParts(parts);
  });
  dialog(`<h2>Arquivar anexos de ${esc(label)}</h2><p>${files.length} imagem(ns), cerca de ${mb} MB. O sistema vai baixar as imagens, gerar o ZIP e salvá-lo no seu computador, organizado por setor e protocolo.</p><p class="muted">Nada é apagado antes da sua confirmação. Mantenha esta aba aberta durante o processo.</p>`, { ok: "Iniciar", onOk: () => { setTimeout(run, 50); } });
}

// ---------- estrutura
const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  m: svg('<path d="M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h5l1 3h6l1-3h5"/>'),
  c: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  p: svg('<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>'),
  l: svg('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'),
  n: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  s: svg('<path d="M4 21V7l8-4 8 4v14"/><path d="M9 21v-6h6v6M9 10h.01M15 10h.01"/>'),
  u: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>'),
  arch: svg('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>'),
  h: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  ok: svg('<path d="M5 12l5 5L20 7"/>'),
  back: svg('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
  out: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  user: '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#5d5a66"/><circle cx="12" cy="9.5" r="4" fill="#e9e6f0"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0a12 12 0 0 1-15 0z" fill="#e9e6f0"/></svg>',
};
const avatar = (px) => { const u = auth.currentUser?.photoURL; return u ? `<img class="avatar" style="width:${px}px;height:${px}px" src="${esc(u)}" referrerpolicy="no-referrer" alt="">` : `<span class="avatar" style="width:${px}px;height:${px}px">${ICON.user}</span>`; };
function shell(inner, active) {
  const adm = me.role === "adm", sec = JSON.parse(sessionStorage.getItem("sector") || "null");
  const tag = sec && !adm ? `<span class="tag">Setor: ${esc(sec.name)}</span>` : "";
  const sig = me.id + "|" + sectors.map((x) => x.id).join(",");
  const cur = $("#app .shell");
  if (cur && cur.dataset.sig === sig) { // mesma estrutura: só troca o conteúdo e a aba ativa, com transição
    cur.querySelectorAll(".side nav a").forEach((a) => a.classList.toggle("on", a.dataset.k === active));
    $(".tagwrap", cur).innerHTML = tag;
    const mn = $("main", cur); mn.classList.remove("fade"); mn.innerHTML = inner; void mn.offsetWidth; mn.classList.add("fade");
    window.scrollTo(0, 0); paintBadge(); return;
  }
  const nav = (h, t, k, b) => `<a href="${h}" data-k="${k}" class="${active === k ? "on" : ""}"><span class="ni">${ICON[k] || ICON.m}</span><span class="nt">${t}</span>${b ? `<span class="nbadge" id="${b}" hidden></span>` : ""}</a>`;
  $("#app").innerHTML = `<div class="shell" data-sig="${sig}"><header class="top"><span class="brandbar"><img class="logo" src="logo.svg" alt="Brasão de Careiro"><span class="org">Prefeitura Municipal de Careiro</span><span class="tagwrap">${tag}</span></span><span class="who"><button class="uchip" id="um" aria-haspopup="true" aria-expanded="false" title="${esc(me.name)} (${esc(me.email)})">${avatar(34)}<b>${esc(String(me.name || me.email).split(" ")[0])}</b></button>
      <div class="umenu" id="umenu" hidden><div class="uinfo">${avatar(64)}<b>${esc(me.name)}</b><span class="muted">${esc(me.email)}</span></div><button class="btn sec" id="out">${ICON.out}<span>Sair</span></button></div></span></header>
    ${adm ? '<div class="abanner" id="abanner" hidden></div>' : ""}<div class="body"><aside class="side"><nav>
    ${adm ? nav("#/central", "Painel", "p") + nav("#/central/protocolos", "Protocolos", "l", "nb-prot") + nav("#/historico", "Histórico", "h") + nav("#/central/novo", "Novo protocolo", "n") + nav("#/central/setores", "Setores", "s") + nav("#/central/usuarios", "Usuários", "u") : ""}
    ${adm ? "" : sectors.length > 1 ? sectors.map((x) => nav("#/setor/" + x.id, esc(x.name), "m" + x.id, "nb-s" + x.id)).join("") : nav("#/setores", "Caixa de entrada", "m", "nb-set")}${adm ? "" : nav("#/historico", "Histórico", "h")}${nav("#/config", "Configurações", "c")}</nav></aside>
    <main class="fade">${inner}</main></div></div>`;
  $("#out").onclick = logout;
  const um = $("#um"), menu = $("#umenu");
  um.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; um.setAttribute("aria-expanded", String(!menu.hidden)); };
  document.querySelectorAll("img.avatar").forEach((i) => (i.onerror = () => i.replaceWith(Object.assign(document.createElement("span"), { className: "avatar", innerHTML: ICON.user }))));
  paintBadge();
}
const loginView = () => {
  $("#app").innerHTML = `<div class="login"><div class="panel"><h1>ProtoWeb</h1><p class="org-l">Prefeitura Municipal de Careiro</p><p class="muted">Protocolos e documentos</p><button class="btn" id="g">Entrar com Google</button></div></div>`;
  $("#g").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => toast("Não foi possível entrar: " + e.code, true));
};

// ---------- notificações
// Contadores nos cards (consulta a cada minuto) e avisos do Windows/push, controlados em Configurações.
let badge = null, sectorBadge = {}, timer = null, listening = false, archivePending = [];
const prefKey = () => "pw_notif_" + me.id;
const pref = () => { try { return localStorage.getItem(prefKey()); } catch { return null; } };
const setPref = (v) => { try { localStorage.setItem(prefKey(), v); } catch { /* sem armazenamento */ } };
const canNotify = () => "Notification" in window;
const newLabel = (r) => (me.role === "adm" ? (r.ru ? "Nova resposta" : "") : !r.first_viewed_at ? "Novo" : r.su ? "Nova mensagem" : "");
function paintBadge() {
  const n = badge || 0, adm = me.role === "adm";
  const set = (el, v) => { if (el) { el.hidden = !v; el.textContent = v > 99 ? "99+" : v || ""; } };
  const ab = $("#abanner");
  if (ab) {
    const p = archivePending[0], key = archivePending.map((x) => x.month).join();
    ab.hidden = !p;
    if (p && ab.dataset.k !== key) {
      ab.dataset.k = key;
      ab.innerHTML = `<span class="ai">${ICON.arch}</span><span>Os anexos de <b>${esc(monthName(p.month))}</b> precisam ser arquivados${archivePending.length > 1 ? ` (mais ${archivePending.length - 1} mês(es) pendente(s) depois deste)` : ""}. Enquanto isso não for feito, as imagens continuam ocupando espaço no banco.</span><button class="btn sm" id="abtn">Arquivar agora</button>`;
      $("#abtn").onclick = guard(() => archiveFlow(p));
    }
  }
  set($("#nb-prot"), adm ? n : 0);
  set($("#nb-set"), adm ? 0 : n);
  if (!adm) sectors.forEach((s) => set($("#nb-s" + s.id), sectorBadge[s.id] || 0));
  document.querySelectorAll(".card[data-id]").forEach((c) => set($(".cbadge", c), adm ? 0 : sectorBadge[c.dataset.id] || 0));
  document.title = (n ? `(${n}) ` : "") + "ProtoWeb · Prefeitura Municipal de Careiro";
  try { n ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.(); } catch { /* sem suporte */ }
  if (!n) swReady.then((r) => r?.getNotifications({ tag: "protoweb" }).then((l) => l.forEach((x) => x.close()))).catch(() => {});
}
async function showAlert(body) {
  if (pref() !== "on") return;
  if (document.visibilityState === "visible") return toast(body);
  if (canNotify() && Notification.permission === "granted") (await swReady)?.showNotification("ProtoWeb", { body, icon: "icon-192.png", tag: "protoweb" });
}
async function poll() {
  try {
    const { count, sectors, archive } = await api("/api/notifications", { quiet: true });
    archivePending = archive || [];
    const prev = badge; badge = count; sectorBadge = sectors || {}; paintBadge();
    if (prev !== null && count > prev) showAlert(me.role === "adm" ? "Nova resposta em um protocolo." : "Novo protocolo ou mensagem recebida.");
  } catch { /* tenta de novo no próximo ciclo */ }
}
async function pushToken() {
  const reg = await swReady; if (!reg) throw new Error("Não foi possível iniciar o serviço de notificações.");
  return getToken(getMessaging(app), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
}
async function enablePush(silent) {
  try {
    if (!canNotify() || !(await isSupported())) throw new Error("Este navegador não suporta notificações.");
    if (VAPID_KEY.startsWith("COLE")) throw new Error("Notificações com o aplicativo fechado ainda não foram configuradas (chave VAPID).");
    if ((await Notification.requestPermission()) !== "granted") throw new Error("O navegador está bloqueando as notificações deste site. Veja a orientação em Configurações.");
    const token = await pushToken();
    await api("/api/push/register", { method: "POST", body: { token }, quiet: true });
    if (!listening) { listening = true; onMessage(getMessaging(app), (p) => { toast(p.notification?.body || "Nova notificação"); poll(); }); }
    setPref("on");
    if (!silent) toast("Notificações ativadas neste computador");
    return true;
  } catch (e) { if (!silent) toast(e.message, true); return false; }
}
async function disablePush() {
  try {
    if (canNotify() && Notification.permission === "granted" && !VAPID_KEY.startsWith("COLE")) {
      const token = await pushToken();
      await api("/api/push/unregister", { method: "POST", body: { token }, quiet: true });
      await deleteToken(getMessaging(app));
    }
  } catch { /* segue: a preferência abaixo já silencia os avisos */ }
  setPref("off"); toast("Notificações desativadas neste computador");
}
function askOnce() {
  setPref("off"); // a pergunta aparece só nesta primeira vez; depois, só em Configurações
  dialog(`<h2>Receber notificações?</h2><p>Quer ser avisado neste computador quando chegar um protocolo ou uma resposta, mesmo com o ProtoWeb fechado?</p><p class="muted">Você pode ativar ou desativar depois em Configurações.</p>`, { ok: "Ativar", cancel: "Agora não", onOk: async () => { await enablePush(false); } });
}
function startNotifications() {
  clearInterval(timer); badge = null; sectorBadge = {}; poll(); timer = setInterval(poll, 60000);
  const p = pref();
  if (p === "on" && canNotify() && Notification.permission === "granted") enablePush(true);
  else if (p === null && canNotify() && Notification.permission !== "denied" && (me.role === "adm" || me.phone)) askOnce();
}
async function logout() {
  clearInterval(timer);
  try { // este computador deixa de receber avisos da conta que saiu (volta a receber ao entrar de novo)
    if (pref() === "on" && canNotify() && Notification.permission === "granted" && !VAPID_KEY.startsWith("COLE")) {
      await api("/api/push/unregister", { method: "POST", body: { token: await pushToken() }, quiet: true });
    }
  } catch { /* segue com a saída */ }
  try { navigator.clearAppBadge?.(); } catch { /* sem suporte */ }
  signOut(auth);
}

// ---------- telas
const views = {
  async setores() {
    sectors = (await api("/api/me")).sectors;
    if (me.role === "adm") return (location.hash = "#/central");
    if (!sectors.length) return shell(`<h1>Caixa de entrada</h1><div class="panel empty">Você ainda não tem acesso a nenhum setor. Peça à administração para liberar.</div>`, "m");
    // entra direto na caixa de entrada: último setor usado ou o primeiro da lista
    const last = JSON.parse(sessionStorage.getItem("sector") || "null"), s = sectors.find((x) => x.id == last?.id) || sectors[0];
    location.hash = "#/setor/" + s.id;
  },
  async config() {
    const perm = canNotify() ? Notification.permission : "unsupported", active = pref() === "on" && perm === "granted";
    const state = active ? "Ativadas" : perm === "denied" ? "Bloqueadas pelo navegador" : perm === "unsupported" ? "Não suportadas neste navegador" : "Desativadas";
    shell(`<h1>Configurações</h1><div class="cfg"><div class="panel"><h2>Meus dados</h2>${profileFields()}<button class="btn" id="sv">Salvar dados</button></div><div class="panel"><h2>Notificações neste computador</h2>
      <p>Situação: <span class="chip ${active ? "respondido" : ""}">${state}</span></p>
      <p class="muted">${me.role === "adm" ? "Você é avisado quando um setor responde a um protocolo." : "Você é avisado quando chega um protocolo ou uma mensagem da central para o seu setor."} O aviso chega mesmo com o ProtoWeb fechado, desde que o navegador esteja em execução. Vale só para este computador e este navegador. Os contadores nos cards continuam aparecendo.</p>
      ${perm === "denied" ? `<p>O navegador está bloqueando as notificações deste site. Clique no ícone à esquerda do endereço, abra as permissões do site, mude Notificações para Permitir e recarregue a página.</p>` : ""}
      ${perm === "unsupported" ? "" : `<button class="btn" id="tg">${active ? "Desativar notificações" : "Ativar notificações"}</button>`}</div>${me.role === "adm" ? `<div class="panel"><h2>Consulta pública de protocolos</h2><p class="muted">Link para o cidadão acompanhar o andamento digitando o número do protocolo. Mostra só as datas do andamento, sem assunto nem documentos. A consulta fica disponível por ${esc(me.public_days)} dia(s) após o cadastro do protocolo.</p><div class="field"><input id="plink" readonly value="${esc(location.origin + location.pathname.replace(/[^/]*$/, "") + "consulta.html")}"></div><button class="btn" id="cp">Copiar link</button></div>` : ""}</div>`, "c");
    maskPhone($("#pp")); $("#sv").onclick = guard(async () => { await saveProfile(); toast("Dados salvos"); route(); });
    if ($("#cp")) $("#cp").onclick = guard(async () => { await navigator.clipboard.writeText($("#plink").value); toast("Link copiado"); });
    const tg = $("#tg");
    if (tg) tg.onclick = guard(async () => { tg.disabled = true; if (active) await disablePush(); else await enablePush(false); route(); });
  },
  async setor(id) {
    if (me.role === "adm") return (location.hash = "#/central");
    const s = sectors.find((x) => x.id == id);
    if (!s) return (location.hash = "#/setores");
    sessionStorage.setItem("sector", JSON.stringify({ id: s.id, name: s.name }));
    await listView(id, `Caixa de entrada`, secKey(s.id));
  },
  async central() {
    const d = await api("/api/dashboard"), k = (n, l, c = "") => `<div class="kpi ${c}"><b>${n}</b><span>${l}</span></div>`;
    const max = Math.max(1, ...d.porSetor.map((s) => s.total));
    const bars = d.porSetor.length ? d.porSetor.map((s) => `<div class="bar-row"><span class="bar-name" title="${esc(s.name)}">${esc(s.name)}</span><div class="bar-track">${s.respondidos ? `<span class="seg ok" style="width:${(s.respondidos / max) * 100}%"></span>` : ""}${s.pendentes ? `<span class="seg pend" style="width:${(s.pendentes / max) * 100}%"></span>` : ""}</div><span class="bar-val"><b>${s.total}</b> <span class="muted">(${s.respondidos} resp. · ${s.pendentes} pend.)</span></span></div>`).join("") : `<p class="muted">Nenhum setor cadastrado.</p>`;
    shell(`<h1>Painel central</h1><div class="kpis">${k(d.total, "Protocolos")}${k(d.enviados, "Enviados")}${k(d.recebidos, "Recebidos")}${k(d.visualizados, "Visualizados")}${k(d.respondidos, "Respondidos")}${k(d.pendentes, "Pendentes de resposta", "pend")}</div>
    <div class="panel"><h2>Protocolos por setor</h2><div class="legend"><span><i class="seg ok"></i>Respondidos</span><span><i class="seg pend"></i>Pendentes</span></div>${bars}</div>`, "p");
  },
  async historico(rid) {
    const adm = me.role === "adm";
    if (!rid) {
      let sid = null;
      if (!adm) {
        if (!sectors.length) return shell(`<h1>Histórico</h1><div class="panel empty">Você ainda não tem acesso a nenhum setor. Peça à administração para liberar.</div>`, "h");
        const last = JSON.parse(sessionStorage.getItem("sector") || "null");
        sid = (sectors.find((x) => x.id == last?.id) || sectors[0]).id;
      }
      return listView(sid, "Histórico", "h", true);
    }
    const d = await api("/api/recipients/" + rid), { protocol: p, recipient: r } = d, orig = d.files.filter((f) => !f.message_id), sib = d.siblings || [];
    const resp = d.messages.filter((m) => m.role !== "adm");
    const steps = [
      { t: "Entrada do protocolo", done: true, when: fmtDay(p.entry_date), wait: "" },
      { t: `Encaminhado a ${esc(r.sector_name)}`, done: !!r.sent_at, when: fmt(r.sent_at), wait: "Ainda não encaminhado" },
      { t: "Documento visualizado", done: !!r.first_viewed_at, when: fmt(r.first_viewed_at), wait: "Aguardando visualização pelo setor" },
      { t: "Resposta do documento", done: !!r.responded_at, when: fmt(r.responded_at), wait: "Aguardando resposta do setor",
        extra: resp.map((m) => `<div class="msg"><small><b>${esc(m.author)}</b> · ${fmt(m.created_at)}</small><div style="white-space:pre-wrap">${esc(m.message)}</div>${fileList(d.files.filter((f) => f.message_id === m.id))}</div>`).join("") },
    ];
    const cur = steps.findIndex((x) => !x.done);
    shell(`<div class="hhead"><a class="backbtn" href="#/historico" title="Voltar ao histórico" aria-label="Voltar ao histórico">${ICON.back}</a><div><h1>${esc(p.protocol_number)} — ${esc(p.subject)}</h1>
      <p class="muted">${sib.length > 1 ? `Destinatário: ${sib.map((x) => `<a class="chipl ${x.rid == rid ? "on" : ""}" href="#/historico/${x.rid}">${esc(x.name)}</a>`).join("")}` : `Destinatário: ${esc(r.sector_name)}`} &nbsp; ${chip(r.status)}</p></div></div>
      <div class="hsplit" id="hs"><section class="hprev panel">${orig.length > 1 ? `<div class="ptabs">${orig.map((f, i) => `<button class="ptab ${i ? "" : "on"}" data-pf="${f.id}">${esc(f.file_name)}</button>`).join("")}</div>` : ""}<div id="pv" class="pv"></div></section>
      <div class="hbar" id="hb" role="separator" aria-orientation="vertical" aria-label="Redimensionar" tabindex="0"></div>
      <section class="htl panel"><h2>Andamento do protocolo</h2><ol class="stp">${steps.map((x, i) => `<li class="${x.done ? "done" : i === cur ? "cur" : "wait"}"><span class="dot">${x.done ? ICON.ok : ""}</span><div><b>${x.t}</b><div class="when">${x.done ? x.when : x.wait}</div>${x.done && x.extra ? x.extra : ""}</div></li>`).join("")}</ol></section></div>`, "h");
    bindFiles($("main"));
    const pv = $("#pv"), hs = $("#hs"), hb = $("#hb");
    const show = guard(async (f) => {
      revokePv();
      if (!f) { pv.innerHTML = `<p class="empty">Nenhum documento anexado a este protocolo.</p>`; return; }
      if (f.archived_at) { pv.innerHTML = `<p class="empty">Documento removido no arquivamento mensal.</p>`; return; }
      pv.innerHTML = `<p class="empty">Carregando documento…</p>`;
      const blob = await api("/api/files/" + f.id, { blob: true });
      pvUrl = URL.createObjectURL(blob);
      pv.innerHTML = f.mime_type === "application/pdf" ? `<iframe src="${pvUrl}" title="${esc(f.file_name)}"></iframe>` : `<img src="${pvUrl}" alt="${esc(f.file_name)}">`;
    });
    document.querySelectorAll("[data-pf]").forEach((b) => (b.onclick = () => { document.querySelectorAll("[data-pf]").forEach((x) => x.classList.toggle("on", x === b)); show(orig.find((f) => f.id == b.dataset.pf)); }));
    const setW = (pc) => hs.style.setProperty("--lw", Math.min(70, Math.max(30, pc)) + "%");
    hb.onpointerdown = (e) => {
      hb.setPointerCapture(e.pointerId); hs.classList.add("drag");
      const mv = (ev) => { const b = hs.getBoundingClientRect(); setW(((ev.clientX - b.left) / b.width) * 100); };
      const up = () => { hs.classList.remove("drag"); hb.removeEventListener("pointermove", mv); hb.removeEventListener("pointerup", up); };
      hb.addEventListener("pointermove", mv); hb.addEventListener("pointerup", up);
    };
    hb.onkeydown = (e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { const cw = parseFloat(getComputedStyle(hs).getPropertyValue("--lw")) || 55; setW(cw + (e.key === "ArrowLeft" ? -5 : 5)); e.preventDefault(); } };
    show(orig[0]);
    poll(); // abrir conclui o aviso de "novo"
  },
  async protocolos() { await listView(null, "Protocolos", "l"); },
  async novo() {
    const list = (await api("/api/sectors")).filter((s) => s.active), today = new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);
    shell(`<h1>Novo protocolo</h1><form class="panel" id="f"><div class="frow"><div class="field"><label for="pnum">Número do protocolo</label><input id="pnum" required maxlength="40" placeholder="Ex.: 123/2026" autocomplete="off"></div><div class="field"><label for="pdt">Data do protocolo</label><input id="pdt" type="date" required value="${today}"></div></div><div class="field"><label for="s">Assunto</label><input id="s" required maxlength="200"></div>
    <div class="field"><label for="d">Conteúdo do documento</label><textarea id="d" maxlength="5000"></textarea></div>
    <div class="field"><label>Setores destinatários</label>${list.length ? `<div class="checks">${list.map((s) => `<label><input type="checkbox" name="sec" value="${s.id}"> ${esc(s.name)}</label>`).join("")}</div>` : `<p class="muted">Cadastre setores antes de enviar.</p>`}</div>
    <div class="field"><label for="a">Anexos (somente PDF; compactados em até 35% antes do envio)</label><input id="a" type="file" multiple accept="application/pdf"></div>
    <p class="muted">Ao enviar, o protocolo entra na caixa de entrada de cada setor e o recebimento é registrado automaticamente. A visualização só é registrada quando alguém do setor abrir o protocolo.</p>
    <button class="btn">Enviar protocolo</button></form>`, "n");
    watchFiles($("#a"));
    $("#f").onsubmit = (e) => {
      e.preventDefault();
      const ids = [...document.querySelectorAll("[name=sec]:checked")].map((c) => +c.value);
      if (!ids.length) return toast("Selecione ao menos um setor", true);
      dialog(`<h2>Confirmar envio</h2><p>Enviar o protocolo para ${ids.length} setor(es)? Essa ação não pode ser desfeita.</p>`, { ok: "Enviar", onOk: async () => {
        const files = await getFiles($("#a"));
        const r = await api("/api/protocols", { method: "POST", body: { protocol_number: $("#pnum").value, entry_date: $("#pdt").value, subject: $("#s").value, description: $("#d").value, sector_ids: ids, files } });
        toast("Protocolo enviado: " + r.protocol_number); location.hash = "#/central/protocolos";
        shareModal(r.id).catch((e) => toast("Protocolo enviado, mas não foi possível preparar o WhatsApp: " + e.message, true));
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
    shell(`<h1>Usuários</h1><p class="muted">Usuários entram pelo Google. O perfil de administrador só pode ser concedido diretamente no banco de dados.</p><div class="wrap"><table><tr><th>Nome</th><th>E-mail</th><th>WhatsApp</th><th>Perfil</th><th>Setores autorizados</th><th>Acesso</th><th></th></tr>${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td class="nw">${esc(fmtPhone(u.phone)) || "—"}</td><td>${u.role === "adm" ? "Administrador" : "Usuário"}</td><td>${u.sector_ids.map((i) => esc(name(i))).join(", ") || "—"}</td><td>${u.active ? "Ativo" : "Bloqueado"}</td><td><button class="btn sec sm" data-u="${u.id}">Editar</button></td></tr>`).join("")}</table></div>`, "u");
    document.querySelectorAll("[data-u]").forEach((b) => (b.onclick = () => {
      const u = users.find((x) => x.id == b.dataset.u);
      dialog(`<h2>${esc(u.name)}</h2><label class="checks"><span><input type="checkbox" id="ua" ${u.active ? "checked" : ""}> Acesso ao sistema ativo</span></label><br><label>Setores que pode acessar</label><div class="checks">${secs.map((s) => `<label><input type="checkbox" name="us" value="${s.id}" ${u.sector_ids.includes(s.id) ? "checked" : ""}> ${esc(s.name)}${s.active ? "" : " (desativado)"}</label>`).join("")}</div>`, { ok: "Salvar", onOk: async () => { await api("/api/users/" + u.id, { method: "PUT", body: { active: $("#ua").checked, sector_ids: [...document.querySelectorAll("[name=us]:checked")].map((c) => +c.value) } }); toast("Permissões salvas"); route(); } });
    }));
  },
  async p(rid) {
    const d = await api("/api/recipients/" + rid), { protocol: p, recipient: r } = d, adm = me.role === "adm";
    const orig = d.files.filter((f) => !f.message_id);
    const back = adm ? "#/central/protocolos" : "#/setor/" + r.sector_id;
    if (!adm) sessionStorage.setItem("sector", JSON.stringify({ id: r.sector_id, name: r.sector_name }));
    shell(`<p><a class="backbtn" href="${back}" title="Voltar à lista" aria-label="Voltar à lista">${ICON.back}</a></p><h1>${esc(p.protocol_number)} — ${esc(p.subject)}</h1>
    <div class="two"><div><div class="panel"><p><b>Destinatário:</b> ${esc(r.sector_name)} &nbsp; ${chip(r.status)}</p><p class="muted">Enviado ${fmt(r.sent_at)} · Recebido ${fmt(r.received_at)} · Visualizado ${fmt(r.first_viewed_at)} · Respondido ${fmt(r.responded_at)}</p><p style="white-space:pre-wrap">${esc(p.description)}</p>${fileList(orig)}${adm ? `<p><button class="btn sec sm" id="wa">Avisar por WhatsApp</button></p>` : ""}</div>
    <div class="panel"><h2>Comunicação</h2>${d.messages.map((m) => `<div class="msg ${m.role === "adm" ? "adm" : ""}"><small><b>${esc(m.author)}</b> · ${m.role === "adm" ? "Central" : esc(r.sector_name)} · ${fmt(m.created_at)}</small><div style="white-space:pre-wrap">${esc(m.message)}</div>${fileList(d.files.filter((f) => f.message_id === m.id))}</div>`).join("") || `<p class="muted">Nenhuma mensagem ainda.</p>`}
    <form id="rf"><div class="field"><label for="t">${adm ? "Enviar mensagem ao setor" : "Responder à central"}</label><textarea id="t" maxlength="5000"></textarea></div><div class="field"><input id="rfile" type="file" multiple accept="application/pdf" aria-label="Anexos"></div><button class="btn">${adm ? "Enviar mensagem" : "Enviar resposta"}</button></form></div></div>
    <div class="panel"><h2>Histórico</h2><ul class="tl">${d.events.map((e) => `<li>${esc(EVENT[e.event_type] || e.event_type)}${e.author ? " · " + esc(e.author) : ""}<br><small class="muted">${fmt(e.created_at)}</small></li>`).join("")}</ul></div></div>`, adm ? "l" : secKey(r.sector_id));
    bindFiles($("main"));
    if ($("#wa")) $("#wa").onclick = guard(() => shareModal(p.id));
    poll(); // abrir o protocolo conclui o aviso: atualiza os contadores
    watchFiles($("#rfile"));
    $("#rf").onsubmit = guard(async (e) => {
      e.preventDefault();
      const files = await getFiles($("#rfile"));
      await api(`/api/recipients/${rid}/messages`, { method: "POST", body: { message: $("#t").value, files } });
      toast(adm ? "Mensagem enviada" : "Resposta enviada"); route();
    });
  },
};

async function listView(sid, title, active, hist = false) {
  const adm = me.role === "adm";
  if (adm && !sectors.length) sectors = (await api("/api/sectors")).filter((s) => s.active);
  shell(`<h1>${title}</h1><form class="panel filters ${adm ? "c" : ""}" id="ff"><div><label for="q">Número ou assunto</label><input id="q"></div>
    ${adm && !sid ? `<div><label for="sc">Setor destinatário</label><select id="sc"><option value="">Todos</option>${sectors.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></div>` : ""}
    <div><label for="st">Status</label><select id="st"><option value="">Todos</option>${Object.entries(LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
    <div><label for="fr">De</label><input id="fr" type="date"></div><div><label for="to">Até</label><input id="to" type="date"></div><button class="btn">Pesquisar</button></form><div id="res"></div>`, active);
  const load = guard(async (page = 1) => {
    const q = new URLSearchParams({ q: $("#q").value, status: $("#st").value, from: $("#fr").value, to: $("#to").value, page });
    const s = sid || ($("#sc") && $("#sc").value); if (s) q.set("sector_id", s);
    const { rows, total, pages, page: cur } = await api("/api/protocols?" + q);
    const pager = total > 50 ? `<div class="pager"><button class="btn sec sm" data-pg="${cur - 1}" ${cur <= 1 ? "disabled" : ""}>Anterior</button><span>Página ${cur} de ${pages} · ${total} protocolos</span><button class="btn sec sm" data-pg="${cur + 1}" ${cur >= pages ? "disabled" : ""}>Próxima</button></div>` : "";
    $("#res").innerHTML = `<div class="wrap"><table><tr><th>Número</th><th>Assunto</th><th>${adm ? "Destinatário" : "Origem"}</th><th>Enviado</th><th>Recebido</th><th>Visualização</th><th>Resposta</th><th></th></tr>${rows.map((r) => `<tr class="${newLabel(r) ? "new" : ""}"><td class="num">${esc(r.protocol_number)}${newLabel(r) ? `<br><span class="newb">${newLabel(r)}</span>` : ""}</td><td class="subj">${esc(r.subject)}</td><td>${adm ? esc(r.sector) : "Central"}</td><td>${two(r.sent_at)}</td><td>${two(r.received_at)}</td><td><div class="st">${r.first_viewed_at ? chip("visualizado") + `<span class="t">${fmt(r.first_viewed_at)}</span>` : `<span class="chip">Não visualizado</span>`}</div></td><td>${r.responded_at ? chip("respondido") : `<span class="chip">Sem resposta</span>`}</td><td class="nw"><a class="btn sec sm" style="text-decoration:none" href="#/${hist ? "historico" : "p"}/${r.rid}">${hist ? "Ver histórico" : "Abrir"}</a></td></tr>`).join("") || `<tr><td colspan="8" class="empty">Nenhum protocolo encontrado.</td></tr>`}</table></div>${pager}`;
    document.querySelectorAll("[data-pg]").forEach((b) => (b.onclick = () => { load(+b.dataset.pg); window.scrollTo({ top: 0 }); }));
  });
  $("#ff").onsubmit = (e) => { e.preventDefault(); load(1); };
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
  } catch (e) {
    toast(e.message, true);
    if (h[0] === "p" || !$("#app").querySelector(".shell")) location.hash = me.role === "adm" ? "#/central" : "#/setores";
  }
}
// "protocolos" e "novo" ficam em #/central/...; mapeia para as telas acima
views["central-protocolos"] = views.protocolos; views["central-novo"] = views.novo;
addEventListener("hashchange", route);
addEventListener("hashchange", revokePv);

onAuthStateChanged(auth, async (user) => {
  if (!user) { me = null; clearInterval(timer); sessionStorage.clear(); return loginView(); }
  try {
    const r = await api("/api/me"); me = r.user; sectors = r.sectors; route(); startNotifications();
    if (me.role !== "adm" && !me.phone) profileModal();
  } catch (e) { toast(e.message, true); await signOut(auth); }
});

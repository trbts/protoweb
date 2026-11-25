import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, updateProfile, updatePassword, reauthenticateWithCredential, EmailAuthProvider, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import { firebaseConfig, API_URL } from "./config.js";
if (/COLE|SEU-/.test(firebaseConfig.apiKey + firebaseConfig.projectId + API_URL)) throw new Error("o arquivo js/config.js ainda não foi preenchido (veja o guia de configuração)");
const API = API_URL.replace(/\/+$/, ""); // endereço do Worker da Cloudflare
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (d) => (d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");
const two = (d) => (d ? `<span class="d">${new Date(d).toLocaleDateString("pt-BR")}</span><span class="t">${new Date(d).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>` : "—");

let me = null, org = null, logoUrl = null, busy = 0, pvUrl = null;
const revokePv = () => { if (pvUrl) URL.revokeObjectURL(pvUrl); pvUrl = null; };
const fmtDay = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "—");

// Links externos (WhatsApp): abrem em nova aba.
function openExternal(url) {
  const a = Object.assign(document.createElement("a"), { href: url, target: "_blank", rel: "noopener" });
  document.body.append(a); a.click(); a.remove(); return true;
}
const waLink = (phone, text) => `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
// Abre a conversa do WhatsApp com a mensagem pronta. Se nada abrir, mostra o texto e o link para copiar.
async function sendWhatsApp(phone, text) {
  let ok = false;
  try { ok = openExternal(waLink(phone, text)); } catch {}
  if (!ok) {
    const m = dialog(`<h2>Não foi possível abrir o WhatsApp</h2><p>Copie a mensagem abaixo e envie para <b>${esc(fmtWa(phone))}</b>.</p><div class="field"><textarea id="wat" rows="6" readonly>${esc(text)}</textarea></div><button class="btn sec sm" id="wac">Copiar mensagem</button>`);
    $("#wac", m).onclick = async () => { try { await navigator.clipboard.writeText(text); } catch { $("#wat", m).select(); document.execCommand("copy"); } toast("Mensagem copiada"); };
  }
}


// ---------- utilidades
function toast(msg, err) {
  if (!msg) return;
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : ""); t.textContent = msg;
  $("#toasts").append(t); setTimeout(() => t.remove(), 4500);
}
let routeGen = 0;           // muda a cada navegação: respostas atrasadas de telas antigas são descartadas
class Stale extends Error { constructor() { super(""); this.stale = true; } }
async function api(path, { method = "GET", body, raw, headers: extra, blob, quiet } = {}) {
  const gen = routeGen, isGet = method === "GET" && !quiet;
  if (!auth.currentUser) throw new Stale(); // sessão encerrada (ex.: logoff em andamento): descarta em silêncio
  if (!quiet) { busy++; $("#bar").hidden = false; }
  try {
    const headers = { Authorization: "Bearer " + (await auth.currentUser.getIdToken()), ...extra };
    if (body) headers["Content-Type"] = "application/json";
    let r;
    try { r = await fetch(API + path, { method, headers, body: raw || (body ? JSON.stringify(body) : undefined) }); }
    catch { throw new Error("Não foi possível falar com o servidor. Confira a sua conexão com a internet e tente de novo."); }
    if (blob && r.ok) return await r.blob();
    const j = await r.json().catch(() => ({}));
    if (isGet && gen !== routeGen) throw new Stale();
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
  m.addEventListener("click", (e) => { if (!required && e.target.dataset.x !== undefined) close(); });
  const b = $("[data-ok]", m);
  if (b) b.onclick = async () => { b.disabled = true; try { if ((await onOk(m)) !== false) close(); } catch (e) { toast(e.message, true); } b.disabled = false; };
  return m;
}
// Com um modal aberto, o fundo fica bloqueado (cliques, foco e rolagem).
new MutationObserver(() => { const open = !!document.querySelector(".modal"), app = $("#app"); if (app) app.inert = open; document.body.classList.toggle("modal-open", open); }).observe(document.body, { childList: true });
document.addEventListener("click", (e) => { const m = $("#umenu"); if (m && !m.hidden && !m.contains(e.target)) { m.hidden = true; $("#um")?.setAttribute("aria-expanded", "false"); } });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { const m = $("#umenu"); if (m) m.hidden = true; } });
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
// Toda exclusão pede a senha do e-mail de acesso: o Firebase reautentica e o servidor só aceita a exclusão com login recém-confirmado.
function confirmPwd({ title, html, pre, run, ok = "Excluir definitivamente" }) {
  return dialog(`<h2>${title}</h2>${html}<div class="field"><label for="dpw">Senha do seu e-mail de acesso</label><input id="dpw" type="password" autocomplete="current-password"></div>`, { ok, onOk: async (m) => {
    if (pre) pre(m);
    const pw = $("#dpw", m).value;
    if (!pw) throw new Error("Digite a sua senha para confirmar.");
    try {
      await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, pw));
      await auth.currentUser.getIdToken(true);
    } catch (e) { throw new Error(/wrong-password|invalid-credential|invalid-login/.test(e.code || "") ? "Senha incorreta." : authErr(e)); }
    return run(m);
  } });
}

// Rascunhos locais: filtros e textos digitados ficam guardados neste aparelho (localStorage) e voltam ao reabrir a tela.
// Senhas e arquivos nunca são guardados. O rascunho é apagado quando a ação é concluída.
function keepDraft(root, scope) {
  const key = `pw:${me.id}:${scope}`, SKIP = ["password", "file", "button", "submit", "hidden"];
  const fields = [...root.querySelectorAll("input[id],select[id],textarea[id]")].filter((e) => !SKIP.includes(e.type) && !e.dataset.nodraft);
  try {
    const st = JSON.parse(localStorage.getItem(key) || "null");
    if (st && Date.now() - st._t < 30 * 864e5) {
      for (const e of fields) if (e.id in st.v) { if (e.type === "checkbox") e.checked = !!st.v[e.id]; else e.value = st.v[e.id]; }
      root.querySelectorAll("details.wan").forEach((d) => { if ([...d.querySelectorAll("input,textarea")].some((e) => e.value)) d.open = true; });
    }
  } catch { /* sem armazenamento local: segue sem rascunho */ }
  const save = () => { try { localStorage.setItem(key, JSON.stringify({ _t: Date.now(), v: Object.fromEntries(fields.map((e) => [e.id, e.type === "checkbox" ? e.checked : e.value])) })); } catch {} };
  root.addEventListener("input", save); root.addEventListener("change", save);
  return () => { try { localStorage.removeItem(key); } catch {} };
}
let clearDraft = () => {};

// Anexos: só PDF, enviados exatamente como estão (sem compressão e sem conversão).
const MAX_FILES = 10, MAX_MB = 50;
const pdfField = (id, label, { multiple = false, required = false } = {}) => `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="file" accept="application/pdf" ${multiple ? "multiple" : ""} ${required ? "required" : ""}><div class="note">O PDF é enviado como está, sem compressão (até ${MAX_MB} MB cada).</div></div>`;
// Cada PDF é enviado separadamente (direto para o armazenamento na nuvem) e depois anexado ao protocolo pelo número do envio.
async function uploadFiles(input) {
  const list = [...(input?.files || [])];
  if (list.length > MAX_FILES) throw new Error(`Envie no máximo ${MAX_FILES} arquivos por vez`);
  for (const f of list) {
    if (!/\.pdf$/i.test(f.name)) throw new Error(`“${f.name}”: envie somente arquivos PDF`);
    if (f.size > MAX_MB * 1048576) throw new Error(`“${f.name}” passa de ${MAX_MB} MB`);
    if (!f.size) throw new Error(`“${f.name}” está vazio`);
  }
  const fileIds = [];
  for (const f of list) {
    const r = await api("/api/uploads", { method: "POST", raw: f, headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(f.name) } });
    fileIds.push(r.id);
  }
  return fileIds;
}
async function downloadFile(id, name) {
  const blob = await api("/api/files/" + id, { blob: true }), url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
// Leitor de PDF para celular: os navegadores de celular não mostram PDF dentro da página (ficam em branco ou só baixam),
// então as páginas são desenhadas com o PDF.js, ajustadas à largura da tela, com zoom e rolagem. No computador continua o leitor do navegador.
const isMobile = () => matchMedia("(pointer: coarse)").matches || innerWidth < 820;
const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
let pdfjsP = null;
const loadPdfJs = () => (pdfjsP ||= new Promise((ok, no) => {
  const s = document.createElement("script"); s.src = PDFJS_URL + "pdf.min.js";
  s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_URL + "pdf.worker.min.js"; ok(window.pdfjsLib); };
  s.onerror = () => { pdfjsP = null; no(new Error("Não foi possível carregar o leitor de PDF.")); };
  document.head.append(s);
}));
async function openPdfMobile(id, name, blob) {
  const url = URL.createObjectURL(blob);
  const m = dialog(`<h2><span class="pvt">${esc(name)}</span></h2><div class="pvbar"><button class="btn sec sm" data-z="out" aria-label="Diminuir o zoom">−</button><span class="muted" id="pvz">100%</span><button class="btn sec sm" data-z="in" aria-label="Aumentar o zoom">+</button><button class="btn sec sm" data-z="fit">Ajustar</button><button class="btn sec sm" data-dl2>Baixar</button></div><div class="pvpages" id="pvp"><p class="muted">Carregando…</p></div>`, { big: true });
  let doc = null, onResize = null;
  new MutationObserver(() => { if (!document.body.contains(m)) { URL.revokeObjectURL(url); doc?.destroy(); if (onResize) removeEventListener("resize", onResize); } }).observe(document.body, { childList: true });
  $("[data-dl2]", m).onclick = guard(() => downloadFile(id, name));
  const box = $("#pvp", m);
  try {
    const lib = await loadPdfJs();
    doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    const v1 = (await doc.getPage(1)).getViewport({ scale: 1 }), ratio = v1.height / v1.width;
    let zoom = 1, gen = 0;
    const cssW = () => Math.max(160, (box.clientWidth - 16) * zoom), dpr = () => Math.min(devicePixelRatio || 1, 2);
    box.innerHTML = "";
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) { const el = document.createElement("div"), cv = document.createElement("canvas"); el.className = "pvpage"; el.dataset.n = i; el.append(cv); box.append(el); pages.push({ n: i, el, cv, busy: false, done: false, err: 0 }); }
    const size = () => pages.forEach((e) => { e.el.style.width = cssW() + "px"; e.el.style.height = Math.round(cssW() * ratio) + "px"; });
    async function render(e) {
      if (e.busy || e.done || e.err > 2) return;
      e.busy = true; const g = gen;
      try {
        const pg = await doc.getPage(e.n), base = pg.getViewport({ scale: 1 }), w = cssW(), sc = (w / base.width) * dpr();
        let vp = pg.getViewport({ scale: sc });
        if (vp.width * vp.height > 14e6) vp = pg.getViewport({ scale: sc * Math.sqrt(14e6 / (vp.width * vp.height)) }); // limita a memória no celular
        e.el.style.width = w + "px"; e.el.style.height = Math.round((w * base.height) / base.width) + "px";
        e.cv.width = Math.floor(vp.width); e.cv.height = Math.floor(vp.height);
        await pg.render({ canvasContext: e.cv.getContext("2d"), viewport: vp }).promise;
        if (g === gen) e.done = true;
      } catch { e.err++; }
      e.busy = false;
      if (!e.done && e.err <= 2) { io.unobserve(e.el); io.observe(e.el); } // o zoom mudou durante o desenho: desenha de novo
    }
    const io = new IntersectionObserver((list) => list.forEach((x) => { if (x.isIntersecting) render(pages[+x.target.dataset.n - 1]); }), { root: box, rootMargin: "700px 0px" });
    const setZoom = (z) => {
      zoom = Math.min(3, Math.max(0.5, z)); gen++; $("#pvz", m).textContent = Math.round(zoom * 100) + "%";
      pages.forEach((e) => { e.done = false; e.err = 0; e.cv.width = 0; }); size();
      pages.forEach((e) => { io.unobserve(e.el); io.observe(e.el); });
    };
    m.querySelectorAll("[data-z]").forEach((b) => (b.onclick = () => setZoom(b.dataset.z === "in" ? zoom * 1.25 : b.dataset.z === "out" ? zoom / 1.25 : 1)));
    onResize = () => setZoom(zoom); addEventListener("resize", onResize);
    size(); pages.forEach((e) => io.observe(e.el));
  } catch {
    box.innerHTML = `<p>Não foi possível exibir este PDF aqui.</p><p class="acts2"><a class="btn" href="${url}" target="_blank" rel="noopener">Abrir em outra aba</a></p>`;
  }
}
async function openFile(id, name, type) {
  const blob = await api("/api/files/" + id, { blob: true });
  if (type === "application/pdf" && isMobile()) return openPdfMobile(id, name, blob);
  const url = URL.createObjectURL(blob);
  const m = dialog(`<h2>${esc(name)} <button class="btn sec sm" data-dl2>Baixar</button></h2>${type === "application/pdf" ? `<iframe src="${url}" title="${esc(name)}"></iframe>` : `<img src="${url}" alt="${esc(name)}">`}`, { big: true });
  new MutationObserver(() => { if (!document.body.contains(m)) URL.revokeObjectURL(url); }).observe(document.body, { childList: true });
  $("[data-dl2]", m).onclick = guard(() => downloadFile(id, name));
}
const own = (f) => (f.holder ? ` <span class="muted">· ${f.holder === "sector" ? "Resposta do setor" : STEP[f.holder]}${f.uploader ? " — " + esc(f.uploader) : ""}</span>` : "");
const fileList = (files) => files.length ? `<ul>${files.map((f) => `<li><button class="link" data-file="${f.id}" data-name="${esc(f.file_name)}" data-type="${f.mime_type}">${esc(f.file_name)}</button> <span class="muted">(${Math.ceil(f.file_size / 1024)} KB)</span> · <button class="link" data-dl="${f.id}" data-name="${esc(f.file_name)}">Baixar</button>${own(f)}</li>`).join("")}</ul>` : "";
const bindFiles = (root) => {
  root.querySelectorAll("[data-file]").forEach((b) => (b.onclick = guard(() => openFile(b.dataset.file, b.dataset.name, b.dataset.type))));
  root.querySelectorAll("[data-dl]").forEach((b) => (b.onclick = guard(() => downloadFile(b.dataset.dl, b.dataset.name))));
};

// ---------- dados do usuário
const profileFields = () => `<div class="field"><label for="pn">Nome completo</label><input id="pn" value="${esc(me.name)}" maxlength="120" autocomplete="name"></div>`;
let avSel = null; // escolha em andamento: { emoji, border, img }
const AV_PX = 256; // lado da foto de perfil, em pixels
// Foto de perfil: corte quadrado pelo centro, redução e conversão para WebP no próprio aparelho (JPEG se o navegador não gerar WebP).
async function toAvatarImage(file) {
  if (!/^image\//.test(file.type)) throw new Error(`“${file.name}” não é uma imagem`);
  if (file.size > 15 * 1048576) throw new Error("A imagem passa de 15 MB");
  let img;
  try { img = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error(`“${file.name}” não é uma imagem válida`)); i.src = URL.createObjectURL(file); }); }
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, side = Math.min(w, h), out = Math.min(side, AV_PX);
  if (!side) throw new Error(`“${file.name}” não é uma imagem válida`);
  const cv = document.createElement("canvas"); cv.width = cv.height = out;
  const cx = cv.getContext("2d"); cx.imageSmoothingQuality = "high";
  cx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out);
  if (img.close) img.close(); else URL.revokeObjectURL(img.src);
  let url = cv.toDataURL("image/webp", 0.82), jpg = false;
  if (!url.startsWith("data:image/webp")) { url = cv.toDataURL("image/jpeg", 0.85); jpg = true; } // Safari antigo: sem WebP
  if (url.length > 150000) throw new Error("A imagem ficou grande demais. Escolha outra.");
  return { url, jpg };
}
const avatarPicker = () => {
  const full = me.step === 3; // emojis e bordas rosas: só a Deliberação; os demais usuários usam só a foto
  avSel = { emoji: AV_EMOJIS.includes(me.avatar_emoji) ? me.avatar_emoji : "", border: full ? me.avatar_border || 0 : 0, img: me.avatar_img || "" };
  return `<h3 class="sech">Foto de perfil</h3><div class="avprev" id="avprev"></div>
    <div class="field"><label for="avf">Enviar uma foto</label><input id="avf" type="file" accept="image/*"><div class="note">A foto é cortada em quadrado (pelo centro), reduzida e convertida para WebP no seu aparelho. Veja a prévia acima e clique em “Salvar dados”.</div></div>
    ${full ? `<p class="muted avhint">Ou escolha um emoji</p>
    <div class="avgrid" id="avem" role="group" aria-label="Escolha um emoji">${AV_EMOJIS.map((e, i) => `<button type="button" class="avo" data-e="${e}" title="${AV_NAMES[i]}" aria-label="${AV_NAMES[i]}">${e}</button>`).join("")}</div>
    <p class="muted avhint">Borda <span>(toque de novo na borda escolhida para tirar)</span></p>
    <div class="avgrid" id="avbd" role="group" aria-label="Escolha uma borda">${AV_BORDERS.map((n, i) => `<button type="button" class="avo avb" data-b="${i + 1}" title="${n}" aria-label="${n}"><span class="avatar emo b${i + 1}" style="width:40px;height:40px;font-size:22px"></span></button>`).join("")}</div>` : ""}
    <button type="button" class="btn sec sm" id="avx">${full ? "Usar ícone padrão" : "Remover foto"}</button>`;
};
function bindAvatarPicker() {
  if (!avSel) return;
  const paint = () => {
    const bd = avSel.border ? " · " + AV_BORDERS[avSel.border - 1] : "";
    $("#avprev").innerHTML = avSel.img ? imgAvatar(avSel.img, avSel.border, 84) + `<b>Sua foto${bd}</b>` : avSel.emoji ? emojiAvatar(avSel.emoji, avSel.border, 84) + `<b>${AV_NAMES[AV_EMOJIS.indexOf(avSel.emoji)]}${bd}</b>` : `<span class="avatar" style="width:84px;height:84px">${ICON.user}</span><b>Ícone padrão</b>`;
    document.querySelectorAll("#avbd .avatar").forEach((a) => { a.innerHTML = avSel.img ? `<img src="${avSel.img}" alt="" style="width:100%;height:100%;object-fit:cover">` : avSel.emoji; });
    document.querySelectorAll("#avem .avo").forEach((b) => b.setAttribute("aria-pressed", String(!avSel.img && b.dataset.e === avSel.emoji)));
    document.querySelectorAll("#avbd .avo").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.b === avSel.border)));
  };
  $("#avf").onchange = guard(async () => {
    const f = $("#avf").files[0]; $("#avf").value = ""; if (!f) return;
    const r = await toAvatarImage(f);
    avSel.img = r.url; avSel.emoji = ""; paint();
    if (r.jpg) toast("Este navegador não gera WebP: a foto foi compactada em JPEG.");
  });
  document.querySelectorAll("#avem .avo").forEach((b) => (b.onclick = () => { avSel.emoji = b.dataset.e; avSel.img = ""; paint(); }));
  document.querySelectorAll("#avbd .avo").forEach((b) => (b.onclick = () => { const v = +b.dataset.b; avSel.border = avSel.border === v ? 0 : v; paint(); }));
  $("#avx").onclick = () => { avSel.emoji = ""; avSel.img = ""; avSel.border = 0; paint(); };
  paint();
}
async function saveProfile() {
  const name = $("#pn").value.trim();
  if (name.length < 3) throw new Error("Informe seu nome completo");
  const body = { name };
  if (avSel) { body.avatar_emoji = avSel.emoji; body.avatar_border = avSel.border; body.avatar_img = avSel.img; }
  const r = await api("/api/me/profile", { method: "PUT", body });
  me.name = r.name;
  if (avSel) { me.avatar_emoji = r.avatar_emoji; me.avatar_border = r.avatar_border; me.avatar_img = r.avatar_img; }
}

// ---------- estrutura
const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  c: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  l: svg('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'),
  n: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  ct: svg('<path d="M4 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4z"/><circle cx="11" cy="10" r="2.5"/><path d="M6.5 17a4.5 4.5 0 0 1 9 0M22 8v2M22 14v2"/>'),
  u: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>'),
  arq: svg('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>'),
  d: svg('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>'),
  h: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  ok: svg('<path d="M5 12l5 5L20 7"/>'),
  back: svg('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
  rf: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>'),
  out: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  user: '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#5d5a66"/><circle cx="12" cy="9.5" r="4" fill="#e9e6f0"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0a12 12 0 0 1-15 0z" fill="#e9e6f0"/></svg>',
};
ICON.m = ICON.l;
// Foto de perfil (só Deliberação): foto enviada ou 10 emojis fofos (o primeiro é o panda) e 5 bordas femininas.
const AV_EMOJIS = ["\u{1F43C}", "\u{1F431}", "\u{1F430}", "\u{1F98A}", "\u{1F43B}", "\u{1F428}", "\u{1F9A5}", "\u{1F984}", "\u{1F439}", "\u{1F438}"];
const AV_NAMES = ["Panda", "Gatinho", "Coelhinho", "Raposinha", "Ursinho", "Coala", "Preguiça", "Unicórnio", "Hamster", "Sapinho"];
const AV_BORDERS = ["Rosa bebê", "Degradê rosa e lilás", "Pêssego e dourado", "Rosa dupla", "Lilás rendado"];
const imgAvatar = (src, border, px) => `<img class="avatar pic b${+border || 0}" style="width:${px}px;height:${px}px" src="${src}" alt="Foto de perfil">`;
const emojiAvatar = (emoji, border, px) => `<span class="avatar emo b${+border || 0}" style="width:${px}px;height:${px}px;font-size:${Math.round(px * 0.58)}px" role="img" aria-label="Foto de perfil">${emoji}</span>`;
const avatar = (px) => {
  if (me?.avatar_img) return imgAvatar(me.avatar_img, me.step === 3 ? me.avatar_border : 0, px);
  if (me?.step === 3 && AV_EMOJIS.includes(me.avatar_emoji)) return emojiAvatar(me.avatar_emoji, me.avatar_border, px);
  const u = auth.currentUser?.photoURL; return u ? `<img class="avatar" style="width:${px}px;height:${px}px" src="${esc(u)}" referrerpolicy="no-referrer" alt="">` : `<span class="avatar" style="width:${px}px;height:${px}px">${ICON.user}</span>`;
};
const hashStr = (t) => { let h = 0; for (let i = 0; i < t.length; i++) h = (Math.imul(31, h) + t.charCodeAt(i)) | 0; return h; };
function shell(inner, active) {
  const dev = me.role === "dev";
  const sig = [me.id, me.funcao, me.name, org.name, logoUrl, me.avatar_emoji, me.avatar_border, hashStr(me.avatar_img || "")].join("|");
  const cur = $("#app .shell");
  if (cur && cur.dataset.sig === sig) { // mesma estrutura: só troca o conteúdo e a aba ativa, com transição
    cur.querySelectorAll(".side nav a").forEach((a) => a.classList.toggle("on", a.dataset.k === active));
    const mn = $("main", cur); mn.classList.remove("fade"); mn.innerHTML = inner; void mn.offsetWidth; mn.classList.add("fade");
    window.scrollTo(0, 0); paintBadge(); return;
  }
  const nav = (h, t, k, b) => `<a href="${h}" data-k="${k}" class="${active === k ? "on" : ""}"><span class="ni">${ICON[k] || ICON.m}</span><span class="nt">${t}</span>${b ? `<span class="nbadge" id="${b}" hidden></span>` : ""}</a>`;
  $("#app").innerHTML = `<div class="shell" data-sig="${sig}"><header class="top"><span class="brandbar"><img class="logo" src="${logoSrc()}" alt=""><span class="org">${esc(org.name)}</span></span>
      <span class="who"><button class="uchip" id="um" aria-haspopup="true" aria-expanded="false" title="${esc(me.name)} (${esc(me.email)})">${avatar(34)}<b>${esc(String(me.name || me.email).split(" ")[0])}</b></button>
      <div class="umenu" id="umenu" hidden><div class="uinfo">${avatar(64)}<b>${esc(me.name)}</b><span class="muted">${esc(me.email)}</span></div><button class="btn sec" id="out">${ICON.out}<span>Sair</span></button></div></span></header>
    <div class="body"><aside class="side"><nav>
    ${canNew() ? nav("#/central/novo", "Novo protocolo", "n") : ""}${dev ? "" : nav("#/central/protocolos", "Protocolos", "l", me.step === 1 ? "" : "nb-prot")}${me.step === 1 ? nav("#/central/arquivamento", "Arquivamento", "arq", "nb-prot") : ""}${dev ? "" : nav("#/historico", "Histórico", "h")}${dev ? nav("#/central/usuarios", "Usuários", "u") + nav("#/central/dev", "Dev", "d") : ""}${nav("#/config", "Configurações", "c")}</nav></aside>
    <main class="fade">${inner}</main></div></div>`;
  $("#out").onclick = logout;
  const um = $("#um"), menu = $("#umenu");
  um.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; um.setAttribute("aria-expanded", String(!menu.hidden)); };
  document.querySelectorAll("img.avatar").forEach((i) => (i.onerror = () => i.replaceWith(Object.assign(document.createElement("span"), { className: "avatar", innerHTML: ICON.user }))));
  paintBadge();
}
// Login por e-mail e senha e cadastro de novos usuários. Quem se cadastra fica sem função até o dev definir (Protocolo, Despacho ou Deliberação), em Usuários.
let regBusy = false;
const AUTH_ERR = { "auth/invalid-credential": "E-mail ou senha incorretos.", "auth/invalid-login-credentials": "E-mail ou senha incorretos.", "auth/wrong-password": "E-mail ou senha incorretos.", "auth/user-not-found": "E-mail ou senha incorretos.", "auth/invalid-email": "E-mail inválido.", "auth/email-already-in-use": "Este e-mail já está cadastrado. Use a aba Entrar.", "auth/weak-password": "A senha deve ter pelo menos 6 caracteres.", "auth/too-many-requests": "Muitas tentativas. Aguarde alguns minutos e tente de novo.", "auth/network-request-failed": "Sem conexão. Tente novamente.", "auth/operation-not-allowed": "O login por e-mail e senha não está ativado no Firebase.", "auth/user-disabled": "Esta conta foi desativada." };
const authErr = (e) => (e.code ? AUTH_ERR[e.code] || "Não foi possível concluir (" + e.code + ")." : e.message);
const loginView = (mode = "in") => {
  const reg = mode === "reg";
  $("#app").innerHTML = `<div class="login"><div class="panel"><img class="mark" src="protoweb.svg" alt="" width="64" height="64"><h1>ProtoWeb</h1><p class="org-l">Protocolos e tramitação de documentos</p>
    <div class="tabs2"><button type="button" id="t-in" class="${reg ? "" : "on"}">Entrar</button><button type="button" id="t-reg" class="${reg ? "on" : ""}">Criar conta</button></div>
    <form id="lf" class="lform" novalidate>
      ${reg ? `<div class="field"><label for="ln">Nome completo</label><input id="ln" maxlength="120" autocomplete="name"></div>` : ""}
      <div class="field"><label for="le">E-mail</label><input id="le" type="email" maxlength="120" autocomplete="email" inputmode="email"></div>
      <div class="field"><label for="lp">Senha</label><input id="lp" type="password" autocomplete="${reg ? "new-password" : "current-password"}"></div>
      ${reg ? `<div class="field"><label for="lp2">Repita a senha</label><input id="lp2" type="password" autocomplete="new-password"></div>` : ""}
      <button class="btn" id="lb">${reg ? "Criar conta" : "Entrar"}</button>
      ${reg ? `<p class="muted">Depois de criar a conta, você cria a sua organização ou entra em uma já existente com um código de convite.</p>` : `<p><button type="button" class="link" id="lr">Esqueci a senha</button></p>`}
    </form><p class="track"><a href="${API}/acompanhar" target="_blank" rel="noopener">Acompanhar um protocolo</a></p></div></div>`;
  $("#t-in").onclick = () => loginView("in"); $("#t-reg").onclick = () => loginView("reg");
  if (!reg) $("#lr").onclick = async () => {
    const email = $("#le").value.trim();
    if (!email) return toast("Digite o seu e-mail e clique em “Esqueci a senha” de novo.", true);
    try { await sendPasswordResetEmail(auth, email); toast("Se o e-mail estiver cadastrado, você receberá o link para criar uma nova senha."); } catch (e) { toast(authErr(e), true); }
  };
  $("#lf").onsubmit = async (e) => {
    e.preventDefault();
    const b = $("#lb"), email = $("#le").value.trim(), pw = $("#lp").value;
    try {
      if (!email || !pw) throw new Error("Informe o e-mail e a senha.");
      b.disabled = true;
      if (!reg) return await signInWithEmailAndPassword(auth, email, pw);
      const name = $("#ln").value.trim();
      if (name.length < 3) throw new Error("Informe seu nome completo.");
      if (pw.length < 6) throw new Error("A senha deve ter pelo menos 6 caracteres.");
      if (pw !== $("#lp2").value) throw new Error("As senhas não conferem.");
      regBusy = true;
      const cred = await createUserWithEmailAndPassword(auth, email, pw);
      try { await updateProfile(cred.user, { displayName: name }); } catch {}
      await boot(cred.user);
    } catch (err) { toast(authErr(err), true); if (b) b.disabled = false; }
    finally { regBusy = false; }
  };
};

// ---------- organização (logotipo) e primeiro acesso
const logoSrc = () => logoUrl || "protoweb.svg";
function revokeLogo() { if (logoUrl) URL.revokeObjectURL(logoUrl); logoUrl = null; }
async function loadLogo() {
  revokeLogo();
  if (!org?.has_logo) return;
  try { logoUrl = URL.createObjectURL(await api("/api/org/logo", { blob: true, quiet: true })); } catch { logoUrl = null; }
}

// Primeiro acesso de uma conta nova. Se ainda não existe organização, quem se cadastra cria a organização e vira o único administrador (Dev).
// Nos demais casos, a pessoa entra com o código de convite e fica sem função até o Dev definir.
function onboardingView(user, first) {
  const create = !!first;
  $("#app").innerHTML = `<div class="login"><div class="panel"><img class="mark" src="protoweb.svg" alt="" width="64" height="64"><h1>${create ? "Primeiro acesso" : "Bem-vindo(a)"}</h1><p class="org-l">${create ? "Configure a sua organização" : "Falta pouco para começar"}</p>
    <form id="of" class="lform" novalidate>
      <div class="field"><label for="on">Seu nome completo</label><input id="on" maxlength="120" value="${esc(user.displayName || "")}" autocomplete="name"></div>
      ${create
        ? `<div class="field"><label for="oo">Nome da organização</label><input id="oo" maxlength="120" placeholder="Ex.: Prefeitura Municipal de …"></div><p class="muted">Você será o administrador (Dev) do sistema e o único com esse perfil. Depois, convide a equipe com o código de convite.</p>`
        : `<div class="field"><label for="oc">Código de convite</label><input id="oc" maxlength="20" autocomplete="off" class="code"></div><p class="muted">Peça o código ao administrador da sua organização (menu Configurações). Depois, ele define a sua função.</p>`}
      <button class="btn" id="ob">${create ? "Criar e entrar" : "Entrar na organização"}</button>
      <p><button type="button" class="link" id="oout">Sair</button></p>
    </form></div></div>`;
  $("#oout").onclick = logout;
  $("#of").onsubmit = async (e) => {
    e.preventDefault();
    const b = $("#ob"); b.disabled = true;
    try {
      const body = { mode: create ? "create" : "join", name: $("#on").value.trim() };
      if (create) body.org_name = $("#oo").value.trim(); else body.code = $("#oc").value.trim();
      await api("/api/onboarding", { method: "POST", body });
      await boot(auth.currentUser);
    } catch (err) { toast(err.message, true); b.disabled = false; }
  };
}

// ---------- avisos dentro da página (contador e alerta enquanto o sistema está aberto)
let badge = null, timer = null;
function paintBadge() {
  const n = badge || 0, el = $("#nb-prot");
  if (el) { el.hidden = !n; el.textContent = n > 99 ? "99+" : n || ""; }
  document.title = (n ? `(${n}) ` : "") + "ProtoWeb" + (org ? " · " + org.name : "");
}
async function poll() {
  if (!me || !staff()) return;
  try {
    const { count } = await api("/api/notifications", { quiet: true });
    const prev = badge; badge = count; paintBadge();
    if (prev !== null && count > prev) toast("Há um protocolo aguardando a sua ação.");
  } catch { /* tenta de novo no próximo ciclo */ }
}
function startNotifications() { clearInterval(timer); badge = null; poll(); timer = setInterval(poll, 20000); }
async function logout() {
  clearInterval(timer); routeGen++; me = null; org = null; // zera antes de sair: nenhuma tela tenta chamar a API sem sessão
  try { await signOut(auth); } finally { location.hash = ""; }
}

// ---------- fluxo de tramitação: funções de apoio
// Fluxo definitivo: Protocolo → Despacho → Deliberação → (volta ao) Protocolo → Arquivamento. Sem setores externos e sem links temporários.
const STEP = { u1: "Protocolo", u2: "Despacho", u3: "Deliberação", sector: "Setor (antigo)" };
const staff = () => me.role === "dev" || me.step > 0;
const canNew = () => me.step === 1;
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const fmtWa = (p) => (p ? `+${p.slice(0, 2)} (${p.slice(2, 4)}) ${p.slice(4, -4)}-${p.slice(-4)}` : "—");
const stageChip = (p) => p.closed_at ? '<span class="chip respondido">Arquivado</span>' : p.stage === "u2" ? '<span class="chip u">No Despacho</span>' : p.stage === "u3" ? '<span class="chip u">Na Deliberação</span>' : '<span class="chip visualizado">Aguardando arquivamento</span>';
const confirmDo = (text, fn) => dialog(`<h2>Confirmar</h2><p>${text}</p>`, { ok: "Confirmar", onOk: fn });
const prevBox = (x, label) => x ? `<div class="msg"><small>${label}: <b>${esc(x.author || STEP[x.holder])}</b> · ${fmt(x.exited_at)}</small>${x.comment ? `<div class="pw">${esc(x.comment)}</div>` : ""}</div>` : "";

// Notificação por WhatsApp: só na Deliberação, sempre opcional. O número é digitado na hora, junto com o texto da mensagem (nada fica guardado).
const waSection = (id) => `<details class="wan"><summary>Enviar notificação por WhatsApp (opcional)</summary>
  <div class="field"><label for="${id}p">Número do WhatsApp (com DDD)</label><input id="${id}p" inputmode="tel" autocomplete="off" placeholder="(92) 99999-9999"></div>
  <div class="field"><label for="${id}m">Mensagem da notificação</label><textarea id="${id}m" maxlength="1000" placeholder="Escreva a mensagem que será enviada."></textarea></div>
  <p class="muted">Ao concluir, o WhatsApp abre com a mensagem pronta para você enviar. Se deixar em branco, nada é enviado.</p></details>`;
function waRead(id, defText) {
  const raw = ($(`#${id}p`)?.value || "").trim(), msg = ($(`#${id}m`)?.value || "").trim();
  if (!raw && !msg) return null;
  if (!raw) throw new Error("Informe o número do WhatsApp para enviar a notificação (ou apague a mensagem).");
  let d = raw.replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) d = "55" + d;
  if (!/^55\d{10,11}$/.test(d)) throw new Error("Número de WhatsApp inválido. Informe o DDD e o número.");
  return { phone: d, text: msg || defText };
}
function offerWhatsApp({ phone, text }) {
  dialog(`<h2>Notificação por WhatsApp</h2><p>Mensagem para <b>${esc(fmtWa(phone))}</b>:</p><div class="msg"><div class="pw">${esc(text)}</div></div>`, { ok: "Abrir WhatsApp", cancel: "Agora não", onOk: () => { sendWhatsApp(phone, text); } });
}

// Uma passagem do processo, com a descrição do que foi feito em cada etapa (histórico interno).
const pwl = (label, text) => `${label}: <span class="pw">${esc(text)}</span>`;
function stepLi(st, p, files, recs) {
  const att = files.filter((f) => f.step_id === st.id), pdfs = att.filter((f) => f.mime_type === "application/pdf");
  const person = st.author || st.viewer, L = [], who = (v) => (v ? ` por <b>${esc(v)}</b>` : "");
  const seen = () => st.viewed_at ? `Visualizado${who(st.viewer)} em ${fmt(st.viewed_at)}` : !st.exited_at && st.entered_at ? "Ainda não visualizado" : "";
  const files2 = () => { if (pdfs.length) L.push(`Documento(s) anexado(s): ${pdfs.map((f) => esc(f.file_name)).join("; ")}`); };
  let title = STEP[st.holder];
  if (st.holder === "u1" && st.leg === "ida") {
    L.push(`Protocolo registrado: nº <b>${esc(p.protocol_number)}</b> em ${fmtDay(p.entry_date)}${p.entry_time ? " às " + esc(p.entry_time) : ""}${who(st.author)}`);
    if (p.oficio_number) L.push(`Nº do ofício: ${esc(p.oficio_number)}`);
    L.push(pwl("Assunto adicionado", p.subject));
    L.push(p.description ? pwl("Descrição adicionada", p.description) : "Descrição: não informada");
    files2();
    if (st.exited_at) L.push(`Encaminhado ao Despacho em ${fmt(st.exited_at)}${who(st.author)}`);
  } else if (st.holder === "u2" && st.leg === "ida") {
    if (st.entered_at) L.push(`Recebido pelo Despacho em ${fmt(st.entered_at)}`);
    L.push(seen());
    if (st.exited_at) {
      L.push(st.comment ? pwl("Informações e ações realizadas", st.comment) : "Informações e ações realizadas: não registradas");
      files2();
      L.push(`Encaminhado à Deliberação em ${fmt(st.exited_at)}${who(st.author)}`);
    } else if (st.entered_at) L.push("Em andamento no Despacho");
  } else if (st.holder === "u3" && st.leg === "ida") {
    if (st.entered_at) L.push(`Recebido pela Deliberação em ${fmt(st.entered_at)}`);
    L.push(seen());
    if (st.exited_at) {
      L.push(st.comment ? pwl("Informações e decisões tomadas", st.comment) : "Informações e decisões tomadas: não registradas");
      if (pdfs.length) L.push(`Ofício(s) anexado(s): ${pdfs.map((f) => esc(f.file_name)).join("; ")}`);
      L.push(`Encaminhado ao Protocolo para arquivamento em ${fmt(st.exited_at)}${who(st.author)}`);
    } else if (st.entered_at) L.push("Em andamento na Deliberação");
  } else if (st.holder === "u1" && st.leg === "volta") {
    title = "Protocolo · retorno e arquivamento";
    if (st.entered_at) L.push(`Recebido de volta da Deliberação em ${fmt(st.entered_at)}`);
    L.push(seen());
    if (st.exited_at) {
      L.push(`Processo arquivado em ${fmt(st.exited_at)}${who(st.author)}`);
      if (st.comment) L.push(pwl("Observação do arquivamento", st.comment));
      L.push("Ciclo do histórico encerrado.");
    } else L.push("Aguardando arquivamento pelo Protocolo");
  }
  const done = !!st.exited_at, cur = !done && !!st.entered_at;
  return `<li class="${done ? "done" : cur ? "cur" : "wait"}"><span class="dot">${done ? ICON.ok : ""}</span><div><b>${title}${person ? ` · <span class="who2">${esc(person)}</span>` : ""}</b>${L.filter(Boolean).map((l) => `<div class="when">${l}</div>`).join("")}</div></li>`;
}
const curStep = (st) => !st.recipient_id && (st.leg === "ida" ? ["u1", "u2", "u3"].includes(st.holder) : st.holder === "u1"); // sem os envios antigos a setores
const histList = (d) => `<ol class="stp">${d.steps.filter(curStep).map((st) => stepLi(st, d.protocol, d.files, d.recipients)).join("")}${d.protocol.closed_at ? `<li class="done"><span class="dot">${ICON.ok}</span><div><b>Ciclo encerrado (arquivado)</b><div class="when">Processo arquivado em ${fmt(d.protocol.closed_at)}. Não há mais movimentações.</div></div></li>` : ""}</ol>`;

const views = {
  async config() {
    const F = { dev: "Dev", user1: "Protocolo", user2: "Despacho", user3: "Deliberação", nenhuma: "Sem função" }, dev = me.role === "dev";
    const o = dev ? await api("/api/org") : null;
    const mb = (b) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0);
    const szb = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(b % 1073741824 ? 2 : 0).replace(".", ",") + " GB" : mb(b) + " MB");
    const orgPanel = dev ? `<div class="panel"><h2>Organização</h2>
      <div class="field"><label for="on2">Nome da organização</label><input id="on2" value="${esc(o.name)}" maxlength="120"></div>
      <p><button class="btn sec sm" id="osv">Salvar nome</button></p>
      <h2 class="sech">Logotipo</h2>
      <div class="logorow"><img class="logo prev" id="lgp" src="${logoSrc()}" alt="">
        <div><input id="lgf" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml"><div class="note">PNG, JPG, WEBP ou SVG, até 1 MB. Aparece no topo do sistema.</div>
        ${o.has_logo ? `<p><button class="link" id="lgd">Remover logotipo</button></p>` : ""}</div></div>
      <h2 class="sech">Convidar a equipe</h2>
      <p class="muted">Quem criar uma conta e informar este código entra na organização (sem função, até você definir em <a href="#/central/usuarios">Usuários</a>).</p>
      <div class="invite"><code id="inv">${esc(o.invite_code)}</code><button class="btn sec sm" id="invc">Copiar</button><button class="btn sec sm" id="invn">Gerar novo código</button></div>
      <h2 class="sech">Plano</h2>
      <p class="muted">Plano <b>${esc(o.plan)}</b></p>
      <div class="usage"><span>Usuários: <b>${o.users}</b> de ${o.max_users}</span><div class="pbar2"><i style="width:${Math.min(100, (o.users / o.max_users) * 100)}%"></i></div></div>
      <div class="usage"><span>Armazenamento: <b>${szb(o.storage_bytes)}</b> de ${szb(o.max_storage_mb * 1048576)}</span><div class="pbar2"><i style="width:${Math.min(100, (o.storage_bytes / 1048576 / o.max_storage_mb) * 100)}%"></i></div></div></div>` : "";
    shell(`<h1>Configurações</h1><div class="cfg"><div class="panel"><h2>Meus dados</h2>${profileFields()}${avatarPicker()}<p class="muted">E-mail: ${esc(me.email)}<br>Função: <b>${F[me.funcao] || "Sem função"}</b> (definida pelo administrador)<br>Organização: <b>${esc(org.name)}</b></p><button class="btn" id="sv">Salvar dados</button></div>
      <div class="panel"><h2>Alterar senha</h2><form id="pwf" novalidate><div class="field"><label for="pw0">Senha atual</label><input id="pw0" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="pw1">Nova senha (mínimo 6 caracteres)</label><input id="pw1" type="password" autocomplete="new-password"></div>
      <div class="field"><label for="pw2">Repita a nova senha</label><input id="pw2" type="password" autocomplete="new-password"></div><button class="btn" id="pw">Alterar senha</button></form></div>${orgPanel ? `<div class="wide">${orgPanel}</div>` : ""}</div>`, "c");
    bindAvatarPicker();
    $("#sv").onclick = guard(async () => { await saveProfile(); toast("Dados salvos"); route(); });
    $("#pwf").onsubmit = guard(async (e) => {
      e.preventDefault();
      const a = $("#pw0").value, n = $("#pw1").value;
      if (!a) throw new Error("Digite a sua senha atual.");
      if (n.length < 6) throw new Error("A nova senha precisa ter ao menos 6 caracteres.");
      if (n !== $("#pw2").value) throw new Error("A confirmação não confere com a nova senha.");
      if (n === a) throw new Error("A nova senha deve ser diferente da atual.");
      try { await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, a)); await updatePassword(auth.currentUser, n); }
      catch (err) { throw new Error(authErr(err)); }
      $("#pwf").reset(); toast("Senha alterada com sucesso");
    });
    if (dev) {
      $("#osv").onclick = guard(async () => { const r = await api("/api/org", { method: "PUT", body: { name: $("#on2").value } }); org.name = r.name; toast("Nome salvo"); route(); });
      $("#lgf").onchange = guard(async () => {
        const f = $("#lgf").files[0]; if (!f) return;
        if (f.size > 1048576) { $("#lgf").value = ""; throw new Error("O logotipo deve ter até 1 MB"); }
        await api("/api/org/logo", { method: "PUT", raw: f, headers: { "Content-Type": f.type } });
        org.has_logo = true; await loadLogo(); toast("Logotipo atualizado"); route();
      });
      if ($("#lgd")) $("#lgd").onclick = () => confirmPwd({ title: "Remover logotipo", html: "<p>Remover o logotipo da organização?</p>", ok: "Remover", run: async () => { await api("/api/org/logo", { method: "DELETE" }); org.has_logo = false; await loadLogo(); toast("Logotipo removido"); route(); } });
      $("#invc").onclick = guard(async () => { try { await navigator.clipboard.writeText(o.invite_code); } catch { /* sem permissão */ } toast("Código copiado"); });
      $("#invn").onclick = () => confirmDo("Gerar um novo código? O código atual deixa de funcionar para novos cadastros.", async () => { await api("/api/org/invite", { method: "POST" }); toast("Novo código gerado"); route(); });
    }
  },
  // Histórico interno: todas as movimentações do processo, com o que foi feito em cada etapa. Pode ser impresso.
  async historico(id) {
    if (!id) return staffList("Histórico", "h", "hist");
    const d = await api("/api/protocols/" + id + "?h=1"), p = d.protocol;
    shell(`<div class="hhead"><a class="backbtn noprint" href="#/historico" title="Voltar ao histórico" aria-label="Voltar ao histórico">${ICON.back}</a><div><h1>${esc(p.protocol_number)}${p.subject ? " — " + esc(p.subject) : ""}</h1><p class="muted">${stageChip(p)}${p.closed_at ? ` &nbsp; Arquivado em ${fmt(p.closed_at)}` : ""}</p></div><button class="btn sec sm noprint" id="pr" type="button">Imprimir histórico</button></div>
      <div class="printhead"><b>${esc(org.name)}</b><div>Histórico interno de movimentações · Protocolo nº ${esc(p.protocol_number)}</div><small>Impresso em ${fmt(new Date().toISOString())} por ${esc(me.name)}</small></div>
      <div class="hist">${d.steps.some(curStep) ? histList(d) : `<div class="panel empty">Sem movimentações registradas.</div>`}</div>`, "h");
    bindFiles($("main"));
    $("#pr").onclick = () => window.print();
    poll();
  },
  async protocolos() { await staffList("Protocolos", "l", "prot"); },
  // Novo protocolo: exclusivo do Protocolo. Sobe o PDF, registra protocolo e data e encaminha ao Despacho.
  async novo() {
    shell(`<h1>Novo protocolo</h1><form class="panel" id="f"><div class="frow3"><div class="field"><label for="pn">Número do protocolo</label><input id="pn" required maxlength="40" autocomplete="off" placeholder="123/2026"></div><div class="field"><label for="po">Nº do ofício</label><input id="po" maxlength="40" autocomplete="off" placeholder="Ex.: 45/2026"></div><div class="field"><label for="pd">Data</label><input id="pd" type="date" required value="${today()}"></div><div class="field"><label for="pt">Hora</label><input id="pt" type="time" required value="${new Date().toTimeString().slice(0, 5)}"></div></div><div class="field"><label for="s">Assunto</label><input id="s" required maxlength="200"></div>
    <div class="field"><label for="d">Descrição</label><textarea id="d" maxlength="5000"></textarea></div>
    ${pdfField("a", "PDF do documento (pode anexar mais de um)", { multiple: true, required: true })}
    <p class="muted">Ao enviar, o documento é encaminhado ao Despacho. Os arquivos ficam guardados na nuvem e acompanham o processo até o arquivamento.</p>
    <button class="btn">Enviar ao Despacho</button></form>`, "n");
    const clr = keepDraft($("#f"), "novo");
    $("#f").onsubmit = guard(async (e) => {
      e.preventDefault();
      confirmDo("Encaminhar este protocolo ao Despacho? Essa ação não pode ser desfeita.", async () => {
        const pdfs = await uploadFiles($("#a"));
        if (!pdfs.length) throw new Error("Anexe o PDF do documento");
        const r = await api("/api/protocols", { method: "POST", body: { protocol_number: $("#pn").value, entry_date: $("#pd").value, entry_time: $("#pt").value, oficio_number: $("#po").value, subject: $("#s").value, description: $("#d").value, file_ids: pdfs } });
        clr(); toast("Protocolo enviado ao Despacho: " + r.protocol_number); location.hash = "#/central/protocolos";
      });
    });
  },
  // Arquivamento: processos que voltaram da Deliberação ao Protocolo. Arquivar encerra o ciclo do histórico.
  async arquivamento() { await staffList("Arquivamento", "arq", "arq"); },
  async usuarios() {
    if (me.role !== "dev") return (location.hash = "#/central/protocolos");
    const users = await api("/api/users");
    const F = { dev: "Dev", user1: "Protocolo", user2: "Despacho", user3: "Deliberação", nenhuma: "Sem função" };
    shell(`<h1>Usuários</h1><p class="muted">Cada pessoa se cadastra com e-mail e senha e entra na organização com o código de convite (veja em Configurações), ficando <b>sem função</b>. Aqui você define Protocolo, Despacho ou Deliberação e bloqueia acessos. Só existe um Dev: quem fez o primeiro acesso. Quem mudar de função precisa atualizar a página.</p>
    <div class="wrap"><table><tr><th>Nome</th><th>E-mail</th><th>Função</th><th>Acesso</th><th></th></tr>${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${F[u.funcao] || "Sem função"}</td><td>${u.active ? "Ativo" : "Bloqueado"}</td><td class="nw"><button class="btn sec sm" data-u="${u.id}">Editar</button>${u.id !== me.id ? ` <button class="btn sec sm" data-del="${u.id}">Excluir</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">Nenhum usuário.</td></tr>`}</table></div>`, "u");
    document.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => {
      const u = users.find((x) => x.id == b.dataset.del);
      confirmPwd({ title: "Excluir usuário", html: `<p>Excluir o usuário <b>${esc(u.name)}</b>? Se ele tiver movimentações no histórico, a exclusão será recusada (nesse caso, bloqueie o acesso).</p>`, run: async () => { await api("/api/users/" + u.id, { method: "DELETE" }); toast("Usuário excluído"); route(); } });
    }));
    document.querySelectorAll("[data-u]").forEach((b) => (b.onclick = () => {
      const u = users.find((x) => x.id == b.dataset.u), self = u.id === me.id;
      dialog(`<h2>${esc(u.name)}</h2><div class="field"><label for="ust">Função</label><select id="ust" ${self ? "disabled" : ""}><option value="nenhuma">Sem função</option>${[["user1", "Protocolo — registra protocolos e arquiva os processos"], ["user2", "Despacho — registra informações e ações e encaminha à Deliberação"], ["user3", "Deliberação — registra informações e decisões e devolve ao Protocolo"], ["dev", "Dev — acesso total (único)"]].filter(([v]) => v !== "dev" || u.funcao === "dev").map(([v, t]) => `<option value="${v}" ${u.funcao === v ? "selected" : ""}>${t}</option>`).join("")}</select></div><label class="checks"><span><input type="checkbox" id="ua" ${u.active ? "checked" : ""}> Acesso ao sistema ativo</span></label>`, { ok: "Salvar", onOk: async () => {
        await api("/api/users/" + u.id, { method: "PUT", body: { active: $("#ua").checked, role: $("#ust").value } });
        toast("Alterações salvas. A pessoa precisa atualizar a página."); route();
      } });
    }));
  },
  // Dev: limpeza de dados (ações permanentes).
  async dev() {
    if (me.role !== "dev") return (location.hash = "#/central/protocolos");
    const ops = [["usuarios", "Apagar todos os usuários (menos o seu)"], ["tudo", "Apagar tudo: protocolos e usuários (menos o seu)"]];
    const F = { dev: "Dev", user1: "Protocolo", user2: "Despacho", user3: "Deliberação", nenhuma: "Sem função" };
    const wusers = await api("/api/users");
    shell(`<h1>Dev · Backup e limpeza de dados</h1>
    <div class="panel"><h2>Backup dos dados do sistema</h2><p class="muted">Baixa um arquivo (.json) com usuários, protocolos, andamentos (histórico) e a lista de arquivos. Os PDFs em si ficam guardados na nuvem (R2) e não vão dentro do arquivo. O arquivo tem dados pessoais: guarde em local seguro. Faça o backup antes de apagar qualquer coisa.</p>
      <div class="drow"><span id="bkinfo" class="muted"></span><button class="btn" id="bk">Baixar backup</button></div></div>
    <div class="panel"><h2>Importar dados exportados</h2><p class="muted">Escolha um arquivo de backup (.json) gerado nesta tela. A importação só acrescenta: nada do que já existe é apagado ou alterado, e protocolos com número já existente são ignorados. Os PDFs não vão dentro do backup: os arquivos importados só abrem se ainda estiverem guardados na nuvem.</p>
      <label class="chk"><input type="checkbox" id="imu" checked> Importar também usuários e funções</label>
      <div class="drow"><input type="file" id="imf" accept=".json,application/json"><button class="btn" id="imgo" disabled>Importar</button></div></div>
    <p class="muted">Ações permanentes e sem volta. Para confirmar, digite APAGAR e a senha do seu e-mail. Usuários apagados podem se cadastrar de novo; para remover também a conta de login, apague-a no Firebase (Authentication → Users). Excluir um protocolo isolado: use a busca por número acima ou o botão na tela do próprio protocolo.</p>
    <div class="panel"><h2>Excluir um protocolo pelo número</h2><p class="muted">Busque o número e exclua o protocolo, com os arquivos e o histórico. A senha do seu e-mail é pedida para confirmar.</p>
      <form id="sf" class="drow"><input id="sn" maxlength="40" autocomplete="off" placeholder="Ex.: 123/2026" aria-label="Número do protocolo"><button class="btn sec sm">Buscar</button></form><div id="sres"></div></div>
    <div class="panel"><h2>Apagar protocolos (com arquivos e históricos)</h2>
      <div class="frow3" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div class="field"><label for="wy">Ano</label><select id="wy"><option value="">Todos</option></select></div>
      <div class="field"><label for="wm">Mês</label><select id="wm"><option value="">Todos</option>${["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"].map((m, i) => `<option value="${String(i + 1).padStart(2, "0")}">${m}</option>`).join("")}</select></div>
      <div class="field"><label for="wu">Usuário (que criou ou atuou)</label><select id="wu"><option value="">Todos</option>${wusers.map((u) => `<option value="${u.id}">${esc(u.name)} · ${F[u.funcao] || "Sem função"}</option>`).join("")}</select></div></div>
      <div class="drow"><span id="wcount" class="muted">Contando…</span><button class="btn sec sm" id="wgo" disabled>Apagar protocolos</button></div></div>
    <div class="panel">${ops.map(([k, t]) => `<div class="drow"><span>${t}</span><button class="btn sec sm" data-w="${k}">Apagar</button></div>`).join("")}</div>`, "d");
    $("#bk").onclick = guard(async () => {
      const b = await api("/api/dev/backup", { blob: true }), d = JSON.parse(await b.text()), t = new Date(), p = (n) => String(n).padStart(2, "0");
      const name = `protoweb-backup-${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}.json`;
      const url = URL.createObjectURL(new Blob([JSON.stringify(d, null, 1)], { type: "application/json" })), a = Object.assign(document.createElement("a"), { href: url, download: name });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
      $("#bkinfo").textContent = `Backup de ${fmt(d.gerado_em)}: ${d.totais.protocolos} protocolo(s), ${d.totais.usuarios} usuário(s), ${d.totais.arquivos} arquivo(s).`;
      toast("Backup baixado");
    });
    let imData = null;
    $("#imf").onchange = guard(async (e) => {
      imData = null; $("#imgo").disabled = true;
      const f = e.target.files[0];
      if (!f) return;
      if (f.size > 25 * 1048576) throw new Error("Arquivo grande demais (máximo 25 MB).");
      try { imData = JSON.parse(await f.text()); } catch { throw new Error("O arquivo não é um JSON válido."); }
      if (!imData || imData.sistema !== "ProtoWeb") { imData = null; throw new Error("Este não é um arquivo de backup do ProtoWeb."); }
      $("#imgo").disabled = false;
    });
    $("#imgo").onclick = guard(async () => {
      if (!imData) return;
      const body = { data: imData, users: $("#imu").checked };
      const r = await api("/api/dev/import", { method: "POST", body: { ...body, dry: true } });
      const li = (n, o) => (o.novos || o.existentes || o.ignorados ? `<li>${n}: <b>${o.novos}</b> a importar${o.existentes ? `, ${o.existentes} já existem` : ""}${o.ignorados ? `, ${o.ignorados} ignorado(s)` : ""}</li>` : "");
      dialog(`<h2>Importar backup de ${fmt(imData.gerado_em)}</h2><ul>${li("Protocolos", r.protocolos)}${li("Contatos", r.contatos)}${li("Usuários", r.usuarios)}${li("Andamentos", r.etapas)}${li("Setores", r.destinatarios)}${li("Arquivos (registros)", r.arquivos)}${li("Envios", r.envios)}</ul><p class="muted">Nada do que já existe será apagado ou alterado.</p>`, { ok: "Importar", onOk: async () => {
        await api("/api/dev/import", { method: "POST", body }); toast("Dados importados"); route();
      } });
    });
    const filt = () => ({ year: $("#wy").value, month: $("#wm").value, user_id: $("#wu").value });
    const count = guard(async () => {
      const r = await api("/api/dev/wipe", { method: "POST", body: { scope: "protocolos", dry: true, ...filt() } });
      if (!$("#wy").dataset.ok) { $("#wy").dataset.ok = 1; r.years.forEach((y) => $("#wy").insertAdjacentHTML("beforeend", `<option>${y}</option>`)); }
      $("#wcount").textContent = r.count ? `${r.count} protocolo(s) serão apagados.` : "Nenhum protocolo com esse filtro."; $("#wgo").disabled = !r.count;
    });
    ["wy", "wm", "wu"].forEach((id) => ($("#" + id).onchange = count)); count();
    $("#wgo").onclick = () => confirmPwd({ title: "Apagar protocolos", html: `<p>${esc($("#wcount").textContent)} Essa ação não pode ser desfeita. Digite <b>APAGAR</b> e a sua senha para confirmar.</p><div class="field"><input id="wc" autocomplete="off" placeholder="APAGAR"></div>`, ok: "Apagar definitivamente",
      pre: (m) => { if ($("#wc", m).value.trim() !== "APAGAR") throw new Error("Digite APAGAR para confirmar"); },
      run: async () => { await api("/api/dev/wipe", { method: "POST", body: { scope: "protocolos", confirm: "APAGAR", ...filt() } }); toast("Protocolos apagados"); route(); } });
    document.querySelectorAll("[data-w]").forEach((b) => (b.onclick = () => {
      const k = b.dataset.w, t = ops.find((o) => o[0] === k)[1];
      confirmPwd({ title: t, html: `<p>Essa ação não pode ser desfeita. Digite <b>APAGAR</b> e a sua senha para confirmar.</p><div class="field"><input id="wc" autocomplete="off" placeholder="APAGAR"></div>`, ok: "Apagar definitivamente",
        pre: (m) => { if ($("#wc", m).value.trim() !== "APAGAR") throw new Error("Digite APAGAR para confirmar"); },
        run: async () => { await api("/api/dev/wipe", { method: "POST", body: { scope: k, confirm: "APAGAR" } }); toast("Dados apagados"); route(); } });
    }));
    // Excluir um protocolo isolado: busca pelo número e confirma com a senha.
    const sres = $("#sres");
    keepDraft($("#sf"), "dev-busca");
    $("#sf").onsubmit = guard(async (e) => {
      e.preventDefault();
      const q = $("#sn").value.trim();
      if (!q) throw new Error("Digite o número do protocolo");
      const r = await api("/api/dev/protocols?number=" + encodeURIComponent(q));
      sres.innerHTML = r.rows.length ? `<div class="wrap"><table><tr><th>Número</th><th>Assunto</th><th>Data</th><th>Situação</th><th></th></tr>${r.rows.map((x) => `<tr><td>${esc(x.protocol_number)}</td><td>${esc(x.subject)}</td><td>${fmtDay(x.entry_date)}</td><td>${stageChip(x)}</td><td class="nw"><button type="button" class="btn sec sm" data-dp="${x.id}">Excluir</button></td></tr>`).join("")}</table></div>` : `<p class="muted">Nenhum protocolo com esse número.</p>`;
      sres.querySelectorAll("[data-dp]").forEach((b) => (b.onclick = () => {
        const x = r.rows.find((y) => y.id == b.dataset.dp);
        confirmPwd({ title: "Excluir protocolo", html: `<p>Excluir o protocolo <b>${esc(x.protocol_number)}</b>${x.subject ? " — " + esc(x.subject) : ""}, com ${x.files} arquivo(s) e todo o histórico? Não dá para desfazer.</p>`, run: async () => {
          await api("/api/protocols/" + x.id, { method: "DELETE" }); toast("Protocolo excluído"); $("#sf").requestSubmit();
        } });
      }));
    });
  },
  // Painel do protocolo: dados, documentos e a ação da etapa (Despacho, Deliberação ou arquivamento).
  async protocolo(pid) {
    const d = await api("/api/protocols/" + pid), { protocol: p, steps } = d, files = d.files.filter((f) => !f.recipient_id), dev = me.role === "dev";
    const s = me.step || (dev ? ({ u2: 2, u3: 3, sector: 1 })[p.stage] || 0 : 0), open = !p.closed_at;
    const pdfs = files.filter((f) => f.mime_type === "application/pdf" && f.holder !== "u3"), oficios = files.filter((f) => f.holder === "u3");
    const prev = steps.filter((x) => !x.recipient_id && x.leg === "ida" && x.exited_at).pop();
    let act = "";
    if (open && p.stage === "u2" && s === 2) act = `<div class="panel act"><h2>Despacho — registrar e encaminhar à Deliberação</h2>${prevBox(prev, "Recebido de")}<form id="ff"><div class="field"><label for="fd">Informações e ações realizadas</label><textarea id="fd" required maxlength="5000" placeholder="Descreva o que foi analisado e as ações realizadas no Despacho."></textarea></div><button class="btn">Encaminhar à Deliberação</button></form></div>`;
    else if (open && p.stage === "u3" && s === 3) act = `<div class="panel act"><h2>Deliberação — registrar e encaminhar ao Protocolo</h2>${prevBox(prev, "Despacho")}<form id="ff"><div class="field"><label for="fd">Informações e decisões tomadas</label><textarea id="fd" required maxlength="5000" placeholder="Descreva as informações e as decisões tomadas na Deliberação."></textarea></div>${pdfField("of", "Ofício (PDF, opcional) — fica anexado ao processo, junto com os demais arquivos", { multiple: true })}${waSection("wa")}<p class="muted">Ao encaminhar, o processo volta ao Protocolo para ser arquivado.</p><button class="btn">Encaminhar ao Protocolo</button></form></div>`;
    else if (open && p.stage === "sector" && s === 1) act = `<div class="panel act"><h2>Arquivamento</h2>${prevBox(prev, "Recebido da Deliberação")}<form id="af"><div class="field"><label for="ac">Observação do arquivamento (opcional)</label><textarea id="ac" maxlength="5000"></textarea></div><p class="muted">Ao arquivar, o ciclo do histórico é encerrado e não pode ser reaberto.</p><button class="btn">Arquivar processo</button></form></div>`;
    shell(`<p><a class="backbtn" href="#/central/protocolos" title="Voltar à lista" aria-label="Voltar à lista">${ICON.back}</a></p><h1>${esc(p.protocol_number)}${p.subject ? " — " + esc(p.subject) : ""}</h1>
    <div class="panel"><p><b>Ato administrativo nº ${esc(p.protocol_number)}</b> &nbsp; ${stageChip(p)}</p>${p.closed_at ? `<p class="exwarn ok">Processo arquivado em ${fmt(p.closed_at)}. O ciclo do histórico está encerrado.</p>` : ""}<p class="muted">Protocolado em ${fmtDay(p.entry_date)}${p.entry_time ? " às " + esc(p.entry_time) : ""}${p.oficio_number ? " · Ofício nº " + esc(p.oficio_number) : ""}</p><p class="pw">${esc(p.description)}</p>${p.review_description ? `<h3 class="sech">Informações e ações do Despacho</h3><p class="pw">${esc(p.review_description)}</p>` : ""}<h2 class="sech">Documento e anexos</h2>${fileList(pdfs) || '<p class="muted">Sem arquivos.</p>'}${oficios.length ? `<h3 class="sech">Ofício da Deliberação</h3>${fileList(oficios)}` : ""}<p><a class="btn sec sm" style="text-decoration:none" href="#/historico/${p.id}">Ver histórico de movimentações</a> ${dev ? `<button class="btn sec sm" id="dp">Excluir protocolo</button>` : ""}</p></div>
    ${act}`, "l");
    bindFiles($("main")); poll();
    if ($("#dp")) $("#dp").onclick = () => confirmPwd({ title: "Excluir protocolo", html: `<p>Excluir o protocolo <b>${esc(p.protocol_number)}</b>, os arquivos e o histórico definitivamente? Não dá para desfazer.</p>`, run: async () => { await api("/api/protocols/" + pid, { method: "DELETE" }); toast("Protocolo excluído"); location.hash = "#/central/protocolos"; } });
    const subj = p.subject ? " — " + p.subject : "";
    clearDraft = $("#ff") ? keepDraft($("#ff"), "p" + pid) : $("#af") ? keepDraft($("#af"), "a" + pid) : () => {};
    if ($("#ff")) $("#ff").onsubmit = guard(async (e) => {
      e.preventDefault();
      const txt = $("#fd").value.trim();
      if (!txt) throw new Error(s === 2 ? "Descreva as informações e ações realizadas" : "Descreva as informações e decisões tomadas");
      const wa = s === 3 ? waRead("wa", `Protocolo nº ${p.protocol_number}${subj} foi encaminhado ao Protocolo para arquivamento. ${org.name}`) : null; // WhatsApp: só na Deliberação
      confirmDo(s === 2 ? "Encaminhar à Deliberação? Essa ação não pode ser desfeita." : "Encaminhar ao Protocolo para arquivamento? Essa ação não pode ser desfeita.", async () => {
        const file_ids = s === 3 ? await uploadFiles($("#of")) : [];
        await api(`/api/protocols/${pid}/forward`, { method: "POST", body: { description: txt, file_ids } });
        clearDraft();
        poll(); toast(s === 2 ? "Encaminhado à Deliberação" : "Encaminhado ao Protocolo"); location.hash = "#/central/protocolos";
        if (wa) offerWhatsApp(wa);
      });
    });
    if ($("#af")) $("#af").onsubmit = guard(async (e) => {
      e.preventDefault();
      confirmDo("Arquivar este processo? O ciclo do histórico será encerrado e não poderá ser reaberto.", async () => {
        await api(`/api/protocols/${pid}/archive`, { method: "POST", body: { comment: $("#ac").value } });
        clearDraft(); poll(); toast("Processo arquivado"); route();
      });
    });
  },
};

// Lista de protocolos. mode: "prot" (Protocolos), "hist" (Histórico) ou "arq" (Arquivamento).
function archiveDialog(r, done) {
  const m = dialog(`<h2>Arquivar ${esc(r.protocol_number)}</h2><p class="muted">O processo será arquivado e o ciclo do histórico será encerrado. Essa ação não pode ser desfeita.</p><div class="field"><label for="ac2">Observação do arquivamento (opcional)</label><textarea id="ac2" maxlength="5000"></textarea></div>`, { ok: "Arquivar", onOk: async () => {
    await api(`/api/protocols/${r.pid}/archive`, { method: "POST", body: { comment: $("#ac2", m).value } });
    clr(); toast("Processo arquivado"); poll(); done();
  } });
  const clr = keepDraft(m, "arq" + r.pid);
}
async function staffList(title, active, mode = "prot") {
  const arq = mode === "arq", hist = mode === "hist";
  const ETAPAS = arq ? [["back", "Aguardando arquivamento"], ["done", "Arquivados"]] : [["mine", "Aguardando minha ação"], ["u2", "No Despacho"], ["u3", "Na Deliberação"], ["back", "Aguardando arquivamento"], ["done", "Arquivados"]];
  shell(`<h1>${title}</h1>${arq ? `<p class="muted">Processos que voltaram da Deliberação ao Protocolo. Ao arquivar, o ciclo do histórico é encerrado.</p>` : ""}<form class="panel filters c" id="ff"><div><label for="q">Número ou assunto</label><input id="q"></div>
    <div><label for="et">Etapa</label><select id="et">${arq ? "" : '<option value="">Todas</option>'}${ETAPAS.filter((e) => e[0] !== "mine" || me.step).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
    <div><label for="fr">De</label><input id="fr" type="date"></div><div><label for="to">Até</label><input id="to" type="date"></div>
    <div><label for="od">Ordenar por data</label><select id="od"><option value="desc">Decrescente (mais recentes)</option><option value="asc">Crescente (mais antigos)</option></select></div><button class="btn">Pesquisar</button></form><div id="res"></div>`, active);
  const load = guard(async (page = 1) => {
    const q = new URLSearchParams({ q: $("#q").value, etapa: $("#et").value, from: $("#fr").value, to: $("#to").value, order: $("#od").value, page });
    const { rows, total, pages, page: cur } = await api("/api/protocols?" + q);
    const pager = total > 50 ? `<div class="pager"><button class="btn sec sm" data-pg="${cur - 1}" ${cur <= 1 ? "disabled" : ""}>Anterior</button><span>Página ${cur} de ${pages} · ${total} protocolos</span><button class="btn sec sm" data-pg="${cur + 1}" ${cur >= pages ? "disabled" : ""}>Próxima</button></div>` : "";
    $("#res").innerHTML = `<div class="wrap"><table><tr><th>Ato (nº do protocolo)</th><th>Assunto</th><th>Entrada</th><th>Situação</th><th></th></tr>${rows.map((r) => `<tr class="${r.mine ? "new" : ""}"><td class="num">${esc(r.protocol_number)}${r.mine ? `<br><span class="newb">Aguardando você</span>` : ""}</td><td class="subj">${esc(r.subject) || "—"}</td><td class="nw">${fmtDay(r.entry_date)}</td><td>${stageChip(r)}</td><td class="nw">${arq && !r.closed_at ? `<button class="btn sm" data-ar="${r.pid}">Arquivar</button> ` : ""}<a class="btn sec sm" style="text-decoration:none" href="#/${hist ? "historico" : "protocolo"}/${r.pid}">${hist ? "Ver histórico" : "Abrir"}</a></td></tr>`).join("") || `<tr><td colspan="5" class="empty">Nenhum protocolo encontrado.</td></tr>`}</table></div>${pager}`;
    document.querySelectorAll("[data-pg]").forEach((b) => (b.onclick = () => { load(+b.dataset.pg); window.scrollTo({ top: 0 }); }));
    document.querySelectorAll("[data-ar]").forEach((b) => (b.onclick = () => archiveDialog(rows.find((x) => x.pid == b.dataset.ar), () => load(cur))));
  });
  keepDraft($("#ff"), "lista-" + mode);
  $("#ff").onsubmit = (e) => { e.preventDefault(); load(1); };
  $("#od").onchange = () => load(1);
  load();
}

async function route() {
  if (!me || !staff()) return;
  routeGen++;
  const h = location.hash.replace(/^#\//, "").split("/"), home = me.role === "dev" ? "#/central/usuarios" : "#/central/protocolos";
  try {
    if (!h[0]) return (location.hash = home);
    let name = h[0], arg = h[1];
    if (name === "central") { name = ["protocolos", "novo", "arquivamento", "usuarios", "dev"].includes(h[1]) ? h[1] : (me.role === "dev" ? "usuarios" : "protocolos"); arg = undefined; }
    if ((name === "usuarios" || name === "dev") && me.role !== "dev") return (location.hash = home);
    if (me.role === "dev" && (name === "historico" || name === "arquivamento" || name === "protocolos")) return (location.hash = home);
    if (name === "arquivamento" && me.step !== 1) return (location.hash = home);
    if (name === "novo" && !canNew()) return (location.hash = home);
    if (!views[name]) return (location.hash = home);
    await views[name](arg);
  } catch (e) {
    if (e.stale) return;
    toast(e.message, true);
    if (h[0] === "protocolo" || !$("#app").querySelector(".shell")) location.hash = home;
  }
}
addEventListener("hashchange", route);
addEventListener("hashchange", revokePv);

// Conta criada mas ainda sem função: aguarda o dev definir (Protocolo, Despacho ou Deliberação).
function noRoleView() {
  clearInterval(timer);
  $("#app").innerHTML = `<div class="login"><div class="panel"><img class="mark" src="protoweb.svg" alt="" width="64" height="64"><h1>ProtoWeb</h1><p class="org-l">${esc(org.name)}</p><p>Olá, <b>${esc(me.name)}</b>! Sua conta foi criada, mas ainda <b>não tem função</b> no sistema.</p><p class="muted">Peça ao dev para definir a sua função (Protocolo, Despacho ou Deliberação) e depois clique em “Verificar de novo”.</p><div class="acts2" style="justify-content:center"><button class="btn" id="re">Verificar de novo</button><button class="btn sec" id="out2">Sair</button></div></div></div>`;
  $("#re").onclick = guard(() => boot(auth.currentUser)); $("#out2").onclick = logout;
}
async function boot(user) {
  try {
    const r = await api("/api/me");
    if (!r.user) { me = null; org = null; return onboardingView(user, !!r.first_run); }
    me = r.user; org = r.org; await loadLogo();
    if (!staff()) return noRoleView();
    route(); startNotifications();
  } catch (e) { if (!e.stale) toast(e.message, true); await signOut(auth); }
}
onAuthStateChanged(auth, async (user) => {
  if (!user) { me = null; org = null; revokeLogo(); clearInterval(timer); sessionStorage.clear(); return loginView(); }
  if (regBusy) return;
  await boot(user);
});

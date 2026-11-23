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

let me = null, org = null, logoUrl = null, contacts = [], busy = 0, pvUrl = null;
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
async function openFile(id, name, type) {
  const blob = await api("/api/files/" + id, { blob: true }), url = URL.createObjectURL(blob);
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
async function saveProfile() {
  const name = $("#pn").value.trim();
  if (name.length < 3) throw new Error("Informe seu nome completo");
  const r = await api("/api/me/profile", { method: "PUT", body: { name } });
  me.name = r.name;
}

// ---------- estrutura
const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  c: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  l: svg('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'),
  n: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  ct: svg('<path d="M4 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4z"/><circle cx="11" cy="10" r="2.5"/><path d="M6.5 17a4.5 4.5 0 0 1 9 0M22 8v2M22 14v2"/>'),
  u: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>'),
  d: svg('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>'),
  h: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  ok: svg('<path d="M5 12l5 5L20 7"/>'),
  back: svg('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
  rf: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>'),
  out: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  user: '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#5d5a66"/><circle cx="12" cy="9.5" r="4" fill="#e9e6f0"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0a12 12 0 0 1-15 0z" fill="#e9e6f0"/></svg>',
};
ICON.m = ICON.l;
const avatar = (px) => { const u = auth.currentUser?.photoURL; return u ? `<img class="avatar" style="width:${px}px;height:${px}px" src="${esc(u)}" referrerpolicy="no-referrer" alt="">` : `<span class="avatar" style="width:${px}px;height:${px}px">${ICON.user}</span>`; };
function shell(inner, active) {
  const dev = me.role === "dev";
  const sig = [me.id, me.funcao, me.name, org.name, logoUrl].join("|");
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
    ${canNew() ? nav("#/central/novo", "Novo protocolo", "n") : ""}${dev ? "" : nav("#/central/protocolos", "Protocolos", "l", "nb-prot")}${dev ? "" : nav("#/historico", "Histórico", "h")}${me.step === 3 ? nav("#/central/contatos", "Contatos", "ct") : ""}${dev ? nav("#/central/usuarios", "Usuários", "u") + nav("#/central/dev", "Dev", "d") : ""}${nav("#/config", "Configurações", "c")}</nav></aside>
    <main class="fade">${inner}</main></div></div>`;
  $("#out").onclick = logout;
  const um = $("#um"), menu = $("#umenu");
  um.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; um.setAttribute("aria-expanded", String(!menu.hidden)); };
  document.querySelectorAll("img.avatar").forEach((i) => (i.onerror = () => i.replaceWith(Object.assign(document.createElement("span"), { className: "avatar", innerHTML: ICON.user }))));
  paintBadge();
}
// Login por e-mail e senha e cadastro de novos usuários. Quem se cadastra fica sem função até o dev definir (Protocolo, Análise ou Despacho), em Usuários.
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
const STEP = { u1: "Protocolo", u2: "Análise", u3: "Despacho", sector: "Setor" };
const RS = { u2: "Com a Análise", u1: "Com o Protocolo (arquivar)", done: "Encerrada (arquivada)" };
const staff = () => me.role === "dev" || me.step > 0;
const canNew = () => me.step === 1;
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const fmtWa = (p) => (p ? `+${p.slice(0, 2)} (${p.slice(2, 4)}) ${p.slice(4, -4)}-${p.slice(-4)}` : "—");
const stageChip = (p) => p.stage === "u2" ? '<span class="chip u">Com a Análise</span>' : p.stage === "u3" ? '<span class="chip u">Com o Despacho</span>'
  : p.nrec && p.nclosed === p.nrec ? '<span class="chip respondido">Encerrado</span>' : p.nback ? '<span class="chip visualizado">Resposta em retorno</span>' : '<span class="chip recebido">Aguardando setor</span>';
const countsOf = (p, recs) => ({ ...p, nrec: recs.length, nback: recs.filter((r) => ["u2", "u1"].includes(r.return_stage) || r.replied).length, nclosed: recs.filter((r) => r.closed_at).length });
// Situação de um setor/contato: encerrado sem resposta, resposta em retorno, falha no envio ou aguardando o setor.
const recChip = (r) => r.closed_reason === "sem_resposta" ? '<span class="chip respondido">Encerrado: sem resposta</span>'
  : r.replied ? '<span class="chip visualizado">Respondeu · aguardando o Despacho</span>'
  : r.return_stage ? `<span class="chip ${r.return_stage === "done" ? "respondido" : "visualizado"}">${RS[r.return_stage]}</span>`
  : '<span class="chip recebido">Link enviado · aguardando setor</span>';
const protoFields = (id) => `<div class="frow"><div class="field"><label for="${id}n">Número do protocolo</label><input id="${id}n" required maxlength="40" autocomplete="off" placeholder="Ex.: 123/2026"></div><div class="field"><label for="${id}d">Data do protocolo</label><input id="${id}d" type="date" required value="${today()}"></div></div>`;
const commentField = (id, label = "Comentário (opcional)") => `<div class="field"><label for="${id}c">${label}</label><textarea id="${id}c" maxlength="5000"></textarea></div>`;
const confirmDo = (text, fn) => dialog(`<h2>Confirmar</h2><p>${text}</p>`, { ok: "Confirmar", onOk: fn });
const prevBox = (x, label) => x ? `<div class="msg"><small>${label}: <b>${esc(x.author || STEP[x.holder])}</b> · ${fmt(x.exited_at)}${x.out_number ? ` · protocolo ${esc(x.out_number)} de ${fmtDay(x.out_date)}` : ""}</small>${x.comment ? `<div style="white-space:pre-wrap">${esc(x.comment)}</div>` : ""}</div>` : "";
const waText = (subject, link) => `Olá! ${org.name} enviou um documento: ${subject}.\nAcesse pelo link (válido por 7 dias) e, se precisar, responda por lá:\n${link}`;

// Uma passagem do documento (histórico de movimentações). Protocolo na ida: a entrada é a data do protocolo; nos demais, a data do recebimento.
// O "setor" é externo: a ida é o link enviado pelo Despacho e a volta é a resposta registrada por ele.
function stepLi(st, p, sectorName, files = [], ctx = {}) {
  const person = st.author || st.viewer, u1 = st.holder === "u1" && st.leg === "ida", sec = st.holder === "sector", back = st.leg === "volta";
  const lines = [];
  if (u1) lines.push(`Entrada (data do protocolo): ${fmtDay(p.entry_date)}${p.entry_time ? " às " + esc(p.entry_time) : ""}`);
  else if (sec && !back) lines.push(`Link enviado em ${fmt(st.entered_at)}`);
  else if (st.entered_at) lines.push(`Chegou em ${fmt(st.entered_at)}`);
  if (!sec && !st.viewed_at && st.entered_at && !st.exited_at) lines.push("Aguardando recebimento"); // "Chegou em" já indica o recebimento
  if (sec && !back) lines.push(st.viewed_at ? `Recebido pelo destinatário em ${fmt(st.viewed_at)} (link aberto)` : !st.exited_at ? "Aguardando o destinatário abrir o link" : "");
  if (sec && !back && !st.exited_at) lines.push("Aguardando o retorno do setor");
  // No card contínuo do setor, a saída do link só aparece quando o envio foi encerrado sem resposta (se houve resposta, o passo seguinte mostra).
  const quietExit = sec && !back && !ctx.noReply;
  if (st.exited_at && !quietExit) lines.push(`${ctx.last ? "Arquivado em" : sec && back ? "Resposta recebida em" : sec ? "Encerrado sem resposta em" : st.holder === "u1" && back ? "Arquivado em" : "Encaminhado em"} ${fmt(st.exited_at)}`);
  if (sec && person && st.exited_at && !quietExit) lines.push(`Registrado por ${esc(person)}`);
  const rp = ctx.reply; // resposta do setor: entra no mesmo tópico do envio
  if (rp) { lines.push(`Resposta recebida em ${fmt(rp.exited_at)}`); if (rp.author) lines.push(`Registrado por ${esc(rp.author)}`); }
  const att = files.filter((f) => f.step_id === st.id || (rp && f.step_id === rp.id));
  if (rp) st = { ...st, comment: rp.comment, out_number: rp.out_number, out_date: rp.out_date };
  const done = !!st.exited_at, cur = !done && (!!st.entered_at || u1);
  return `<li class="${done ? "done" : cur ? "cur" : "wait"}"><span class="dot">${done ? ICON.ok : ""}</span><div><b>${sec ? esc(sectorName || "Setor") : STEP[st.holder]}${!sec && person ? ` · <span class="who2">${esc(person)}</span>` : ""}</b>${lines.filter(Boolean).map((l) => `<div class="when">${l}</div>`).join("")}${st.out_number ? `<div class="when">Protocolo registrado: <b>${esc(st.out_number)}</b> de ${fmtDay(st.out_date)}</div>` : ""}${att.length ? `<div class="when">Anexo(s): ${att.map((f) => esc(f.file_name)).join("; ")}</div>` : ""}${st.comment ? `<div class="msg"><div style="white-space:pre-wrap">${esc(st.comment)}</div></div>` : ""}</div></li>`;
}
const stepsPanel = (title, list, p, sectorName, files) => list.length ? `<section class="panel"><h2>${title}</h2><ol class="stp">${list.map((x) => stepLi(x, p, sectorName, files)).join("")}</ol></section>` : "";
// Card único por setor: link enviado → resposta → Despacho → Análise/Protocolo → encerramento, em uma linha do tempo contínua.
function sectorPanel(r, list, p, files) {
  const noReply = r.closed_reason === "sem_resposta";
  const lastId = r.closed_at && !noReply ? list.filter((x) => x.leg === "volta" && x.exited_at).pop()?.id : null;
  const reply = list.find((x) => x.holder === "sector" && x.leg === "volta");
  const items = list.filter((x) => x !== reply).map((x) => stepLi(x, p, r.sector, files, { noReply, last: x.id === lastId, reply: x.holder === "sector" && x.leg === "ida" ? reply : null })).join("");
  const end = r.closed_at ? `<li class="done"><span class="dot">${ICON.ok}</span><div><b>Encerrado e arquivado</b><div class="when">${noReply ? "Encerrado sem resposta do setor" : "Ciclo do setor encerrado"} em ${fmt(r.closed_at)}</div></div></li>` : "";
  return `<section class="panel"><h2>${esc(r.sector)} ${recChip(r)}</h2><ol class="stp">${items}${end}</ol></section>`;
}

// Links gerados pelo Despacho: copiar e enviar pelo WhatsApp.
function showLinks(results, subject) {
  const ok = results.filter((r) => r.sent), bad = results.filter((r) => !r.sent);
  const m = dialog(`<h2>Link gerado${ok.length > 1 ? "s" : ""} (válido por 7 dias)</h2>
    <ul class="rs">${ok.map((r, i) => `<li><b>${esc(r.name)}</b><div class="field"><input readonly value="${esc(r.link)}" data-lk="${i}"></div><div class="acts2"><button class="btn sm" data-wa="${i}">${r.whatsapp ? "Enviar por WhatsApp (" + esc(fmtWa(r.whatsapp)) + ")" : "Enviar por WhatsApp"}</button><button class="btn sec sm" data-cp="${i}">Copiar link</button></div></li>`).join("")}</ul>
    ${bad.map((r) => `<div class="exwarn">${esc(r.name)}: ${esc(r.error)}</div>`).join("")}`);
  m.querySelectorAll("[data-wa]").forEach((b) => (b.onclick = () => { const r = ok[+b.dataset.wa]; sendWhatsApp(r.whatsapp || "", waText(subject, r.link)); }));
  m.querySelectorAll("[data-cp]").forEach((b) => (b.onclick = async () => { const r = ok[+b.dataset.cp]; try { await navigator.clipboard.writeText(r.link); toast("Link copiado"); } catch { m.querySelector(`[data-lk="${b.dataset.cp}"]`).select(); document.execCommand("copy"); toast("Link copiado"); } }));
}

const views = {
  async config() {
    const F = { dev: "Dev", user1: "Protocolo", user2: "Análise", user3: "Despacho", nenhuma: "Sem função" }, dev = me.role === "dev";
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
    shell(`<h1>Configurações</h1><div class="cfg"><div class="panel"><h2>Meus dados</h2>${profileFields()}<p class="muted">E-mail: ${esc(me.email)}<br>Função: <b>${F[me.funcao] || "Sem função"}</b> (definida pelo administrador)<br>Organização: <b>${esc(org.name)}</b></p><button class="btn" id="sv">Salvar dados</button></div>
      <div class="panel"><h2>Alterar senha</h2><form id="pwf" novalidate><div class="field"><label for="pw0">Senha atual</label><input id="pw0" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="pw1">Nova senha (mínimo 6 caracteres)</label><input id="pw1" type="password" autocomplete="new-password"></div>
      <div class="field"><label for="pw2">Repita a nova senha</label><input id="pw2" type="password" autocomplete="new-password"></div><button class="btn" id="pw">Alterar senha</button></form></div>${orgPanel ? `<div class="wide">${orgPanel}</div>` : ""}</div>`, "c");
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
      if ($("#lgd")) $("#lgd").onclick = guard(async () => { await api("/api/org/logo", { method: "DELETE" }); org.has_logo = false; await loadLogo(); toast("Logotipo removido"); route(); });
      $("#invc").onclick = guard(async () => { try { await navigator.clipboard.writeText(o.invite_code); } catch { /* sem permissão */ } toast("Código copiado"); });
      $("#invn").onclick = () => confirmDo("Gerar um novo código? O código atual deixa de funcionar para novos cadastros.", async () => { await api("/api/org/invite", { method: "POST" }); toast("Novo código gerado"); route(); });
    }
  },
  // Histórico: somente movimentações (entrada, encaminhamentos, envio ao setor, resposta e arquivamento).
  async historico(id) {
    if (!id) return staffList("Histórico", "h", true);
    const d = await api("/api/protocols/" + id + "?h=1"), p = d.protocol, recs = d.recipients;
    const head = `<h1>${esc(p.protocol_number)} — ${esc(p.subject)}</h1><p class="muted">${stageChip(countsOf(p, recs))}${p.closed_at ? ` &nbsp; Ato encerrado em ${fmt(p.closed_at)}` : ""}</p>`;
    const body = stepsPanel("Tramitação interna: Protocolo → Análise → Despacho", d.steps.filter((x) => !x.recipient_id), p, "", d.files) + recs.map((r) => sectorPanel(r, d.steps.filter((x) => x.recipient_id === r.rid), p, d.files)).join("");
    shell(`<div class="hhead"><a class="backbtn" href="#/historico" title="Voltar ao histórico" aria-label="Voltar ao histórico">${ICON.back}</a><div>${head}</div></div><div class="hist">${body || `<div class="panel empty">Sem movimentações registradas.</div>`}</div>`, "h");
    poll();
  },
  async protocolos() { await staffList("Protocolos", "l"); },
  // Novo protocolo: exclusivo do Protocolo. Sobe o PDF, registra protocolo e data e encaminha à Análise.
  async novo() {
    shell(`<h1>Novo protocolo</h1><form class="panel" id="f"><div class="frow3"><div class="field"><label for="pn">Número do protocolo</label><input id="pn" required maxlength="40" autocomplete="off" placeholder="123/2026"></div><div class="field"><label for="po">Nº do ofício</label><input id="po" maxlength="40" autocomplete="off" placeholder="Ex.: 45/2026"></div><div class="field"><label for="pd">Data</label><input id="pd" type="date" required value="${today()}"></div><div class="field"><label for="pt">Hora</label><input id="pt" type="time" required value="${new Date().toTimeString().slice(0, 5)}"></div></div><div class="field"><label for="s">Assunto</label><input id="s" required maxlength="200"></div>
    <div class="field"><label for="d">Descrição</label><textarea id="d" maxlength="5000"></textarea></div>
    ${pdfField("a", "PDF do documento (pode anexar mais de um)", { multiple: true, required: true })}
    <p class="muted">Ao enviar, o documento é encaminhado à Análise. Os PDFs ficam guardados na nuvem e acompanham o ato até o encerramento.</p>
    <button class="btn">Enviar à Análise</button></form>`, "n");
    $("#f").onsubmit = (e) => {
      e.preventDefault();
      confirmDo("Encaminhar este protocolo à Análise? Essa ação não pode ser desfeita.", async () => {
        const file_ids = await uploadFiles($("#a"));
        if (!file_ids.length) throw new Error("Anexe o PDF do documento");
        const r = await api("/api/protocols", { method: "POST", body: { protocol_number: $("#pn").value, entry_date: $("#pd").value, entry_time: $("#pt").value, oficio_number: $("#po").value, subject: $("#s").value, description: $("#d").value, file_ids } });
        toast("Protocolo enviado à Análise: " + r.protocol_number); location.hash = "#/central/protocolos";
      });
    };
  },
  // Contatos: agenda dos setores (externos ao sistema) com e-mail e WhatsApp, usada pelo Despacho no envio.
  async contatos() {
    const list = await api("/api/contacts");
    shell(`<h1>Contatos dos setores</h1><p class="muted">Os setores ficam fora do sistema: o Despacho gera um link do documento e envia pelo WhatsApp para os contatos cadastrados aqui.</p>
    <form class="panel filters" id="f" style="grid-template-columns:1.4fr 1fr auto"><div><label for="n">Setor / contato</label><input id="n" required maxlength="120"></div><div><label for="w">WhatsApp (com DDD) — usado no envio</label><input id="w" inputmode="tel" placeholder="(92) 99999-9999"></div><button class="btn">Cadastrar</button></form>
    <div class="wrap"><table><tr><th>Setor / contato</th><th>WhatsApp</th><th>Atos enviados</th><th>Situação</th><th></th></tr>${list.map((c) => `<tr><td>${esc(c.name)}</td><td class="nw">${esc(fmtWa(c.whatsapp))}</td><td>${c.used}</td><td>${c.active ? "Ativo" : "Desativado"}</td><td><button class="btn sec sm" data-e="${c.id}">Editar</button></td></tr>`).join("") || `<tr><td colspan="5" class="empty">Nenhum contato cadastrado.</td></tr>`}</table></div>`, "ct");
    $("#f").onsubmit = guard(async (e) => { e.preventDefault(); await api("/api/contacts", { method: "POST", body: { name: $("#n").value, whatsapp: $("#w").value } }); toast("Contato cadastrado"); route(); });
    document.querySelectorAll("[data-e]").forEach((b) => (b.onclick = () => {
      const c = list.find((x) => x.id == b.dataset.e);
      dialog(`<h2>Editar contato</h2><div class="field"><label>Setor / contato</label><input id="m1" value="${esc(c.name)}"></div><div class="field"><label>WhatsApp (com DDD)</label><input id="m4" value="${esc(c.whatsapp || "")}"></div><label class="checks"><span><input type="checkbox" id="m3" ${c.active ? "checked" : ""}> Ativo (aparece para envio)</span></label>`, { ok: "Salvar", onOk: async () => {
        await api("/api/contacts/" + c.id, { method: "PUT", body: { name: $("#m1").value, whatsapp: $("#m4").value, active: $("#m3").checked } }); toast("Contato salvo"); route();
      } });
    }));
  },
  async usuarios() {
    if (me.role !== "dev") return (location.hash = "#/central/protocolos");
    const users = await api("/api/users");
    const F = { dev: "Dev", user1: "Protocolo", user2: "Análise", user3: "Despacho", nenhuma: "Sem função" };
    shell(`<h1>Usuários</h1><p class="muted">Cada pessoa se cadastra com e-mail e senha e entra na organização com o código de convite (veja em Configurações), ficando <b>sem função</b>. Aqui você define Protocolo, Análise ou Despacho e bloqueia acessos. Só existe um Dev: quem fez o primeiro acesso. Quem mudar de função precisa atualizar a página.</p>
    <div class="wrap"><table><tr><th>Nome</th><th>E-mail</th><th>Função</th><th>Acesso</th><th></th></tr>${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${F[u.funcao] || "Sem função"}</td><td>${u.active ? "Ativo" : "Bloqueado"}</td><td class="nw"><button class="btn sec sm" data-u="${u.id}">Editar</button>${u.id !== me.id ? ` <button class="btn sec sm" data-del="${u.id}">Excluir</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">Nenhum usuário.</td></tr>`}</table></div>`, "u");
    document.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => {
      const u = users.find((x) => x.id == b.dataset.del);
      confirmDo(`Excluir o usuário <b>${esc(u.name)}</b>? Se ele tiver movimentações no histórico, a exclusão será recusada (nesse caso, bloqueie o acesso).`, async () => { await api("/api/users/" + u.id, { method: "DELETE" }); toast("Usuário excluído"); route(); });
    }));
    document.querySelectorAll("[data-u]").forEach((b) => (b.onclick = () => {
      const u = users.find((x) => x.id == b.dataset.u), self = u.id === me.id;
      dialog(`<h2>${esc(u.name)}</h2><div class="field"><label for="ust">Função</label><select id="ust" ${self ? "disabled" : ""}><option value="nenhuma">Sem função</option>${[["user1", "Protocolo — Upload, protocolo inicial e encaminhamento"], ["user2", "Análise — Análise, comentários e encaminhamento"], ["user3", "Despacho — Anotação, envio ao setor por e-mail e registro da resposta"], ["dev", "Dev — acesso total (único)"]].filter(([v]) => v !== "dev" || u.funcao === "dev").map(([v, t]) => `<option value="${v}" ${u.funcao === v ? "selected" : ""}>${t}</option>`).join("")}</select></div><label class="checks"><span><input type="checkbox" id="ua" ${u.active ? "checked" : ""}> Acesso ao sistema ativo</span></label>`, { ok: "Salvar", onOk: async () => {
        await api("/api/users/" + u.id, { method: "PUT", body: { active: $("#ua").checked, role: $("#ust").value } });
        toast("Alterações salvas. A pessoa precisa atualizar a página."); route();
      } });
    }));
  },
  // Dev: limpeza de dados (ações permanentes).
  async dev() {
    if (me.role !== "dev") return (location.hash = "#/central/protocolos");
    const ops = [["contatos", "Apagar todos os contatos"], ["usuarios", "Apagar todos os usuários (menos o seu)"], ["tudo", "Apagar tudo: protocolos, contatos e usuários (menos o seu)"]];
    const F = { dev: "Dev", user1: "Protocolo", user2: "Análise", user3: "Despacho", nenhuma: "Sem função" };
    const wusers = await api("/api/users");
    shell(`<h1>Dev · Limpeza de dados</h1><p class="muted">Ações permanentes e sem volta. Para confirmar, digite APAGAR. Usuários apagados podem se cadastrar de novo; para remover também a conta de login, apague-a no Firebase (Authentication → Users). Excluir um protocolo isolado é feito na tela do próprio protocolo.</p>
    <div class="panel"><h2>Apagar protocolos (com arquivos e históricos)</h2>
      <div class="frow3" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div class="field"><label for="wy">Ano</label><select id="wy"><option value="">Todos</option></select></div>
      <div class="field"><label for="wm">Mês</label><select id="wm"><option value="">Todos</option>${["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"].map((m, i) => `<option value="${String(i + 1).padStart(2, "0")}">${m}</option>`).join("")}</select></div>
      <div class="field"><label for="wu">Usuário (que criou ou atuou)</label><select id="wu"><option value="">Todos</option>${wusers.map((u) => `<option value="${u.id}">${esc(u.name)} · ${F[u.funcao] || "Sem função"}</option>`).join("")}</select></div></div>
      <div class="drow"><span id="wcount" class="muted">Contando…</span><button class="btn sec sm" id="wgo" disabled>Apagar protocolos</button></div></div>
    <div class="panel">${ops.map(([k, t]) => `<div class="drow"><span>${t}</span><button class="btn sec sm" data-w="${k}">Apagar</button></div>`).join("")}</div>`, "d");
    const filt = () => ({ year: $("#wy").value, month: $("#wm").value, user_id: $("#wu").value });
    const count = guard(async () => {
      const r = await api("/api/dev/wipe", { method: "POST", body: { scope: "protocolos", dry: true, ...filt() } });
      if (!$("#wy").dataset.ok) { $("#wy").dataset.ok = 1; r.years.forEach((y) => $("#wy").insertAdjacentHTML("beforeend", `<option>${y}</option>`)); }
      $("#wcount").textContent = r.count ? `${r.count} protocolo(s) serão apagados.` : "Nenhum protocolo com esse filtro."; $("#wgo").disabled = !r.count;
    });
    ["wy", "wm", "wu"].forEach((id) => ($("#" + id).onchange = count)); count();
    $("#wgo").onclick = () => dialog(`<h2>Apagar protocolos</h2><p>${esc($("#wcount").textContent)} Essa ação não pode ser desfeita. Digite <b>APAGAR</b> para confirmar.</p><div class="field"><input id="wc" autocomplete="off"></div>`, { ok: "Apagar definitivamente", onOk: async () => {
      if ($("#wc").value.trim() !== "APAGAR") throw new Error("Digite APAGAR para confirmar");
      await api("/api/dev/wipe", { method: "POST", body: { scope: "protocolos", confirm: "APAGAR", ...filt() } }); toast("Protocolos apagados"); route();
    } });
    document.querySelectorAll("[data-w]").forEach((b) => (b.onclick = () => {
      const k = b.dataset.w, t = ops.find((o) => o[0] === k)[1];
      dialog(`<h2>${t}</h2><p>Essa ação não pode ser desfeita. Digite <b>APAGAR</b> para confirmar.</p><div class="field"><input id="wc" autocomplete="off"></div>`, { ok: "Apagar definitivamente", onOk: async () => {
        if ($("#wc").value.trim() !== "APAGAR") throw new Error("Digite APAGAR para confirmar");
        await api("/api/dev/wipe", { method: "POST", body: { scope: k, confirm: "APAGAR" } }); toast("Dados apagados"); route();
      } });
    }));
  },
  // Painel do protocolo: documento, ação da etapa (Análise/Despacho/Protocolo) e situação de cada setor/contato.
  async protocolo(pid) {
    const [d, cts] = await Promise.all([api("/api/protocols/" + pid), api("/api/contacts")]);
    contacts = cts;
    const { protocol: p, steps, files, shares } = d, dev = me.role === "dev";
    const recs = d.recipients.map((r) => ({ ...r, replied: !r.closed_at && !r.return_stage && shares.some((sh) => sh.recipient_id === r.rid && sh.replied_at), share: shares.filter((sh) => sh.recipient_id === r.rid).pop() }));

    const s = me.step || (dev ? { u2: 2, u3: 3 }[p.stage] || 0 : 0), can3 = me.step === 3 || dev;
    const orig = files.filter((f) => !f.recipient_id);
    const mineFwd = (s === 2 || s === 3) && p.stage === "u" + s;
    const prev = steps.filter((x) => !x.recipient_id && x.leg === "ida" && x.exited_at).pop();
    const active = cts.filter((c) => c.active);
    const ctList = (list, name) => list.length ? `<div class="checks">${list.map((c) => `<label><input type="checkbox" name="${name}" value="${c.id}"><span class="ctx"><b>${esc(c.name)}</b><small class="muted">${c.whatsapp ? "WhatsApp " + esc(fmtWa(c.whatsapp)) : "sem WhatsApp (você escolhe o contato ao enviar)"}</small></span></label>`).join("")}</div>` : `<p class="muted">Nenhum contato ativo. ${me.step === 3 ? `Cadastre na aba <a href="#/central/contatos">Contatos</a>.` : "O Despacho cadastra os contatos."}</p>`;


    const fwd = mineFwd ? (s === 2
      ? `<div class="panel act"><h2>Análise e encaminhamento ao Despacho</h2>${prevBox(prev, "Recebido de")}<form id="ff"><div class="field"><label for="fs">Assunto</label><input id="fs" required maxlength="200"></div><div class="field"><label for="fd">Descrição</label><textarea id="fd" maxlength="5000"></textarea></div><p class="muted">O assunto e a descrição abaixo serão vistos somente pelo Despacho.</p><button class="btn">Encaminhar ao Despacho</button></form></div>`
      : `<div class="panel act"><h2>Documento a enviar ao setor</h2>${prevBox(prev, "Recebido de")}<form id="ff"><div class="field"><label for="fs">Assunto</label><input id="fs" required maxlength="200" autocomplete="off"></div>
        <div class="field"><label for="fd">Descrição</label><textarea id="fd" maxlength="5000" placeholder="Ex.: Favor responder em até 10 dias."></textarea></div>
        <div class="field"><label>Documentos que seguem no link</label>
          <label class="chk"><input type="checkbox" id="fip" ${orig.some((f) => f.holder === "u1") ? "" : "disabled"}> Documento do Protocolo (${orig.filter((f) => f.holder === "u1").length} PDF)</label>
          <label class="chk"><input type="checkbox" id="fid" checked> Documento do Despacho (anexar abaixo)</label></div>
        <div id="fdw">${pdfField("ffa", "PDF do Despacho (pode anexar mais de um)", { multiple: true })}</div>
        <div class="field"><label>Enviar para (setor / contato)</label>${ctList(active, "fct")}</div>
        <p class="muted">Ao finalizar, o sistema cria um link com o documento, válido por 7 dias, para você enviar pelo WhatsApp. O setor pode responder pela mesma página.</p>
        <button class="btn">Finalizar e gerar link</button></form></div>`) : "";
    const back = recs.filter((r) => ["u1", "u2"].includes(r.return_stage) && (dev || r.return_stage === "u" + me.step)).map((r) => {
      const rs = +r.return_stage.slice(1), reply = steps.filter((x) => x.recipient_id === r.rid && x.leg === "volta" && x.holder === "sector").pop(), last = steps.filter((x) => x.recipient_id === r.rid && x.leg === "volta" && x.exited_at).pop();
      return `<div class="panel act"><h2>Resposta de ${esc(r.sector)} — ${rs === 1 ? "receber e arquivar" : "arquivar"}</h2>${prevBox(last, rs === 2 ? "Resposta registrada por" : "Recebido de")}${fileList(files.filter((f) => reply && f.step_id === reply.id))}<form data-ret="${r.rid}" data-s="${rs}">${commentField("r" + r.rid, "Descrição")}<button class="btn">${rs === 1 ? "Receber e arquivar" : "Arquivar"}</button></form></div>`;
    }).join("");
    const rows = recs.map((r) => {
      const open = r.sent_at && !r.closed_at && !r.return_stage && !r.replied;
      const acts = can3 && open ? `<button class="btn sm" data-lk="${r.rid}">Link / WhatsApp</button>` : "";
      const exp = r.share ? `<div class="muted">${new Date(r.share.expires_at) < new Date() ? "Link expirado em " : "Link válido até "}${fmt(r.share.expires_at)}</div>` : "";
      return `<tr><td>${esc(r.sector)}${r.whatsapp ? `<div class="muted">${esc(fmtWa(r.whatsapp))}</div>` : ""}</td><td>${two(r.sent_at)}</td><td>${recChip(r)}${open ? exp : ""}</td>${can3 ? `<td><div class="acts3">${acts}</div></td>` : ""}</tr>`;
    }).join("");
    const rpl = can3 ? recs.filter((r) => r.replied).map((r) => {
      const reply = steps.filter((x) => x.recipient_id === r.rid && x.leg === "volta" && x.holder === "sector").pop();
      return `<div class="panel act"><h2>Resposta de ${esc(r.sector)}</h2><div class="msg"><small><b>${esc(r.share.reply_name)}</b> · ${fmt(r.share.replied_at)}</small>${r.share.reply_text ? `<div style="white-space:pre-wrap">${esc(r.share.reply_text)}</div>` : ""}</div>${fileList(files.filter((f) => reply && f.step_id === reply.id))}
        <form data-rt="${r.rid}">${commentField("t" + r.rid, "Descrição")}<div class="acts2"><button class="btn" data-to="done">Arquivar</button><button class="btn sec" data-to="u2">Encaminhar à Análise</button></div></form></div>`;
    }).join("") : "";
    const secs = recs.length ? `<div class="panel"><h2>Setores / contatos</h2><div class="wrap"><table><tr><th>Setor / contato</th><th>Link enviado em</th><th>Situação</th>${can3 ? "<th>Ações do Despacho</th>" : ""}</tr>${rows}</table></div>${can3 ? `<p class="muted">Quando o setor responde pelo link, a resposta aparece aqui para você encaminhar.</p>` : ""}</div>` : "";
    const others = active.filter((c) => !recs.some((r) => r.contact_id === c.id));
    const more = can3 && p.stage === "sector" && others.length ? `<div class="panel"><h2>Enviar a outro setor</h2><form id="mf"><div class="field">${ctList(others, "mct")}</div><p class="muted">Será enviado o mesmo documento (novo link para cada setor).</p><button class="btn">Gerar link</button></form></div>` : "";
    const rep = recs.map((r) => ({ r, list: steps.filter((x) => x.recipient_id === r.rid && x.leg === "volta" && x.holder === "sector") })).filter((x) => x.list.length);
    const reps = rep.length ? `<div class="panel"><h2>Respostas dos setores</h2>${rep.map(({ r, list }) => list.map((x) => `<div class="msg adm"><small><b>${esc(r.sector)}</b> · registrada por ${esc(x.author || "")} · ${fmt(x.exited_at)}${x.out_number ? ` · protocolo ${esc(x.out_number)} de ${fmtDay(x.out_date)}` : ""}</small>${x.comment ? `<div style="white-space:pre-wrap">${esc(x.comment)}</div>` : ""}${fileList(files.filter((f) => f.step_id === x.id))}</div>`).join("")).join("")}</div>` : "";
    shell(`<p><a class="backbtn" href="#/central/protocolos" title="Voltar à lista" aria-label="Voltar à lista">${ICON.back}</a></p><h1>${esc(p.protocol_number)} — ${esc(p.subject)}</h1>
    <div class="panel"><p><b>Ato administrativo nº ${esc(p.protocol_number)}</b> &nbsp; ${stageChip(countsOf(p, recs))}</p>${p.closed_at ? `<p class="exwarn ok">Ato administrativo encerrado em ${fmt(p.closed_at)}.</p>` : ""}<p class="muted">Protocolado em ${fmtDay(p.entry_date)}${p.entry_time ? " às " + esc(p.entry_time) : ""}${p.oficio_number ? " · Ofício nº " + esc(p.oficio_number) : ""}</p><p style="white-space:pre-wrap">${esc(p.description)}</p><h2 class="sech">Documento e anexos</h2>${fileList(orig) || '<p class="muted">Sem arquivos.</p>'}<p><a class="btn sec sm" style="text-decoration:none" href="#/historico/${p.id}">Ver histórico de movimentações</a> ${dev ? `<button class="btn sec sm" id="dp">Excluir protocolo</button>` : ""}</p></div>
    ${fwd}${rpl}${back}${secs}${more}${reps}`, "l");
    bindFiles($("main")); poll();
    if ($("#dp")) $("#dp").onclick = () => confirmDo("Excluir este protocolo, os arquivos e o histórico definitivamente? Não dá para desfazer.", async () => { await api("/api/protocols/" + pid, { method: "DELETE" }); toast("Protocolo excluído"); location.hash = "#/central/protocolos"; });
    const afterSend = (r) => { route(); showLinks(r.results, r.subject || p.subject); };
    if ($("#fid")) $("#fid").onchange = () => { $("#fdw").hidden = !$("#fid").checked; };
    if ($("#ff")) $("#ff").onsubmit = (e) => {
      e.preventDefault();
      const ids = s === 3 ? [...document.querySelectorAll("[name=fct]:checked")].map((c) => +c.value) : [];
      if (s === 3 && !ids.length) return toast("Selecione ao menos um setor/contato", true);
      confirmDo(s === 2 ? "Encaminhar ao Despacho? Essa ação não pode ser desfeita." : `Finalizar e gerar o link para ${ids.length} setor(es)? Essa ação não pode ser desfeita.`, async () => {
        if (s === 2) { await api(`/api/protocols/${pid}/forward`, { method: "POST", body: { subject: $("#fs").value, description: $("#fd").value } }); poll(); toast("Encaminhado ao Despacho"); location.hash = "#/central/protocolos"; return; }
        const file_ids = $("#fid").checked ? await uploadFiles($("#ffa")) : [];
        if (!file_ids.length && !$("#fip").checked) throw new Error("Marque o documento do Protocolo ou anexe o PDF do Despacho");
        const subject = $("#fs").value;
        const r = await api(`/api/protocols/${pid}/forward`, { method: "POST", body: { subject, description: $("#fd").value, include_protocol: $("#fip").checked, file_ids, contact_ids: ids } });
        poll(); afterSend({ ...r, subject });
      });
    };
    if ($("#mf")) $("#mf").onsubmit = (e) => {
      e.preventDefault();
      const ids = [...document.querySelectorAll("[name=mct]:checked")].map((c) => +c.value);
      if (!ids.length) return toast("Selecione ao menos um setor/contato", true);
      confirmDo(`Gerar o link do documento para ${ids.length} setor(es)?`, async () => {
        afterSend(await api(`/api/protocols/${pid}/send`, { method: "POST", body: { contact_ids: ids } }));
      });
    };
    document.querySelectorAll("button[data-lk]").forEach((b) => (b.onclick = guard(async () => {
      const r = recs.find((x) => x.rid == b.dataset.lk), sh = r.share;
      let link = sh && new Date(sh.expires_at) > new Date() ? sh.link : null;
      if (!link) { link = (await api(`/api/recipients/${r.rid}/link`, { method: "POST" })).link; route(); }
      showLinks([{ sent: true, name: r.sector, whatsapp: r.whatsapp, link }], sh?.subject || p.subject);
    })));
    document.querySelectorAll("form[data-rt] button[data-to]").forEach((b) => (b.onclick = (e) => {
      e.preventDefault();
      const rid = b.closest("form").dataset.rt, to = b.dataset.to;
      confirmDo(to === "done" ? "Arquivar esta resposta? O ciclo deste setor será encerrado." : "Encaminhar a resposta à Análise?", async () => {
        await api(`/api/recipients/${rid}/route`, { method: "POST", body: { to, comment: $("#t" + rid + "c").value } });
        toast(to === "done" ? "Resposta arquivada" : "Resposta encaminhada"); poll(); route();
      });
    }));
    document.querySelectorAll("[data-resp]").forEach((b) => (b.onclick = () => {
      const r = recs.find((x) => x.rid == b.dataset.resp);
      dialog(`<h2>Setor respondeu — ${esc(r.sector)}</h2><p class="muted">Anexe o PDF recebido (por outro meio, fora do link). A resposta segue à Análise e depois ao Protocolo, que arquiva.</p>${commentField("x")}${pdfField("xf", "PDF da resposta", { multiple: true, required: true })}`, { ok: "Registrar resposta", onOk: async () => {
        const file_ids = await uploadFiles($("#xf"));
        if (!file_ids.length) throw new Error("Anexe o PDF da resposta");
        await api(`/api/recipients/${r.rid}/response`, { method: "POST", body: { comment: $("#xc").value, file_ids } }); toast("Resposta registrada e encaminhada à Análise"); poll(); route();
      } });
    }));
    document.querySelectorAll("[data-ret]").forEach((f) => (f.onsubmit = (e) => {
      e.preventDefault(); const id = f.dataset.ret, rs = +f.dataset.s, body = { comment: $("#r" + id + "c").value };
      confirmDo("Arquivar a resposta? O ciclo deste setor será encerrado.", async () => {
        await api(`/api/recipients/${id}/advance`, { method: "POST", body });
        toast("Resposta arquivada"); poll(); route();
      });
    }));
  },
};

// Lista de protocolos (por ato administrativo).
async function staffList(title, active, hist = false) {
  const ETAPAS = [["mine", "Aguardando minha ação"], ["u2", "Com a Análise"], ["u3", "Com o Despacho"], ["sector", "Aguardando setor"], ["volta", "Resposta em retorno"], ["done", "Encerrados"]];
  contacts = await api("/api/contacts");
  shell(`<h1>${title}</h1><form class="panel filters c" id="ff"><div><label for="q">Número ou assunto</label><input id="q"></div>
    <div><label for="sc">Setor / contato</label><select id="sc"><option value="">Todos</option>${contacts.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>
    <div><label for="et">Etapa</label><select id="et"><option value="">Todas</option>${ETAPAS.filter((e) => e[0] !== "mine" || me.step).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
    <div><label for="fr">De</label><input id="fr" type="date"></div><div><label for="to">Até</label><input id="to" type="date"></div><button class="btn">Pesquisar</button></form><div id="res"></div>`, active);
  const load = guard(async (page = 1) => {
    const q = new URLSearchParams({ q: $("#q").value, etapa: $("#et").value, from: $("#fr").value, to: $("#to").value, page });
    if ($("#sc").value) q.set("contact_id", $("#sc").value);
    const { rows, total, pages, page: cur } = await api("/api/protocols?" + q);
    const pager = total > 50 ? `<div class="pager"><button class="btn sec sm" data-pg="${cur - 1}" ${cur <= 1 ? "disabled" : ""}>Anterior</button><span>Página ${cur} de ${pages} · ${total} protocolos</span><button class="btn sec sm" data-pg="${cur + 1}" ${cur >= pages ? "disabled" : ""}>Próxima</button></div>` : "";
    $("#res").innerHTML = `<div class="wrap"><table><tr><th>Ato (nº do protocolo)</th><th>Assunto</th><th>Entrada</th><th>Situação</th><th></th></tr>${rows.map((r) => `<tr class="${r.mine ? "new" : ""}"><td class="num">${esc(r.protocol_number)}${r.mine ? `<br><span class="newb">Aguardando você</span>` : ""}</td><td class="subj">${esc(r.subject)}</td><td class="nw">${fmtDay(r.entry_date)}</td><td>${stageChip(r)}</td><td class="nw"><a class="btn sec sm" style="text-decoration:none" href="#/${hist ? "historico" : "protocolo"}/${r.pid}">${hist ? "Ver histórico" : "Abrir"}</a></td></tr>`).join("") || `<tr><td colspan="5" class="empty">Nenhum protocolo encontrado.</td></tr>`}</table></div>${pager}`;
    document.querySelectorAll("[data-pg]").forEach((b) => (b.onclick = () => { load(+b.dataset.pg); window.scrollTo({ top: 0 }); }));
  });
  $("#ff").onsubmit = (e) => { e.preventDefault(); load(1); };
  load();
}

async function route() {
  if (!me || !staff()) return;
  routeGen++;
  const h = location.hash.replace(/^#\//, "").split("/"), home = me.role === "dev" ? "#/central/usuarios" : "#/central/protocolos";
  try {
    if (!h[0]) return (location.hash = home);
    let name = h[0], arg = h[1];
    if (name === "central") { name = ["protocolos", "novo", "contatos", "usuarios", "dev"].includes(h[1]) ? h[1] : (me.role === "dev" ? "usuarios" : "protocolos"); arg = undefined; }
    if ((name === "usuarios" || name === "dev") && me.role !== "dev") return (location.hash = home);
    if (me.role === "dev" && (name === "historico" || name === "contatos" || name === "protocolos")) return (location.hash = home);
    if (name === "contatos" && me.step !== 3) return (location.hash = home);
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

// Conta criada mas ainda sem função: aguarda o dev definir (Protocolo, Análise ou Despacho).
function noRoleView() {
  clearInterval(timer);
  $("#app").innerHTML = `<div class="login"><div class="panel"><img class="mark" src="protoweb.svg" alt="" width="64" height="64"><h1>ProtoWeb</h1><p class="org-l">${esc(org.name)}</p><p>Olá, <b>${esc(me.name)}</b>! Sua conta foi criada, mas ainda <b>não tem função</b> no sistema.</p><p class="muted">Peça ao dev para definir a sua função (Protocolo, Análise ou Despacho) e depois clique em “Verificar de novo”.</p><div class="acts2" style="justify-content:center"><button class="btn" id="re">Verificar de novo</button><button class="btn sec" id="out2">Sair</button></div></div></div>`;
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

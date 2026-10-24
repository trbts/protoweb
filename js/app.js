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
const MAX_MB = 1;
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

let me = null, sectors = [], busy = 0;
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
const fileList = (files) => files.length ? `<ul>${files.map((f) => `<li><button class="link" data-file="${f.id}" data-name="${esc(f.file_name)}" data-type="${f.mime_type}">${esc(f.file_name)}</button> <span class="muted">(${Math.ceil(f.file_size / 1024)} KB)</span> · <button class="link" data-dl="${f.id}" data-name="${esc(f.file_name)}">Baixar</button></li>`).join("")}</ul>` : "";
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

// ---------- estrutura
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
  const nav = (h, t, k, b) => `<a href="${h}" data-k="${k}" class="${active === k ? "on" : ""}">${t}${b ? `<span class="nbadge" id="${b}" hidden></span>` : ""}</a>`;
  $("#app").innerHTML = `<div class="shell" data-sig="${sig}"><header class="top"><span class="brandbar"><img class="logo" src="logo.svg" alt="Brasão de Careiro"><span class="org">Prefeitura Municipal de Careiro</span><span class="tagwrap">${tag}</span></span><span class="who">${esc(me.name)} (${esc(me.email)}) <button class="link" id="out">Sair</button></span></header>
    <div class="body"><aside class="side"><nav>
    ${adm ? nav("#/central", "Painel", "p") + nav("#/central/protocolos", "Protocolos", "l", "nb-prot") + nav("#/central/novo", "Novo protocolo", "n") + nav("#/central/setores", "Setores", "s") + nav("#/central/usuarios", "Usuários", "u") : ""}
    ${adm ? "" : sectors.length > 1 ? sectors.map((x) => nav("#/setor/" + x.id, esc(x.name), "m" + x.id, "nb-s" + x.id)).join("") : nav("#/setores", "Caixa de entrada", "m", "nb-set")}${nav("#/config", "Configurações", "c")}</nav></aside>
    <main class="fade">${inner}</main></div></div>`;
  $("#out").onclick = logout;
  paintBadge();
}
const loginView = () => {
  $("#app").innerHTML = `<div class="login"><div class="panel"><h1>ProtoWeb</h1><p class="org-l">Prefeitura Municipal de Careiro</p><p class="muted">Protocolos e documentos</p><button class="btn" id="g">Entrar com Google</button></div></div>`;
  $("#g").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => toast("Não foi possível entrar: " + e.code, true));
};

// ---------- notificações
// Contadores nos cards (consulta a cada minuto) e avisos do Windows/push, controlados em Configurações.
let badge = null, sectorBadge = {}, timer = null, listening = false;
const prefKey = () => "pw_notif_" + me.id;
const pref = () => { try { return localStorage.getItem(prefKey()); } catch { return null; } };
const setPref = (v) => { try { localStorage.setItem(prefKey(), v); } catch { /* sem armazenamento */ } };
const canNotify = () => "Notification" in window;
const newLabel = (r) => (me.role === "adm" ? (r.ru ? "Nova resposta" : "") : !r.first_viewed_at ? "Novo" : r.su ? "Nova mensagem" : "");
function paintBadge() {
  const n = badge || 0, adm = me.role === "adm";
  const set = (el, v) => { if (el) { el.hidden = !v; el.textContent = v > 99 ? "99+" : v || ""; } };
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
    const { count, sectors } = await api("/api/notifications", { quiet: true });
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
    shell(`<h1>Configurações</h1><div class="panel" style="max-width:560px"><h2>Meus dados</h2>${profileFields()}<button class="btn" id="sv">Salvar dados</button></div><div class="panel"><h2>Notificações neste computador</h2>
      <p>Situação: <span class="chip ${active ? "respondido" : ""}">${state}</span></p>
      <p class="muted">${me.role === "adm" ? "Você é avisado quando um setor responde a um protocolo." : "Você é avisado quando chega um protocolo ou uma mensagem da central para o seu setor."} O aviso chega mesmo com o ProtoWeb fechado, desde que o navegador esteja em execução. Vale só para este computador e este navegador. Os contadores nos cards continuam aparecendo.</p>
      ${perm === "denied" ? `<p>O navegador está bloqueando as notificações deste site. Clique no ícone à esquerda do endereço, abra as permissões do site, mude Notificações para Permitir e recarregue a página.</p>` : ""}
      ${perm === "unsupported" ? "" : `<button class="btn" id="tg">${active ? "Desativar notificações" : "Ativar notificações"}</button>`}</div>`, "c");
    maskPhone($("#pp")); $("#sv").onclick = guard(async () => { await saveProfile(); toast("Dados salvos"); route(); });
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
    shell(`<p><a href="${back}">Voltar à lista</a></p><h1>${esc(p.protocol_number)} — ${esc(p.subject)}</h1>
    <div class="two"><div><div class="panel"><p><b>Destinatário:</b> ${esc(r.sector_name)} &nbsp; ${chip(r.status)}</p><p class="muted">Enviado ${fmt(r.sent_at)} · Recebido ${fmt(r.received_at)} · Visualizado ${fmt(r.first_viewed_at)} · Respondido ${fmt(r.responded_at)}</p><p style="white-space:pre-wrap">${esc(p.description)}</p>${fileList(orig)}${adm ? `<p><button class="btn sec sm" id="wa">Avisar por WhatsApp</button></p>` : ""}</div>
    <div class="panel"><h2>Comunicação</h2>${d.messages.map((m) => `<div class="msg ${m.role === "adm" ? "adm" : ""}"><small><b>${esc(m.author)}</b> · ${m.role === "adm" ? "Central" : esc(r.sector_name)} · ${fmt(m.created_at)}</small><div style="white-space:pre-wrap">${esc(m.message)}</div>${fileList(d.files.filter((f) => f.message_id === m.id))}</div>`).join("") || `<p class="muted">Nenhuma mensagem ainda.</p>`}
    <form id="rf"><div class="field"><label for="t">${adm ? "Enviar mensagem ao setor" : "Responder à central"}</label><textarea id="t" maxlength="5000"></textarea></div><div class="field"><input id="rfile" type="file" multiple accept="application/pdf,image/*" aria-label="Anexos"></div><button class="btn">${adm ? "Enviar mensagem" : "Enviar resposta"}</button></form></div></div>
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

async function listView(sid, title, active) {
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
    $("#res").innerHTML = `<div class="wrap"><table><tr><th>Número</th><th>Assunto</th><th>${adm ? "Destinatário" : "Origem"}</th><th>Enviado</th><th>Recebido</th><th>Visualização</th><th>Resposta</th><th></th></tr>${rows.map((r) => `<tr class="${newLabel(r) ? "new" : ""}"><td class="num">${esc(r.protocol_number)}${newLabel(r) ? `<br><span class="newb">${newLabel(r)}</span>` : ""}</td><td class="subj">${esc(r.subject)}</td><td>${adm ? esc(r.sector) : "Central"}</td><td>${two(r.sent_at)}</td><td>${two(r.received_at)}</td><td><div class="st">${r.first_viewed_at ? chip("visualizado") + `<span class="t">${fmt(r.first_viewed_at)}</span>` : `<span class="chip">Não visualizado</span>`}</div></td><td>${r.responded_at ? chip("respondido") : `<span class="chip">Sem resposta</span>`}</td><td class="nw"><a class="btn sec sm" style="text-decoration:none" href="#/p/${r.rid}">Abrir</a></td></tr>`).join("") || `<tr><td colspan="8" class="empty">Nenhum protocolo encontrado.</td></tr>`}</table></div>${pager}`;
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

onAuthStateChanged(auth, async (user) => {
  if (!user) { me = null; clearInterval(timer); sessionStorage.clear(); return loginView(); }
  try {
    const r = await api("/api/me"); me = r.user; sectors = r.sectors; route(); startNotifications();
    if (me.role !== "adm" && !me.phone) profileModal();
  } catch (e) { toast(e.message, true); await signOut(auth); }
});

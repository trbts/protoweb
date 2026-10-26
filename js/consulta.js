// Consulta pública de protocolo: sem login. Mostra só as datas do andamento.
const API = "https://protoweb.dw0mc7.workers.dev";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (d) => (d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Manaus" }) : "");
const fmtDay = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "");
const OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';

function steps(entry, s) {
  const list = [
    { t: "Entrada do protocolo", when: fmtDay(entry), wait: "" },
    { t: "Encaminhado ao setor", when: fmt(s.sent_at), wait: "Ainda não encaminhado" },
    { t: "Documento visualizado", when: fmt(s.first_viewed_at), wait: "Aguardando visualização pelo setor" },
    { t: "Resposta do documento", when: s.responded_at ? "Respondido em " + fmt(s.responded_at) : "", wait: "Aguardando resposta do setor" },
  ];
  const cur = list.findIndex((x) => !x.when);
  return `<ol class="stp">${list.map((x, i) => `<li class="${x.when ? "done" : i === cur ? "cur" : "wait"}"><span class="dot">${x.when ? OK : ""}</span><div><b>${x.t}</b><div class="when">${esc(x.when || x.wait)}</div></div></li>`).join("")}</ol>`;
}

async function consultar(num) {
  const res = $("#res"), b = $("#b");
  b.disabled = true; res.innerHTML = '<p class="muted">Consultando…</p>';
  try {
    const r = await fetch(`${API}/api/public/status?numero=${encodeURIComponent(num)}`), j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Não foi possível consultar agora. Tente novamente.");
    res.innerHTML = `<h2>Protocolo ${esc(j.protocol_number)}</h2>` + (j.sectors.length ? j.sectors.map((s) => `<section class="panel"><h3>${esc(s.sector)}</h3>${steps(j.entry_date, s)}</section>`).join("") : `<section class="panel">${steps(j.entry_date, {})}</section>`);
  } catch (e) { res.innerHTML = `<div class="perr" role="alert">${esc(e.message)}</div>`; }
  b.disabled = false;
}
$("#f").onsubmit = (e) => { e.preventDefault(); consultar($("#n").value.trim()); };
const q = new URLSearchParams(location.search).get("n");
if (q) { $("#n").value = q; consultar(q); }

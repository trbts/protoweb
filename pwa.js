// ProtoWeb · PWA: service worker, botão "Instalar aplicativo", aviso de conexão e de nova versão.
// Script independente do app.js: se algo aqui falhar, o sistema continua funcionando normalmente.
(function () {
  "use strict";
  try {
    var $ = function (s, r) { return (r || document).querySelector(s); };
    var isStandalone = function () {
      return matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: fullscreen)").matches || navigator.standalone === true;
    };
    // iPhone e iPad (o iPad novo se identifica como Mac, por isso o teste de toque)
    var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var deferred = null; // evento de instalação do Chrome/Edge/Android

    /* ---------- 1. Service worker ---------- */
    if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
      var hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        // um service worker NOVO assumiu: o app aberto ainda roda o código antigo, então oferece recarregar
        if (hadController) note("upd", "Nova versão do ProtoWeb disponível.", "Atualizar", function () { location.reload(); });
        hadController = true;
      });
      addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js").then(function (reg) {
          // tablets ficam com o app aberto por dias: procura versão nova ao voltar para ele
          document.addEventListener("visibilitychange", function () { if (!document.hidden) reg.update().catch(function () {}); });
        }).catch(function () {});
      });
    }

    /* ---------- 2. Avisos (conexão e versão) ---------- */
    function note(id, text, actionLabel, onAction, cls) {
      var el = $("#pw-" + id);
      if (!el) {
        el = document.createElement("div");
        el.id = "pw-" + id;
        el.className = "pwnote" + (cls ? " " + cls : "");
        el.setAttribute("role", "status");
        document.body.appendChild(el);
      }
      el.textContent = "";
      var span = document.createElement("span");
      span.textContent = text;
      el.appendChild(span);
      if (actionLabel) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "btn"; b.textContent = actionLabel;
        b.onclick = onAction;
        el.appendChild(b);
      }
      el.hidden = false;
    }
    function hideNote(id) { var el = $("#pw-" + id); if (el) el.hidden = true; }
    function netState() {
      if (navigator.onLine === false) note("off", "Sem conexão com a internet. O ProtoWeb precisa dela para carregar e enviar protocolos.", null, null, "off");
      else hideNote("off");
    }
    addEventListener("online", netState);
    addEventListener("offline", netState);
    netState();

    function toast(msg) {
      var box = $("#toasts"); if (!box) return;
      var t = document.createElement("div");
      t.className = "toast"; t.textContent = msg;
      box.appendChild(t);
      setTimeout(function () { t.remove(); }, 4500);
    }

    /* ---------- 3. Instalar aplicativo ---------- */
    var canOffer = function () { return !isStandalone() && (!!deferred || isIOS); };
    var SHARE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
    var DL_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>';

    function makeBtn() {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn sec pwa-i";
      b.innerHTML = DL_ICON + "<span>Instalar aplicativo</span>";
      b.style.gap = "8px";
      b.onclick = install;
      return b;
    }

    function iosHelp() {
      var m = document.createElement("div");
      m.className = "modal";
      m.innerHTML = '<div role="dialog" aria-labelledby="pwa-t"><h2 id="pwa-t">Instalar o ProtoWeb</h2>' +
        '<p class="muted" style="margin:0">No iPad e no iPhone a instalação é feita pelo Safari:</p>' +
        '<ol class="pwa-steps">' +
        '<li>Abra este endereço no <b>Safari</b> (se estiver em outro navegador).</li>' +
        '<li>Toque no botão <b>Compartilhar</b> ' + SHARE_ICON + ' (na barra de cima no iPad, na de baixo no iPhone).</li>' +
        '<li>Role a lista e toque em <b>Adicionar à Tela de Início</b>.</li>' +
        '<li>Toque em <b>Adicionar</b>. O ícone do ProtoWeb aparece na tela inicial.</li></ol>' +
        '<div class="acts"><button type="button" class="btn" data-x>Entendi</button></div></div>';
      m.addEventListener("click", function (e) { if (e.target === m || (e.target.closest && e.target.closest("[data-x]"))) m.remove(); });
      document.body.appendChild(m);
      var ok = $("[data-x]", m); if (ok) ok.focus();
    }

    function install() {
      if (deferred) {
        var p = deferred; deferred = null; // o evento só pode ser usado uma vez
        p.prompt();
        p.userChoice.then(function () { paint(); }, function () { paint(); });
        paint();
      } else if (isIOS) {
        iosHelp();
      }
    }

    // Coloca o botão no menu do usuário (topo) e na tela de login, sem mexer no app.js.
    function paint() {
      var btns = document.querySelectorAll(".pwa-i");
      if (!canOffer()) { btns.forEach(function (b) { b.remove(); }); var w = $(".pwa-login"); if (w) w.remove(); return; }
      var menu = $("#umenu");
      if (menu && !$(".pwa-i", menu)) menu.insertBefore(makeBtn(), $("#out", menu));
      var track = $(".login .panel .track");
      if (track && !$(".pwa-login", track.parentNode)) {
        var wrap = document.createElement("div");
        wrap.className = "pwa-login";
        wrap.appendChild(makeBtn());
        track.parentNode.appendChild(wrap);
      }
    }
    var queued = false;
    function schedulePaint() { if (queued) return; queued = true; requestAnimationFrame(function () { queued = false; paint(); }); }

    addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferred = e; schedulePaint(); });
    addEventListener("appinstalled", function () { deferred = null; paint(); toast("ProtoWeb instalado! Procure o ícone na sua tela inicial."); });
    try { matchMedia("(display-mode: standalone)").addEventListener("change", schedulePaint); } catch (e) { /* navegador antigo */ }

    function watch() {
      var app = $("#app");
      if (app) new MutationObserver(schedulePaint).observe(app, { childList: true, subtree: true });
      schedulePaint();
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch); else watch();
  } catch (err) {
    if (window.console) console.warn("pwa.js:", err);
  }
})();

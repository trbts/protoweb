// ProtoWeb · configuração do site (único arquivo que você precisa editar no front-end).
// Estes valores NÃO são segredos: o Firebase os entrega a qualquer navegador.
// Onde encontrar cada um: docs/GUIA-CONFIGURACAO.md

export const firebaseConfig = {
  apiKey: "COLE-AQUI-A-apiKey",
  authDomain: "SEU-PROJETO.firebaseapp.com",
  projectId: "SEU-PROJETO",
  appId: "COLE-AQUI-O-appId",
};

// Endereço do Worker da Cloudflare (aparece depois do deploy), sem barra no final.
export const API_URL = "https://protoweb-api.SEU-SUBDOMINIO.workers.dev";

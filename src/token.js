// Troca o token curto do Threads (dura ~1h) por um token longo (~60 dias)
// ou renova um token longo, e grava o resultado no .env.
//
//   npm run token:trocar    -> usa THREADS_ACCESS_TOKEN (curto) + THREADS_APP_SECRET
//   npm run token:renovar   -> usa THREADS_ACCESS_TOKEN (longo, com mais de 24h de vida)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", ".env");

function carregarEnv() {
  try {
    const txt = fs.readFileSync(ENV_PATH, "utf8");
    for (const linha of txt.split(/\r?\n/)) {
      if (linha.trim().startsWith("#")) continue;
      const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let valor = m[2];
      if (
        (valor.startsWith('"') && valor.endsWith('"')) ||
        (valor.startsWith("'") && valor.endsWith("'"))
      ) {
        valor = valor.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = valor;
    }
  } catch {
    // sem .env
  }
}
carregarEnv();

const modo = process.argv[2];
const { THREADS_ACCESS_TOKEN, THREADS_APP_SECRET } = process.env;

function gravarTokenNoEnv(novoToken) {
  let txt = "";
  try {
    txt = fs.readFileSync(ENV_PATH, "utf8");
  } catch {
    // cria o arquivo
  }
  const linha = `THREADS_ACCESS_TOKEN=${novoToken}`;
  if (/^THREADS_ACCESS_TOKEN=.*$/m.test(txt)) {
    txt = txt.replace(/^THREADS_ACCESS_TOKEN=.*$/m, () => linha);
  } else {
    txt += (txt && !txt.endsWith("\n") ? "\n" : "") + linha + "\n";
  }
  fs.writeFileSync(ENV_PATH, txt);
}

async function main() {
  if (!["trocar", "renovar"].includes(modo)) {
    throw new Error("Use: npm run token:trocar  ou  npm run token:renovar");
  }
  if (!THREADS_ACCESS_TOKEN) {
    throw new Error("THREADS_ACCESS_TOKEN não encontrado no .env.");
  }

  let url;
  if (modo === "trocar") {
    if (!THREADS_APP_SECRET) {
      throw new Error(
        "THREADS_APP_SECRET não encontrado. Adicione ao .env a linha THREADS_APP_SECRET=... (segredo do app do Threads, no painel da Meta)."
      );
    }
    url =
      "https://graph.threads.com/access_token?" +
      new URLSearchParams({
        grant_type: "th_exchange_token",
        client_secret: THREADS_APP_SECRET,
        access_token: THREADS_ACCESS_TOKEN,
      });
  } else {
    url =
      "https://graph.threads.com/refresh_access_token?" +
      new URLSearchParams({
        grant_type: "th_refresh_token",
        access_token: THREADS_ACCESS_TOKEN,
      });
  }

  const res = await fetch(url);
  const corpo = await res.text();
  if (!res.ok) {
    const dica = /"code":\s*190/.test(corpo)
      ? "\n>>> Token expirado: gere um novo token no painel da Meta e rode este comando logo em seguida."
      : "";
    throw new Error(`Threads ${res.status}: ${corpo}${dica}`);
  }

  const { access_token, expires_in } = JSON.parse(corpo);
  if (!access_token) throw new Error(`Resposta sem access_token: ${corpo}`);
  gravarTokenNoEnv(access_token);

  const validade = new Date(Date.now() + Number(expires_in) * 1000);
  console.log(
    `Token ${modo === "trocar" ? "longo gerado" : "renovado"} e salvo no .env.\n` +
      `Válido até ${validade.toLocaleDateString("pt-BR")} (renove antes disso com: npm run token:renovar).`
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
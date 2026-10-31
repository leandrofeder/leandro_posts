import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(__dirname, "..");
const CONFIG_PATH = path.join(RAIZ, "config", "produtos.json");
const HISTORICO_PATH = path.join(RAIZ, "data", "historico.json");

// Carrega o arquivo .env (o Node não faz isso sozinho). Variáveis já definidas no
// sistema (ex.: secrets do GitHub Actions) têm prioridade.
function carregarEnv() {
  try {
    const txt = fs.readFileSync(path.join(RAIZ, ".env"), "utf8");
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
    // sem .env: segue só com as variáveis do sistema
  }
}
carregarEnv();

// Padrão: só gera rascunho. Publica com DRY_RUN=false ou com a flag --publicar.
const DRY_RUN =
  process.env.DRY_RUN !== "false" && !process.argv.includes("--publicar");
const { GEMINI_API_KEY, THREADS_USER_ID, THREADS_ACCESS_TOKEN } = process.env;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const lerJson = (p, padrao) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return padrao;
  }
};

function sortearPonderado(itens) {
  const total = itens.reduce((s, i) => s + (i.peso ?? 1), 0);
  let r = Math.random() * total;
  for (const i of itens) {
    r -= i.peso ?? 1;
    if (r <= 0) return i;
  }
  return itens[itens.length - 1];
}

function escolherPauta(cfg, historico) {
  const c = cfg.configuracoes;
  const comLink = Math.random() < c.probabilidade_link;

  if (comLink) {
    const recentes = historico
      .slice(-c.evitar_repetir_ultimos)
      .map((h) => h.produto_id)
      .filter(Boolean);
    let candidatos = cfg.produtos.filter((p) => p.ativo && !recentes.includes(p.id));
    if (!candidatos.length) candidatos = cfg.produtos.filter((p) => p.ativo);
    if (candidatos.length) {
      const produto = sortearPonderado(candidatos);
      const situacao =
        produto.situacoes[Math.floor(Math.random() * produto.situacoes.length)];
      return { produto, tema: situacao };
    }
  }
  const tema =
    c.temas_sem_link[Math.floor(Math.random() * c.temas_sem_link.length)];
  return { produto: null, tema };
}

function montarPrompt(cfg, { produto, tema }, limitePorParte) {
  const c = cfg.configuracoes;
  let p =
    `Escreva uma história para o Threads em ${c.idioma}, dividida em uma sequência de postagens encadeadas (uma thread).\n` +
    `Estilo: ${c.estilo}.\n` +
    `Tema: ${tema}.\n` +
    `Regras:\n` +
    `- Entre ${c.partes_min} e ${c.partes_max} partes; escolha a quantidade que a história pedir.\n` +
    `- Cada parte com no máximo ${limitePorParte} caracteres.\n` +
    `- A parte 1 precisa ter um gancho forte, que faça a pessoa querer ler a próxima.\n` +
    `- Cada parte deve terminar deixando vontade de ler a seguinte, e a última fecha a história.\n` +
    `- Sem hashtags, sem numeração ("1/8"), sem aspas no começo/fim, sem emojis em excesso.\n`;
  if (produto) {
    p +=
      `- A história deve mencionar de forma natural e discreta o item "${produto.nome}" (${produto.tipo}), ` +
      `como parte do enredo, sem soar como propaganda, de preferência perto do final. NÃO inclua links nem URLs.\n`;
  } else {
    p += `- Esta história NÃO deve mencionar produtos nem lojas.\n`;
  }
  p += `Responda SOMENTE com JSON no formato {"partes": ["texto da parte 1", "texto da parte 2", ...]}.`;
  return p;
}

async function chamarGemini(prompt, modelo, maxTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!res.ok) {
    const corpo = await res.text();
    const erro = new Error(`Gemini ${res.status}: ${corpo}`);
    erro.status = res.status;
    // O Gemini informa quanto esperar no header ou no corpo ("retryDelay": "30s").
    const ra =
      Number(res.headers.get("retry-after")) ||
      Number(corpo.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/)?.[1]) ||
      0;
    if (ra > 0) erro.retryAfterSeg = Math.ceil(ra);
    throw erro;
  }
  const data = await res.json();
  const cand = data.candidates?.[0];
  const texto = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!texto) {
    const motivo = cand?.finishReason ?? data.promptFeedback?.blockReason ?? "desconhecido";
    throw new Error(`Gemini não devolveu texto (motivo: ${motivo})`);
  }
  return texto;
}

// Corta no último espaço antes do limite, para não quebrar palavra.
function cortar(texto, limite) {
  if (texto.length <= limite) return texto;
  const corte = texto.slice(0, limite - 1);
  const ultimoEspaco = corte.lastIndexOf(" ");
  return (ultimoEspaco > limite * 0.6 ? corte.slice(0, ultimoEspaco) : corte).trimEnd() + "…";
}

async function gerarPartes(cfg, pauta, limitePorParte) {
  const c = cfg.configuracoes;
  const prompt = montarPrompt(cfg, pauta, limitePorParte);

  // Os limites do Gemini são por modelo: se um estourar, passa para o próximo da lista.
  const modelos = c.modelos?.length
    ? c.modelos
    : ["gemini-3.8-flash", "gemini-3.5-flash-lite"];
  const MAX_TENTATIVAS = Math.max(6, modelos.length * 2);
  let idx = 0;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    const modelo = modelos[idx];
    try {
      console.log(`Gerando história com ${modelo} (tentativa ${tentativa})...`);
      const bruto = await chamarGemini(prompt, modelo, c.max_tokens ?? 8192);
      // Remove cercas de código (```json) caso o modelo as inclua.
      const limpo = bruto.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      const partes = JSON.parse(limpo).partes;
      if (!Array.isArray(partes)) throw new Error("JSON sem o campo 'partes'");
      const limpas = partes
        .map((t) => String(t).trim())
        .filter(Boolean)
        .map((t) => cortar(t, limitePorParte));
      if (limpas.length < c.partes_min) throw new Error(`Poucas partes (${limpas.length})`);
      return limpas.slice(0, c.partes_max);
    } catch (e) {
      // Chave recusada: tentar de novo não adianta.
      if ([401, 403].includes(e.status) || /API key not valid|API_KEY_INVALID/i.test(e.message)) {
        throw new Error(`Chave do Gemini recusada. Confira GEMINI_API_KEY no .env. Detalhe: ${e.message}`);
      }
      console.warn(`Tentativa ${tentativa} falhou (${modelo}): ${e.message}`);
      if (tentativa < MAX_TENTATIVAS) {
        let espera = 2;
        if (e.status) {
          // Erro da API (limite, modelo indisponível...): tenta o próximo modelo.
          // Só espera de verdade depois de ter passado por todos eles.
          idx = (idx + 1) % modelos.length;
          espera =
            idx === 0 && e.status === 429 ? Math.max(e.retryAfterSeg ?? 0, 20) : 1;
        }
        console.warn(`Aguardando ${espera}s antes de tentar de novo...`);
        await dormir(espera * 1000);
      }
    }
  }
  throw new Error(`Não consegui gerar uma thread válida após ${MAX_TENTATIVAS} tentativas`);
}

async function publicarParte(texto, respondeA) {
  const base = `https://graph.threads.net/v1.0/${THREADS_USER_ID}`;
  const corpo = {
    media_type: "TEXT",
    text: texto,
    access_token: THREADS_ACCESS_TOKEN,
  };
  if (respondeA) corpo.reply_to_id = respondeA;

  const criar = await fetch(`${base}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(corpo),
  });
  if (!criar.ok) throw new Error(`Threads (criar) ${criar.status}: ${await criar.text()}`);
  const { id: creationId } = await criar.json();

  const pub = await fetch(`${base}/threads_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ creation_id: creationId, access_token: THREADS_ACCESS_TOKEN }),
  });
  if (!pub.ok) throw new Error(`Threads (publicar) ${pub.status}: ${await pub.text()}`);
  const { id } = await pub.json();
  return id;
}

async function publicarThread(partes, pausaSeg) {
  const ids = [];
  try {
    for (let i = 0; i < partes.length; i++) {
      const id = await publicarParte(partes[i], ids[i - 1]);
      ids.push(id);
      console.log(`Parte ${i + 1}/${partes.length} publicada (id ${id})`);
      if (i < partes.length - 1) await dormir(pausaSeg * 1000);
    }
  } catch (e) {
    // Thread pela metade: registra o que já saiu para você decidir o que fazer.
    e.idsPublicados = ids;
    throw e;
  }
  return ids;
}

async function main() {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY vazia ou não encontrada. Preencha o arquivo .env (copie de .env.example), sem aspas nem espaços."
    );
  }
  if (!DRY_RUN && (!THREADS_USER_ID || !THREADS_ACCESS_TOKEN)) {
    throw new Error("THREADS_USER_ID e THREADS_ACCESS_TOKEN são obrigatórios para publicar.");
  }

  const cfg = lerJson(CONFIG_PATH);
  if (!cfg) throw new Error("Não consegui ler config/produtos.json");
  const historico = lerJson(HISTORICO_PATH, []);
  const c = cfg.configuracoes;

  const pauta = escolherPauta(cfg, historico);

  // O link é anexado pelo código (não pela IA) na última parte, então nunca sai errado.
  const rodape = pauta.produto
    ? `\n\n${pauta.produto.link} ${c.aviso_afiliado}`.trimEnd()
    : "";

  // Reserva o espaço do link em todas as partes: assim a última sempre comporta o rodapé.
  const limitePorParte = c.max_caracteres - rodape.length;
  const partes = await gerarPartes(cfg, pauta, limitePorParte);
  partes[partes.length - 1] += rodape;

  console.log(
    `Tipo: ${pauta.produto ? pauta.produto.tipo : "sem link"} | ${partes.length} partes\n`
  );
  partes.forEach((t, i) => {
    console.log(`---- PARTE ${i + 1}/${partes.length} (${t.length} caracteres) ----\n${t}\n`);
  });

  let ids = [];
  let publicado = false;
  if (DRY_RUN) {
    console.log("DRY_RUN ativo: nada foi publicado.");
  } else {
    ids = await publicarThread(partes, c.pausa_entre_partes_seg ?? 3);
    publicado = true;
  }

  historico.push({
    data: new Date().toISOString(),
    produto_id: pauta.produto?.id ?? null,
    publicado,
    ids,
    partes,
  });
  fs.mkdirSync(path.dirname(HISTORICO_PATH), { recursive: true });
  fs.writeFileSync(HISTORICO_PATH, JSON.stringify(historico.slice(-100), null, 2));
}

main().catch((e) => {
  console.error(e);
  if (e.idsPublicados?.length) {
    console.error(`Thread incompleta. Partes já publicadas: ${e.idsPublicados.join(", ")}`);
  }
  process.exit(1);
});
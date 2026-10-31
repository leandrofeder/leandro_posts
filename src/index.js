import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(__dirname, "..");
const CONFIG_PATH = path.join(RAIZ, "config", "produtos.json");
const HISTORICO_PATH = path.join(RAIZ, "data", "historico.json");

const DRY_RUN = process.env.DRY_RUN !== "false"; // padrão: só gera rascunho
const { MISTRAL_API_KEY, THREADS_USER_ID, THREADS_ACCESS_TOKEN } = process.env;

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

async function chamarMistral(prompt) {
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model: "mistral-small-latest",
      temperature: 0.9,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Mistral ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
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

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const bruto = await chamarMistral(prompt);
      const partes = JSON.parse(bruto).partes;
      if (!Array.isArray(partes)) throw new Error("JSON sem o campo 'partes'");
      const limpas = partes
        .map((t) => String(t).trim())
        .filter(Boolean)
        .map((t) => cortar(t, limitePorParte));
      if (limpas.length < c.partes_min) throw new Error(`Poucas partes (${limpas.length})`);
      return limpas.slice(0, c.partes_max);
    } catch (e) {
      console.warn(`Tentativa ${tentativa} falhou: ${e.message}`);
    }
  }
  throw new Error("Não consegui gerar uma thread válida após 3 tentativas");
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

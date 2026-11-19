export const maxDuration = 60;

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

const instrucoes = {
  titular: `
    Identifique o titular pelo cabeçalho, identificação da conta ou saudação
    personalizada. Nunca use nomes de remetentes, favorecidos ou Pix para
    identificar o titular. Preserve o CPF mascarado. Se a saudação só tiver
    primeiro nome, devolva somente o primeiro nome. Use strings vazias para
    campos ausentes. Responda só com JSON: {"titular":"","cpf":""}.
  `,
  documento: `
    Leia RG, CNH ou certidão. Quando a referência contém titular, extraia
    dados dessa pessoa. Na primeira leitura, extraia a pessoa identificada
    no RG ou na CNH. Use somente dados visíveis e não copie o CPF da
    referência. O verso pode ter apenas filiação. Se a página não mostrar
    nome ou CPF, deixe o campo vazio. Em certidão, associe cada parente
    à pessoa correta. Para dados ausentes ou ilegíveis, use strings vazias.
    Responda só com JSON: {"titular":"","cpf":"","pai":"","mae":"","conjuge":""}.
  `,
  pagina: `
    Você recebe propositalmente UMA página de um extrato brasileiro.
    O aplicativo percorre todas as páginas separadamente. A numeração
    como "1/26", a existência de páginas seguintes ou o fato de esta
    página cobrir só parte do período NÃO são motivos para completa=false.
    Uma capa, resumo ou aviso legível pode ser completa=true e ter zero
    transações. Use completa=false apenas se um lançamento desta página
    estiver realmente ilegível, cortado ou com dados insuficientes.

    Extraia cada crédito efetivamente lançado nesta página. Não extraia
    saldo, limite, saldo anterior, subtotal, total, débito ou uma segunda
    via em quadros-resumo. Demonstrativos de investimentos não são novos
    créditos em conta. Preserve entradas distintas, mesmo com mesma data
    e valor. Use data real AAAA-MM-DD e centavos como inteiro positivo.
    O cabeçalho da primeira página ajuda a interpretar o ano. Nunca
    invente data, valor, remetente ou identificador.

    Em meses, informe AAAA-MM para meses de movimentações da página,
    inclusive meses em que todos os lançamentos são débitos. Se o extrato
    declarar explicitamente seu mês ou seu intervalo de cobertura,
    registre também os meses desse período. Datas de impressão, datas
    publicitárias e vencimentos futuros não são cobertura bancária.
    Em periodo, copie a indicação de período do extrato se estiver visível.
    Se ausente, use string vazia.

    Classifique cada crédito como CONSIDERADO, REJEITADO ou REVISAR.
    Rejeite transferências da própria titularidade, de pai, de mãe ou
    do cônjuge informados, estornos, devoluções, resgates e rendimentos.
    Filho não é motivo de exclusão. Use REVISAR se o remetente ou a
    natureza do crédito for incerta. Use id_bancario somente quando
    houver identificador único explícito, como EndToEndId completo.

    Responda só com JSON:
    {
      "completa": true, "observacao": "", "meses": [], "periodo": "",
      "transacoes": [
        {"data":"AAAA-MM-DD","descricao":"","centavos":100,
         "status":"CONSIDERADO","motivo":"","id_bancario":""}
      ]
    }
  `
};

async function consultar(nome, url, opcoes) {
  let resposta;
  try {
    resposta = await fetch(url, opcoes);
  } catch (erro) {
    if (erro.name === "TimeoutError" || erro.name === "AbortError") {
      throw Error(`${nome}: tempo de resposta esgotado.`);
    }
    throw Error(`${nome}: falha de comunicação.`);
  }

  const dados = await resposta.json().catch(() => null);
  if (!resposta.ok) {
    const codigo = String(dados?.error?.status || "").match(/^[A-Z_]{1,40}$/)?.[0];
    throw Error(`${nome} HTTP ${resposta.status}${codigo ? ` (${codigo})` : ""}.`);
  }
  if (!dados) throw Error(`${nome}: resposta HTTP fora do formato JSON.`);
  return dados;
}

function interpretar(nome, bruto, operacao) {
  const texto = String(bruto || "").trim()
    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let dados;
  try {
    dados = JSON.parse(texto);
  } catch {
    throw Error(`${nome}: resposta vazia ou fora do formato JSON.`);
  }

  if (operacao === "pagina") {
    if (typeof dados?.completa !== "boolean" ||
        !Array.isArray(dados.meses) || !Array.isArray(dados.transacoes)) {
      throw Error(`${nome}: faltaram os campos da leitura da página.`);
    }
  } else if (typeof dados?.titular !== "string" || typeof dados?.cpf !== "string") {
    throw Error(`${nome}: faltaram os campos de identificação.`);
  } else if (operacao === "titular" && !dados.titular.trim() && !dados.cpf.trim()) {
    throw Error(`${nome}: titularidade não localizada.`);
  } else if (operacao === "documento" &&
      !["titular", "cpf", "pai", "mae", "conjuge"].some(campo =>
        typeof dados[campo] === "string" && dados[campo].trim())) {
    throw Error(`${nome}: nenhum dado de identificação localizado nesta página.`);
  }

  return dados;
}

async function usarGemini(pedido, imagem, operacao, sinal) {
  const chave = process.env.GEMINI_API_KEY;
  if (!chave) throw Error("Configure GEMINI_API_KEY na Vercel.");

  const headers = { "Content-Type": "application/json", "x-goog-api-key": chave };
  const catalogo = await consultar("Catálogo Gemini", `${GEMINI}/models`, { headers, signal: sinal });
  const modelos = (catalogo.models || [])
    .filter(m => m.supportedGenerationMethods?.includes("generateContent"))
    .map(m => String(m.name || "").replace(/^models\//, ""))
    .filter(nome => /^[a-z0-9._-]+$/i.test(nome) && /flash|vision/i.test(nome));

  if (!modelos.length) throw Error("A chave não retornou modelos Flash ou Vision.");

  const parts = [
    { text: pedido },
    { inline_data: { mime_type: "image/jpeg", data: imagem } }
  ];
  const restante = new AbortController();
  const signal = AbortSignal.any([sinal, restante.signal]);
  let incompleta;

  try {
    return await Promise.any(modelos.map(async modelo => {
      const nome = `Gemini ${modelo}`;
      const dados = await consultar(nome, `${GEMINI}/models/${encodeURIComponent(modelo)}:generateContent`, {
        method: "POST", headers, signal,
        body: JSON.stringify({ contents: [{ parts }] })
      });
      const texto = dados.candidates?.[0]?.content?.parts
        ?.filter(parte => !parte.thought && typeof parte.text === "string")
        .map(parte => parte.text).join("");

      const resultado = interpretar(nome, texto, operacao);
      if (operacao === "pagina" && !resultado.completa) {
        incompleta ||= resultado;
        throw Error(`${nome}: a página ficou incompleta.`);
      }
      return resultado;
    }));
  } catch (erro) {
    if (incompleta) return incompleta;
    if (!(erro instanceof AggregateError)) throw erro;
    throw Error(erro.errors.slice(0, 5).map(falha => falha.message).join(" "));
  } finally {
    restante.abort();
  }
}

async function usarTexto(pedido, operacao, prazo) {
  const provedores = [
    ["OpenRouter", "https://openrouter.ai/api/v1/chat/completions",
      process.env.RENDA_OPEN_API_KEY, process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini"],
    ["Groq", "https://api.groq.com/openai/v1/chat/completions",
      process.env.GROQ_API_KEY, process.env.GROQ_MODEL || "llama-3.1-70b-versatile"],
    ["SambaNova", "https://api.sambanova.ai/v1/chat/completions",
      process.env.SAMBA_API_KEY, process.env.SAMBA_MODEL || "Meta-Llama-3.1-70B-Instruct"]
  ];
  const falhas = [];
  let incompleta;

  for (const [nome, url, chave, model] of provedores) {
    if (!chave) continue;
    const tempo = Math.min(22000, prazo - Date.now());
    if (tempo < 1500) break;

    try {
      const dados = await consultar(nome, url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${chave}` },
        signal: AbortSignal.timeout(tempo),
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "Responda estritamente com um objeto JSON." },
            { role: "user", content: pedido }
          ],
          response_format: { type: "json_object" },
          temperature: 0.1
        })
      });

      const resultado = interpretar(nome, dados.choices?.[0]?.message?.content, operacao);
      if (operacao === "pagina" && !resultado.completa) {
        incompleta ||= resultado;
        continue;
      }
      return resultado;
    } catch (erro) {
      falhas.push(erro.message);
    }
  }

  if (incompleta) return incompleta;
  throw Error(falhas.join(" ") || "Nenhum motor de texto disponível para esta solicitação.");
}

const urlProjeto='https://uztsmkhlvoemjbbyebcr.supabase.co', chavePublica='sb_publishable_nmolEh_G5_hKcfdgy2Xpeg_s4T6ePAz';
async function acessoConfirmado(req,res){
  const authorization=String(req.headers.authorization||"");
  if(!/^Bearer [^\s]+$/.test(authorization)){res.status(401).json({error:"Entre com sua conta."});return false;}
  const opcoes={headers:{apikey:chavePublica,Authorization:authorization},signal:AbortSignal.timeout(12000)};
  try{
    const auth=await fetch(urlProjeto+"/auth/v1/user",opcoes);
    if(auth.status===401||auth.status===403){res.status(401).json({error:"Sessão expirada."});return false;}
    if(!auth.ok)throw Error();
    const u=await auth.json();
    if(!u.id)throw Error();
    let vip=u.id==="d0cb0d94-62f5-4a87-86fc-d0f36743a857"&&u.email==="chalfouncorretor@gmail.com",expira=null;
    if(!vip){
      const r=await fetch(urlProjeto+"/rest/v1/profiles?id=eq."+encodeURIComponent(u.id)+"&select=role,subscription_status,subscription_expires_at",opcoes);
      if(!r.ok)throw Error();
      const [p]=await r.json();vip=p?.role==="admin";expira=p?.subscription_expires_at||null;
      if(!vip && !(p?.subscription_status==="ativo" && Date.parse(expira)>Date.now())){
        res.status(403).json({error:p?.role==="manutencao"?"Manutenção expirada. Solicite um novo código.":"Acesso inativo ou expirado.",manutencao:p?.role==="manutencao"});return false;
      }
    }
    if(req.body?.operacao==="acesso"){res.status(200).json({vip,expira});return false;}
    return true;
  }catch{res.status(503).json({error:"Não foi possível consultar o acesso no Supabase."});return false;}
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  if(!await acessoConfirmado(req,res))return;

  const { operacao, texto = "", imagem = "", referencia = {} } = req.body || {};
  const contexto = JSON.stringify(referencia);
  if (typeof operacao !== "string" || !Object.hasOwn(instrucoes, operacao) ||
      typeof texto !== "string" || typeof imagem !== "string" ||
      texto.length > 65000 || imagem.length > 2800000 ||
      contexto.length > 3500 || (!texto.trim() && !imagem)) {
    return res.status(400).json({ error: "Operação inválida, página vazia ou conteúdo acima do limite." });
  }

  const pedido = [
    instrucoes[operacao],
    `REFERÊNCIA:\n${contexto}`,
    `TEXTO DA PÁGINA:\n${texto}`
  ].join("\n\n");

  try {
    const resultado = imagem
      ? await usarGemini(pedido, imagem, operacao, AbortSignal.timeout(55000))
      : await usarTexto(pedido, operacao, Date.now() + 55000);
    return res.status(200).json(resultado);
  } catch (erro) {
    console.warn("[apurador]", operacao, erro.message);
    return res.status(503).json({ error: `Falha na operação ${operacao}. ${erro.message}` });
  }
}

export const config = {
  maxDuration: 300, // Limite de 5 minutos da Vercel
};

/**
 * Utilitário: Chamada para a API do Google Gemini
 */
async function callGemini(prompt, timeoutMs = 60000) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY não configurada na Vercel.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini erro ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini retornou resposta vazia.");

    return { provider: "Gemini", result: text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Utilitário: Chamada para a API da Groq
 */
async function callGroq(prompt, timeoutMs = 60000) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY não configurada na Vercel.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: prompt }],
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Groq erro ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error("Groq retornou resposta vazia.");

    return { provider: "Groq", result: text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Utilitário: Chamada para a API da SambaNova
 */
async function callSambaNova(prompt, timeoutMs = 60000) {
  // Pega SAMBA_API_KEY conforme está no seu print da Vercel
  const apiKey = process.env.SAMBA_API_KEY || process.env.SAMBANOVA_API_KEY;
  if (!apiKey) throw new Error("SAMBA_API_KEY não configurada na Vercel.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      "https://api.sambanova.ai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: "Meta-Llama-3.1-70B-Instruct",
          messages: [{ role: "user", content: prompt }],
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`SambaNova erro ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error("SambaNova retornou resposta vazia.");

    return { provider: "SambaNova", result: text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Handler principal
 */
export default async function handler(req, res) {
  // Headers de CORS
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS,PATCH,DELETE,POST,PUT"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido. Use POST." });
  }

  const { prompt, content } = req.body || {};
  const queryPrompt = prompt || content;

  if (!queryPrompt) {
    return res.status(400).json({
      error: "O campo 'prompt' ou 'content' é obrigatório no corpo da requisição.",
    });
  }

  try {
    // Corrida de IAs: a mais rápida responde
    const winner = await Promise.any([
      callGemini(queryPrompt),
      callGroq(queryPrompt),
      callSambaNova(queryPrompt),
    ]);

    return res.status(200).json({
      success: true,
      provider: winner.provider,
      data: winner.result,
    });
  } catch (error) {
    console.error("Erro em todos os provedores:", error);

    const errors =
      error instanceof AggregateError
        ? error.errors.map((e) => e.message)
        : [error.message];

    return res.status(502).json({
      success: false,
      error: "Nenhum provedor de IA respondeu com sucesso a tempo.",
      details: errors,
    });
  }
}

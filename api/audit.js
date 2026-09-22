export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  try {
    const { prompt, texts, images } = req.body;
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    const SAMBA_API_KEY = process.env.SAMBA_API_KEY;

    if (!GEMINI_API_KEY && !GROQ_API_KEY && !SAMBA_API_KEY) {
      return res.status(500).json({ error: "Nenhuma chave de API configurada." });
    }

    const cleanJson = (raw) => {
      if (!raw) return null;
      try {
        const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleaned);
      } catch (e) {
        return null;
      }
    };

    // ==========================================
    // ESTRATÉGIA 1: PARALELISMO POR CORRIDA (Race / Fallback Rápido)
    // Se a auditoria for enviada como um bloco único completo
    // ==========================================
    // Quando você quer a resposta do lote todo, chamamos as IAs em paralelo.
    // A primeira que responder com JSON válido ganha, reduzindo a latência a milissegundos.

    const executarGemini = async () => {
      if (!GEMINI_API_KEY) throw new Error("Sem chave Gemini");
      const modelos = ["gemini-3.8-flash", "gemini-3.6-flash"];
      
      for (const mod of modelos) {
        try {
          const parts = [{ text: prompt }];
          if (texts) parts.push({ text: "TEXTOS ADICIONAIS:\n" + texts });
          if (Array.isArray(images)) {
            images.forEach(img => {
              parts.push({ inline_data: { mime_type: "image/jpeg", data: img } });
            });
          }

          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mod}:generateContent?key=${GEMINI_API_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts }],
              generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
            })
          });

          if (response.ok) {
            const data = await response.json();
            const json = cleanJson(data.candidates?.[0]?.content?.parts?.[0]?.text);
            if (json) return { provider: `Gemini (${mod})`, result: json };
          }
        } catch (e) {}
      }
      throw new Error("Gemini falhou em todas as tentativas");
    };

    const executarGroq = async () => {
      if (!GROQ_API_KEY) throw new Error("Sem chave Groq");
      const hasImages = Array.isArray(images) && images.length > 0;
      const model = hasImages ? "qwen/qwen3.8-27b" : "llama-3.3-70b-versatile";

      const content = [{ type: "text", text: prompt + (texts ? "\n\nCONTEÚDO:\n" + texts : "") }];
      if (hasImages) {
        images.slice(0, 3).forEach(img => {
          content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${img}` } });
        });
      }

      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "Retorne ESTRITAMENTE um JSON válido sem marcações markdown." },
            { role: "user", content: hasImages ? content : content[0].text }
          ],
          response_format: { type: "json_object" },
          temperature: 0.1
        })
      });

      if (response.ok) {
        const data = await response.json();
        const json = cleanJson(data.choices?.[0]?.message?.content);
        if (json) return { provider: `Groq (${model})`, result: json };
      }
      throw new Error("Groq falhou na execução");
    };

    const executarSambaNova = async () => {
      if (!SAMBA_API_KEY) throw new Error("Sem chave SambaNova");
      if (Array.isArray(images) && images.length > 0) {
        throw new Error("SambaNova ignorado pois o prompt possui imagens");
      }

      const response = await fetch("https://api.sambanova.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SAMBA_API_KEY}`
        },
        body: JSON.stringify({
          model: "Meta-Llama-3.1-70B-Instruct",
          messages: [
            { role: "system", content: "Retorne ESTRITAMENTE um JSON válido." },
            { role: "user", content: prompt + "\n\nCONTEÚDO:\n" + texts }
          ],
          response_format: { type: "json_object" },
          temperature: 0.1
        })
      });

      if (response.ok) {
        const data = await response.json();
        const json = cleanJson(data.choices?.[0]?.message?.content);
        if (json) return { provider: "SambaNova (Llama 70B)", result: json };
      }
      throw new Error("SambaNova falhou");
    };

    // Monta a lista de provedores ativos
    const providers = [];
    if (GEMINI_API_KEY) providers.push(executarGemini());
    if (GROQ_API_KEY) providers.push(executarGroq());
    if (SAMBA_API_KEY && (!images || images.length === 0)) providers.push(executarSambaNova());

    if (providers.length === 0) {
      return res.status(500).json({ error: "Nenhum provedor elegível para a requisição." });
    }

    // ==========================================
    // EXECUÇÃO EM PARALELO (Promise.any)
    // ==========================================
    // Todas as IAs começam a trabalhar juntas no mesmo milissegundo.
    // Se uma falhar, ela é descartada silenciosamente e a outra assume.
    // Assim que a primeira concluir com sucesso, ela retorna imediatamente pro cliente.
    try {
      const vencedor = await Promise.any(providers);
      return res.status(200).json(vencedor.result);
    } catch (aggregateError) {
      // Só entra aqui se TODAS falharem
      return res.status(500).json({
        error: "Todas as IAs falharam simultaneamente.",
        details: aggregateError.errors?.map(e => e.message)
      });
    }

  } catch (err) {
    return res.status(500).json({ error: "Erro interno: " + err.message });
  }
}

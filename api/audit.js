// Limite máximo exato do plano gratuito da Vercel
export const maxDuration = 60; 

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
    const RENDA_OPEN_API_KEY = process.env.RENDA_OPEN_API_KEY;

    if (!GEMINI_API_KEY && !GROQ_API_KEY && !SAMBA_API_KEY && !RENDA_OPEN_API_KEY) {
      return res.status(500).json({ error: "Nenhuma chave de API configurada." });
    }

    const temImagens = Array.isArray(images) && images.length > 0;

    // ==========================================
    // MODO VISÃO (Documentos e CNH com imagens)
    // ==========================================
    if (temImagens && GEMINI_API_KEY) {
        const reqModelos = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
        const dataModelos = await reqModelos.json();

        if (!dataModelos.models) {
            return res.status(500).json({ error: "A chave da API Gemini é inválida ou foi bloqueada." });
        }

        const modelosPermitidos = dataModelos.models
            .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent"))
            .map(m => m.name.replace('models/', ''))
            .filter(nome => nome.includes('flash') || nome.includes('vision'));

        if (modelosPermitidos.length === 0) {
            return res.status(500).json({ error: "Sua chave do Gemini não tem acesso a modelos de visão. Crie uma nova no Google AI Studio." });
        }

        const parts = [{ text: prompt }];
        if (texts) parts.push({ text: "TEXTOS ADICIONAIS:\n" + texts });
        images.forEach(img => {
            parts.push({ inline_data: { mime_type: "image/jpeg", data: img } });
        });

        const tentarModelo = async (modelo) => {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts }] })
            });
            if (!response.ok) throw new Error(`Falha no ${modelo}`);
            const data = await response.json();
            const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!rawText) throw new Error(`Resposta vazia no ${modelo}`);
            const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(cleanJson);
        };

        try {
            const jsonResultado = await Promise.any(modelosPermitidos.map(mod => tentarModelo(mod)));
            return res.status(200).json(jsonResultado);
        } catch (err) {
            return res.status(500).json({ error: "Modelos de visão falharam. Tente novamente." });
        }
    }

    // ==========================================
    // MODO TEXTO (Extratos puros) – prioridade:
    // RENDA_OPEN_API_KEY > GROQ > SAMBA
    // ==========================================
    if (!temImagens && texts) {
      // --------- PRINCIPAL: RENDA_OPEN_API_KEY (OpenRouter) ---------
      if (RENDA_OPEN_API_KEY) {
        try {
          const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${RENDA_OPEN_API_KEY}`,
              "HTTP-Referer": "https://renda-extra.vercel.app",
              "X-Title": "Analisador de Renda"
            },
            body: JSON.stringify({
              model: "openai/gpt-4o-mini",
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
            return res.status(200).json(JSON.parse(data.choices[0].message.content));
          }
        } catch (e) {}
      }

      // --------- FALLBACK 1: GROQ ---------
      if (GROQ_API_KEY) {
        try {
          const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
              model: "llama-3.1-70b-versatile",
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
            return res.status(200).json(JSON.parse(data.choices[0].message.content));
          }
        } catch (e) {}
      }

      // --------- FALLBACK 2: SAMBA ---------
      if (SAMBA_API_KEY) {
        try {
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
            return res.status(200).json(JSON.parse(data.choices[0].message.content));
          }
        } catch (e) {}
      }

      return res.status(500).json({ error: "Nenhuma IA conseguiu processar os textos." });
    }

    return res.status(500).json({ error: "Payload vazio." });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno: " + error.message });
  }
}

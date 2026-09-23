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

    if (!GEMINI_API_KEY && !GROQ_API_KEY && !SAMBA_API_KEY) {
      return res.status(500).json({ error: "Nenhuma chave de API configurada." });
    }

    const temImagens = Array.isArray(images) && images.length > 0;

    // ==========================================
    // MODO VISÃO: CORRIDA PARALELA DE IAS
    // ==========================================
    if (temImagens && GEMINI_API_KEY) {
      // Modelos oficiais e universais
      const modelosGemini = ["gemini-1.5-flash", "gemini-pro-vision"];
      
      const parts = [{ text: prompt }];
      if (texts) parts.push({ text: "TEXTOS ADICIONAIS:\n" + texts });
      images.forEach(img => {
        parts.push({ inline_data: { mime_type: "image/jpeg", data: img } });
      });

      // Função que faz a chamada para um único modelo
      const tentarModeloVisao = async (modelo) => {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts }] })
        });
        
        if (!response.ok) {
          const errData = await response.json();
          throw new Error(`${modelo}: ${errData.error?.message || 'Falhou'}`);
        }
        
        const data = await response.json();
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawText) throw new Error(`${modelo}: Resposta vazia`);
        
        const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanJson);
      };

      try {
        // Promise.any dispara as requisições em PARALELO. A primeira que der sucesso é retornada.
        const jsonResultado = await Promise.any(modelosGemini.map(modelo => tentarModeloVisao(modelo)));
        return res.status(200).json(jsonResultado);
      } catch (aggregateError) {
        // Se todos os modelos da corrida falharem, captura os erros
        const errosLogs = aggregateError.errors ? aggregateError.errors.map(e => e.message) : [aggregateError.message];
        return res.status(500).json({ error: "Falha na IA Visual (Todos falharam): " + errosLogs.join(" | ") });
      }
    }

    // ==========================================
    // MODO TEXTO (Extratos longos - Fallbacks)
    // ==========================================
    if (!temImagens && texts) {
      
      // 1. Tenta SambaNova (Llama 3.1 70B)
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
        } catch (err) {}
      }

      // 2. Tenta Groq
      if (GROQ_API_KEY) {
        try {
          const listRes = await fetch("https://api.groq.com/openai/v1/models", {
            headers: { "Authorization": `Bearer ${GROQ_API_KEY}` }
          });
          
          if (listRes.ok) {
            const listData = await listRes.json();
            const modelosGroq = (listData.data || [])
              .map(m => m.id)
              .filter(id => !id.includes("whisper") && !id.includes("guard"));

            for (const mod of modelosGroq) {
              try {
                const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${GROQ_API_KEY}`
                  },
                  body: JSON.stringify({
                    model: mod,
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
              } catch (err) {}
            }
          }
        } catch (err) {}
      }

      // 3. Fallback final para Gemini Texto (Também em Corrida Paralela)
      if (GEMINI_API_KEY) {
        const modelosGeminiText = ["gemini-1.5-flash", "gemini-pro"];
        
        const tentarModeloTexto = async (modelo) => {
          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt + "\n\nTEXTO:\n" + texts }] }] })
          });
          if (!response.ok) throw new Error();
          const data = await response.json();
          const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!raw) throw new Error();
          const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
          return JSON.parse(clean);
        };

        try {
          const jsonResultado = await Promise.any(modelosGeminiText.map(mod => tentarModeloTexto(mod)));
          return res.status(200).json(jsonResultado);
        } catch (e) {}
      }
    }

    return res.status(500).json({ error: "Não foi possível processar a requisição com as IAs ativas." });

  } catch (error) {
    return res.status(500).json({ error: "Erro interno: " + error.message });
  }
}

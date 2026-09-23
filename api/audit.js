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
    // MODO VISÃO (Documentos e CNH com imagens)
    // ==========================================
    if (temImagens && GEMINI_API_KEY) {
      // Usa o Flash mais rápido e tem o Pro-Vision universal como garantia de segurança
      const modelosGemini = ["gemini-1.5-flash", "gemini-pro-vision"];
      let errosLogs = [];

      for (const modelo of modelosGemini) {
        try {
          const parts = [{ text: prompt }];
          if (texts) parts.push({ text: "TEXTOS ADICIONAIS:\n" + texts });
          images.forEach(img => {
            parts.push({ inline_data: { mime_type: "image/jpeg", data: img } });
          });

          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts }] })
          });

          if (response.ok) {
            const data = await response.json();
            const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (rawText) {
              const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
              return res.status(200).json(JSON.parse(cleanJson));
            }
          } else {
            const errData = await response.json();
            errosLogs.push(`${modelo}: ${errData.error?.message || 'Erro na API'}`);
          }
        } catch (err) {
          errosLogs.push(`${modelo}: ${err.message}`);
        }
      }
      return res.status(500).json({ error: "Falha na IA Visual: " + errosLogs.join(" | ") });
    }

    // ==========================================
    // MODO TEXTO (Extratos longos - Rodízio)
    // ==========================================
    if (!temImagens && texts) {
      let errosLogsText = [];

      // 1. Tenta SambaNova
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
          } else {
            errosLogsText.push(`SambaNova falhou`);
          }
        } catch (err) {
          errosLogsText.push(`SambaNova: ${err.message}`);
        }
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
              .filter(id => id.includes("llama") || id.includes("mixtral"));

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
          errosLogsText.push(`Groq falhou`);
        } catch (err) {
          errosLogsText.push(`Groq: ${err.message}`);
        }
      }

      // 3. Tenta Gemini (Fallback final)
      if (GEMINI_API_KEY) {
        const modelosGeminiText = ["gemini-1.5-flash", "gemini-pro"];
        for (const mod of modelosGeminiText) {
            try {
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mod}:generateContent?key=${GEMINI_API_KEY}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt + "\n\nTEXTO:\n" + texts }] }] })
                });
                if (response.ok) {
                  const data = await response.json();
                  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
                  if (raw) {
                      const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
                      return res.status(200).json(JSON.parse(clean));
                  }
                }
            } catch(e) {
                errosLogsText.push(`Gemini ${mod}: ${e.message}`);
            }
        }
      }

      return res.status(500).json({ error: "Todos os provedores falharam ou atingiram tempo limite. " + errosLogsText.join(" | ") });
    }

    return res.status(500).json({ error: "Não foi possível processar a requisição com as IAs ativas." });

  } catch (error) {
    return res.status(500).json({ error: "Erro interno: " + error.message });
  }
}

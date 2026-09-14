export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const { prompt, texts, images } = req.body;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const GROQ_API_KEY = process.env.GROQ_API_KEY;

  if (!GEMINI_API_KEY && !GROQ_API_KEY) {
    return res.status(500).json({ error: "Nenhuma chave de API configurada na Vercel." });
  }

  let errosLogs = [];

  // ==========================================
  // MODO 1: VISÃO (Documentos CNH/RG com imagem)
  // ==========================================
  if (images && images.length > 0 && GEMINI_API_KEY) {
    // Tenta primeiro o flash, se falhar por limite de cota, tenta o PRO
    const modelosGemini = ["gemini-1.5-flash", "gemini-2.0-flash", "gemini-1.5-pro"];
    
    for (const mod of modelosGemini) {
      try {
        const parts = [{ text: prompt }];
        // Adiciona imagens otimizadas
        images.forEach(img => {
          parts.push({ inline_data: { mime_type: "image/jpeg", data: img } });
        });

        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mod}:generateContent?key=${GEMINI_API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts }] })
        });

        if (geminiRes.ok) {
          const data = await geminiRes.json();
          const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawText) {
            const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
            return res.status(200).json(JSON.parse(cleanJson));
          }
        } else {
          const errData = await geminiRes.json();
          errosLogs.push(`[${mod}]: ${errData.error?.message}`);
        }
      } catch (e) {
        errosLogs.push(`[${mod}] Catch: ${e.message}`);
      }
    }
    return res.status(500).json({ error: "Falha na Leitura Visual. Erros: " + errosLogs.join(" | ") });
  }

  // ==========================================
  // MODO 2: TEXTO (Extratos longos)
  // ==========================================
  if (texts && texts.length > 10) {
    // Tenta Groq Primeiro (Rápido e gratuito para texto)
    if (GROQ_API_KEY) {
      try {
        const listRes = await fetch("https://api.groq.com/openai/v1/models", {
          headers: { "Authorization": `Bearer ${GROQ_API_KEY}` }
        });
        if (listRes.ok) {
          const listData = await listRes.json();
          const modelosValidos = (listData.data || [])
            .map(m => m.id)
            .filter(id => !id.includes("whisper") && !id.includes("guard"));

          for (const mod of modelosValidos) {
            try {
              const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${GROQ_API_KEY}`
                },
                body: JSON.stringify({
                  model: mod,
                  messages: [
                    { role: "system", content: "Retorne estritamente um JSON válido." },
                    { role: "user", content: prompt + "\n\nCONTEÚDO:\n" + texts }
                  ],
                  response_format: { type: "json_object" },
                  temperature: 0.1
                })
              });
              if (groqRes.ok) {
                const groqData = await groqRes.json();
                return res.status(200).json(JSON.parse(groqData.choices[0].message.content));
              }
            } catch (err) {}
          }
        }
      } catch (err) {}
    }

    // Fallback para Gemini (Texto)
    if (GEMINI_API_KEY) {
      const modelosGemini = ["gemini-1.5-flash", "gemini-2.0-flash"];
      for (const mod of modelosGemini) {
        try {
          const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mod}:generateContent?key=${GEMINI_API_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt + "\n\nTEXTO:\n" + texts }] }] })
          });
          if (geminiRes.ok) {
            const data = await geminiRes.json();
            const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (raw) {
              const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
              return res.status(200).json(JSON.parse(clean));
            }
          }
        } catch (e) {}
      }
    }
  }

  return res.status(500).json({ error: "Falha geral no processamento do servidor." });
}

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

    if (!GEMINI_API_KEY && !GROQ_API_KEY) {
      return res.status(500).json({ error: "Chaves de API não configuradas." });
    }

    const temImagens = Array.isArray(images) && images.length > 0;

    // MODO VISÃO (Documentos e CNH com imagens)
    if (temImagens && GEMINI_API_KEY) {
      const modelos = ["gemini-1.5-flash", "gemini-1.5-pro"];
      let lastError = "";

      for (const modelo of modelos) {
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
            lastError = errData.error?.message || "Erro Gemini API";
          }
        } catch (err) {
          lastError = err.message;
        }
      }
      return res.status(500).json({ error: "Falha na IA Visual: " + lastError });
    }

    // MODO TEXTO (Apenas texto, sem imagens)
    if (!temImagens && texts) {
      if (GROQ_API_KEY) {
        try {
          const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
              model: "llama-3.3-70b-versatile",
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
        } catch (err) {
          // Fallback para Gemini
        }
      }

      if (GEMINI_API_KEY) {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
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
      }
    }

    return res.status(500).json({ error: "Não foi possível processar a requisição com os modelos disponíveis." });

  } catch (error) {
    return res.status(500).json({ error: "Erro interno: " + error.message });
  }
}

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
    return res.status(500).json({ error: "Nenhuma chave configurada na Vercel." });
  }

  // Se tem imagem (foto de documento/CNH/RG), DEVE rodar no Gemini Multimodal
  if (images && Array.isArray(images) && images.length > 0 && GEMINI_API_KEY) {
    const modelosGemini = ["gemini-1.5-flash", "gemini-2.0-flash", "gemini-2.5-flash"];
    for (const mod of modelosGemini) {
      try {
        const parts = [{ text: prompt }];
        if (texts) parts.push({ text: "TEXTO DO ARQUIVO:\n" + texts });
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
          const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (raw) {
            const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
            return res.status(200).json(JSON.parse(clean));
          }
        }
      } catch (e) {}
    }
  }

  // Se for análise puramente textual volumosa (extratos) ou fallback
  if (texts && texts.length > 30) {
    // 1. Tenta Groq
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

    // 2. Tenta Gemini Texto
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

  return res.status(500).json({ error: "Não foi possível extrair os dados do documento. Tente novamente." });
}

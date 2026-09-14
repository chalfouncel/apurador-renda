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

  // 1. Descoberta Dinâmica dos Modelos Ativos na Groq
  if (texts && texts.length > 50 && GROQ_API_KEY) {
    try {
      const modelsListRes = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { "Authorization": `Bearer ${GROQ_API_KEY}` }
      });

      if (modelsListRes.ok) {
        const listData = await modelsListRes.json();
        // Filtra apenas modelos de chat utilizáveis ativos na sua conta
        const modelosValidos = listData.data
          ? listData.data.map(m => m.id).filter(id => !id.includes("whisper") && !id.includes("guard"))
          : [];

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
                  { role: "system", content: "Você é um auditor financeiro rigoroso. Retorne ESTRITAMENTE um JSON válido conforme solicitado." },
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
          } catch (e) {
            errosLogs.push(`Groq [${mod}]: ${e.message}`);
          }
        }
      }
    } catch (e) {
      errosLogs.push(`Falha listagem Groq: ${e.message}`);
    }
  }

  // 2. Fallback com modelos de Visão e Texto do Gemini
  if (GEMINI_API_KEY) {
    // Modelos com alta disponibilidade para documentos e imagens
    const modelosGemini = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-flash"];

    for (const mod of modelosGemini) {
      try {
        const parts = [{ text: prompt }];
        if (texts) parts.push({ text: "TEXTO DO DOCUMENTO:\n" + texts });
        if (images && Array.isArray(images)) {
          images.forEach(img => {
            parts.push({ inline_data: { mime_type: "image/jpeg", data: img } });
          });
        }

        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mod}:generateContent?key=${GEMINI_API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts }] })
        });

        if (geminiRes.ok) {
          const geminiData = await geminiRes.json();
          const textResp = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (textResp) {
            const cleanJson = textResp.replace(/```json/g, '').replace(/```/g, '').trim();
            return res.status(200).json(JSON.parse(cleanJson));
          }
        } else {
          const errData = await geminiRes.json().catch(() => ({}));
          errosLogs.push(`Gemini [${mod}]: ${errData.error?.message || geminiRes.statusText}`);
        }
      } catch (e) {
        errosLogs.push(`Gemini [${mod}] Exceção: ${e.message}`);
      }
    }
  }

  return res.status(500).json({ error: "Falha geral. Detalhes:\n" + errosLogs.join(" | ") });
}

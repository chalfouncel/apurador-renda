export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { prompt, texts, images } = req.body;
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  let jsonResult = null;

  try {
    // Tenta primeiro via Gemini Visão (mais robusto para imagens e documentos escaneados)
    if (GEMINI_API_KEY) {
      const modelos = ["gemini-2.0-flash", "gemini-1.5-flash"];
      
      for (let modelo of modelos) {
        try {
          const parts = [{ text: prompt }];
          if (texts) parts.push({ text: "TEXTO DO DOCUMENTO:\n" + texts });
          if (images && Array.isArray(images)) {
            images.forEach(img => {
              parts.push({ inline_data: { mime_type: "image/jpeg", data: img } });
            });
          }

          const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts }] })
          });

          if (geminiRes.ok) {
            const data = await geminiRes.json();
            const textResp = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (textResp) {
              const cleanJson = textResp.replace(/```json/g, '').replace(/```/g, '').trim();
              jsonResult = JSON.parse(cleanJson);
              break;
            }
          }
        } catch (geminiErr) {
          console.warn(`Tentativa com ${modelo} falhou:`, geminiErr);
        }
      }
    }

    // Fallback para Groq se Gemini não retornou e há texto
    if (!jsonResult && texts && GROQ_API_KEY) {
      try {
        const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            messages: [
              { role: "system", content: "Você é um auditor financeiro e contábil rigoroso. Retorne estritamente um JSON válido." },
              { role: "user", content: prompt + "\n\nTEXTOS:\n" + texts }
            ],
            response_format: { type: "json_object" },
            temperature: 0.1
          })
        });

        if (groqRes.ok) {
          const data = await groqRes.json();
          jsonResult = JSON.parse(data.choices[0].message.content);
        }
      } catch (err) {
        console.warn("Groq falhou:", err);
      }
    }

    if (!jsonResult) {
      return res.status(500).json({ error: "As IAs não conseguiram processar o documento. Verifique se as chaves da Vercel estão corretas." });
    }

    return res.status(200).json(jsonResult);

  } catch (err) {
    console.error("Erro crítico na API Serverless:", err);
    return res.status(500).json({ error: err.message || "Erro interno no servidor." });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { prompt, texts, images } = req.body;
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  let jsonResult = null;

  try {
    // 1. Tenta via Groq se houver texto relevante
    if (texts && texts.length > 30 && GROQ_API_KEY) {
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
              { role: "system", content: "Você é um auditor financeiro e contábil rigoroso especializado em apuração de renda bancária e extração documental. Retorne estritamente um JSON válido." },
              { role: "user", content: prompt + "\n\nTEXTO DO DOCUMENTO:\n" + texts }
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
        console.warn("Groq falhou, tentando Gemini...", err);
      }
    }

    // 2. Fallback para Gemini se o Groq não processou ou se há imagens puras
    if (!jsonResult && GEMINI_API_KEY) {
      const modelos = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"];
      
      for (let modelo of modelos) {
        try {
          const parts = [{ text: prompt }];
          if (texts) parts.push({ text: "TEXTO COMPLEMENTAR:\n" + texts });
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

    if (!jsonResult) {
      throw new Error("Nenhuma IA conseguiu processar os dados com as chaves configuradas na Vercel.");
    }

    return res.status(200).json(jsonResult);

  } catch (err) {
    console.error("Erro crítico na API Serverless:", err);
    return res.status(500).json({ error: err.message });
  }
}

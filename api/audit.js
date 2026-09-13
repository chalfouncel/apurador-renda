export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { prompt, texts, images } = req.body;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const GROQ_API_KEY = process.env.GROQ_API_KEY;

  if (!GEMINI_API_KEY && !GROQ_API_KEY) {
    return res.status(500).json({ error: "Nenhuma chave de API configurada nas Environment Variables da Vercel." });
  }

  let errosLogs = [];

  // 1. Varrimento automático da família Gemini atualizada (3.8, 3.7, 3.6, 3.5)
  if (GEMINI_API_KEY) {
    const modelosGemini = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-flash"];

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

        const geminiData = await geminiRes.json();

        if (geminiRes.ok) {
          const textResp = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (textResp) {
            const cleanJson = textResp.replace(/```json/g, '').replace(/```/g, '').trim();
            return res.status(200).json(JSON.parse(cleanJson));
          }
        } else {
          errosLogs.push(`Gemini [${mod}]: ${geminiData.error?.message || 'Erro'}`);
        }
      } catch (e) {
        errosLogs.push(`Gemini [${mod}] Exceção: ${e.message}`);
      }
    }
  }

  // 2. Varrimento automático dos modelos da Groq atuais
  if (GROQ_API_KEY) {
    const modelosGroq = ["llama-3.1-70b-versatile", "llama-3.1-8b-instant", "llama3-70b-8192"];

    for (const mod of modelosGroq) {
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
              { role: "user", content: prompt + "\n\n" + (texts || "") }
            ],
            response_format: { type: "json_object" },
            temperature: 0.1
          })
        });

        const groqData = await groqRes.json();

        if (groqRes.ok) {
          return res.status(200).json(JSON.parse(groqData.choices[0].message.content));
        } else {
          errosLogs.push(`Groq [${mod}]: ${groqData.error?.message || 'Erro'}`);
        }
      } catch (e) {
        errosLogs.push(`Groq [${mod}] Exceção: ${e.message}`);
      }
    }
  }

  return res.status(500).json({ error: "Todas as tentativas de IA falharam. Detalhes:\n" + errosLogs.join(" | ") });
}

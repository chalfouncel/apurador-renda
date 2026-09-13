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

  let detalheErro = "";

  try {
    // Tenta Gemini primeiro
    if (GEMINI_API_KEY) {
      const parts = [{ text: prompt }];
      if (texts) parts.push({ text: "TEXTO DO DOCUMENTO:\n" + texts });
      if (images && Array.isArray(images)) {
        images.forEach(img => {
          parts.push({ inline_data: { mime_type: "image/jpeg", data: img } });
        });
      }

      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
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
        detalheErro += ` Gemini: ${JSON.stringify(geminiData.error || geminiRes.statusText)}`;
      }
    }

    // Fallback para Groq se Gemini falhou
    if (GROQ_API_KEY) {
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
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
        detalheErro += ` Groq: ${JSON.stringify(groqData.error || groqRes.statusText)}`;
      }
    }

    return res.status(500).json({ error: `Erro nas IAs:${detalheErro}` });

  } catch (err) {
    return res.status(500).json({ error: `Exceção: ${err.message}` });
  }
}

// api/audit.js - Executado de forma segura no servidor da Vercel
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { prompt, texts, images } = req.body;
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  try {
    // Tenta primeiro via Groq se houver texto
    if (texts && texts.length > 50 && GROQ_API_KEY) {
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: "Você é um auditor financeiro e contábil rigoroso especializado em apuração de renda bancária. Retorne estritamente um JSON válido." },
            { role: "user", content: prompt + "\n\nTEXTOS:\n" + texts }
          ],
          response_format: { type: "json_object" },
          temperature: 0.1
        })
      });

      if (groqRes.ok) {
        const data = await groqRes.json();
        return res.status(200).json(JSON.parse(data.choices[0].message.content));
      }
    }

    // Fallback para Gemini Visão se Groq não estiver disponível ou houver imagens puras
    if (images && images.length > 0 && GEMINI_API_KEY) {
      const parts = [{ text: prompt }];
      if (texts) parts.push({ text: "TEXTOS COMPLEMENTARES:\n" + texts });
      images.forEach(img => parts.push({ inline_data: { mime_type: "image/jpeg", data: img } }));

      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }] })
      });

      if (geminiRes.ok) {
        const data = await geminiRes.json();
        const textResp = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (textResp) {
          const cleanJson = textResp.replace(/```json/g, '').replace(/```/g, '').trim();
          return res.status(200).json(JSON.parse(cleanJson));
        }
      }
    }

    throw new Error("Nenhuma IA conseguiu processar a solicitação com as chaves configuradas.");

  } catch (err) {
    console.error("Erro na API Serverless:", err);
    return res.status(500).json({ error: err.message });
  }
}

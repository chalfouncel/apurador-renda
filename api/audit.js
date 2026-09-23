// Aumenta o tempo limite da Vercel para 120s
export const maxDuration = 120; 

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
      const modelosGemini = ["gemini-1.5-flash", "gemini-1.5-pro"];
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
              const cleanJson = rawText.replace(/```json/g, '').replace(/

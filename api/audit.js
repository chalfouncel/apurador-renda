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
  // MODO VISÃO: Leitura do Documento (CNH/RG)
  // Ativado quando há imagem e pouco ou nenhum texto
  // ==========================================
  const isLeituraDocumento = images && images.length > 0 && (!texts || texts.length < 50);

  if (isLeituraDocumento && GEMINI_API_KEY) {
    // Modelos ATUAIS de 2026 sugeridos pelo erro da API
    const modelosGemini = ["gemini-3.6-flash", "gemini-3.8-flash", "gemini-3.5-flash"];
    
    for (const mod of modelosGemini) {
      try {
        const parts = [{ text: prompt }];
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
            const cleanJson = rawText.replace(/```json/g, '').replace(/

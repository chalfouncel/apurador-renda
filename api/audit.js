export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const { prompt, texts, images } = req.body;

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const GROQ_API_KEY = process.env.GROQ_API_KEY;

    if (!GEMINI_API_KEY && !GROQ_API_KEY) {
      return res.status(500).json({
        error: "Chaves de API não configuradas."
      });
    }

    const temImagens = Array.isArray(images) && images.length > 0;

    // ============================================================
    // MODO VISÃO — DOCUMENTOS / CNH / RG / CERTIDÃO
    // ============================================================

    if (temImagens && GEMINI_API_KEY) {

      const modelosPreferidos = [
        "gemini-3.6-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.5-flash",
        "gemini-2.5-flash"
      ];

      let modelosDisponiveis = [];
      let errosLogs = [];

      // Descobre quais modelos a chave realmente possui
      try {

        const listResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`
        );

        if (listResponse.ok) {

          const listData = await listResponse.json();

          const disponiveis = (listData.models || [])
            .filter(modelo =>
              Array.isArray(modelo.supportedGenerationMethods) &&
              modelo.supportedGenerationMethods.includes("generateContent")
            )
            .map(modelo =>
              (modelo.name || "").replace(/^models\//, "")
            );

          modelosDisponiveis = modelosPreferidos.filter(modelo =>
            disponiveis.includes(modelo)
          );

          // Fallback para qualquer Gemini atual compatível
          if (!modelosDisponiveis.length) {

            modelosDisponiveis = disponiveis
              .filter(modelo =>
                /^gemini-(3|2\.5)/.test(modelo) &&
                !/embedding|tts|image|audio|robotics/.test(modelo)
              )
              .slice(0, 4);
          }
        }

      } catch (erro) {

        errosLogs.push(
          `Erro ao consultar modelos Gemini: ${erro.message}`
        );
      }

      // Se não conseguiu consultar a lista,
      // tenta diretamente os modelos atuais.
      if (!modelosDisponiveis.length) {
        modelosDisponiveis = modelosPreferidos;
      }

      // ============================================================
      // TENTA OS MODELOS UM POR UM
      // ============================================================

      for (const modelo of modelosDisponiveis) {

        try {

          const parts = [
            {
              text: prompt
            }
          ];

          // Inclui texto extraído do PDF quando existir
          if (texts) {

            parts.push({
              text:
                "TEXTO EXTRAÍDO DO DOCUMENTO:\n" +
                texts
            });
          }

          // Inclui as imagens
          images.forEach(img => {

            parts.push({
              inline_data: {
                mime_type: "image/jpeg",
                data: img
              }
            });

          });

          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`,
            {
              method: "POST",

              headers: {
                "Content-Type": "application/json"
              },

              body: JSON.stringify({

                contents: [
                  {
                    parts: parts
                  }
                ],

                generationConfig: {
                  responseMimeType: "application/json"
                }

              })
            }
          );

          const responseText = await response.text();

          // ========================================================
          // SUCESSO
          // ========================================================

          if (response.ok) {

            const data = JSON.parse(responseText);

            const rawText =
              data.candidates?.[0]?.content?.parts?.[0]?.text;

            if (rawText) {

              const cleanJson = rawText
                .replace(/^```json\s*/i, "")
                .replace(/\s*```$/i, "")
                .trim();

              try {

                const resultado = JSON.parse(cleanJson);

                return res.status(200).json(resultado);

              } catch (erroJSON) {

                errosLogs.push(
                  `${modelo}: resposta não é JSON válido`
                );
              }

            } else {

              errosLogs.push(
                `${modelo}: resposta vazia`
              );
            }

          } else {

            let mensagem = responseText;

            try {

              const erroData =
                JSON.parse(responseText);

              mensagem =
                erroData.error?.message ||
                responseText;

            } catch (_) {}

            errosLogs.push(
              `${modelo}: ${mensagem}`
            );
          }

        } catch (erro) {

          errosLogs.push(
            `${modelo}: ${erro.message}`
          );
        }
      }

      return res.status(500).json({

        error:
          "Falha na IA Visual: " +
          errosLogs.join(" | ")

      });
    }

    // ============================================================
    // MODO TEXTO — EXTRATOS
    // ============================================================

    if (!temImagens && texts) {

      // ------------------------------------------------------------
      // GROQ
      // ------------------------------------------------------------

      if (GROQ_API_KEY) {

        try {

          const listRes = await fetch(
            "https://api.groq.com/openai/v1/models",
            {
              headers: {
                "Authorization":
                  `Bearer ${GROQ_API_KEY}`
              }
            }
          );

          if (listRes.ok) {

            const listData =
              await listRes.json();

            const modelosGroq =
              (listData.data || [])
                .map(modelo => modelo.id)
                .filter(id =>
                  !id.includes("whisper") &&
                  !id.includes("guard")
                );

            for (const modelo of modelosGroq) {

              try {

                const response = await fetch(
                  "https://api.groq.com/openai/v1/chat/completions",
                  {
                    method: "POST",

                    headers: {
                      "Content-Type":
                        "application/json",

                      "Authorization":
                        `Bearer ${GROQ_API_KEY}`
                    },

                    body: JSON.stringify({

                      model: modelo,

                      messages: [

                        {
                          role: "system",

                          content:
                            "Retorne ESTRITAMENTE um JSON válido."
                        },

                        {
                          role: "user",

                          content:
                            prompt +
                            "\n\nCONTEÚDO:\n" +
                            texts
                        }

                      ],

                      response_format: {
                        type: "json_object"
                      },

                      temperature: 0.1

                    })
                  }
                );

                if (response.ok) {

                  const data =
                    await response.json();

                  return res.status(200).json(
                    JSON.parse(
                      data.choices[0].message.content
                    )
                  );
                }

              } catch (_) {}
            }
          }

        } catch (_) {}
      }

      // ------------------------------------------------------------
      // GEMINI TEXTO
      // ------------------------------------------------------------

      if (GEMINI_API_KEY) {

        const modelosGeminiText = [
          "gemini-3.6-flash",
          "gemini-3.5-flash-lite",
          "gemini-3.5-flash",
          "gemini-2.5-flash"
        ];

        for (const modelo of modelosGeminiText) {

          try {

            const response = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`,
              {
                method: "POST",

                headers: {
                  "Content-Type":
                    "application/json"
                },

                body: JSON.stringify({

                  contents: [

                    {
                      parts: [

                        {
                          text:
                            prompt +
                            "\n\nTEXTO:\n" +
                            texts
                        }

                      ]
                    }

                  ],

                  generationConfig: {
                    responseMimeType:
                      "application/json"
                  }

                })
              }
            );

            if (response.ok) {

              const data =
                await response.json();

              const raw =
                data.candidates?.[0]
                  ?.content
                  ?.parts?.[0]
                  ?.text;

              if (raw) {

                const clean =
                  raw
                    .replace(/^```json\s*/i, "")
                    .replace(/\s*```$/i, "")
                    .trim();

                return res.status(200).json(
                  JSON.parse(clean)
                );
              }
            }

          } catch (_) {}
        }
      }
    }

    return res.status(500).json({

      error:
        "Não foi possível processar a requisição com as IAs ativas."

    });

  } catch (error) {

    return res.status(500).json({

      error:
        "Erro interno: " +
        error.message

    });
  }
}

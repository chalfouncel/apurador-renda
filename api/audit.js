export default async function handler(req, res) {

  res.setHeader(
    'Access-Control-Allow-Credentials',
    true
  );

  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'OPTIONS,POST'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  );


  if (
    req.method === 'OPTIONS'
  ) {

    return res
      .status(200)
      .end();

  }


  if (
    req.method !== 'POST'
  ) {

    return res
      .status(405)
      .json({
        error:
          'Método não permitido'
      });

  }


  try {

    const {
      prompt,
      texts,
      images
    } =
      req.body || {};


    const GEMINI_API_KEY =
      process.env.GEMINI_API_KEY;


    const GROQ_API_KEY =
      process.env.GROQ_API_KEY;


    if (
      !GEMINI_API_KEY &&
      !GROQ_API_KEY
    ) {

      return res
        .status(500)
        .json({

          error:
            'Chaves de API não configuradas.'

        });

    }


    const temImagens =
      Array.isArray(images) &&
      images.length > 0;


    const temTexto =
      typeof texts === 'string' &&
      texts.trim().length > 0;


    // ==========================================================
    // DESCOBRIR MODELOS GEMINI
    // ==========================================================

    async function obterModelosGemini() {

      if (
        !GEMINI_API_KEY
      ) {

        return [];

      }


      try {

        const response =
          await fetch(

            `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`

          );


        if (
          !response.ok
        ) {

          return [];

        }


        const data =
          await response.json();


        const modelos =
          (data.models || [])

            .filter(
              modelo =>

                Array.isArray(
                  modelo
                    .supportedGenerationMethods
                )

                &&

                modelo
                  .supportedGenerationMethods
                  .includes(
                    'generateContent'
                  )

            )

            .map(
              modelo =>

                (modelo.name || '')
                  .replace(
                    /^models\//,
                    ''
                  )

            )

            .filter(
              modelo =>

                /^gemini-/.test(
                  modelo
                )

            );


        // ======================================================
        // PRIORIZAR FLASH
        // ======================================================

        const flash =
          modelos.filter(
            modelo =>

              /flash/i.test(
                modelo
              )

          );


        const outros =
          modelos.filter(
            modelo =>

              !flash.includes(
                modelo
              )

          );


        return [

          ...flash,

          ...outros

        ].slice(
          0,
          5
        );


      } catch (_) {

        return [];

      }

    }


    // ==========================================================
    // MODO VISION
    //
    // CNH / RG / CERTIDÃO
    // e páginas escaneadas.
    // ==========================================================

    if (

      temImagens &&

      GEMINI_API_KEY

    ) {

      const modelos =
        await obterModelosGemini();


      const erros = [];


      for (
        const modelo of modelos
      ) {

        try {

          const parts = [

            {

              text:
                prompt || ''

            }

          ];


          // Texto extraído também acompanha
          // a imagem quando existir.

          if (
            temTexto
          ) {

            parts.push({

              text:

                'TEXTO EXTRAÍDO:\n' +
                texts

            });

          }


          // ====================================================
          // IMAGENS
          // ====================================================

          for (
            const img of images
          ) {

            parts.push({

              inline_data: {

                mime_type:
                  'image/jpeg',

                data:
                  img

              }

            });

          }


          const response =
            await fetch(

              `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`,

              {

                method:
                  'POST',

                headers: {

                  'Content-Type':
                    'application/json'

                },

                body:
                  JSON.stringify({

                    contents: [

                      {

                        parts:
                          parts

                      }

                    ],

                    generationConfig: {

                      temperature:
                        0.1,

                      responseMimeType:
                        'application/json'

                    }

                  })

              }

            );


          const responseText =
            await response.text();


          if (
            !response.ok
          ) {

            let msg =
              responseText;


            try {

              msg =

                JSON.parse(
                  responseText
                )
                .error
                ?.message ||

                responseText;


            } catch (_) {}


            erros.push(

              `${modelo}: ${msg}`

            );


            continue;

          }


          const data =
            JSON.parse(
              responseText
            );


          const raw =

            data
              .candidates?.[0]
              ?.content
              ?.parts
              ?.map(
                p =>
                  p.text || ''
              )
              .join('')
              .trim();


          if (
            !raw
          ) {

            erros.push(

              `${modelo}: resposta vazia`

            );


            continue;

          }


          const clean =

            raw

              .replace(
                /^```json\s*/i,
                ''
              )

              .replace(
                /\s*```$/i,
                ''
              )

              .trim();


          return res
            .status(200)
            .json(

              JSON.parse(
                clean
              )

            );


        } catch (erro) {

          erros.push(

            `${modelo}: ${erro.message}`

          );

        }

      }


      return res
        .status(500)
        .json({

          error:

            'Falha na IA Visual: ' +

            erros.join(
              ' | '
            )

        });

    }


    // ==========================================================
    // MODO TEXTO
    //
    // PRINCIPAL PARA EXTRATOS PDF DIGITAIS
    // ==========================================================

    if (

      temTexto &&

      GEMINI_API_KEY

    ) {

      const modelos =
        await obterModelosGemini();


      const erros = [];


      for (
        const modelo of modelos
      ) {

        try {

          const response =
            await fetch(

              `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`,

              {

                method:
                  'POST',

                headers: {

                  'Content-Type':
                    'application/json'

                },

                body:
                  JSON.stringify({

                    contents: [

                      {

                        parts: [

                          {

                            text:

                              (prompt || '') +

                              '\n\nCONTEÚDO DOS EXTRATOS:\n' +

                              texts

                          }

                        ]

                      }

                    ],

                    generationConfig: {

                      temperature:
                        0.1,

                      responseMimeType:
                        'application/json'

                    }

                  })

              }

            );


          const responseText =
            await response.text();


          if (
            !response.ok
          ) {

            let msg =
              responseText;


            try {

              msg =

                JSON.parse(
                  responseText
                )
                .error
                ?.message ||

                responseText;


            } catch (_) {}


            erros.push(

              `${modelo}: ${msg}`

            );


            continue;

          }


          const data =
            JSON.parse(
              responseText
            );


          const raw =

            data
              .candidates?.[0]
              ?.content
              ?.parts
              ?.map(
                p =>
                  p.text || ''
              )
              .join('')
              .trim();


          if (
            !raw
          ) {

            continue;

          }


          const clean =

            raw

              .replace(
                /^```json\s*/i,
                ''
              )

              .replace(
                /\s*```$/i,
                ''
              )

              .trim();


          return res
            .status(200)
            .json(

              JSON.parse(
                clean
              )

            );


        } catch (erro) {

          erros.push(

            `${modelo}: ${erro.message}`

          );

        }

      }

    }


    // ==========================================================
    // FALLBACK GROQ
    //
    // Somente texto.
    // ==========================================================

    if (

      temTexto &&

      GROQ_API_KEY

    ) {

      try {

        const listRes =
          await fetch(

            'https://api.groq.com/openai/v1/models',

            {

              headers: {

                Authorization:
                  `Bearer ${GROQ_API_KEY}`

              }

            }

          );


        if (
          listRes.ok
        ) {

          const listData =
            await listRes.json();


          const modelos =

            (listData.data || [])

              .map(
                modelo =>
                  modelo.id
              )

              .filter(

                id =>

                  !id.includes(
                    'whisper'
                  )

                  &&

                  !id.includes(
                    'guard'
                  )

              );


          for (
            const modelo of modelos
          ) {

            try {

              const response =
                await fetch(

                  'https://api.groq.com/openai/v1/chat/completions',

                  {

                    method:
                      'POST',

                    headers: {

                      'Content-Type':
                        'application/json',

                      Authorization:
                        `Bearer ${GROQ_API_KEY}`

                    },

                    body:
                      JSON.stringify({

                        model:
                          modelo,

                        messages: [

                          {

                            role:
                              'system',

                            content:

                              'Retorne ESTRITAMENTE um JSON válido.'

                          },

                          {

                            role:
                              'user',

                            content:

                              (prompt || '') +

                              '\n\nCONTEÚDO DOS EXTRATOS:\n' +

                              texts

                          }

                        ],

                        response_format: {

                          type:
                            'json_object'

                        },

                        temperature:
                          0.1

                      })

                  }

                );


              if (
                response.ok
              ) {

                const data =
                  await response.json();


                const content =

                  data
                    .choices?.[0]
                    ?.message
                    ?.content;


                if (
                  content
                ) {

                  return res
                    .status(200)
                    .json(

                      JSON.parse(
                        content
                      )

                    );

                }

              }

            } catch (_) {}

          }

        }

      } catch (_) {}

    }


    // ==========================================================
    // ERRO FINAL
    // ==========================================================

    return res
      .status(500)
      .json({

        error:

          'Não foi possível processar a requisição com as IAs ativas.'

      });


  } catch (error) {

    return res
      .status(500)
      .json({

        error:

          'Erro interno: ' +
          error.message

      });

  }

}

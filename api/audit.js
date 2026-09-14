export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Método não permitido'
    });
  }

  try {

    const {
      prompt,
      texts,
      images,
      action
    } = req.body || {};

    const GEMINI_API_KEY =
      process.env.GEMINI_API_KEY;

    const GROQ_API_KEY =
      process.env.GROQ_API_KEY;

    if (!GEMINI_API_KEY && !GROQ_API_KEY) {
      return res.status(500).json({
        error: 'Chaves de API não configuradas.'
      });
    }

    const temImagens =
      Array.isArray(images) &&
      images.length > 0;

    const temTexto =
      typeof texts === 'string' &&
      texts.trim().length > 0;


    // ==========================================================
    // IDENTIFICAÇÃO DE TITULAR / VÍNCULOS
    // ==========================================================
    // Estas ações são usadas pelo index.html em segundo plano.
    // 1) Ao anexar o extrato, identifica o titular do extrato.
    // 2) Ao anexar um documento/certidão, usa o titular do extrato
    //    como referência para determinar pai, mãe e cônjuge.
    // ==========================================================

    function limparRespostaJson(raw) {

      if (!raw) return null;

      const texto = String(raw)
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      try {

        return JSON.parse(texto);

      } catch (_) {

        const ini =
          texto.indexOf('{');

        const fim =
          texto.lastIndexOf('}');

        if (
          ini >= 0 &&
          fim > ini
        ) {

          try {

            return JSON.parse(
              texto.slice(
                ini,
                fim + 1
              )
            );

          } catch (_) {}
        }
      }

      return null;
    }


    async function chamarGeminiIdentificacao(
      promptIdentificacao,
      textoIdentificacao,
      imagensIdentificacao
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
                promptIdentificacao
            }
          ];

          if (
            textoIdentificacao
          ) {

            parts.push({
              text:
                '\n\nTEXTO EXTRAÍDO DO DOCUMENTO:\n' +
                textoIdentificacao
            });
          }

          if (
            Array.isArray(
              imagensIdentificacao
            )
          ) {

            for (
              const img of
              imagensIdentificacao
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
          }

          const response =
            await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`,
              {
                method: 'POST',

                headers: {
                  'Content-Type':
                    'application/json'
                },

                body:
                  JSON.stringify({
                    contents: [
                      {
                        parts
                      }
                    ],

                    generationConfig: {
                      temperature:
                        0.05,

                      responseMimeType:
                        'application/json'
                    }
                  })
              }
            );

          const responseText =
            await response.text();

          if (!response.ok) {

            let msg =
              responseText;

            try {

              msg =
                JSON.parse(
                  responseText
                ).error?.message ||
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
            data.candidates?.[0]?.content?.parts
              ?.map(
                p =>
                  p.text || ''
              )
              .join('')
              .trim();

          const json =
            limparRespostaJson(
              raw
            );

          if (json)
            return json;

        } catch (e) {

          erros.push(
            `${modelo}: ${e.message}`
          );
        }
      }

      throw new Error(
        erros.join(' | ') ||
        'Nenhum modelo Gemini disponível.'
      );
    }


    // ----------------------------------------------------------
    // AÇÃO: identifica o titular do extrato.
    // ----------------------------------------------------------

    if (
      action ===
      'identificar_titular_extrato'
    ) {

      if (!GEMINI_API_KEY) {

        return res.status(500).json({
          error:
            'GEMINI_API_KEY não configurada.'
        });
      }

      try {

        const textoExtrato =
          String(
            texts || ''
          ).slice(
            0,
            120000
          );

        const resultado =
          await chamarGeminiIdentificacao(

            `Você é responsável exclusivamente por IDENTIFICAR O TITULAR DA CONTA bancária.

Analise o texto e/ou imagens do extrato bancário.

REGRAS:
- Procure o nome que aparece como titular da conta.
- Priorize cabeçalho do extrato, nome da conta, identificação do cliente e informações equivalentes.
- NÃO escolha o nome de uma pessoa que fez uma transferência recebida.
- NÃO escolha o nome de uma pessoa que recebeu uma transferência enviada.
- NÃO escolha nomes de familiares ou terceiros apenas porque aparecem nas transações.
- Se o extrato tiver várias páginas, use o nome de titular repetido no cabeçalho.
- Retorne somente o nome do titular encontrado.
- Se não for possível identificar com segurança, retorne string vazia.

JSON OBRIGATÓRIO:
{
  "titular_extrato": ""
}`,

            textoExtrato,

            images
          );

        return res.status(200).json({
          titular_extrato:
            String(
              resultado.titular_extrato ||
              ''
            )
            .trim()
            .toUpperCase()
        });

      } catch (e) {

        return res.status(500).json({
          error:
            'Falha ao identificar titular do extrato: ' +
            e.message
        });
      }
    }


    // ----------------------------------------------------------
    // AÇÃO: relaciona certidão/documento ao titular do extrato.
    // ----------------------------------------------------------

    if (
      action ===
      'identificar_vinculos_documento'
    ) {

      if (!GEMINI_API_KEY) {

        return res.status(500).json({
          error:
            'GEMINI_API_KEY não configurada.'
        });
      }

      try {

        const titularExtrato =
          String(
            req.body?.titular_extrato ||
            ''
          ).trim();

        const textoDocumento =
          String(
            texts || ''
          ).slice(
            0,
            120000
          );

        const resultado =
          await chamarGeminiIdentificacao(

            `Você é um perito documental.

O TITULAR DO EXTRATO BANCÁRIO JÁ FOI IDENTIFICADO COMO:
"${titularExtrato}"

Agora analise cuidadosamente o documento anexado (CNH, RG, certidão de casamento ou outro documento civil).

OBJETIVO:
Preencher os dados de PAI, MÃE e CÔNJUGE EXATAMENTE EM RELAÇÃO AO TITULAR DO EXTRATO acima.

REGRAS OBRIGATÓRIAS:

1. O titular do extrato é a referência principal. Não troque o titular por outra pessoa que apareça no documento.

2. Se for CERTIDÃO DE CASAMENTO:
   - Identifique os dois cônjuges/esposos descritos na certidão.
   - Compare os nomes com o TITULAR DO EXTRATO.
   - O outro esposo/cônjuge é o "conjuge" do titular do extrato.
   - Nunca coloque o nome do outro cônjuge no campo "pai" ou "mae".
   - Procure especificamente a filiação do titular do extrato para obter pai e mãe.
   - Se a certidão apresentar a filiação dos dois cônjuges, escolha SOMENTE a filiação correspondente ao titular do extrato.

3. Se for CNH/RG:
   - Identifique a filiação do próprio titular.
   - Se houver cônjuge explicitamente informado, use-o; caso contrário, deixe vazio.

4. NÃO deduza parentesco por sobrenome.
5. NÃO invente dados.
6. NÃO use o nome de testemunhas, declarantes, pais do outro cônjuge ou autoridades como pai/mãe do titular.
7. Preserve o nome completo conforme aparece no documento.
8. Se um campo não estiver comprovado no documento, retorne string vazia.
9. O titular do extrato deve ser reconhecido mesmo que o documento apresente variação de acentuação ou ordem dos sobrenomes.

RETORNE SOMENTE ESTE JSON:
{
  "titular_extrato": "${titularExtrato}",
  "titular_documento": "",
  "tipo_documento": "",
  "pai": "",
  "mae": "",
  "conjuge": ""
}`,

            textoDocumento,

            images
          );

        return res.status(200).json({

          titular_extrato:
            titularExtrato,

          titular_documento:
            String(
              resultado.titular_documento ||
              ''
            )
            .trim()
            .toUpperCase(),

          tipo_documento:
            String(
              resultado.tipo_documento ||
              ''
            )
            .trim()
            .toUpperCase(),

          pai:
            String(
              resultado.pai ||
              ''
            )
            .trim()
            .toUpperCase(),

          mae:
            String(
              resultado.mae ||
              ''
            )
            .trim()
            .toUpperCase(),

          conjuge:
            String(
              resultado.conjuge ||
              ''
            )
            .trim()
            .toUpperCase()
        });

      } catch (e) {

        return res.status(500).json({
          error:
            'Falha ao relacionar documento ao titular do extrato: ' +
            e.message
        });
      }
    }


    // ==========================================================
    // DESCOBRE MODELOS GEMINI DISPONÍVEIS
    // ==========================================================

    async function obterModelosGemini() {

      if (!GEMINI_API_KEY) {
        return [];
      }

      try {

        const response =
          await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`
          );

        if (!response.ok) {
          return [];
        }

        const data =
          await response.json();

        const modelos =
          (data.models || [])

            .filter(
              modelo =>
                Array.isArray(
                  modelo.supportedGenerationMethods
                ) &&
                modelo.supportedGenerationMethods
                  .includes(
                    'generateContent'
                  )
            )

            .map(
              modelo =>
                (
                  modelo.name || ''
                )
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
    // VALIDAÇÃO DETERMINÍSTICA DA AUDITORIA
    // A IA classifica; o servidor valida regras que não devem
    // depender de interpretação probabilística.
    // ==========================================================

    function normalizarNome(valor) {

      return String(
        valor || ''
      )

        .normalize('NFD')

        .replace(
          /[\u0300-\u036f]/g,
          ''
        )

        .toUpperCase()

        .replace(
          /[^A-Z0-9 ]/g,
          ' '
        )

        .replace(
          /\b(JR|JUNIOR)\b/g,
          ' '
        )

        .replace(
          /\s+/g,
          ' '
        )

        .trim();
    }


    function nomeCorresponde(
      descricao,
      nome
    ) {

      const a =
        normalizarNome(
          descricao
        );

      const b =
        normalizarNome(
          nome
        );

      if (
        !a ||
        !b
      ) {
        return false;
      }

      if (
        a.includes(b)
      ) {
        return true;
      }

      const tokens =
        b
          .split(' ')
          .filter(
            t =>
              t.length >= 3
          );

      if (
        !tokens.length
      ) {
        return false;
      }

      const hits =
        tokens.filter(
          t =>
            a.includes(t)
        ).length;

      return (
        hits >=
        Math.max(
          2,
          Math.ceil(
            tokens.length *
            0.7
          )
        )
      );
    }


    function extrairCpfTitular(
      texto
    ) {

      const m =
        String(
          texto || ''
        ).match(
          /CPF\s+([^\n]{0,80}?\d{3}\.\d{3}\.\d{3}-\d{2}|[^\n]{0,80}?•{2,}\.?\d{3}\.?\d{3}-?•{2})/i
        );

      return m
        ? String(
            m[1]
          ).replace(
            /\s+/g,
            ''
          )
        : '';
    }


    function cpfMascaradoCorresponde(
      descricao,
      cpfTitular
    ) {

      if (!cpfTitular)
        return false;

      const alvo =
        String(
          cpfTitular
        ).replace(
          /\s+/g,
          ''
        );

      const trecho =
        String(
          descricao || ''
        ).replace(
          /\s+/g,
          ''
        );

      return (
        alvo.length > 5 &&
        trecho.includes(
          alvo
        )
      );
    }


    function normalizarAuditoria(
      resultado,
      textoExtratos,
      cliente
    ) {

      const r =
        resultado &&
        typeof resultado === 'object'
          ? resultado
          : {};

      const transacoes =
        Array.isArray(
          r.transacoes
        )
          ? r.transacoes
          : [];

      const titular =
        String(
          cliente?.titular ||
          ''
        ).trim();

      const pai =
        String(
          cliente?.pai ||
          ''
        ).trim();

      const mae =
        String(
          cliente?.mae ||
          ''
        ).trim();

      const conjuge =
        String(
          cliente?.conjuge ||
          ''
        ).trim();

      const cpfTitular =
        extrairCpfTitular(
          textoExtratos
        );


      const rejeicoes = [

        {
          nome:
            titular,
          motivo:
            'Mesma titularidade'
        },

        {
          nome:
            pai,
          motivo:
            'Parentesco excluído — pai do titular'
        },

        {
          nome:
            mae,
          motivo:
            'Parentesco excluído — mãe do titular'
        },

        {
          nome:
            conjuge,
          motivo:
            'Parentesco excluído — cônjuge do titular'
        }

      ].filter(
        x =>
          x.nome
      );


      const termosExclusao = [

        [
          'RESGATE RDB',
          'Resgate de investimento'
        ],

        [
          'RESGATE',
          'Resgate de investimento'
        ],

        [
          'APLICACAO RDB',
          'Aplicação de investimento'
        ],

        [
          'APLICAÇÃO RDB',
          'Aplicação de investimento'
        ],

        [
          'CDB',
          'Movimentação de investimento'
        ],

        [
          'INVESTIMENTO',
          'Movimentação de investimento'
        ],

        [
          'COFRINHO',
          'Movimentação de investimento'
        ],

        [
          'RENDIMENTO',
          'Rendimento automático'
        ],

        [
          'REEMBOLSO',
          'Estorno, devolução ou reembolso'
        ],

        [
          'ESTORNO',
          'Estorno, devolução ou reembolso'
        ],

        [
          'DEVOLUCAO',
          'Estorno, devolução ou reembolso'
        ],

        [
          'DEVOLUÇÃO',
          'Estorno, devolução ou reembolso'
        ]

      ];


      const normalizadas =
        transacoes.map(
          t => {

            const item = {
              ...t
            };

            const descricao =
              String(
                item.descricao ||
                ''
              ).trim();

            const upper =
              normalizarNome(
                descricao
              );

            const valor =
              Number(
                item.valor
              ) || 0;

            let status =
              String(
                item.status ||
                ''
              ).toUpperCase() ===
              'CONSIDERADO'
                ? 'CONSIDERADO'
                : 'REJEITADO';

            let motivo =
              String(
                item.motivo ||
                ''
              ).trim();


            for (
              const [
                termo,
                motivoExclusao
              ]
              of termosExclusao
            ) {

              if (
                upper.includes(
                  normalizarNome(
                    termo
                  )
                )
              ) {

                status =
                  'REJEITADO';

                motivo =
                  motivoExclusao;

                break;
              }
            }


            if (
              cpfMascaradoCorresponde(
                descricao,
                cpfTitular
              )
            ) {

              status =
                'REJEITADO';

              motivo =
                'Mesma titularidade — CPF do titular';
            }


            if (
              status ===
              'CONSIDERADO'
            ) {

              for (
                const itemRejeicao
                of rejeicoes
              ) {

                if (
                  nomeCorresponde(
                    descricao,
                    itemRejeicao.nome
                  )
                ) {

                  status =
                    'REJEITADO';

                  motivo =
                    itemRejeicao.motivo;

                  break;
                }
              }
            }


            if (
              status ===
              'CONSIDERADO' &&
              valor <= 0
            ) {

              status =
                'REJEITADO';

              motivo =
                'Valor de entrada inválido';
            }


            return {

              ...item,

              valor,

              status,

              motivo:
                motivo ||
                (
                  status ===
                  'CONSIDERADO'
                    ? 'Renda válida'
                    : 'Rejeitado pelas regras de auditoria'
                )
            };
          }
        );


      // Recalcula os consolidados EXCLUSIVAMENTE a partir das linhas auditadas.
      // Isso impede que a IA produza um resumo matematicamente incompatível
      // com a própria tabela discriminada.

      const porMes =
        new Map();

      let totalConsiderado =
        0;

      let totalRejeitado =
        0;


      for (
        const t of normalizadas
      ) {

        const valor =
          Number(
            t.valor
          ) || 0;

        if (
          t.status ===
          'CONSIDERADO'
        ) {

          totalConsiderado +=
            valor;

          const mes =
            String(
              t.mes_ano ||
              ''
            ).trim();

          if (mes)
            porMes.set(
              mes,
              (
                porMes.get(mes) ||
                0
              ) + valor
            );

        } else {

          totalRejeitado +=
            valor;
        }
      }


      const apuracaoMensal =
        Array.from(
          porMes.entries()
        )
        .map(
          (
            [
              mes_ano,
              somatorio_entradas
            ]
          ) => ({

            mes_ano,

            somatorio_entradas:
              Number(
                somatorio_entradas
                  .toFixed(2)
              )
          })
        );


      const quantidadeMeses =
        apuracaoMensal.length;

      const media =
        quantidadeMeses
          ? totalConsiderado /
            quantidadeMeses
          : 0;


      return {

        resumo_geral: {

          total_entradas_consideradas:
            Number(
              totalConsiderado.toFixed(2)
            ),

          total_entradas_descartadas:
            Number(
              totalRejeitado.toFixed(2)
            ),

          quantidade_meses:
            quantidadeMeses,

          renda_media_mensal:
            Number(
              media.toFixed(2)
            )
        },

        apuracao_mensal:
          apuracaoMensal,

        transacoes:
          normalizadas
      };
    }


    // ==========================================================
    // VISION
    // Usado para CNH/RG e páginas escaneadas.
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


          if (temTexto) {

            parts.push({
              text:
                'TEXTO EXTRAÍDO:\n' +
                texts
            });
          }


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


          if (!response.ok) {

            let msg =
              responseText;

            try {

              msg =
                JSON.parse(
                  responseText
                ).error?.message ||
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
            data.candidates?.[0]
              ?.content
              ?.parts
              ?.map(
                p =>
                  p.text || ''
              )
              .join('')
              .trim();


          if (!raw) {

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


          const resultado =
            JSON.parse(
              clean
            );


          const ehAuditoria =
            !!(
              resultado &&
              (
                resultado.transacoes ||
                resultado.resumo_geral ||
                resultado.apuracao_mensal
              )
            );


          return res.status(
            200
          ).json(

            ehAuditoria
              ? normalizarAuditoria(
                  resultado,
                  texts,
                  req.body || {}
                )
              : resultado

          );


        } catch (e) {

          erros.push(
            `${modelo}: ${e.message}`
          );
        }
      }


      return res.status(
        500
      ).json({

        error:
          'Falha na IA Visual: ' +
          erros.join(' | ')
      });
    }


    // ==========================================================
    // TEXTO — PRINCIPAL PARA EXTRATOS DIGITAIS
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


          if (!response.ok) {

            let msg =
              responseText;

            try {

              msg =
                JSON.parse(
                  responseText
                ).error?.message ||
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
            data.candidates?.[0]
              ?.content
              ?.parts
              ?.map(
                p =>
                  p.text || ''
              )
              .join('')
              .trim();


          if (!raw) {
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


          const resultado =
            JSON.parse(
              clean
            );


          const ehAuditoria =
            !!(
              resultado &&
              (
                resultado.transacoes ||
                resultado.resumo_geral ||
                resultado.apuracao_mensal
              )
            );


          return res.status(
            200
          ).json(

            ehAuditoria
              ? normalizarAuditoria(
                  resultado,
                  texts,
                  req.body || {}
                )
              : resultado

          );


        } catch (e) {

          erros.push(
            `${modelo}: ${e.message}`
          );
        }
      }
    }


    // ==========================================================
    // FALLBACK GROQ — SOMENTE TEXTO
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


        if (listRes.ok) {

          const listData =
            await listRes.json();


          const modelos =
            (listData.data || [])

              .map(
                m =>
                  m.id
              )

              .filter(
                id =>
                  !id.includes(
                    'whisper'
                  ) &&
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


              if (response.ok) {

                const data =
                  await response.json();


                const content =
                  data.choices?.[0]
                    ?.message
                    ?.content;


                if (content) {

                  const resultado =
                    JSON.parse(
                      content
                    );


                  const ehAuditoria =
                    !!(
                      resultado &&
                      (
                        resultado.transacoes ||
                        resultado.resumo_geral ||
                        resultado.apuracao_mensal
                      )
                    );


                  return res.status(
                    200
                  ).json(

                    ehAuditoria
                      ? normalizarAuditoria(
                          resultado,
                          texts,
                          req.body || {}
                        )
                      : resultado

                  );
                }
              }


            } catch (_) {}
          }
        }


      } catch (_) {}
    }


    return res.status(
      500
    ).json({

      error:
        'Não foi possível processar a requisição com as IAs ativas.'
    });


  } catch (error) {

    return res.status(
      500
    ).json({

      error:
        'Erro interno: ' +
        error.message
    });
  }
}

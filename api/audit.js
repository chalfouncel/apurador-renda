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
    // LIMPEZA DE JSON
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
      } catch (_) {}

      const inicio = texto.indexOf('{');
      const fim = texto.lastIndexOf('}');

      if (inicio >= 0 && fim > inicio) {
        try {
          return JSON.parse(
            texto.slice(inicio, fim + 1)
          );
        } catch (_) {}
      }

      return null;
    }

    // ==========================================================
    // MODELOS GEMINI
    // ==========================================================

    async function obterModelosGemini() {
      if (!GEMINI_API_KEY) return [];

      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`
        );

        if (!response.ok) return [];

        const data = await response.json();

        const modelos =
          (data.models || [])
            .filter(modelo =>
              Array.isArray(
                modelo.supportedGenerationMethods
              ) &&
              modelo.supportedGenerationMethods.includes(
                'generateContent'
              )
            )
            .map(modelo =>
              String(modelo.name || '')
                .replace(/^models\//, '')
            )
            .filter(modelo =>
              /^gemini-/i.test(modelo)
            );

        const flash =
          modelos.filter(modelo =>
            /flash/i.test(modelo)
          );

        const outros =
          modelos.filter(modelo =>
            !flash.includes(modelo)
          );

        return [
          ...flash,
          ...outros
        ].slice(0, 5);

      } catch (_) {
        return [];
      }
    }

    // ==========================================================
    // CHAMADA GEMINI ESPECIALIZADA
    // ==========================================================

    async function chamarGeminiIdentificacao(
      promptIdentificacao,
      textoIdentificacao,
      imagensIdentificacao
    ) {
      const modelos =
        await obterModelosGemini();

      const erros = [];

      for (const modelo of modelos) {
        try {
          const parts = [
            {
              text: promptIdentificacao
            }
          ];

          if (textoIdentificacao) {
            parts.push({
              text:
                '\n\nTEXTO EXTRAÍDO DO DOCUMENTO:\n' +
                textoIdentificacao
            });
          }

          if (
            Array.isArray(imagensIdentificacao)
          ) {
            for (
              const img of imagensIdentificacao
            ) {
              parts.push({
                inline_data: {
                  mime_type: 'image/jpeg',
                  data: img
                }
              });
            }
          }

          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`,
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json'
              },
              body: JSON.stringify({
                contents: [
                  {
                    parts
                  }
                ],
                generationConfig: {
                  temperature: 0.05,
                  responseMimeType:
                    'application/json'
                }
              })
            }
          );

          const responseText =
            await response.text();

          if (!response.ok) {
            let msg = responseText;

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
            JSON.parse(responseText);

          const raw =
            data.candidates?.[0]
              ?.content
              ?.parts
              ?.map(
                p => p.text || ''
              )
              .join('')
              .trim();

          const json =
            limparRespostaJson(raw);

          if (json) {
            return json;
          }

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

    // ==========================================================
    // AÇÃO 1
    // IDENTIFICAR TITULAR DO EXTRATO
    // ==========================================================

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
          String(texts || '')
            .slice(0, 120000);

        const resultado =
          await chamarGeminiIdentificacao(
            `
Você é responsável exclusivamente por
IDENTIFICAR O TITULAR DA CONTA BANCÁRIA.

Analise o texto e/ou imagens do extrato bancário.

OBJETIVO:
Encontrar o NOME DO TITULAR DA CONTA.

REGRAS ABSOLUTAS:

1. Procure primeiro:
   - cabeçalho do extrato;
   - identificação do cliente;
   - nome da conta;
   - nome do titular;
   - dados da conta;
   - informações repetidas no cabeçalho das páginas.

2. NÃO confunda o titular com:
   - remetente de PIX;
   - pessoa que fez transferência;
   - pessoa que recebeu transferência;
   - familiar;
   - cônjuge;
   - beneficiário;
   - favorecido;
   - empresa;
   - terceiro.

3. Uma pessoa aparecer em uma transferência recebida NÃO significa que ela seja o titular.

4. Se o nome do titular aparecer várias vezes no documento, use esse nome como prioridade.

5. Não invente.

6. Não deduza o titular pelo maior número de transações.

7. Não deduza o titular pelo nome mais frequente nas movimentações.

8. Se não houver segurança suficiente, retorne string vazia.

RETORNE SOMENTE:

{
  "titular_extrato": ""
}
`,
            textoExtrato,
            images
          );

        return res.status(200).json({
          titular_extrato:
            String(
              resultado?.titular_extrato || ''
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

    // ==========================================================
    // AÇÃO 2
    // IDENTIFICAR PAI, MÃE E CÔNJUGE
    // SEMPRE EM RELAÇÃO AO TITULAR DO EXTRATO
    // ==========================================================

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
            req.body?.titular_extrato || ''
          )
            .trim();

        const textoDocumento =
          String(texts || '')
            .slice(0, 120000);

        const resultado =
          await chamarGeminiIdentificacao(
            `
Você é um PERITO DOCUMENTAL.

O TITULAR DO EXTRATO BANCÁRIO JÁ FOI
IDENTIFICADO COMO:

"${titularExtrato}"

Este nome é a REFERÊNCIA PRINCIPAL
e NÃO deve ser substituído por outra pessoa.

Agora analise cuidadosamente o documento
anexado.

O documento pode ser:

- RG
- CNH
- Certidão de casamento
- Certidão civil
- outro documento oficial

OBJETIVO:

Encontrar:

1. PAI do titular do extrato
2. MÃE do titular do extrato
3. CÔNJUGE do titular do extrato

REGRAS ABSOLUTAS:

============================================================
REGRA 1 — TITULAR
============================================================

O titular do extrato é:

"${titularExtrato}"

Não troque essa pessoa por outra pessoa
mencionada no documento.

============================================================
REGRA 2 — CERTIDÃO DE CASAMENTO
============================================================

Se for certidão de casamento:

1. Identifique os dois cônjuges.

2. Compare os nomes encontrados com:

"${titularExtrato}"

3. Determine qual dos dois é o titular do extrato.

4. O OUTRO CÔNJUGE deve ser colocado no campo:

"conjuge"

5. Procure a FILIAÇÃO DO PRÓPRIO TITULAR.

6. Se a certidão apresentar:

- filiação do primeiro cônjuge;
- filiação do segundo cônjuge;

use somente a filiação correspondente
ao titular do extrato.

7. NÃO coloque os pais do outro cônjuge
como pai ou mãe do titular.

============================================================
REGRA 3 — PAI
============================================================

O campo "pai" deve conter somente o
pai biológico/documental do titular do extrato,
quando expressamente identificado.

NÃO use:

- pai do cônjuge;
- testemunha;
- declarante;
- autoridade;
- padrinho;
- pessoa com sobrenome semelhante.

============================================================
REGRA 4 — MÃE
============================================================

O campo "mae" deve conter somente a
mãe biológica/documental do titular do extrato,
quando expressamente identificada.

NÃO use:

- mãe do cônjuge;
- testemunha;
- declarante;
- autoridade;
- pessoa com sobrenome semelhante.

============================================================
REGRA 5 — SOBRENOME
============================================================

NÃO deduza parentesco apenas por sobrenome.

Sobrenome igual NÃO é prova suficiente.

============================================================
REGRA 6 — NÃO INVENTAR
============================================================

Se o documento não comprovar um determinado
campo, retorne:

""

Não tente completar o campo com conhecimento externo.

============================================================
REGRA 7 — NOMES
============================================================

Preserve o nome completo conforme aparece
no documento.

Não abrevie.

Não corrija.

Não invente.

============================================================
REGRA 8 — TITULAR DO DOCUMENTO
============================================================

Informe também quem a IA entende ser o
titular apresentado no documento.

============================================================

RETORNE SOMENTE ESTE JSON:

{
  "titular_extrato": "${titularExtrato}",
  "titular_documento": "",
  "tipo_documento": "",
  "pai": "",
  "mae": "",
  "conjuge": ""
}
`,
            textoDocumento,
            images
          );

        return res.status(200).json({
          titular_extrato:
            titularExtrato,

          titular_documento:
            String(
              resultado?.titular_documento ||
              ''
            )
              .trim()
              .toUpperCase(),

          tipo_documento:
            String(
              resultado?.tipo_documento ||
              ''
            )
              .trim()
              .toUpperCase(),

          pai:
            String(
              resultado?.pai || ''
            )
              .trim()
              .toUpperCase(),

          mae:
            String(
              resultado?.mae || ''
            )
              .trim()
              .toUpperCase(),

          conjuge:
            String(
              resultado?.conjuge || ''
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
    // VISION GENÉRICA
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
              text: prompt || ''
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
                mime_type: 'image/jpeg',
                data: img
              }
            });
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
                body: JSON.stringify({
                  contents: [
                    {
                      parts
                    }
                  ],
                  generationConfig: {
                    temperature: 0.1,
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
            JSON.parse(responseText);

          const raw =
            data.candidates?.[0]
              ?.content
              ?.parts
              ?.map(
                p => p.text || ''
              )
              .join('')
              .trim();

          const resultado =
            limparRespostaJson(raw);

          if (resultado) {
            return res.status(200).json(
              resultado
            );
          }

        } catch (e) {

          erros.push(
            `${modelo}: ${e.message}`
          );
        }
      }

      return res.status(500).json({
        error:
          'Falha na IA Visual: ' +
          erros.join(' | ')
      });
    }

    // ==========================================================
    // TEXTO
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
                method: 'POST',

                headers: {
                  'Content-Type':
                    'application/json'
                },

                body: JSON.stringify({
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
                    temperature: 0.05,
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
            JSON.parse(responseText);

          const raw =
            data.candidates?.[0]
              ?.content
              ?.parts
              ?.map(
                p => p.text || ''
              )
              .join('')
              .trim();

          const resultado =
            limparRespostaJson(raw);

          if (resultado) {

            return res.status(200).json(
              resultado
            );
          }

        } catch (e) {

          erros.push(
            `${modelo}: ${e.message}`
          );
        }
      }
    }

    // ==========================================================
    // FALLBACK GROQ
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
              .map(m => m.id)
              .filter(id =>
                !id.includes('whisper') &&
                !id.includes('guard')
              );

          for (
            const modelo of modelos
          ) {

            try {

              const response =
                await fetch(
                  'https://api.groq.com/openai/v1/chat/completions',
                  {
                    method: 'POST',

                    headers: {
                      'Content-Type':
                        'application/json',

                      Authorization:
                        `Bearer ${GROQ_API_KEY}`
                    },

                    body: JSON.stringify({
                      model: modelo,

                      messages: [
                        {
                          role: 'system',
                          content:
                            'Você é um auditor financeiro. Retorne exclusivamente JSON válido.'
                        },
                        {
                          role: 'user',
                          content:
                            (prompt || '') +
                            '\n\nCONTEÚDO DOS EXTRATOS:\n' +
                            texts
                        }
                      ],

                      response_format: {
                        type: 'json_object'
                      },

                      temperature: 0.05
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
                    limparRespostaJson(
                      content
                    );

                  if (resultado) {

                    return res.status(200).json(
                      resultado
                    );
                  }
                }
              }

            } catch (_) {}
          }
        }

      } catch (_) {}
    }

    return res.status(500).json({
      error:
        'Não foi possível processar a requisição com as IAs ativas.'
    });

  } catch (error) {

    return res.status(500).json({
      error:
        'Erro interno: ' +
        error.message
    });
  }
}

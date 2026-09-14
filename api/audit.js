export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Método não permitido'
    });
  }

  try {
    const {
      prompt,
      texts,
      images
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
    // UTILITÁRIOS
    // ==========================================================

    function limparJson(raw) {
      if (!raw) return null;

      let texto = String(raw)
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      try {
        return JSON.parse(texto);
      } catch (_) {
        const inicio = texto.indexOf('{');
        const fim = texto.lastIndexOf('}');

        if (inicio >= 0 && fim > inicio) {
          try {
            return JSON.parse(
              texto.substring(inicio, fim + 1)
            );
          } catch (_) {}
        }
      }

      return null;
    }


    function normalizarNome(nome) {
      return String(nome || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }


    function numeroValido(valor) {
      const n = Number(valor);
      return Number.isFinite(n) ? n : null;
    }


    function arredondar(valor) {
      return Math.round(
        (Number(valor) + Number.EPSILON) * 100
      ) / 100;
    }


    function ehEntrada(transacao) {
      const descricao =
        normalizarNome(transacao?.descricao);

      if (
        descricao.includes('TOTAL DE ENTRADAS') ||
        descricao.includes('TOTAL ENTRADAS')
      ) {
        return false;
      }

      const status =
        normalizarNome(transacao?.status);

      if (
        status.includes('SAIDA') ||
        status.includes('SAÍDA')
      ) {
        return false;
      }

      return true;
    }


    function ehTotalDiario(descricao) {
      const d = normalizarNome(descricao);

      return (
        d.includes('TOTAL DE ENTRADAS') ||
        d.includes('TOTAL ENTRADAS') ||
        d.includes('TOTAL DE SAIDAS') ||
        d.includes('TOTAL SAÍDAS')
      );
    }


    function obterDataChave(data) {
      if (!data) return '';

      const m =
        String(data).match(
          /(\d{2})\/(\d{2})\/(\d{4})/
        );

      if (!m) return String(data);

      return `${m[1]}/${m[2]}/${m[3]}`;
    }


    // ==========================================================
    // EXTRAÇÃO DETERMINÍSTICA DOS LANÇAMENTOS DO TEXTO
    //
    // IMPORTANTE:
    // O "Total de entradas" NÃO é uma transação.
    // O valor pertence sempre ao lançamento imediatamente
    // correspondente à descrição.
    // ==========================================================

    function extrairLancamentosDoTexto(texto) {
      if (!texto) return [];

      const linhas =
        String(texto)
          .split(/\r?\n/)
          .map(l => l.trim())
          .filter(Boolean);

      const resultados = [];

      let dataAtual = '';

      const regexData =
        /^(\d{2})\s+(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\s+(\d{4})/i;

      const meses = {
        JAN: '01',
        FEV: '02',
        MAR: '03',
        ABR: '04',
        MAI: '05',
        JUN: '06',
        JUL: '07',
        AGO: '08',
        SET: '09',
        OUT: '10',
        NOV: '11',
        DEZ: '12'
      };

      function converterData(linha) {
        const m = linha.match(regexData);

        if (!m) return null;

        const mes =
          meses[m[2].toUpperCase()];

        if (!mes) return null;

        return `${m[1]}/${mes}/${m[3]}`;
      }

      function extrairValorFinal(linha) {
        const normalizada =
          String(linha)
            .replace(/\s+/g, ' ')
            .trim();

        const matches =
          normalizada.match(
            /(?:R\$\s*)?(-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+(?:,\d{2})?)\s*$/
          );

        if (!matches) {
          return null;
        }

        const bruto =
          matches[1]
            .replace(/\./g, '')
            .replace(',', '.');

        const valor =
          Number(bruto);

        return Number.isFinite(valor)
          ? valor
          : null;
      }

      function ehLinhaIgnorada(linha) {
        const d =
          normalizarNome(linha);

        return (
          d.startsWith('TOTAL DE ENTRADAS') ||
          d.startsWith('TOTAL ENTRADAS') ||
          d.startsWith('TOTAL DE SAIDAS') ||
          d.startsWith('TOTAL SAIDAS') ||
          d.startsWith('SALDO FINAL') ||
          d.startsWith('SALDO INICIAL') ||
          d.includes('EXTRATO GERADO') ||
          d.startsWith('TEM ALGUMA DUVIDA') ||
          d.startsWith('CASO A SOLUCAO')
        );
      }

      for (let i = 0; i < linhas.length; i++) {
        const linha =
          linhas[i];

        const novaData =
          converterData(linha);

        if (novaData) {
          dataAtual = novaData;
          continue;
        }

        if (!dataAtual) {
          continue;
        }

        if (ehLinhaIgnorada(linha)) {
          continue;
        }

        const normalizada =
          normalizarNome(linha);

        const ehRecebimento =
          normalizada.includes(
            'TRANSFERENCIA RECEBIDA PELO PIX'
          ) ||
          normalizada.includes(
            'TED RECEBIDA'
          ) ||
          normalizada.includes(
            'DEPOSITO RECEBIDO'
          ) ||
          normalizada.includes(
            'CREDITO RECEBIDO'
          );

        if (!ehRecebimento) {
          continue;
        }

        let descricao =
          linha;

        let valor = null;

        /*
         * O Nubank frequentemente quebra uma operação
         * em várias linhas:
         *
         * Transferência recebida pelo Pix NOME...
         * BANCO...
         * Agência...
         * Conta...
         * 150,00
         *
         * Portanto procuramos o valor nas linhas seguintes,
         * mas paramos ao encontrar outro lançamento,
         * outra data ou um total.
         */

        let textoOperacao =
          linha;

        for (
          let j = i + 1;
          j < Math.min(i + 12, linhas.length);
          j++
        ) {
          const proxima =
            linhas[j];

          if (converterData(proxima)) {
            break;
          }

          const proxNormalizada =
            normalizarNome(proxima);

          if (
            proxNormalizada.startsWith(
              'TOTAL DE ENTRADAS'
            ) ||
            proxNormalizada.startsWith(
              'TOTAL ENTRADAS'
            ) ||
            proxNormalizada.startsWith(
              'TOTAL DE SAIDAS'
            ) ||
            proxNormalizada.startsWith(
              'TOTAL SAIDAS'
            )
          ) {
            break;
          }

          if (
            proxNormalizada.includes(
              'TRANSFERENCIA RECEBIDA PELO PIX'
            ) ||
            proxNormalizada.includes(
              'TRANSFERENCIA ENVIADA PELO PIX'
            ) ||
            proxNormalizada.startsWith(
              'COMPRA NO DEBITO'
            ) ||
            proxNormalizada.startsWith(
              'PAGAMENTO DE BOLETO'
            )
          ) {
            break;
          }

          const valorLinha =
            extrairValorFinal(proxima);

          if (
            valorLinha !== null &&
            valorLinha > 0
          ) {
            valor = valorLinha;
            break;
          }

          textoOperacao +=
            ' ' + proxima;
        }

        if (
          valor !== null &&
          valor > 0
        ) {
          resultados.push({
            data: dataAtual,
            descricao: textoOperacao,
            valor: arredondar(valor)
          });
        }
      }

      return resultados;
    }


    // ==========================================================
    // REMOVE TOTAIS DIÁRIOS QUE A IA TENHA TRANSFORMADO
    // EM TRANSAÇÕES
    // ==========================================================

    function removerTotaisComoTransacoes(resultado) {
      if (!resultado) return resultado;

      if (
        !Array.isArray(resultado.transacoes)
      ) {
        resultado.transacoes = [];
        return resultado;
      }

      resultado.transacoes =
        resultado.transacoes.filter(
          t => !ehTotalDiario(t?.descricao)
        );

      return resultado;
    }


    // ==========================================================
    // RECONCILIAÇÃO MATEMÁTICA
    //
    // Compara os lançamentos da IA com os lançamentos
    // encontrados diretamente no texto.
    //
    // A finalidade é detectar:
    // - total diário tratado como transação;
    // - valor associado ao remetente errado;
    // - duplicidade;
    // - valor impossível;
    // - resumo diferente da tabela.
    // ==========================================================

    function reconciliarResultado(resultado, textoOriginal) {
      if (!resultado) {
        return {
          resultado: null,
          divergencias: ['Resultado vazio']
        };
      }

      removerTotaisComoTransacoes(resultado);

      const fonte =
        extrairLancamentosDoTexto(
          textoOriginal
        );

      const divergencias = [];

      /*
       * Se não conseguimos extrair lançamentos
       * deterministicamente, não alteramos cegamente
       * o resultado da IA.
       */
      if (!fonte.length) {
        divergencias.push(
          'Não foi possível reconstruir lançamentos diretamente do texto.'
        );

        return {
          resultado,
          divergencias
        };
      }

      const transacoes =
        Array.isArray(resultado.transacoes)
          ? resultado.transacoes
          : [];

      /*
       * Agrupa a fonte por data.
       */
      const fontePorData = {};

      for (const item of fonte) {
        const chave =
          obterDataChave(item.data);

        if (!fontePorData[chave]) {
          fontePorData[chave] = [];
        }

        fontePorData[chave].push(item);
      }


      /*
       * Agrupa IA por data.
       */
      const iaPorData = {};

      for (const item of transacoes) {
        const chave =
          obterDataChave(item.data);

        if (!iaPorData[chave]) {
          iaPorData[chave] = [];
        }

        iaPorData[chave].push(item);
      }


      /*
       * Verificação de subtotal diário.
       */
      for (const data of Object.keys(fontePorData)) {
        const fonteDia =
          fontePorData[data] || [];

        const iaDia =
          iaPorData[data] || [];

        const totalFonte =
          arredondar(
            fonteDia.reduce(
              (s, x) => s + Number(x.valor || 0),
              0
            )
          );

        const totalIA =
          arredondar(
            iaDia.reduce(
              (s, x) => s + Number(x.valor || 0),
              0
            )
          );

        if (
          Math.abs(totalFonte - totalIA) >
          0.01
        ) {
          divergencias.push(
            `Divergência em ${data}: fonte R$ ${totalFonte.toFixed(2)} x IA R$ ${totalIA.toFixed(2)}.`
          );
        }
      }


      /*
       * Verificação de associação valor/remetente.
       *
       * Se encontramos uma transação da IA cujo valor
       * não existe na fonte correspondente ao mesmo dia,
       * ela é suspeita.
       */
      for (const ia of transacoes) {
        const data =
          obterDataChave(ia.data);

        const fonteDia =
          fontePorData[data] || [];

        const valorIA =
          arredondar(
            Number(ia.valor || 0)
          );

        const mesmaValor =
          fonteDia.filter(
            x =>
              Math.abs(
                Number(x.valor) -
                valorIA
              ) <= 0.01
          );

        if (!mesmaValor.length) {
          divergencias.push(
            `Valor R$ ${valorIA.toFixed(2)} em ${data} não encontrado como lançamento individual na fonte.`
          );
        }
      }


      /*
       * Se houve divergência, NÃO fazemos uma substituição
       * cega pela fonte.
       *
       * Marcamos para segunda análise da IA.
       */
      return {
        resultado,
        divergencias,
        fonte
      };
    }


    // ==========================================================
    // RECALCULA O RESUMO A PARTIR DAS TRANSAÇÕES
    // ==========================================================

    function recalcularResumo(resultado) {
      if (!resultado) return resultado;

      const transacoes =
        Array.isArray(resultado.transacoes)
          ? resultado.transacoes
          : [];

      const consideradas =
        transacoes.filter(
          t =>
            normalizarNome(t?.status)
              .includes('CONSIDERADO') &&
            !ehTotalDiario(t?.descricao)
        );

      const rejeitadas =
        transacoes.filter(
          t =>
            normalizarNome(t?.status)
              .includes('REJEITADO') &&
            !ehTotalDiario(t?.descricao)
        );

      const totalConsiderado =
        arredondar(
          consideradas.reduce(
            (s, t) =>
              s + Number(t.valor || 0),
            0
          )
        );

      const totalDescartado =
        arredondar(
          rejeitadas.reduce(
            (s, t) =>
              s + Number(t.valor || 0),
            0
          )
        );

      const meses = {};

      for (const t of consideradas) {
        const mes =
          t.mes_ano ||
          (
            String(t.data || '')
              .match(
                /^\d{2}\/\d{2}\/\d{4}$/
              )
              ? String(t.data).substring(3)
              : ''
          );

        if (!mes) continue;

        if (!meses[mes]) {
          meses[mes] = 0;
        }

        meses[mes] +=
          Number(t.valor || 0);
      }

      const apuracaoMensal =
        Object.keys(meses)
          .sort()
          .map(mes => ({
            mes_ano: mes,
            somatorio_entradas:
              arredondar(meses[mes])
          }));

      const quantidadeMeses =
        apuracaoMensal.length;

      const media =
        quantidadeMeses
          ? arredondar(
              totalConsiderado /
              quantidadeMeses
            )
          : 0;

      resultado.resumo_geral = {
        ...(resultado.resumo_geral || {}),
        total_entradas_consideradas:
          totalConsiderado,
        total_entradas_descartadas:
          totalDescartado,
        quantidade_meses:
          quantidadeMeses,
        renda_media_mensal:
          media
      };

      resultado.apuracao_mensal =
        apuracaoMensal;

      return resultado;
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
            .filter(modelo =>
              Array.isArray(
                modelo.supportedGenerationMethods
              ) &&
              modelo.supportedGenerationMethods
                .includes('generateContent')
            )
            .map(modelo =>
              (modelo.name || '')
                .replace(
                  /^models\//,
                  ''
                )
            )
            .filter(modelo =>
              /^gemini-/.test(modelo)
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
    // CHAMADA GEMINI TEXTO
    // ==========================================================

    async function chamarGeminiTexto(
      modelos,
      promptCompleto
    ) {
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
                            promptCompleto
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
            JSON.parse(
              responseText
            );

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
            limparJson(raw);

          if (resultado) {
            return {
              resultado,
              erros
            };
          }

          erros.push(
            `${modelo}: JSON inválido`
          );

        } catch (e) {
          erros.push(
            `${modelo}: ${e.message}`
          );
        }
      }

      return {
        resultado: null,
        erros
      };
    }


    // ==========================================================
    // VISION
    //
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
                mime_type:
                  'image/jpeg',
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
            JSON.parse(
              responseText
            );

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
            limparJson(raw);

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
    // TEXTO — PRINCIPAL PARA EXTRATOS DIGITAIS
    // ==========================================================

    if (
      temTexto &&
      GEMINI_API_KEY
    ) {
      const modelos =
        await obterModelosGemini();

      /*
       * PROMPT PRINCIPAL
       *
       * A regra crítica está aqui:
       * "TOTAL DE ENTRADAS" NÃO É TRANSAÇÃO.
       */

      const promptPrincipal = `
Você é um perito financeiro e auditor contábil.

Audite rigorosamente TODAS as entradas financeiras contidas em todo o período dos extratos.

REGRAS ABSOLUTAS DE EXTRAÇÃO:

1. CADA transferência recebida é um lançamento individual.

2. O valor deve permanecer obrigatoriamente associado à descrição/remetente imediatamente correspondente.

3. NUNCA use "Total de entradas" como uma transação.

4. NUNCA use "Total de saídas" como uma transação.

5. "Total de entradas" é somente um subtotal diário e NÃO deve aparecer no array "transacoes".

6. Se em um determinado dia houver:
   - R$ 7,50 recebido por MELL LANUSSY MORET
   - R$ 150,00 recebido por ANDRE LUIZ MINEIRO DOS SANTOS
   e o extrato informar "Total de entradas + R$ 157,50",
   devem existir DUAS transações:
   - MELL LANUSSY MORET = R$ 7,50
   - ANDRE LUIZ MINEIRO DOS SANTOS = R$ 150,00
   O valor de R$ 157,50 jamais deve ser usado como transação.

7. O subtotal diário deve ser matematicamente igual à soma das transações individuais daquele dia.

8. Nunca redistribua um valor de uma transação para outra somente para fazer a soma fechar.

9. Não associe um valor à pessoa anterior ou posterior. O valor pertence à operação imediatamente correspondente no documento.

10. Se a descrição estiver quebrada em várias linhas, reconstrua a descrição antes de associar o valor.

11. Considere apenas ENTRADAS.

12. Transferências da mesma titularidade do cliente devem ser rejeitadas.

13. Transferências entre familiares devem ser rejeitadas.

14. Estornos, devoluções, reembolsos, aplicações, resgates de investimentos, CDB, RDB, cofrinhos e rendimentos automáticos devem ser rejeitados.

15. Não invente nenhuma transação.

16. Não some dois lançamentos em um só.

17. Não divida um lançamento em dois.

18. O campo "valor" deve representar o valor individual da transação, nunca um subtotal.

Regras de exclusão:

Titular:
"${normalizarNome(
  prompt || ''
)}"

Os dados completos do cliente e as regras específicas já estão contidos nas instruções do aplicativo.

RETORNE ESTRITAMENTE JSON VÁLIDO:

{
  "resumo_geral": {
    "total_entradas_consideradas": 0.00,
    "total_entradas_descartadas": 0.00,
    "quantidade_meses": 0,
    "renda_media_mensal": 0.00
  },
  "apuracao_mensal": [
    {
      "mes_ano": "04/2026",
      "somatorio_entradas": 0.00
    }
  ],
  "transacoes": [
    {
      "data": "DD/MM/AAAA",
      "mes_ano": "MM/AAAA",
      "descricao": "descrição completa do lançamento",
      "valor": 0.00,
      "status": "CONSIDERADO",
      "motivo": "Renda válida"
    }
  ]
}

NÃO coloque "Total de entradas" ou "Total de saídas" no array de transacoes.
`;

      const promptComTexto =
        (prompt || '') +
        '\n\n' +
        promptPrincipal +
        '\n\nCONTEÚDO ORIGINAL DOS EXTRATOS:\n' +
        texts;

      const primeira =
        await chamarGeminiTexto(
          modelos,
          promptComTexto
        );

      if (primeira.resultado) {

        let resultado =
          primeira.resultado;

        const recon =
          reconciliarResultado(
            resultado,
            texts
          );

        /*
         * Se houver divergência, fazemos uma segunda
         * auditoria corretiva.
         */
        if (
          recon.divergencias &&
          recon.divergencias.length > 0
        ) {

          const promptCorrecao = `
Você está realizando uma SEGUNDA AUDITORIA DE RECONCILIAÇÃO.

O primeiro resultado apresentou divergências.

É OBRIGATÓRIO corrigir somente as inconsistências demonstradas.

REGRAS:

- "Total de entradas" NÃO é transação.
- "Total de saídas" NÃO é transação.
- Cada valor deve permanecer associado ao remetente correto.
- Não transfira valores entre pessoas.
- Não agrupe lançamentos.
- Não divida lançamentos.
- Use o texto original como fonte primária.
- O subtotal diário deve ser igual à soma das transações individuais.
- Se o documento mostrar duas transferências no mesmo dia, mantenha duas transações.
- Nunca use o subtotal diário como valor de uma transação.

DIVERGÊNCIAS DETECTADAS:
${recon.divergencias.join('\n')}

PRIMEIRO RESULTADO:
${JSON.stringify(
  resultado,
  null,
  2
)}

Retorne o JSON completo corrigido no mesmo formato.
`;

          const segunda =
            await chamarGeminiTexto(
              modelos,
              promptCorrecao +
              '\n\nTEXTO ORIGINAL:\n' +
              texts
            );

          if (segunda.resultado) {
            resultado =
              segunda.resultado;
          }
        }

        /*
         * Remove novamente qualquer total que a IA
         * tenha introduzido na segunda etapa.
         */
        removerTotaisComoTransacoes(
          resultado
        );

        /*
         * Recalcula o resumo com base na tabela.
         */
        recalcularResumo(
          resultado
        );

        return res.status(200).json(
          resultado
        );
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
              .map(m => m.id)
              .filter(id =>
                !id.includes('whisper') &&
                !id.includes('guard')
              );

          for (
            const modelo of modelos
          ) {
            try {

              const promptGroq = `
${prompt || ''}

REGRAS CRÍTICAS DE AUDITORIA:

- Cada transferência recebida é uma transação individual.
- "Total de entradas" é subtotal e NÃO é transação.
- "Total de saídas" é subtotal e NÃO é transação.
- Nunca use o subtotal diário como lançamento.
- O valor deve permanecer vinculado ao remetente correto.
- Não agrupe transações.
- Não divida transações.
- Não associe o valor de uma operação ao remetente de outra.
- O total diário deve corresponder à soma das transações individuais.

RETORNE ESTRITAMENTE JSON VÁLIDO.

CONTEÚDO DOS EXTRATOS:
${texts}
`;

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
                            'Você é um auditor financeiro rigoroso. Retorne ESTRITAMENTE JSON válido.'
                        },

                        {
                          role: 'user',
                          content:
                            promptGroq
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

                  let resultado =
                    limparJson(content);

                  if (resultado) {

                    removerTotaisComoTransacoes(
                      resultado
                    );

                    recalcularResumo(
                      resultado
                    );

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


    // ==========================================================
    // ERRO FINAL
    // ==========================================================

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

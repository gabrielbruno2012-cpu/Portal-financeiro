const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const PDFDocument = require('pdfkit');

const app = express();
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, '../public')));

const DB = path.join(__dirname, 'sql', 'financeiro.db');
const db = new sqlite3.Database(DB);


function monthKey(ano, mes){
  return `${ano}-${String(mes).padStart(2,'0')}`;
}
function shiftMonth(ano, mes, delta){
  const d = new Date(`${ano}-${String(mes).padStart(2,'0')}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth()+delta);
  return { ano: d.getUTCFullYear(), mes: String(d.getUTCMonth()+1).padStart(2,'0') };
}

function toMonthRange(ano, mes) {
  const m = String(mes).padStart(2,'0');
  const start = `${ano}-${m}-01`;
  const dt = new Date(`${ano}-${m}-01T00:00:00Z`);
  dt.setUTCMonth(dt.getUTCMonth()+1);
  const end = dt.toISOString().slice(0,10);
  return { start, end };
}
function healthIndicator(margem, saldo) {
  if (saldo < 0) return { cor: 'vermelho', texto: 'Prejuízo no período' };
  if (margem >= 0.15) return { cor: 'verde', texto: 'Saudável' };
  return { cor: 'amarelo', texto: 'Atenção na margem' };
}

app.get('/', (req,res)=> res.sendFile(path.join(__dirname,'../public/finance/login.html')));

app.post('/api/fin/login', (req,res)=>{
  const { email, senha } = req.body;
  db.get('SELECT id,nome,email,role FROM usuarios_financeiro WHERE email=? AND senha=?', [email, senha], (err,row)=>{
    if (err) return res.status(500).json({ error:'db' });
    if (!row) return res.status(401).json({ error:'invalid' });
    res.json(row);
  });
});

// =========================
// EMPRESAS (CRUD básico)
// =========================

// listar (inclui ativas e inativas; o front pode filtrar se quiser)
app.get('/api/fin/empresas', (req,res)=>{
  db.all('SELECT id,nome,cnpj,ativo FROM empresas ORDER BY id', [], (err,rows)=>{
    if (err) return res.status(500).json({ error:'db' });
    res.json(rows || []);
  });
});

// criar
app.post('/api/fin/empresas', (req,res)=>{
  const { nome, cnpj } = req.body || {};
  if (!nome) return res.status(400).json({ error:'params' });

  db.run(
    'INSERT INTO empresas (nome, cnpj, ativo) VALUES (?,?,1)',
    [String(nome).trim(), String(cnpj||'').trim()],
    function(err){
      if (err) return res.status(500).json({ error:'db' });
      const newId = this.lastID;
      // cria config de impostos default (se não existir)
      db.run(
        `INSERT INTO impostos_config (empresa_id,simples_percent,taxas_percent,outros_percent,atualizado_em)
         VALUES (?,?,?,?,datetime('now'))
         ON CONFLICT(empresa_id) DO NOTHING`,
        [newId, 0, 0, 0],
        ()=> res.json({ id: newId })
      );
    }
  );
});

// editar (nome/cnpj/ativo)
app.put('/api/fin/empresas/:id', (req,res)=>{
  const id = Number(req.params.id);
  const { nome, cnpj, ativo } = req.body || {};
  if (!id || !nome) return res.status(400).json({ error:'params' });

  db.run(
    'UPDATE empresas SET nome=?, cnpj=?, ativo=? WHERE id=?',
    [String(nome).trim(), String(cnpj||'').trim(), (ativo===undefined?1:Number(ativo)), id],
    (err)=>{
      if (err) return res.status(500).json({ error:'db' });
      res.json({ ok:true });
    }
  );
});

app.get('/api/fin/impostos', (req,res)=>{
  const empresa_id = req.query.empresa_id;
  if (!empresa_id) return res.status(400).json({ error:'params' });
  db.get('SELECT empresa_id,simples_percent,taxas_percent,outros_percent,atualizado_em FROM impostos_config WHERE empresa_id=?',
    [empresa_id], (err,row)=>{
      if (err) return res.status(500).json({ error:'db' });
      if (!row) return res.json({ empresa_id, simples_percent:0, taxas_percent:0, outros_percent:0 });
      res.json(row);
    });
});

app.put('/api/fin/impostos', (req,res)=>{
  const { empresa_id, simples_percent, taxas_percent, outros_percent } = req.body;
  if (!empresa_id) return res.status(400).json({ error:'params' });
  db.run(
    `INSERT INTO impostos_config (empresa_id,simples_percent,taxas_percent,outros_percent,atualizado_em)
     VALUES (?,?,?,?,datetime('now'))
     ON CONFLICT(empresa_id) DO UPDATE SET
       simples_percent=excluded.simples_percent,
       taxas_percent=excluded.taxas_percent,
       outros_percent=excluded.outros_percent,
       atualizado_em=datetime('now')`,
    [empresa_id, Number(simples_percent||0), Number(taxas_percent||0), Number(outros_percent||0)],
    (err)=>{
      if (err) return res.status(500).json({ error:'db' });
      res.json({ ok:true });
    }
  );
});

app.get('/api/fin/categorias', (req,res)=>{
  const empresa_id = req.query.empresa_id;
  const tipo = req.query.tipo;
  if (!empresa_id || !tipo) return res.status(400).json({ error:'params' });
  db.all('SELECT id,empresa_id,tipo,nome FROM categorias WHERE empresa_id=? AND tipo=? ORDER BY nome',
    [empresa_id, tipo], (err,rows)=>{
      if (err) return res.status(500).json({ error:'db' });
      res.json(rows);
    });
});

app.get('/api/fin/lancamentos', (req,res)=>{
  const { empresa_id, ano, mes, tipo, status, q } = req.query;
  if (!ano || !mes) return res.status(400).json({ error:'params' });

  const { start, end } = toMonthRange(ano, mes);
  let where = 'WHERE l.data >= ? AND l.data < ?';
  const params = [start, end];

  if (empresa_id && empresa_id !== 'all') { where += ' AND l.empresa_id=?'; params.push(empresa_id); }
  if (tipo && tipo !== 'all') { where += ' AND l.tipo=?'; params.push(tipo); }
  if (status && status !== 'all') { where += ' AND l.status=?'; params.push(status); }
  if (q && q.trim()) { where += ' AND (l.descricao LIKE ? OR l.forma LIKE ? OR l.conta LIKE ?)'; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }

  const sql = `
    SELECT l.id,l.empresa_id,e.nome as empresa_nome,l.tipo,l.data,l.valor,l.categoria_id,c.nome as categoria_nome,
           l.status,l.descricao,l.forma,l.conta,l.criado_em
    FROM lancamentos l
    LEFT JOIN empresas e ON e.id=l.empresa_id
    LEFT JOIN categorias c ON c.id=l.categoria_id
    ${where}
    ORDER BY l.data DESC, l.id DESC
  `;
  db.all(sql, params, (err,rows)=>{
    if (err) return res.status(500).json({ error:'db' });
    res.json(rows);
  });
});

app.post('/api/fin/lancamentos', (req,res)=>{
  const { empresa_id, tipo, data, valor, categoria_id, status, descricao, forma, conta } = req.body;
  if (!empresa_id || !tipo || !data || valor===undefined) return res.status(400).json({ error:'params' });

  db.run(
    `INSERT INTO lancamentos (empresa_id,tipo,data,valor,categoria_id,status,descricao,forma,conta)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [empresa_id, tipo, data, Number(valor), categoria_id||null, status||'Pago', descricao||'', forma||'', conta||''],
    function(err){
      if (err) return res.status(500).json({ error:'db' });
      res.json({ id:this.lastID });
    }
  );
});

app.put('/api/fin/lancamentos/:id', (req,res)=>{
  const id = req.params.id;
  const { empresa_id, tipo, data, valor, categoria_id, status, descricao, forma, conta } = req.body;
  db.run(
    `UPDATE lancamentos SET empresa_id=?,tipo=?,data=?,valor=?,categoria_id=?,status=?,descricao=?,forma=?,conta=? WHERE id=?`,
    [empresa_id, tipo, data, Number(valor), categoria_id||null, status||'Pago', descricao||'', forma||'', conta||'', id],
    (err)=>{
      if (err) return res.status(500).json({ error:'db' });
      res.json({ ok:true });
    }
  );
});

app.delete('/api/fin/lancamentos/:id', (req,res)=>{
  const id = req.params.id;
  db.run('DELETE FROM lancamentos WHERE id=?', [id], (err)=>{
    if (err) return res.status(500).json({ error:'db' });
    res.json({ ok:true });
  });
});


// Projeção automática (média móvel) - receita/despesa/resultado
// Usa os últimos N meses (default 6) e projeta o próximo mês pela média dos últimos 3 meses disponíveis.
app.get('/api/fin/projecao', (req,res)=>{
  const { empresa_id, ano, mes, n } = req.query;
  if (!ano || !mes) return res.status(400).json({ error:'params' });

  const N = Math.max(3, Math.min(24, Number(n||6)));
  const meses = [];
  for(let i=N-1;i>=0;i--){
    const m = shiftMonth(Number(ano), Number(mes), -i);
    meses.push(m);
  }

  const empresaWhere = (empresa_id && empresa_id !== 'all') ? ' AND empresa_id=?' : '';
  const results = [];

  const runOne = (i) => {
    if (i >= meses.length) {
      // projeção: média dos últimos 3 meses (ou menos se não tiver)
      const tail = results.slice(-3).filter(x => (x.receitas>0 || x.despesas>0));
      const denom = tail.length || 1;
      const projReceitas = tail.reduce((a,x)=>a+x.receitas,0) / denom;
      const projDespesas = tail.reduce((a,x)=>a+x.despesas,0) / denom;
      const projResultado = projReceitas - projDespesas;
      const next = shiftMonth(Number(ano), Number(mes), 1);

      return res.json({
        serie: results,
        projecao: { ano: String(next.ano), mes: String(next.mes), receitas: projReceitas, despesas: projDespesas, resultado: projResultado }
      });
    }

    const m = meses[i];
    const range = toMonthRange(m.ano, m.mes);
    const params = [range.start, range.end];
    if (empresaWhere) params.push(empresa_id);

    db.get(
      `SELECT
        SUM(CASE WHEN tipo='RECEITA' THEN valor ELSE 0 END) as receitas,
        SUM(CASE WHEN tipo='DESPESA' THEN valor ELSE 0 END) as despesas
       FROM lancamentos
       WHERE data >= ? AND data < ? ${empresaWhere}`,
      params,
      (err,row)=>{
        if (err) return res.status(500).json({ error:'db' });
        const receitas = Number(row?.receitas||0);
        const despesas = Number(row?.despesas||0);
        results.push({
          ano: String(m.ano),
          mes: String(m.mes),
          key: monthKey(m.ano, m.mes),
          receitas,
          despesas,
          resultado: receitas - despesas
        });
        runOne(i+1);
      }
    );
  };

  runOne(0);
});


app.get('/api/fin/dashboard', (req,res)=>{
  const { empresa_id, ano, mes } = req.query;
  if (!ano || !mes) return res.status(400).json({ error:'params' });

  const { start, end } = toMonthRange(ano, mes);
  const empresaWhere = (empresa_id && empresa_id !== 'all') ? ' AND empresa_id=?' : '';
  const params = [start, end];
  if (empresaWhere) params.push(empresa_id);

  const sql = `
    SELECT
      SUM(CASE WHEN tipo='RECEITA' THEN valor ELSE 0 END) as receitas,
      SUM(CASE WHEN tipo='DESPESA' THEN valor ELSE 0 END) as despesas
    FROM lancamentos
    WHERE data >= ? AND data < ? ${empresaWhere}
  `;

  db.get(sql, params, (err,row)=>{
    if (err) return res.status(500).json({ error:'db' });

    const receitas = Number(row?.receitas || 0);
    const despesas = Number(row?.despesas || 0);
    const resultado = receitas - despesas;

    if (!empresa_id || empresa_id === 'all') {
      const sqlEmp = `
        SELECT empresa_id,
          SUM(CASE WHEN tipo='RECEITA' THEN valor ELSE 0 END) as receitas
        FROM lancamentos
        WHERE data >= ? AND data < ?
        GROUP BY empresa_id
      `;
      db.all(sqlEmp, [start, end], (e2, empRows)=>{
        if (e2) return res.status(500).json({ error:'db' });

        const empresaIds = empRows.map(r=>r.empresa_id);
        if (!empresaIds.length) {
          const impostoEstimado = 0;
          const receitaLiquida = receitas - impostoEstimado;
          const margem = receitas > 0 ? (resultado / receitas) : 0;
          const health = healthIndicator(margem, resultado);
          return res.json({ receitas, despesas, resultado, impostoEstimado, receitaLiquida, margem, health });
        }

        const placeholders = empresaIds.map(()=>'?').join(',');
        db.all(`SELECT empresa_id,simples_percent,taxas_percent,outros_percent FROM impostos_config WHERE empresa_id IN (${placeholders})`,
          empresaIds, (e3, taxRows)=>{
            if (e3) return res.status(500).json({ error:'db' });
            const taxMap = new Map(taxRows.map(t=>[t.empresa_id, t]));
            let impostoEstimado = 0;
            for (const r of empRows) {
              const rec = Number(r.receitas||0);
              const t = taxMap.get(r.empresa_id) || { simples_percent:0, taxas_percent:0, outros_percent:0 };
              const totalPct = (Number(t.simples_percent||0) + Number(t.taxas_percent||0) + Number(t.outros_percent||0))/100;
              impostoEstimado += rec * totalPct;
            }
            const receitaLiquida = receitas - impostoEstimado;
            const margem = receitas > 0 ? (resultado / receitas) : 0;
            const health = healthIndicator(margem, resultado);
            res.json({ receitas, despesas, resultado, impostoEstimado, receitaLiquida, margem, health });
          });
      });
    } else {
      db.get('SELECT simples_percent,taxas_percent,outros_percent FROM impostos_config WHERE empresa_id=?', [empresa_id], (e2,t)=>{
        if (e2) return res.status(500).json({ error:'db' });
        const totalPct = ((Number(t?.simples_percent||0) + Number(t?.taxas_percent||0) + Number(t?.outros_percent||0))/100);
        const impostoEstimado = receitas * totalPct;
        const receitaLiquida = receitas - impostoEstimado;
        const margem = receitas > 0 ? (resultado / receitas) : 0;
        const health = healthIndicator(margem, resultado);
        res.json({ receitas, despesas, resultado, impostoEstimado, receitaLiquida, margem, health, impostos: t });
      });
    }
  });
});


// Relatório PDF mensal (server-side)
app.get('/api/fin/relatorio/pdf', (req,res)=>{
  const { empresa_id, ano, mes } = req.query;
  if (!ano || !mes) return res.status(400).json({ error:'params' });

  const { start, end } = toMonthRange(ano, mes);

  const fetchTotals = (cb) => {
    const empresaWhere = (empresa_id && empresa_id !== 'all') ? ' AND l.empresa_id=?' : '';
    const params = [start, end];
    if (empresaWhere) params.push(empresa_id);
    db.get(
      `SELECT
        SUM(CASE WHEN l.tipo='RECEITA' THEN l.valor ELSE 0 END) as receitas,
        SUM(CASE WHEN l.tipo='DESPESA' THEN l.valor ELSE 0 END) as despesas
       FROM lancamentos l
       WHERE l.data >= ? AND l.data < ? ${empresaWhere}`,
      params,
      (err,row)=>{
        if (err) return cb(err);
        cb(null, { receitas:Number(row?.receitas||0), despesas:Number(row?.despesas||0) });
      }
    );
  };

  const fetchByCategoria = (cb) => {
    const empresaWhere = (empresa_id && empresa_id !== 'all') ? ' AND l.empresa_id=?' : '';
    const params = [start, end];
    if (empresaWhere) params.push(empresa_id);
    db.all(
      `SELECT l.tipo, COALESCE(c.nome,'(Sem categoria)') as categoria, SUM(l.valor) as total
       FROM lancamentos l
       LEFT JOIN categorias c ON c.id=l.categoria_id
       WHERE l.data >= ? AND l.data < ? ${empresaWhere}
       GROUP BY l.tipo, categoria
       ORDER BY l.tipo, total DESC`,
      params,
      (err,rows)=>{
        if (err) return cb(err);
        cb(null, rows.map(r=>({ tipo:r.tipo, categoria:r.categoria, total:Number(r.total||0) })));
      }
    );
  };

  const fetchImpostos = (cb) => {
    if (!empresa_id || empresa_id === 'all') {
      // consolidado: soma por empresa
      db.all('SELECT empresa_id,simples_percent,taxas_percent,outros_percent FROM impostos_config', [], (err,rows)=>{
        if (err) return cb(err);
        const map = new Map(rows.map(r=>[r.empresa_id, r]));
        cb(null, { mode:'all', map });
      });
    } else {
      db.get('SELECT simples_percent,taxas_percent,outros_percent FROM impostos_config WHERE empresa_id=?', [empresa_id], (err,row)=>{
        if (err) return cb(err);
        cb(null, { mode:'one', row: row || { simples_percent:0, taxas_percent:0, outros_percent:0 } });
      });
    }
  };

  const fetchEmpName = (cb) => {
    if (!empresa_id || empresa_id === 'all') return cb(null, 'Consolidado (3 empresas)');
    db.get('SELECT nome,cnpj FROM empresas WHERE id=?', [empresa_id], (err,row)=>{
      if (err) return cb(err);
      cb(null, row ? `${row.nome}${row.cnpj?` • ${row.cnpj}`:''}` : `Empresa ${empresa_id}`);
    });
  };

  fetchTotals((e1,tot)=>{
    if (e1) return res.status(500).json({ error:'db' });
    fetchImpostos((e2,taxInfo)=>{
      if (e2) return res.status(500).json({ error:'db' });
      fetchEmpName((e3,empName)=>{
        if (e3) return res.status(500).json({ error:'db' });
        fetchByCategoria((e4,byCat)=>{
          if (e4) return res.status(500).json({ error:'db' });

          const receitas = tot.receitas;
          const despesas = tot.despesas;
          const resultado = receitas - despesas;

          let impostoEstimado = 0;
          if (!empresa_id || empresa_id === 'all') {
            // para consolidado: estima imposto por empresa com base na receita por empresa
            db.all(
              `SELECT empresa_id, SUM(CASE WHEN tipo='RECEITA' THEN valor ELSE 0 END) as receitas
               FROM lancamentos
               WHERE data >= ? AND data < ?
               GROUP BY empresa_id`,
              [start, end],
              (e5,rows)=>{
                if (e5) return res.status(500).json({ error:'db' });
                for (const r of rows) {
                  const rec = Number(r.receitas||0);
                  const t = taxInfo.map.get(r.empresa_id) || { simples_percent:0, taxas_percent:0, outros_percent:0 };
                  const pct = (Number(t.simples_percent||0)+Number(t.taxas_percent||0)+Number(t.outros_percent||0))/100;
                  impostoEstimado += rec * pct;
                }
                buildPdf(empName, receitas, despesas, resultado, impostoEstimado, byCat);
              }
            );
          } else {
            const t = taxInfo.row || { simples_percent:0, taxas_percent:0, outros_percent:0 };
            const pct = (Number(t.simples_percent||0)+Number(t.taxas_percent||0)+Number(t.outros_percent||0))/100;
            impostoEstimado = receitas * pct;
            buildPdf(empName, receitas, despesas, resultado, impostoEstimado, byCat);
          }

          function buildPdf(empName, receitas, despesas, resultado, impostoEstimado, byCat){
            const receitaLiquida = receitas - impostoEstimado;
            const margem = receitas > 0 ? (resultado / receitas) : 0;
            const health = healthIndicator(margem, resultado);

            const doc = new PDFDocument({ margin: 42, size: 'A4' });
            res.setHeader('Content-Type', 'application/pdf');
            const safeName = `relatorio_${String(ano)}_${String(mes).padStart(2,'0')}.pdf`;
            res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
            doc.pipe(res);

            doc.fontSize(18).text('Relatório Financeiro Mensal', { align:'left' });
            doc.moveDown(0.3);
            doc.fontSize(11).fillColor('#333333')
              .text(`Empresa: ${empName}`)
              .text(`Período: ${String(mes).padStart(2,'0')}/${ano}`)
              .text(`Gerado em: ${new Date().toLocaleString('pt-BR')}`);
            doc.moveDown(0.8);

            doc.fillColor('#000000').fontSize(13).text('Resumo', { underline: true });
            doc.moveDown(0.3);
            doc.fontSize(11);
            doc.text(`Receita bruta: R$ ${receitas.toFixed(2)}`);
            doc.text(`Impostos estimados: R$ ${impostoEstimado.toFixed(2)}`);
            doc.text(`Receita líquida (estimada): R$ ${receitaLiquida.toFixed(2)}`);
            doc.text(`Despesas: R$ ${despesas.toFixed(2)}`);
            doc.text(`Resultado: R$ ${resultado.toFixed(2)}`);
            doc.text(`Margem: ${(margem*100).toFixed(1)}%`);
            doc.text(`Indicador: ${health.cor.toUpperCase()} • ${health.texto}`);
            doc.moveDown(0.8);

            doc.fontSize(13).text('Por categoria (top)', { underline: true });
            doc.moveDown(0.3);
            doc.fontSize(10);

            const topRows = byCat.slice(0, 18);
            for (const r of topRows) {
              doc.text(`${r.tipo.padEnd(7)}  ${r.categoria}: R$ ${Number(r.total||0).toFixed(2)}`);
            }
            if (byCat.length > topRows.length) doc.text(`... (+${byCat.length-topRows.length} categorias)`);

            doc.moveDown(1.0);
            doc.fontSize(9).fillColor('#555555')
              .text('Obs: Impostos são estimativas com base nas % cadastradas. Para valor exato, use a apuração contábil.', { align:'left' });

            doc.end();
          }
        });
      });
    });
  });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('Financeiro rodando na porta', PORT));

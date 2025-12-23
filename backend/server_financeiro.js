const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, '../public')));

const DB = path.join(__dirname, 'sql', 'financeiro.db');
const db = new sqlite3.Database(DB);

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

app.get('/api/fin/empresas', (req,res)=>{
  db.all('SELECT id,nome,cnpj,ativo FROM empresas WHERE ativo=1 ORDER BY id', [], (err,rows)=>{
    if (err) return res.status(500).json({ error:'db' });
    res.json(rows);
  });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('Financeiro rodando na porta', PORT));

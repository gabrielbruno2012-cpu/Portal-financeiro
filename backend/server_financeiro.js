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
function lastDayOfMonth(ano, mes){
  // mes: 1-12
  return new Date(Number(ano), Number(mes), 0).getDate();
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
  let { email, senha } = req.body || {};

  // Normalização simples para evitar erro comum de domínio digitado.
  // Ex.: financeiro@coelho.com -> financeiro@coelholog.com
  if (typeof email === 'string') {
    email = email.trim().toLowerCase();
    if (email.endsWith('@coelho.com')) {
      email = email.replace(/@coelho\.com$/,'@coelholog.com');
    }
  }

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
  const { empresa_id, tipo } = req.query;
  if (!empresa_id) return res.status(400).json({ error:'params' });

  let sql = 'SELECT id,empresa_id,tipo,nome,grupo,ativo FROM categorias WHERE empresa_id=?';
  const params = [empresa_id];

  if (tipo && tipo !== 'all') { sql += ' AND tipo=?'; params.push(tipo); }

  sql += ' ORDER BY nome';
  db.all(sql, params, (err,rows)=>{
    if (err) return res.status(500).json({ error:'db' });
    res.json(rows);
  });
});

// Criar categoria
app.post('/api/fin/categorias', (req,res)=>{
  const { empresa_id, tipo, nome, grupo, ativo } = req.body;
  if (!empresa_id || !tipo || !nome) return res.status(400).json({ error:'params' });
  const grp = grupo || (tipo === 'RECEITA' ? 'receita' : (tipo === 'CUSTO' ? 'custo' : 'despesa'));
  const atv = (ativo === 0 || ativo === false) ? 0 : 1;

  db.run(
    'INSERT INTO categorias (empresa_id,tipo,nome,grupo,ativo) VALUES (?,?,?,?,?)',
    [empresa_id, tipo, String(nome).trim(), grp, atv],
    function(err){
      if (err) return res.status(500).json({ error:'db' });
      res.json({ id:this.lastID });
    }
  );
});

// Atualizar categoria
app.put('/api/fin/categorias/:id', (req,res)=>{
  const id = req.params.id;
  const { empresa_id, tipo, nome, grupo, ativo } = req.body;
  if (!id || !empresa_id || !tipo || !nome) return res.status(400).json({ error:'params' });

  const grp = grupo || (tipo === 'RECEITA' ? 'receita' : (tipo === 'CUSTO' ? 'custo' : 'despesa'));
  const atv = (ativo === 0 || ativo === false) ? 0 : 1;

  db.run(
    'UPDATE categorias SET empresa_id=?, tipo=?, nome=?, grupo=?, ativo=? WHERE id=?',
    [empresa_id, tipo, String(nome).trim(), grp, atv, id],
    function(err){
      if (err) return res.status(500).json({ error:'db' });
      res.json({ ok:true });
    }
  );
});

// Excluir categoria
app.delete('/api/fin/categorias/:id', (req,res)=>{
  const id = req.params.id;
  if (!id) return res.status(400).json({ error:'params' });
  db.run('DELETE FROM categorias WHERE id=?',[id], function(err){
    if (err) return res.status(500).json({ error:'db' });
    res.json({ ok:true });
  });
});


// ============================
//        RECORRÊNCIAS
// ============================
app.get('/api/fin/recorrencias', (req,res)=>{
  const { empresa_id } = req.query;
  if (!empresa_id) return res.status(400).json({ error:'params' });

  const sql = `
    SELECT r.id,r.empresa_id,e.nome as empresa_nome,r.tipo,r.categoria_id,c.nome as categoria_nome,
           r.descricao,r.valor,r.dia,r.status_padrao,r.ativo,r.criado_em
    FROM recorrencias r
    LEFT JOIN empresas e ON e.id=r.empresa_id
    LEFT JOIN categorias c ON c.id=r.categoria_id
    WHERE r.empresa_id=?
    ORDER BY r.ativo DESC, r.tipo, r.descricao
  `;
  db.all(sql, [empresa_id], (err,rows)=>{
    if (err) return res.status(500).json({ error:'db' });
    res.json(rows);
  });
});

app.post('/api/fin/recorrencias', (req,res)=>{
  const { empresa_id, tipo, categoria_id, descricao, valor, dia, status_padrao, ativo } = req.body;
  if (!empresa_id || !tipo || !descricao || valor===undefined || !dia) return res.status(400).json({ error:'params' });

  const atv = (ativo === 0 || ativo === false) ? 0 : 1;
  const st  = status_padrao || 'Previsto';

  db.run(
    `INSERT INTO recorrencias (empresa_id,tipo,categoria_id,descricao,valor,dia,status_padrao,ativo,criado_em)
     VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
    [empresa_id, tipo, categoria_id||null, String(descricao).trim(), Number(valor), Number(dia), st, atv],
    function(err){
      if (err) return res.status(500).json({ error:'db' });
      res.json({ id:this.lastID });
    }
  );
});

app.put('/api/fin/recorrencias/:id', (req,res)=>{
  const id = req.params.id;
  const { empresa_id, tipo, categoria_id, descricao, valor, dia, status_padrao, ativo } = req.body;
  if (!id || !empresa_id || !tipo || !descricao || valor===undefined || !dia) return res.status(400).json({ error:'params' });

  const atv = (ativo === 0 || ativo === false) ? 0 : 1;
  const st  = status_padrao || 'Previsto';

  db.run(
    `UPDATE recorrencias SET empresa_id=?, tipo=?, categoria_id=?, descricao=?, valor=?, dia=?, status_padrao=?, ativo=?
     WHERE id=?`,
    [empresa_id, tipo, categoria_id||null, String(descricao).trim(), Number(valor), Number(dia), st, atv, id],
    function(err){
      if (err) return res.status(500).json({ error:'db' });
      res.json({ ok:true });
    }
  );
});

app.delete('/api/fin/recorrencias/:id', (req,res)=>{
  const id = req.params.id;
  if (!id) return res.status(400).json({ error:'params' });
  db.run('DELETE FROM recorrencias WHERE id=?',[id], function(err){
    if (err) return res.status(500).json({ error:'db' });
    res.json({ ok:true });
  });
});



// Criar categoria
app.post("/api/fin/categorias", (req, res) => {
  const { empresa_id, tipo, nome } = req.body || {};
  if (!empresa_id || !tipo || !nome) return res.status(400).json({ error: "empresa_id, tipo e nome são obrigatórios" });
  db.run(
    `INSERT INTO categorias (empresa_id, tipo, nome, ativo) VALUES (?,?,?,1)`,
    [empresa_id, String(tipo), String(nome).trim()],
    function (err) {
      if (err) return res.status(500).json({ error: "Erro ao criar categoria" });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

// Editar categoria
app.put("/api/fin/categorias/:id", (req, res) => {
  const { id } = req.params;
  const { tipo, nome, ativo } = req.body || {};
  db.run(
    `UPDATE categorias SET tipo = COALESCE(?, tipo), nome = COALESCE(?, nome), ativo = COALESCE(?, ativo) WHERE id = ?`,
    [tipo ?? null, nome ? String(nome).trim() : null, typeof ativo === "number" ? ativo : (ativo === undefined ? null : (ativo ? 1 : 0)), id],
    function (err) {
      if (err) return res.status(500).json({ error: "Erro ao editar categoria" });
      res.json({ ok: true, changes: this.changes });
    }
  );
});

// "Excluir" categoria (desativa)
app.delete("/api/fin/categorias/:id", (req, res) => {
  const { id } = req.params;
  db.run(`UPDATE categorias SET ativo = 0 WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ error: "Erro ao remover categoria" });
    res.json({ ok: true, changes: this.changes });
  });
});

// Listar recorrências
app.get("/api/fin/recorrencias", (req, res) => {
  const { empresa_id } = req.query;
  if (!empresa_id) return res.status(400).json({ error: "empresa_id obrigatório" });
  db.all(
    `SELECT r.*, c.nome AS categoria_nome
       FROM recorrencias r
       LEFT JOIN categorias c ON c.id = r.categoria_id
      WHERE r.empresa_id = ? AND r.ativo = 1
      ORDER BY r.tipo, r.dia, r.id DESC`,
    [empresa_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "Erro ao listar recorrências" });
      res.json(rows || []);
    }
  );
});

// Criar recorrência
app.post("/api/fin/recorrencias", (req, res) => {
  const { empresa_id, tipo, categoria_id, descricao, valor, dia, ativo } = req.body || {};
  if (!empresa_id || !tipo || !descricao || valor === undefined || valor === null) {
    return res.status(400).json({ error: "empresa_id, tipo, descricao e valor são obrigatórios" });
  }
  const diaNum = Math.max(1, Math.min(31, Number(dia || 1)));
  db.run(
    `INSERT INTO recorrencias (empresa_id, tipo, categoria_id, descricao, valor, dia, ativo)
     VALUES (?,?,?,?,?,?,?)`,
    [empresa_id, String(tipo), categoria_id || null, String(descricao).trim(), Number(valor), diaNum, (ativo === 0 || ativo === false) ? 0 : 1],
    function (err) {
      if (err) return res.status(500).json({ error: "Erro ao criar recorrência" });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

// Editar recorrência
app.put("/api/fin/recorrencias/:id", (req, res) => {
  const { id } = req.params;
  const { tipo, categoria_id, descricao, valor, dia, ativo } = req.body || {};
  const diaNum = dia === undefined ? null : Math.max(1, Math.min(31, Number(dia || 1)));
  db.run(
    `UPDATE recorrencias
        SET tipo = COALESCE(?, tipo),
            categoria_id = COALESCE(?, categoria_id),
            descricao = COALESCE(?, descricao),
            valor = COALESCE(?, valor),
            dia = COALESCE(?, dia),
            ativo = COALESCE(?, ativo)
      WHERE id = ?`,
    [
      tipo ?? null,
      categoria_id === undefined ? null : (categoria_id || null),
      descricao ? String(descricao).trim() : null,
      (valor === undefined ? null : Number(valor)),
      diaNum,
      (ativo === undefined ? null : (ativo ? 1 : 0)),
      id
    ],
    function (err) {
      if (err) return res.status(500).json({ error: "Erro ao editar recorrência" });
      res.json({ ok: true, changes: this.changes });
    }
  );
});

// "Excluir" recorrência (desativa)
app.delete("/api/fin/recorrencias/:id", (req, res) => {
  const { id } = req.params;
  db.run(`UPDATE recorrencias SET ativo = 0 WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ error: "Erro ao remover recorrência" });
    res.json({ ok: true, changes: this.changes });
  });
});

app.get('/api/fin/lancamentos', async (req,res)=>{
  const { empresa_id, ano, mes, tipo, status, q } = req.query;
  if (!ano || !mes) return res.status(400).json({ error:'params' });

  const { start, end } = toMonthRange(ano, mes);
  // gera recorrências do mês (Previsto) antes de listar
  try {
    if (empresa_id && empresa_id !== 'all') {
      await new Promise((resolve,reject)=>ensureRecorrenciasGeradas(empresa_id, ano, mes, (e)=>e?reject(e):resolve()));
    }
  } catch(e){ /* ignora erro de geração */ }
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



// ============================
//     DRE MENSAL
// ============================
function calcImposto(empresa_id, receita, cb){
  db.get(`SELECT simples_percent,taxas_percent,outros_percent FROM impostos_config WHERE empresa_id=?`, [empresa_id], (err,row)=>{
    if (err) return cb(err, 0);
    const p = row ? (Number(row.simples_percent||0) + Number(row.taxas_percent||0) + Number(row.outros_percent||0)) : 0;
    cb(null, receita * (p/100));
  });
}

// Gera lançamentos "Previsto" a partir de recorrências (se ainda não existir no mês)
function ensureRecorrenciasGeradas(empresa_id, ano, mes, cb) {
  const mesNum = String(mes).padStart(2, "0");
  const ym = `${ano}-${mesNum}`;

  db.all(
    `SELECT * FROM recorrencias WHERE empresa_id = ? AND ativo = 1`,
    [empresa_id],
    (err, recs) => {
      if (err) return cb(err);
      if (!recs || recs.length === 0) return cb(null, { generated: 0 });

      let pending = recs.length;
      let generated = 0;

      const done = (e) => {
        if (e) {
          pending = -999;
          return cb(e);
        }
        pending--;
        if (pending === 0) cb(null, { generated });
      };

      recs.forEach((r) => {
        const maxDia = new Date(Number(ano), Number(mesNum), 0).getDate();
        const dia = Math.min(Math.max(1, Number(r.dia || 1)), maxDia);
        const data = `${ym}-${String(dia).padStart(2, "0")}`;

        db.get(
          `SELECT id FROM lancamentos
            WHERE empresa_id = ? AND recorrencia_id = ? AND substr(data,1,7) = ?
            LIMIT 1`,
          [empresa_id, r.id, ym],
          (e2, row) => {
            if (e2) return done(e2);
            if (row) return done();

            db.run(
              `INSERT INTO lancamentos
                (empresa_id, tipo, categoria_id, descricao, valor, data, status, origem, recorrencia_id)
               VALUES (?,?,?,?,?,?,?,? ,?)`,
              [
                empresa_id,
                r.tipo,
                r.categoria_id || null,
                r.descricao,
                Number(r.valor || 0),
                data,
                "Previsto",
                "recorrencia",
                r.id,
              ],
              (e3) => {
                if (!e3) generated++;
                return done(e3);
              }
            );
          }
        );
      });
    }
  );
}

function dreEmpresa(empresa_id, ano, mes, cb){
  // garante recorrências do mês antes de calcular
  ensureRecorrenciasGeradas(String(empresa_id), String(ano), String(mes), (eGen)=>{
    if (eGen) return cb(eGen);

    const start = `${ano}-${String(mes).padStart(2,'0')}-01`;
    const end = `${ano}-${String(mes).padStart(2,'0')}-${String(lastDayOfMonth(ano, mes)).padStart(2,'0')}`;

    // receitas
    db.get(
      `SELECT COALESCE(SUM(valor),0) as total
       FROM lancamentos
       WHERE empresa_id=? AND tipo='RECEITA' AND date(data) BETWEEN date(?) AND date(?)`,
      [empresa_id, start, end],
      (err, rRec)=>{
        if (err) return cb(err);
        const receita = Number(rRec.total||0);

        // custos e despesas por grupo via categoria
        db.all(
          `SELECT COALESCE(c.grupo,'despesa') as grupo, COALESCE(c.nome,'(Sem categoria)') as categoria, COALESCE(SUM(l.valor),0) as total
           FROM lancamentos l
           LEFT JOIN categorias c ON c.id=l.categoria_id
           WHERE l.empresa_id=? AND l.tipo='DESPESA' AND date(l.data) BETWEEN date(?) AND date(?)
           GROUP BY COALESCE(c.grupo,'despesa'), COALESCE(c.nome,'(Sem categoria)')
           ORDER BY grupo, total DESC`,
          [empresa_id, start, end],
          (err2, rows)=>{
            if (err2) return cb(err2);

            let custos = 0, despesas = 0;
            const porCategoria = { custo: [], despesa: [], receita: [] };

            rows.forEach(r=>{
              const g = String(r.grupo||'despesa').toLowerCase();
              const v = Number(r.total||0);
              if (g === 'custo') custos += v;
              else despesas += v;
              porCategoria[g === 'custo' ? 'custo' : 'despesa'].push({ categoria: r.categoria, total: v });
            });

            // receitas por categoria (opcional)
            db.all(
              `SELECT COALESCE(c.nome,'(Sem categoria)') as categoria, COALESCE(SUM(l.valor),0) as total
               FROM lancamentos l
               LEFT JOIN categorias c ON c.id=l.categoria_id
               WHERE l.empresa_id=? AND l.tipo='RECEITA' AND date(l.data) BETWEEN date(?) AND date(?)
               GROUP BY COALESCE(c.nome,'(Sem categoria)')
               ORDER BY total DESC`,
              [empresa_id, start, end],
              (err3, rRows)=>{
                if (err3) return cb(err3);
                porCategoria.receita = rRows.map(x=>({ categoria: x.categoria, total: Number(x.total||0) }));

                calcImposto(empresa_id, receita, (eImp, imposto)=>{
                  if (eImp) return cb(eImp);

                  const lucroBruto = receita - custos;
                  const resultadoOper = lucroBruto - despesas;
                  const lucroLiquido = resultadoOper - imposto;

                  const out = {
                    empresa_id: Number(empresa_id),
                    receita_bruta: receita,
                    custos,
                    despesas,
                    lucro_bruto: lucroBruto,
                    resultado_operacional: resultadoOper,
                    imposto_estimado: imposto,
                    lucro_liquido_estimado: lucroLiquido,
                    margem_bruta: receita>0 ? (lucroBruto/receita) : 0,
                    margem_liquida: receita>0 ? (lucroLiquido/receita) : 0,
                    por_categoria: porCategoria
                  };
                  cb(null, out);
                });
              }
            );
          }
        );
      }
    );
  });
}

app.get('/api/fin/dre', (req,res)=>{
  const { empresa_id, ano, mes } = req.query;
  if (!ano || !mes || !empresa_id) return res.status(400).json({ error:'params' });

  // helper para mês anterior
  function prevMonth(a, m){
    let yy = Number(a), mm = Number(m);
    mm -= 1;
    if (mm<=0){ mm = 12; yy -= 1; }
    return { ano: yy, mes: mm };
  }

  if (empresa_id === 'all'){
    // consolidado: soma empresas ativas
    db.all("SELECT id,nome FROM empresas WHERE ativo=1 ORDER BY id", [], (err, emps)=>{
      if (err) return res.status(500).json({ error:'db' });
      const results = [];
      let pending = emps.length;
      if (!pending) return res.json({ empresa_id:'all', ano, mes, dre:null });

      emps.forEach(e=>{
        dreEmpresa(e.id, ano, mes, (eD, dre)=>{
          if (!eD && dre) dre.nome = e.nome;
          results.push(dre);
          pending -= 1;
          if (pending===0){
            // soma
            const sum = (k)=> results.reduce((acc,x)=>acc + Number((x&&x[k])||0), 0);
            const receita = sum('receita_bruta');
            const custos = sum('custos');
            const despesas = sum('despesas');
            const imposto = sum('imposto_estimado');
            const lucroBruto = receita - custos;
            const resultadoOper = lucroBruto - despesas;
            const lucroLiquido = resultadoOper - imposto;

            res.json({
              empresa_id:'all',
              ano, mes,
              dre: {
                receita_bruta: receita,
                custos, despesas,
                lucro_bruto: lucroBruto,
                resultado_operacional: resultadoOper,
                imposto_estimado: imposto,
                lucro_liquido_estimado: lucroLiquido,
                margem_bruta: receita>0 ? (lucroBruto/receita) : 0,
                margem_liquida: receita>0 ? (lucroLiquido/receita) : 0
              },
              por_empresa: results
            });
          }
        });
      });
    });
  } else {
    const pid = prevMonth(ano, mes);
    dreEmpresa(empresa_id, ano, mes, (err, dre)=>{
      if (err) return res.status(500).json({ error:'db' });
      dreEmpresa(empresa_id, pid.ano, pid.mes, (err2, drePrev)=>{
        // se falhar mês anterior, ignora
        const prev = err2 ? null : drePrev;
        const comp = prev ? {
          receita_bruta: dre.receita_bruta - prev.receita_bruta,
          custos: dre.custos - prev.custos,
          despesas: dre.despesas - prev.despesas,
          lucro_liquido_estimado: dre.lucro_liquido_estimado - prev.lucro_liquido_estimado
        } : null;
        res.json({ empresa_id, ano, mes, dre, anterior: prev, variacao: comp });
      });
    });
  }
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
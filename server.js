/* QR dinâmico (plaquinhas de avaliação)
   - Cada plaquinha tem um link fixo: PUBLIC_URL/<codigo>  (vai no QR e no NFC)
   - Quem lê é mandado para o destino salvo no painel; dá para trocar o destino quando quiser.
   - Painel em /painel. Entrada de dois jeitos: código no WhatsApp (pelo seu fluxo do n8n) ou senha de admin.
   - Tudo fica num SQLite em DB_PATH (no EasyPanel, monte um volume em /data).
   - Cópia automática do banco 1x por dia em <pasta do banco>/backups (guarda as últimas 30).
   - Sem dependências: só Node 22.

   Variáveis de ambiente:
     PUBLIC_URL        domínio que vai dentro dos QR (ex.: https://qr.seudominio.com.br). Defina ANTES de imprimir.
     ADMIN_TELEFONES   números que podem entrar, separados por vírgula (ex.: 5514999999999)
     N8N_WEBHOOK_URL   webhook do n8n que manda o código no WhatsApp
     ADMIN_SENHA       senha de admin (o outro jeito de entrar)
     DB_PATH           (opcional) padrão /data/qr.db
     PORT              (opcional) padrão 3000                                              */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/* ---------- configuração ---------- */
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = path.resolve(process.env.DB_PATH || "/data/qr.db");
const PASTA_BACKUP = path.join(path.dirname(DB_PATH), "backups");
const BACKUPS_GUARDADOS = 30;
const WEBHOOK = String(process.env.N8N_WEBHOOK_URL || "").trim();
const SENHA = String(process.env.ADMIN_SENHA || "");
const PUBLIC_URL = String(process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
const DIAS_SESSAO = 30;
const so = (t) => String(t || "").replace(/\D/g, "");
const com55 = (t) => { const d = so(t); return d.length === 10 || d.length === 11 ? "55" + d : d; };
const ADMINS = new Set(String(process.env.ADMIN_TELEFONES || "").split(",").map(com55).filter(Boolean));
const PUBLICO = path.join(path.dirname(new URL(import.meta.url).pathname), "public");
const RESERVADOS = new Set(["", "api", "painel", "saude", "qrcode.js", "robots.txt", "favicon.ico"]);

const log = (...a) => console.log(new Date().toISOString(), ...a);
if (PUBLIC_URL && !/^https?:\/\/[^/]+\.[^/]+$/i.test(PUBLIC_URL)) log("⚠️  PUBLIC_URL parece errado:", PUBLIC_URL, "(use só https://dominio, sem caminho)");
if (!PUBLIC_URL) log("⚠️  PUBLIC_URL vazio: o painel vai usar o endereço em que foi aberto. Defina antes de imprimir plaquinhas.");
if (!ADMINS.size && !SENHA) log("⚠️  ADMIN_TELEFONES e ADMIN_SENHA vazios: ninguém consegue entrar no painel.");
if (ADMINS.size && !WEBHOOK) log("⚠️  N8N_WEBHOOK_URL vazio: o código de entrada só aparece no log do serviço.");
if (SENHA && SENHA.length < 12) log("⚠️  ADMIN_SENHA curta: use 12 caracteres ou mais.");

/* ---------- banco ---------- */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS links (
    codigo        TEXT PRIMARY KEY,
    numero        INTEGER NOT NULL,
    nome          TEXT NOT NULL,
    destino       TEXT NOT NULL DEFAULT '',
    cliques       INTEGER NOT NULL DEFAULT 0,
    criado_em     TEXT NOT NULL DEFAULT (datetime('now')),
    ultimo_clique TEXT
  );
  CREATE TABLE IF NOT EXISTS sessoes (
    token      TEXT PRIMARY KEY,
    telefone   TEXT NOT NULL,
    expira_em  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS historico (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo    TEXT NOT NULL,
    acao      TEXT NOT NULL,
    antes     TEXT,
    depois    TEXT,
    quem      TEXT,
    em        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS historico_codigo ON historico (codigo, id);
`);
// colunas novas em bancos antigos (seguro rodar sempre)
const colunas = new Set(db.prepare("PRAGMA table_info(links)").all().map((c) => c.name));
if (!colunas.has("alterado_em")) db.exec("ALTER TABLE links ADD COLUMN alterado_em TEXT");

const q = {
  todos:    db.prepare("SELECT * FROM links ORDER BY numero"),
  um:       db.prepare("SELECT * FROM links WHERE codigo = ?"),
  maiorNum: db.prepare("SELECT MAX(COALESCE((SELECT MAX(numero) FROM links), 0), COALESCE((SELECT MAX(CAST(antes AS INTEGER)) FROM historico WHERE acao = 'excluiu'), 0)) AS n"),
  criar:    db.prepare("INSERT INTO links (codigo, numero, nome) VALUES (?, ?, ?)"),
  editar:   db.prepare("UPDATE links SET nome = ?, destino = ?, alterado_em = datetime('now') WHERE codigo = ?"),
  apagar:   db.prepare("DELETE FROM links WHERE codigo = ?"),
  clique:   db.prepare("UPDATE links SET cliques = cliques + 1, ultimo_clique = datetime('now') WHERE codigo = ?"),
  hist:     db.prepare("INSERT INTO historico (codigo, acao, antes, depois, quem) VALUES (?, ?, ?, ?, ?)"),
  histDe:   db.prepare("SELECT acao, antes, depois, quem, em FROM historico WHERE codigo = ? ORDER BY id DESC LIMIT 20"),
  sessao:   db.prepare("SELECT * FROM sessoes WHERE token = ? AND expira_em > ?"),
  novaSes:  db.prepare("INSERT INTO sessoes (token, telefone, expira_em) VALUES (?, ?, ?)"),
  fimSes:   db.prepare("DELETE FROM sessoes WHERE token = ?"),
  limpaSes: db.prepare("DELETE FROM sessoes WHERE expira_em < ?"),
  ping:     db.prepare("SELECT 1 AS ok")
};

/* ---------- cópia diária do banco ---------- */
function fazerBackup() {
  try {
    fs.mkdirSync(PASTA_BACKUP, { recursive: true });
    const hoje = new Date().toISOString().slice(0, 10);
    const arq = path.join(PASTA_BACKUP, `qr-${hoje}.db`);
    if (fs.existsSync(arq)) return;
    db.exec(`VACUUM INTO '${arq.replace(/'/g, "''")}'`);
    const antigos = fs.readdirSync(PASTA_BACKUP).filter((f) => /^qr-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of antigos.slice(0, Math.max(0, antigos.length - BACKUPS_GUARDADOS))) fs.rmSync(path.join(PASTA_BACKUP, f), { force: true });
    log("💾 backup salvo:", arq);
  } catch (e) { log("❌ backup falhou:", e.message); }
}

/* ---------- utilidades ---------- */
const novoCodigo = () => {
  const letras = "abcdefghjkmnpqrstuvwxyz23456789"; // sem letras que confundem (i, l, o, 0, 1)
  let c;
  do { c = Array.from(crypto.randomBytes(6), (b) => letras[b % letras.length]).join(""); } while (q.um.get(c) || RESERVADOS.has(c));
  return c;
};
function baseDe(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  return `${proto}://${req.headers.host}`;
}
function destinoValido(v, req) {
  let t = String(v || "").trim();
  if (!t) return "";
  if (t.length > 2000) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = "https://" + t;
  try {
    const u = new URL(t);
    if (!["http:", "https:"].includes(u.protocol) || !u.hostname.includes(".")) return null;
    // não deixa um QR apontar para ele mesmo (daria um laço infinito)
    if (u.host === new URL(baseDe(req)).host || u.host === req.headers.host) return null;
    return u.toString();
  } catch { return null; }
}
// IP real: o proxy do EasyPanel (Traefik) acrescenta o IP no FIM do X-Forwarded-For; o começo pode ser forjado
function ipDe(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : String(req.socket.remoteAddress || "");
}
const SEGURANCA = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY"
};
function json(res, status, dados) {
  res.writeHead(status, { ...SEGURANCA, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(dados));
}
function lerCorpo(req) {
  return new Promise((ok, falha) => {
    let t = "";
    req.setEncoding("utf8");
    req.on("data", (p) => { t += p; if (t.length > 20000) { falha(new Error("Pedido grande demais")); req.destroy(); } });
    req.on("end", () => { try { ok(t ? JSON.parse(t) : {}); } catch { falha(new Error("JSON inválido")); } });
    req.on("error", falha);
  });
}
function pagina(res, status, titulo, texto, head) {
  res.writeHead(status, { ...SEGURANCA, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  if (head) return res.end();
  res.end(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${titulo}</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#120d0e;color:#f6eeeb;font:16px system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box"><div><h1 style="font-size:22px;margin:0 0 8px">${titulo}</h1><p style="color:#ab9c99;margin:0">${texto}</p></div></body></html>`);
}
function arquivo(res, nome, tipo, cache) {
  fs.readFile(path.join(PUBLICO, nome), (err, dados) => {
    if (err) { res.writeHead(500); return res.end("Arquivo não encontrado"); }
    const extra = tipo.startsWith("text/html")
      ? { "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }
      : {};
    res.writeHead(200, { ...SEGURANCA, ...extra, "Content-Type": tipo, "Cache-Control": cache });
    res.end(dados);
  });
}

/* ---------- entrada pelo WhatsApp ---------- */
const codigosLogin = new Map(); // telefone -> { codigo, expira, tentativas, enviadoEm }
const pedidosPorIp = new Map(); // ip -> { n, desde }

async function avisarN8n(tel, codigo, mensagem) {
  const corpo = JSON.stringify({ evento: "qr_login", telefone: tel, codigo, mensagem, enviado_em: new Date().toISOString() });
  let ultimoErro;
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const r = await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: corpo, signal: AbortSignal.timeout(10000) });
      if (r.ok) return;
      ultimoErro = new Error(`webhook respondeu ${r.status}`);
    } catch (e) { ultimoErro = e; }
    if (tentativa === 1) await new Promise((ok) => setTimeout(ok, 1500));
  }
  throw ultimoErro;
}

async function pedirCodigo(req, res) {
  const ip = ipDe(req);
  const p = pedidosPorIp.get(ip) || { n: 0, desde: Date.now() };
  if (Date.now() - p.desde > 3600000) { p.n = 0; p.desde = Date.now(); }
  if (++p.n > 10) return json(res, 429, { error: "Muitos pedidos. Tente de novo em 1 hora." });
  pedidosPorIp.set(ip, p);

  const { telefone } = await lerCorpo(req);
  const tel = com55(telefone);
  if (tel.length < 12) return json(res, 400, { error: "Digite o WhatsApp com DDD" });
  const atual = codigosLogin.get(tel);
  if (atual && Date.now() - atual.enviadoEm < 45000) return json(res, 429, { error: "Espere alguns segundos para pedir outro código" });
  // número fora da lista: responde igual, sem mandar nada (não revela quem é admin)
  if (!ADMINS.has(tel)) return json(res, 200, { ok: true });
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  codigosLogin.set(tel, { codigo, expira: Date.now() + 10 * 60000, tentativas: 0, enviadoEm: Date.now() });
  const mensagem = `🔐 Seu código para entrar no painel de QR codes: *${codigo}*\n\nVale por 10 minutos.`;
  if (!WEBHOOK) { log(`🔐 Código de ${tel}: ${codigo}`); return json(res, 200, { ok: true }); }
  try { await avisarN8n(tel, codigo, mensagem); }
  catch (e) {
    log("❌ webhook n8n:", e.message);
    codigosLogin.delete(tel);
    return json(res, 502, { error: "Não deu para mandar o código no WhatsApp. Tente de novo ou entre com a senha." });
  }
  return json(res, 200, { ok: true });
}

function abrirSessao(quem) {
  q.limpaSes.run(Date.now());
  const token = crypto.randomBytes(32).toString("hex");
  q.novaSes.run(token, quem, Date.now() + DIAS_SESSAO * 864e5);
  return token;
}

async function confirmarCodigo(req, res) {
  const { telefone, codigo } = await lerCorpo(req);
  const tel = com55(telefone), c = codigosLogin.get(tel);
  if (!c || c.expira < Date.now()) return json(res, 400, { error: "Código vencido. Peça outro." });
  if (++c.tentativas > 5) { codigosLogin.delete(tel); return json(res, 429, { error: "Muitas tentativas. Peça outro código." }); }
  const dig = so(codigo);
  if (dig.length !== 6 || !crypto.timingSafeEqual(Buffer.from(dig), Buffer.from(c.codigo))) return json(res, 400, { error: "Código errado" });
  codigosLogin.delete(tel);
  log("🔓 entrou pelo WhatsApp:", tel);
  return json(res, 200, { token: abrirSessao(tel) });
}

// senha de admin: 5 erros seguidos travam 15 min por endereço; 30 erros em 1 hora travam para todos
const errosSenha = new Map();
const errosGerais = { n: 0, desde: Date.now() };
async function entrarComSenha(req, res) {
  const ip = ipDe(req);
  const e = errosSenha.get(ip) || { n: 0, ate: 0 };
  if (Date.now() - errosGerais.desde > 3600000) { errosGerais.n = 0; errosGerais.desde = Date.now(); }
  if (e.ate > Date.now() || errosGerais.n >= 30) return json(res, 429, { error: "Muitas tentativas. Espere um pouco ou entre pelo WhatsApp." });
  const { senha } = await lerCorpo(req);
  const a = crypto.createHash("sha256").update(String(senha || "")).digest();
  const b = crypto.createHash("sha256").update(SENHA).digest();
  if (!SENHA || !crypto.timingSafeEqual(a, b)) {
    e.n++; errosGerais.n++;
    if (e.n >= 5) { e.ate = Date.now() + 15 * 60000; e.n = 0; }
    errosSenha.set(ip, e);
    return json(res, 401, { error: "Senha errada" });
  }
  errosSenha.delete(ip);
  log("🔓 entrou com a senha, ip", ip);
  return json(res, 200, { token: abrirSessao("senha") });
}

function sessaoDe(req) {
  const t = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return t && t.length === 64 ? q.sessao.get(t, Date.now()) : null;
}

/* ---------- API dos QR codes ---------- */
async function api(req, res, codigo, extra) {
  const ses = sessaoDe(req);
  if (!ses) return json(res, 401, { error: "Entre de novo" });
  const quem = ses.telefone;
  const base = baseDe(req);
  try {
    if (req.method === "GET" && !codigo) return json(res, 200, { base, fixo: !!PUBLIC_URL, links: q.todos.all() });

    // cria vários de uma vez: { quantidade: 10 }
    if (req.method === "POST" && !codigo) {
      const b = await lerCorpo(req);
      const qtd = Math.min(200, Math.max(1, parseInt(b.quantidade, 10) || 1));
      let n = q.maiorNum.get().n;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let i = 0; i < qtd; i++) { n++; const c = novoCodigo(); q.criar.run(c, n, `QR ${n}`); q.hist.run(c, "criou", null, String(n), quem); }
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      log(`➕ ${qtd} QR criados por ${quem}`);
      return json(res, 201, { base, fixo: !!PUBLIC_URL, links: q.todos.all() });
    }

    const atual = codigo && q.um.get(codigo);
    if (!atual) return json(res, 404, { error: "QR não encontrado" });

    if (req.method === "GET" && extra === "historico") return json(res, 200, { historico: q.histDe.all(codigo) });

    if (req.method === "PUT") {
      const b = await lerCorpo(req);
      const nome = b.nome !== undefined ? String(b.nome).trim().slice(0, 80) || atual.nome : atual.nome;
      const destino = b.destino !== undefined ? destinoValido(b.destino, req) : atual.destino;
      if (destino === null) return json(res, 400, { error: "Link inválido. Cole o link completo de avaliação (ex.: https://g.page/r/...)" });
      q.editar.run(nome, destino, codigo);
      if (destino !== atual.destino) q.hist.run(codigo, "destino", atual.destino, destino, quem);
      if (nome !== atual.nome) q.hist.run(codigo, "nome", atual.nome, nome, quem);
      log(`✏️  QR ${atual.numero} alterado por ${quem}: ${destino || "(sem destino)"}`);
      return json(res, 200, { link: q.um.get(codigo) });
    }
    if (req.method === "DELETE") {
      q.apagar.run(codigo);
      q.hist.run(codigo, "excluiu", String(atual.numero), JSON.stringify(atual), quem);
      log(`🗑️  QR ${atual.numero} (${codigo}) excluído por ${quem}. Destino era: ${atual.destino || "(vazio)"}`);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: "Método não aceito" });
  } catch (e) {
    log("❌ api:", e.message);
    return json(res, 400, { error: e.message || "Erro" });
  }
}

/* ---------- servidor ---------- */
const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    let partes;
    try { partes = url.pathname.split("/").map((p) => decodeURIComponent(p)); } catch { return pagina(res, 400, "Endereço inválido", "Confira o link."); }
    const primeiro = (partes[1] || "").toLowerCase();
    const head = req.method === "HEAD";

    if (primeiro === "api") {
      if (partes[2] === "login" && req.method === "POST") return partes[3] === "confirmar" ? await confirmarCodigo(req, res) : partes[3] === "senha" ? await entrarComSenha(req, res) : await pedirCodigo(req, res);
      if (partes[2] === "sair" && req.method === "POST") { const t = String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""); if (t) q.fimSes.run(t); return json(res, 200, { ok: true }); }
      if (partes[2] === "links") return await api(req, res, (partes[3] || "").toLowerCase(), partes[4]);
      return json(res, 404, { error: "Rota não encontrada" });
    }
    if (req.method !== "GET" && !head) return json(res, 405, { error: "Método não aceito" });

    if (primeiro === "" || primeiro === "painel") return arquivo(res, "index.html", "text/html; charset=utf-8", "no-cache");
    if (primeiro === "qrcode.js") return arquivo(res, "qrcode.js", "text/javascript; charset=utf-8", "public, max-age=86400");
    if (primeiro === "saude") { q.ping.get(); return json(res, 200, { ok: true }); }
    if (primeiro === "robots.txt") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("User-agent: *\nDisallow: /\n"); }
    if (primeiro === "favicon.ico") { res.writeHead(204); return res.end(); }

    // leitura do QR / NFC (aceita barra no fim e letras maiúsculas)
    const link = q.um.get(primeiro);
    if (!link) return pagina(res, 404, "QR code não encontrado", "Confira se a plaquinha é deste estabelecimento.", head);
    if (!link.destino) return pagina(res, 200, "Plaquinha ainda não ativada", "Em breve esta plaquinha vai levar você para avaliar o estabelecimento.", head);
    if (!head) { try { q.clique.run(link.codigo); } catch {} }
    res.writeHead(302, { ...SEGURANCA, Location: link.destino, "Cache-Control": "no-store, max-age=0" });
    res.end();
  } catch (e) {
    log("❌", e.message);
    if (!res.headersSent) json(res, 500, { error: "Erro interno" });
    else res.end();
  }
});
servidor.headersTimeout = 15000;
servidor.requestTimeout = 30000;
servidor.keepAliveTimeout = 5000;

/* ---------- faxina, backup e desligamento ---------- */
setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of codigosLogin) if (v.expira < agora) codigosLogin.delete(k);
  for (const [k, v] of errosSenha) if (v.ate < agora && v.n === 0) errosSenha.delete(k);
  for (const [k, v] of pedidosPorIp) if (agora - v.desde > 3600000) pedidosPorIp.delete(k);
  try { q.limpaSes.run(agora); } catch {}
}, 10 * 60000).unref();
fazerBackup();
setInterval(fazerBackup, 60 * 60000).unref(); // confere de hora em hora; só grava 1 por dia

function desligar(sinal) {
  log(`👋 ${sinal}: desligando`);
  servidor.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => { try { db.close(); } catch {} process.exit(0); }, 5000).unref();
}
process.on("SIGTERM", () => desligar("SIGTERM"));
process.on("SIGINT", () => desligar("SIGINT"));
process.on("uncaughtException", (e) => log("❌ erro não tratado:", e.stack || e.message));
process.on("unhandledRejection", (e) => log("❌ promessa rejeitada:", e?.stack || e));

servidor.listen(PORT, () => log(`🔗 QR dinâmico na porta ${PORT} · banco ${DB_PATH} · link base ${PUBLIC_URL || "(automático)"} · ${ADMINS.size} telefone(s) de admin · senha ${SENHA ? "ligada" : "desligada"}`));

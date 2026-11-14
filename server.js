/* QR dinâmico (plaquinhas de avaliação)
   - Cada plaquinha tem um link fixo: https://SEU-DOMINIO/<codigo>  (vai no QR e no NFC)
   - Quem lê é mandado para o destino salvo no painel; dá para trocar o destino quando quiser.
   - Painel em /painel, entrada de dois jeitos: código no WhatsApp (pelo seu fluxo do n8n) ou senha de admin.
   - Tudo fica num SQLite em DB_PATH (no EasyPanel, monte um volume em /data).

   Variáveis de ambiente:
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

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || "/data/qr.db";
const WEBHOOK = process.env.N8N_WEBHOOK_URL || "";
const SENHA = process.env.ADMIN_SENHA || "";
const so = (t) => String(t || "").replace(/\D/g, "");
const com55 = (t) => { const d = so(t); return d.length === 10 || d.length === 11 ? "55" + d : d; };
const ADMINS = new Set(String(process.env.ADMIN_TELEFONES || "").split(",").map(com55).filter(Boolean));
const PUBLICO = path.join(path.dirname(new URL(import.meta.url).pathname), "public");

if (!ADMINS.size && !SENHA) console.warn("⚠️  ADMIN_TELEFONES e ADMIN_SENHA vazios: ninguém consegue entrar no painel.");
if (!WEBHOOK) console.warn("⚠️  N8N_WEBHOOK_URL vazio: o código de entrada só aparece no log do serviço.");
fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
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
`);

const q = {
  todos:    db.prepare("SELECT * FROM links ORDER BY numero"),
  um:       db.prepare("SELECT * FROM links WHERE codigo = ?"),
  maiorNum: db.prepare("SELECT COALESCE(MAX(numero), 0) AS n FROM links"),
  criar:    db.prepare("INSERT INTO links (codigo, numero, nome) VALUES (?, ?, ?)"),
  editar:   db.prepare("UPDATE links SET nome = ?, destino = ? WHERE codigo = ?"),
  apagar:   db.prepare("DELETE FROM links WHERE codigo = ?"),
  clique:   db.prepare("UPDATE links SET cliques = cliques + 1, ultimo_clique = datetime('now') WHERE codigo = ?"),
  sessao:   db.prepare("SELECT * FROM sessoes WHERE token = ? AND expira_em > ?"),
  novaSes:  db.prepare("INSERT INTO sessoes (token, telefone, expira_em) VALUES (?, ?, ?)"),
  fimSes:   db.prepare("DELETE FROM sessoes WHERE token = ?"),
  limpaSes: db.prepare("DELETE FROM sessoes WHERE expira_em < ?")
};

/* ---------- utilidades ---------- */
const novoCodigo = () => {
  const letras = "abcdefghjkmnpqrstuvwxyz23456789"; // sem letras que confundem (l, 1, o, 0)
  let c;
  do { c = Array.from(crypto.randomBytes(6), (b) => letras[b % letras.length]).join(""); } while (q.um.get(c) || c === "painel" || c === "api");
  return c;
};
function destinoValido(v) {
  let t = String(v || "").trim();
  if (!t) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = "https://" + t; // "evoriseai.com.br" vira "https://evoriseai.com.br"
  try { const u = new URL(t); return ["http:", "https:"].includes(u.protocol) && u.hostname.includes(".") ? u.toString() : null; } catch { return null; }
}
function json(res, status, dados) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(dados));
}
function lerCorpo(req) {
  return new Promise((ok, falha) => {
    let t = "";
    req.on("data", (p) => { t += p; if (t.length > 20000) { falha(new Error("Pedido grande demais")); req.destroy(); } });
    req.on("end", () => { try { ok(t ? JSON.parse(t) : {}); } catch { falha(new Error("JSON inválido")); } });
  });
}
function pagina(res, status, titulo, texto) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#120d0e;color:#f6eeeb;font:16px system-ui;text-align:center;padding:24px"><div><h1 style="font-size:22px;margin:0 0 8px">${titulo}</h1><p style="color:#ab9c99;margin:0">${texto}</p></div></body>`);
}

/* ---------- entrada pelo WhatsApp ---------- */
const codigosLogin = new Map(); // telefone -> { codigo, expira, tentativas, enviadoEm }
const DIAS_SESSAO = 30;

async function pedirCodigo(req, res) {
  const { telefone } = await lerCorpo(req);
  const tel = com55(telefone);
  const atual = codigosLogin.get(tel);
  if (atual && Date.now() - atual.enviadoEm < 45000) return json(res, 429, { error: "Espere alguns segundos para pedir outro código" });
  // número fora da lista: responde igual, sem mandar nada (não revela quem é admin)
  if (!ADMINS.has(tel)) return json(res, 200, { ok: true });
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  codigosLogin.set(tel, { codigo, expira: Date.now() + 10 * 60000, tentativas: 0, enviadoEm: Date.now() });
  const mensagem = `🔐 Seu código para entrar no painel de QR codes: *${codigo}*\n\nVale por 10 minutos.`;
  if (!WEBHOOK) { console.log(`🔐 Código de ${tel}: ${codigo}`); return json(res, 200, { ok: true }); }
  try {
    const r = await fetch(WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ evento: "qr_login", telefone: tel, codigo, mensagem, enviado_em: new Date().toISOString() }),
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) throw new Error(`webhook respondeu ${r.status}`);
  } catch (e) {
    console.error("❌ webhook n8n:", e.message);
    return json(res, 502, { error: "Não deu para mandar o código no WhatsApp. Tente de novo." });
  }
  return json(res, 200, { ok: true });
}

async function confirmarCodigo(req, res) {
  const { telefone, codigo } = await lerCorpo(req);
  const tel = com55(telefone), c = codigosLogin.get(tel);
  if (!c || c.expira < Date.now()) return json(res, 400, { error: "Código vencido. Peça outro." });
  if (++c.tentativas > 5) { codigosLogin.delete(tel); return json(res, 429, { error: "Muitas tentativas. Peça outro código." }); }
  if (so(codigo) !== c.codigo) return json(res, 400, { error: "Código errado" });
  codigosLogin.delete(tel);
  q.limpaSes.run(Date.now());
  const token = crypto.randomBytes(32).toString("hex");
  q.novaSes.run(token, tel, Date.now() + DIAS_SESSAO * 864e5);
  return json(res, 200, { token });
}

// entrar com a senha de admin (5 erros seguidos travam 15 min por endereço)
const errosSenha = new Map();
async function entrarComSenha(req, res) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const e = errosSenha.get(ip) || { n: 0, ate: 0 };
  if (e.ate > Date.now()) return json(res, 429, { error: "Muitas tentativas. Espere 15 minutos." });
  const { senha } = await lerCorpo(req);
  const s = String(senha || "");
  const certa = SENHA && s.length === SENHA.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(SENHA));
  if (!certa) {
    e.n++; if (e.n >= 5) { e.ate = Date.now() + 15 * 60000; e.n = 0; }
    errosSenha.set(ip, e);
    return json(res, 401, { error: "Senha errada" });
  }
  errosSenha.delete(ip);
  q.limpaSes.run(Date.now());
  const token = crypto.randomBytes(32).toString("hex");
  q.novaSes.run(token, "senha", Date.now() + DIAS_SESSAO * 864e5);
  return json(res, 200, { token });
}

function logado(req) {
  const t = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return t && q.sessao.get(t, Date.now());
}

/* ---------- API dos QR codes ---------- */
async function api(req, res, codigo) {
  if (!logado(req)) return json(res, 401, { error: "Entre de novo" });
  try {
    if (req.method === "GET" && !codigo) return json(res, 200, { links: q.todos.all() });

    // cria vários de uma vez: { quantidade: 10 }
    if (req.method === "POST" && !codigo) {
      const b = await lerCorpo(req);
      const qtd = Math.min(200, Math.max(1, parseInt(b.quantidade, 10) || 1));
      let n = q.maiorNum.get().n;
      db.exec("BEGIN");
      try {
        for (let i = 0; i < qtd; i++) { n++; q.criar.run(novoCodigo(), n, `QR ${n}`); }
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      return json(res, 201, { links: q.todos.all() });
    }

    const atual = codigo && q.um.get(codigo);
    if (!atual) return json(res, 404, { error: "QR não encontrado" });

    if (req.method === "PUT") {
      const b = await lerCorpo(req);
      const nome = b.nome !== undefined ? String(b.nome).trim().slice(0, 80) || atual.nome : atual.nome;
      const destino = b.destino !== undefined ? destinoValido(b.destino) : atual.destino;
      if (destino === null) return json(res, 400, { error: "O destino precisa começar com http:// ou https://" });
      q.editar.run(nome, destino, codigo);
      return json(res, 200, { link: q.um.get(codigo) });
    }
    if (req.method === "DELETE") { q.apagar.run(codigo); return json(res, 200, { ok: true }); }
    return json(res, 405, { error: "Método não aceito" });
  } catch (e) {
    return json(res, 400, { error: e.message || "Erro" });
  }
}

/* ---------- servidor ---------- */
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const partes = url.pathname.split("/").map((p) => decodeURIComponent(p));
    const primeiro = (partes[1] || "").toLowerCase();

    if (primeiro === "api") {
      if (partes[2] === "login" && req.method === "POST") return partes[3] === "confirmar" ? confirmarCodigo(req, res) : partes[3] === "senha" ? entrarComSenha(req, res) : pedirCodigo(req, res);
      if (partes[2] === "sair" && req.method === "POST") { const t = String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""); if (t) q.fimSes.run(t); return json(res, 200, { ok: true }); }
      if (partes[2] === "links") return api(req, res, (partes[3] || "").toLowerCase());
      return json(res, 404, { error: "Rota não encontrada" });
    }
    if (primeiro === "" || primeiro === "painel") {
      return fs.readFile(path.join(PUBLICO, "index.html"), (err, dados) => {
        if (err) { res.writeHead(500); return res.end("Painel não encontrado"); }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(dados);
      });
    }
    if (primeiro === "robots.txt") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("User-agent: *\nDisallow: /\n"); }
    if (primeiro === "favicon.ico") { res.writeHead(204); return res.end(); }

    // leitura do QR / NFC
    const link = q.um.get(primeiro);
    if (!link) return pagina(res, 404, "QR code não encontrado", "Confira se a plaquinha é deste estabelecimento.");
    if (!link.destino) return pagina(res, 200, "Plaquinha ainda não ativada", "Em breve esta plaquinha vai levar você para avaliar o estabelecimento.");
    try { q.clique.run(link.codigo); } catch {}
    res.writeHead(302, { Location: link.destino, "Cache-Control": "no-store, max-age=0" });
    res.end();
  } catch (e) {
    console.error("❌", e.message);
    if (!res.headersSent) json(res, 500, { error: "Erro interno" });
  }
}).listen(PORT, () => console.log(`🔗 QR dinâmico na porta ${PORT} · banco ${path.resolve(DB_PATH)} · ${ADMINS.size} telefone(s) de admin · senha ${SENHA ? "ligada" : "desligada"}`));

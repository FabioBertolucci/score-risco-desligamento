import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM, SCHEMA, MAX_TXT, userMessage, classOf } from "./prompt.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const MOCK = process.env.MOCK_CLAUDE === "1";
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const DATA_DIR = process.env.DATA_DIR || path.join(here, "data");

if (!APP_PASSWORD || !SESSION_SECRET) {
  console.error("Defina APP_PASSWORD e SESSION_SECRET (veja .env.example).");
  process.exit(1);
}
if (!MOCK && !process.env.ANTHROPIC_API_KEY) {
  console.error("Defina ANTHROPIC_API_KEY, ou MOCK_CLAUDE=1 para testar sem a API.");
  process.exit(1);
}

// ---------- banco ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "avaliacoes.db"));
db.exec(`CREATE TABLE IF NOT EXISTS avaliacoes (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  vaga TEXT,
  nota INTEGER NOT NULL,
  dados TEXT NOT NULL,
  curriculo TEXT,
  entrevista TEXT,
  autor TEXT,
  criado_em TEXT NOT NULL,
  revisao TEXT NOT NULL DEFAULT 'pendente',
  nota_revisao TEXT,
  revisor TEXT,
  revisado_em TEXT
)`);

const toJson = (r) => ({
  id: r.id, nome: r.nome, vaga: r.vaga, nota: r.nota, classificacao: classOf(r.nota),
  ...JSON.parse(r.dados),
  curriculo: r.curriculo, entrevista: r.entrevista, autor: r.autor, criadoEm: r.criado_em,
  revisao: r.revisao, notaRevisao: r.nota_revisao || "", revisor: r.revisor, revisadoEm: r.revisado_em,
});

// ---------- sessão (cookie assinado com HMAC) ----------
const sign = (v) => crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("base64url");
function makeCookie(nome) {
  const payload = Buffer.from(JSON.stringify({ nome, exp: Date.now() + 12 * 3600e3 })).toString("base64url");
  return payload + "." + sign(payload);
}
function readSession(req) {
  const raw = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith("sessao="));
  if (!raw) return null;
  const [payload, sig] = raw.slice(7).split(".");
  if (!payload || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString());
    return s.exp > Date.now() ? s : null;
  } catch { return null; }
}
const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "public")));

app.post("/api/login", (req, res) => {
  const nome = String(req.body?.nome || "").trim().slice(0, 80);
  const senha = String(req.body?.senha || "");
  const ok = crypto.timingSafeEqual(
    crypto.createHash("sha256").update(senha).digest(),
    crypto.createHash("sha256").update(APP_PASSWORD).digest(),
  );
  if (!nome || !ok) return res.status(401).json({ erro: "Nome ou senha incorretos." });
  res.setHeader("Set-Cookie", `sessao=${makeCookie(nome)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`);
  res.json({ nome });
});
app.post("/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `sessao=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
  res.json({ ok: true });
});

// Tudo abaixo exige login.
app.use("/api", (req, res, next) => {
  const s = readSession(req);
  if (!s) return res.status(401).json({ erro: "Faça login para continuar." });
  req.usuario = s.nome;
  next();
});

app.get("/api/eu", (req, res) => res.json({ nome: req.usuario }));

app.get("/api/avaliacoes", (_req, res) => {
  const rows = db.prepare("SELECT * FROM avaliacoes ORDER BY nota ASC, nome ASC").all();
  res.json(rows.map(toJson));
});

// ---------- chamada ao Claude ----------
const client = MOCK ? null : new Anthropic();

async function avaliar(entrada) {
  if (MOCK) return mockAvaliacao(entrada);
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: userMessage(entrada) }],
  });
  if (response.stop_reason === "refusal") throw Object.assign(new Error("refusal"), { publico: "O Claude não aceitou analisar este texto. Revise o conteúdo e tente de novo." });
  if (response.stop_reason === "max_tokens") throw Object.assign(new Error("max_tokens"), { publico: "A análise ficou longa demais. Encurte o currículo ou os comentários." });
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}

function mockAvaliacao({ curriculo, entrevista }) {
  const t = (curriculo + " " + entrevista).toLowerCase();
  let nota = 45;
  if (/esperando|outra proposta|outra vaga/.test(t)) nota += 25;
  if (/1 m[eê]s|um m[eê]s/.test(t)) nota += 15;
  if (/estabilidade|aceit|atendem/.test(t)) nota -= 20;
  nota = Math.max(0, Math.min(100, nota));
  return {
    nota,
    resumo: "Resultado de TESTE gerado sem a API do Claude (MOCK_CLAUDE=1). A nota foi calculada por regras simples só para testar a tela.",
    fatores_risco: [{ fator: "Exemplo de fator de risco", evidencia: (entrevista || curriculo).slice(0, 80) }],
    fatores_protecao: [],
    pontos_a_verificar: ["Configure ANTHROPIC_API_KEY para usar a análise real."],
    confianca: "baixa",
  };
}

const clip = (v, n) => String(v ?? "").slice(0, n);
const fatores = (x) => (Array.isArray(x) ? x : []).slice(0, 8)
  .map((f) => ({ fator: clip(f?.fator, 300), evidencia: clip(f?.evidencia, 300) })).filter((f) => f.fator);

app.post("/api/avaliar", async (req, res) => {
  const nome = clip(req.body?.nome, 120).trim();
  const vaga = clip(req.body?.vaga, 300).trim();
  const curriculo = clip(req.body?.curriculo, MAX_TXT).trim();
  const entrevista = clip(req.body?.entrevista, MAX_TXT).trim();
  if (!nome) return res.status(400).json({ erro: "Informe o nome." });
  if (!curriculo && !entrevista) return res.status(400).json({ erro: "Inclua o currículo, os comentários da entrevista ou os dois." });

  let r;
  try {
    r = await avaliar({ nome, vaga, curriculo, entrevista });
  } catch (e) {
    console.error("Falha na avaliação:", e?.status || "", e?.message);
    let msg = e.publico || "Não foi possível calcular agora. Tente novamente.";
    if (e instanceof Anthropic.RateLimitError) msg = "Muitas avaliações em pouco tempo. Tente de novo em alguns minutos.";
    else if (e instanceof Anthropic.AuthenticationError) msg = "A chave da API do Claude está inválida. Avise o responsável pelo sistema.";
    return res.status(502).json({ erro: msg });
  }

  const nota = Math.max(0, Math.min(100, Math.round(Number(r?.nota))));
  if (!Number.isFinite(nota)) return res.status(502).json({ erro: "A resposta veio num formato inesperado. Tente novamente." });
  const dados = {
    resumo: clip(r.resumo, 1500),
    fatores_risco: fatores(r.fatores_risco),
    fatores_protecao: fatores(r.fatores_protecao),
    pontos_a_verificar: (Array.isArray(r.pontos_a_verificar) ? r.pontos_a_verificar : []).slice(0, 6).map((s) => clip(s, 300)),
    confianca: clip(r.confianca, 20),
  };
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO avaliacoes (id, nome, vaga, nota, dados, curriculo, entrevista, autor, criado_em)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, nome, vaga, nota, JSON.stringify(dados), curriculo, entrevista, req.usuario, new Date().toISOString());
  res.json(toJson(db.prepare("SELECT * FROM avaliacoes WHERE id = ?").get(id)));
});

app.patch("/api/avaliacoes/:id", (req, res) => {
  const revisao = String(req.body?.revisao || "");
  if (!["pendente", "confirmada", "contestada"].includes(revisao)) return res.status(400).json({ erro: "Revisão inválida." });
  const r = db.prepare(`UPDATE avaliacoes SET revisao = ?, nota_revisao = ?, revisor = ?, revisado_em = ? WHERE id = ?`)
    .run(revisao, clip(req.body?.notaRevisao, 500), req.usuario, new Date().toISOString(), req.params.id);
  if (!r.changes) return res.status(404).json({ erro: "Avaliação não encontrada." });
  res.json(toJson(db.prepare("SELECT * FROM avaliacoes WHERE id = ?").get(req.params.id)));
});

app.delete("/api/avaliacoes/:id", (req, res) => {
  db.prepare("DELETE FROM avaliacoes WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Score de risco rodando em http://localhost:${PORT}${MOCK ? " (modo de teste, sem API)" : ""}`));

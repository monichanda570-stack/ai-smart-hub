import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import OpenAI from "openai";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) { fs.mkdirSync(dataDir, { recursive: true }); }
const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "";
const isProd = process.env.NODE_ENV === "production";
const CHAT_LIMIT = Math.max(1, Number(process.env.DAILY_CHAT_LIMIT || 25));
const IMAGE_LIMIT = Math.max(0, Number(process.env.DAILY_IMAGE_LIMIT || 2));

if (JWT_SECRET.length < 32) 

  console.error("SECURITY ERROR: Set JWT_SECRET in .env to a random secret at least 32 characters long.");
  process.exit(1);
}

const adapter = new JSONFile(path.join(__dirname, "data", "db.json"));
const db = new Low(adapter, { users: [], conversations: [], usage: [] });
await db.read();
db.data ||= { users: [], conversations: [], usage: [] };
await db.write();

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false });

const dayKey = () => new Date().toISOString().slice(0, 10);
const safeUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt });

async function readDb() { await db.read(); db.data ||= { users: [], conversations: [], usage: [] }; }
async function writeDb() { await db.write(); }
function tokenFor(user) { return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "7d" }); }
function setAuthCookie(res, user) {
  res.cookie("ash_session", tokenFor(user), {
    httpOnly: true, secure: isProd, sameSite: "lax", path: "/", maxAge: 7 * 24 * 60 * 60 * 1000
  });
}
function authRequired(req, res, next) {
  try {
    const token = req.cookies.ash_session;
    if (!token) return res.status(401).json({ error: "প্রথমে লগইন করুন।" });
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.clearCookie("ash_session", { path: "/" }); return res.status(401).json({ error: "সেশন শেষ হয়েছে। আবার লগইন করুন।" }); }
}
async function currentUser(req) {
  await readDb();
  return db.data.users.find(u => u.id === req.auth.sub);
}
async function usageFor(userId) {
  await readDb();
  let row = db.data.usage.find(x => x.userId === userId && x.day === dayKey());
  if (!row) {
    row = { userId, day: dayKey(), chats: 0, images: 0 };
    db.data.usage.push(row);
    await writeDb();
  }
  return row;
}
function providerAvailable(provider) {
  return provider === "openai" ? Boolean(openai) : provider === "gemini" ? Boolean(process.env.GEMINI_API_KEY) : false;
}
function systemPrompt(mode) {
  const prompts = {
    chat: "You are AI Smart Hub, a helpful, honest and accurate assistant. Reply in the same language as the user. If unsure, say so.",
    writer: "You are an expert writing assistant. Draft, rewrite, proofread and translate. Produce polished, ready-to-use content in the user's language.",
    coding: "You are a senior software engineer and patient coding tutor. Provide correct, secure code and concise explanations in the user's language.",
    study: "You are a patient tutor. Teach step by step with simple examples and check understanding. Reply in the user's language.",
    summarize: "Summarize accurately. Preserve key facts, names, numbers and caveats. Reply in the user's language."
  };
  return prompts[mode] || prompts.chat;
}
function extractGeminiText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const texts = [];
  for (const step of payload.steps || []) {
    for (const item of step.content || []) if (item.type === "text" && item.text) texts.push(item.text);
  }
  return texts.join("\n").trim();
}
async function generateText({ provider, model, mode, message, history }) {
  const instructions = systemPrompt(mode);
  const cleanHistory = history.slice(-12).map(m => ({ role: m.role, content: m.content.slice(0, 6000) }));
  if (provider === "openai") {
    if (!openai) throw new Error("OpenAI API Key সেট করা হয়নি।");
    const response = await openai.responses.create({
      model: model || process.env.OPENAI_CHAT_MODEL || "gpt-5.5",
      instructions,
      input: [...cleanHistory, { role: "user", content: message }],
      max_output_tokens: 2500
    });
    return response.output_text || "দুঃখিত, কোনো উত্তর পাওয়া যায়নি।";
  }
  if (provider === "gemini") {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("Gemini API Key সেট করা হয়নি।");
    const turns = [...cleanHistory, { role: "user", content: message }]
      .map(m => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`).join("\n\n");
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        model: model || process.env.GEMINI_CHAT_MODEL || "gemini-3.8-flash",
        input: turns,
        system_instruction: instructions,
        store: false
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      console.error("Gemini API error:", response.status, payload?.error?.message);
      throw new Error("Gemini API অনুরোধ ব্যর্থ হয়েছে। API key, model access ও billing পরীক্ষা করুন।");
    }
    return extractGeminiText(payload) || "দুঃখিত, কোনো উত্তর পাওয়া যায়নি।";
  }
  throw new Error("অজানা AI provider।");
}

app.get("/api/health", (req, res) => res.json({
  ok: true,
  providers: { openai: Boolean(openai), gemini: Boolean(process.env.GEMINI_API_KEY) },
  freeLimits: { chats: CHAT_LIMIT, images: IMAGE_LIMIT }
}));

app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const { name, email, password, adminSetupCode } = req.body || {};
    if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 50) return res.status(400).json({ error: "নাম ২–৫০ অক্ষরের মধ্যে লিখুন।" });
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) return res.status(400).json({ error: "সঠিক ইমেইল ঠিকানা লিখুন।" });
    if (typeof password !== "string" || password.length < 10 || password.length > 100) return res.status(400).json({ error: "পাসওয়ার্ড কমপক্ষে ১০ অক্ষরের হতে হবে।" });
    await readDb();
    const normalized = email.trim().toLowerCase();
    if (db.data.users.some(u => u.email === normalized)) return res.status(409).json({ error: "এই ইমেইল দিয়ে অ্যাকাউন্ট আগে থেকেই আছে।" });
    const passwordHash = await bcrypt.hash(password, 12);
    const isAdminEmail = process.env.ADMIN_EMAIL && normalized === process.env.ADMIN_EMAIL.trim().toLowerCase();
    if (isAdminEmail && process.env.ADMIN_SETUP_TOKEN && adminSetupCode !== process.env.ADMIN_SETUP_TOKEN) {
      return res.status(403).json({ error: "Admin setup code সঠিক নয়।" });
    }
    const role = isAdminEmail && process.env.ADMIN_SETUP_TOKEN ? "admin" : "user";
    const user = { id: randomUUID(), name: name.trim(), email: normalized, passwordHash, role, createdAt: new Date().toISOString() };
    db.data.users.push(user);
    await writeDb();
    setAuthCookie(res, user);
    res.status(201).json({ user: safeUser(user) });
  } catch (e) { console.error(e); res.status(500).json({ error: "অ্যাকাউন্ট তৈরি করা যায়নি।" }); }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  await readDb();
  const user = db.data.users.find(u => u.email === String(email || "").trim().toLowerCase());
  if (!user || typeof password !== "string" || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: "ইমেইল অথবা পাসওয়ার্ড সঠিক নয়।" });
  setAuthCookie(res, user);
  res.json({ user: safeUser(user) });
});
app.post("/api/auth/logout", (req, res) => { res.clearCookie("ash_session", { path: "/" }); res.json({ ok: true }); });
app.get("/api/me", authRequired, async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "অ্যাকাউন্ট পাওয়া যায়নি।" });
  const usage = await usageFor(user.id);
  res.json({ user: safeUser(user), usage, limits: { chats: CHAT_LIMIT, images: IMAGE_LIMIT } });
});

app.get("/api/conversations", authRequired, async (req, res) => {
  const user = await currentUser(req); if (!user) return res.status(401).json({ error: "লগইন প্রয়োজন।" });
  await readDb();
  const items = db.data.conversations.filter(c => c.userId === user.id)
    .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(c => ({ id:c.id, title:c.title, provider:c.provider, updatedAt:c.updatedAt }));
  res.json({ conversations: items });
});
app.get("/api/conversations/:id", authRequired, async (req, res) => {
  const user = await currentUser(req); await readDb();
  const c = db.data.conversations.find(x => x.id === req.params.id && x.userId === user?.id);
  if (!c) return res.status(404).json({ error: "চ্যাট পাওয়া যায়নি।" });
  res.json({ conversation: c });
});
app.delete("/api/conversations/:id", authRequired, async (req, res) => {
  const user = await currentUser(req); await readDb();
  const before = db.data.conversations.length;
  db.data.conversations = db.data.conversations.filter(x => !(x.id === req.params.id && x.userId === user?.id));
  await writeDb();
  res.json({ deleted: before !== db.data.conversations.length });
});

app.post("/api/chat", authRequired, apiLimiter, async (req, res) => {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "লগইন প্রয়োজন।" });
    const { message, conversationId, provider = "openai", model, mode = "chat" } = req.body || {};
    if (typeof message !== "string" || !message.trim()) return res.status(400).json({ error: "একটি মেসেজ লিখুন।" });
    if (message.length > 10000) return res.status(413).json({ error: "মেসেজ ১০,০০০ অক্ষরের মধ্যে রাখুন।" });
    if (!["chat","writer","coding","study","summarize"].includes(mode)) return res.status(400).json({ error: "অজানা AI mode।" });
    if (!["openai","gemini"].includes(provider)) return res.status(400).json({ error: "অজানা AI provider।" });
    if (!providerAvailable(provider)) return res.status(503).json({ error: `${provider} API Key অ্যাডমিনকে সেট করতে হবে।` });
    const usage = await usageFor(user.id);
    if (usage.chats >= CHAT_LIMIT) return res.status(429).json({ error: `আজকের ফ্রি Chat limit (${CHAT_LIMIT}) শেষ। আগামী UTC দিনে আবার চেষ্টা করুন।` });

    // Count the request before calling the provider so repeated failed requests cannot bypass free limits.
    usage.chats += 1;
    await writeDb();
    let convo = conversationId ? db.data.conversations.find(c => c.id === conversationId && c.userId === user.id) : null;
    if (conversationId && !convo) return res.status(404).json({ error: "এই চ্যাটটি পাওয়া যায়নি।" });
    if (!convo) {
      convo = { id: randomUUID(), userId: user.id, title: message.trim().slice(0, 55), provider, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
      db.data.conversations.push(convo);
    }
    const prior = convo.messages.slice(-12).map(m => ({ role: m.role, content: m.content }));
    const answer = await generateText({ provider, model: typeof model === "string" ? model.slice(0,100) : undefined, mode, message: message.trim(), history: prior });
    const now = new Date().toISOString();
    convo.provider = provider;
    convo.messages.push({ role: "user", content: message.trim(), createdAt: now }, { role: "assistant", content: answer, createdAt: now });
    convo.updatedAt = now;
    await writeDb();
    res.json({ answer, conversationId: convo.id, usage: { chats: usage.chats, limit: CHAT_LIMIT } });
  } catch (e) {
    console.error("Chat error:", e?.status, e?.message);
    res.status(500).json({ error: e.message?.includes("API Key") ? e.message : "AI উত্তর তৈরি করা যায়নি। Provider settings, API quota ও model access পরীক্ষা করুন।" });
  }
});

app.post("/api/image", authRequired, apiLimiter, async (req, res) => {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "লগইন প্রয়োজন।" });
    const { prompt } = req.body || {};
    if (typeof prompt !== "string" || !prompt.trim()) return res.status(400).json({ error: "ছবির বর্ণনা লিখুন।" });
    if (prompt.length > 3500) return res.status(413).json({ error: "Prompt ৩,৫০০ অক্ষরের মধ্যে রাখুন।" });
    if (!openai) return res.status(503).json({ error: "Image Generator চালাতে OpenAI API Key প্রয়োজন।" });
    const usage = await usageFor(user.id);
    if (usage.images >= IMAGE_LIMIT) return res.status(429).json({ error: `আজকের ফ্রি Image limit (${IMAGE_LIMIT}) শেষ।` });
    const result = await openai.images.generate({
      model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst",
      prompt: prompt.trim(),
      size: "1024x1024"
    });
    const b64 = result.data?.[0]?.b64_json;
    if (!b64) return res.status(502).json({ error: "Image API থেকে ছবি পাওয়া যায়নি।" });
    usage.images += 1;
    await writeDb();
    res.json({ image: `data:image/png;base64,${b64}`, usage: { images: usage.images, limit: IMAGE_LIMIT } });
  } catch (e) {
    console.error("Image error:", e?.status, e?.message);
    res.status(500).json({ error: "ছবি তৈরি হয়নি। OpenAI image model access ও billing পরীক্ষা করুন।" });
  }
});

app.get("/api/admin/overview", authRequired, async (req, res) => {
  const user = await currentUser(req);
  if (!user || user.role !== "admin") return res.status(403).json({ error: "শুধু Admin ব্যবহার করতে পারবেন।" });
  await readDb();
  res.json({
    users: db.data.users.map(safeUser),
    totalConversations: db.data.conversations.length,
    providers: { openai: Boolean(openai), gemini: Boolean(process.env.GEMINI_API_KEY) }
  });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => {
  console.log(`AI Smart Hub V2 running at http://localhost:${PORT}`);
  console.log(`Providers: OpenAI=${Boolean(openai)} | Gemini=${Boolean(process.env.GEMINI_API_KEY)}`);
});

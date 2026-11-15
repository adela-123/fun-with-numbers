// Times Table Stars leaderboard endpoint.
//
// The only way in or out of the leaderboard data. The game calls these routes; nobody gets
// direct access to the database except the account owner in the Cloudflare dashboard.
//
//   GET  /health                         is the service up?
//   GET  /board                          best player for each of the 100 facts
//   GET  /taken?exclude=<id>             emojis already chosen by someone else
//   GET  /check?nickname=..&exclude=..   can this nickname be used?
//   POST /join     {emoji, nickname}            -> {id, key}
//   POST /profile  {id, key, emoji, nickname}   change emoji or nickname
//   POST /leave    {id, key}                    remove the player and their times
//   POST /scores   {id, key, times:[{c, ms, at}]}  replace the player's times

import { EMOJIS, cleanNickname, nickKey, nicknameProblem } from "./name-rules.js";

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // only times from the last 2 weeks count
const MIN_MS = 300;
const MAX_MS = 60000;
const CELL = /^(10|[1-9])x(10|[1-9])$/;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "null",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });

    try {
      const url = new URL(request.url);
      const route = request.method + " " + url.pathname.replace(/\/+$/, "");
      switch (route) {
        case "GET /health": return reply({ ok: true });
        case "GET /board": return reply(await board(env));
        case "GET /taken": return reply(await taken(env, url.searchParams.get("exclude")));
        case "GET /check": return reply(await check(env, url.searchParams.get("nickname"), url.searchParams.get("exclude")));
        case "POST /join": return await join(env, await body(request), reply);
        case "POST /profile": return await profile(env, await body(request), reply);
        case "POST /leave": return await leave(env, await body(request), reply);
        case "POST /scores": return await scores(env, await body(request), reply);
        default: return reply({ error: "not_found" }, 404);
      }
    } catch (e) {
      if (e instanceof BadRequest) return reply({ error: "bad_request", message: e.message }, 400);
      console.error(e);
      return reply({ error: "server_error" }, 500);
    }
  },
};

class BadRequest extends Error {}

async function body(request) {
  const text = await request.text();
  if (text.length > 20000) throw new BadRequest("Too large.");
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object") return data;
  } catch (e) { /* fall through */ }
  throw new BadRequest("Send JSON.");
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The player, if the id and secret key match; otherwise null. */
async function authed(env, data) {
  if (typeof data.id !== "string" || typeof data.key !== "string" || data.key.length > 200) return null;
  const row = await env.DB.prepare("SELECT id, key_hash FROM players WHERE id = ?1").bind(data.id).first();
  if (!row) return null;
  return row.key_hash === (await sha256(data.key)) ? row : null;
}

async function board(env) {
  const since = Date.now() - WINDOW_MS;
  const { results } = await env.DB.prepare(
    `SELECT t.cell, t.ms, t.since, p.id, p.emoji, p.nickname
       FROM times t JOIN players p ON p.id = t.player_id
      WHERE t.at > ?1
      ORDER BY t.cell, t.ms, t.since`
  ).bind(since).all();
  const cells = {};
  const holders = {};
  for (const r of results) {
    if (cells[r.cell]) continue; // rows are sorted: the first per fact is the fastest, earliest on a tie
    cells[r.cell] = { ms: r.ms, p: r.id };
    holders[r.id] = holders[r.id] || { id: r.id, emoji: r.emoji, nickname: r.nickname, squares: 0 };
    holders[r.id].squares += 1;
  }
  const players = Object.values(holders).sort((a, b) => b.squares - a.squares || a.nickname.localeCompare(b.nickname));
  return { cells, players, windowDays: 14 };
}

async function taken(env, exclude) {
  const { results } = await env.DB.prepare("SELECT emoji FROM players WHERE id != ?1").bind(exclude || "").all();
  return { emojis: results.map((r) => r.emoji), all: EMOJIS };
}

async function check(env, raw, exclude) {
  const problem = nicknameProblem(raw);
  if (problem) return { ok: false, reason: problem };
  const row = await env.DB.prepare("SELECT id FROM players WHERE nick_norm = ?1 AND id != ?2")
    .bind(nickKey(raw), exclude || "").first();
  return row ? { ok: false, reason: "Someone already has that nickname." } : { ok: true };
}

function validateProfile(data) {
  if (!EMOJIS.includes(data.emoji)) return { field: "emoji", reason: "Pick one of the emojis shown." };
  const problem = nicknameProblem(data.nickname);
  if (problem) return { field: "nickname", reason: problem };
  return null;
}

// A UNIQUE clash means someone took the emoji or nickname first. Say which.
async function clash(env, data, exclude) {
  const e = await env.DB.prepare("SELECT 1 FROM players WHERE emoji = ?1 AND id != ?2").bind(data.emoji, exclude).first();
  if (e) return { field: "emoji", reason: "Someone just picked that emoji. Choose another." };
  return { field: "nickname", reason: "Someone already has that nickname." };
}

async function join(env, data, reply) {
  const bad = validateProfile(data);
  if (bad) return reply({ error: "invalid", ...bad }, 400);
  const id = "p_" + randomHex(12);
  const key = randomHex(32);
  const now = Date.now();
  try {
    await env.DB.prepare(
      "INSERT INTO players (id, key_hash, emoji, nickname, nick_norm, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)"
    ).bind(id, await sha256(key), data.emoji, cleanNickname(data.nickname), nickKey(data.nickname), now).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return reply({ error: "taken", ...(await clash(env, data, "")) }, 409);
    throw e;
  }
  return reply({ id, key, emoji: data.emoji, nickname: cleanNickname(data.nickname) });
}

async function profile(env, data, reply) {
  const me = await authed(env, data);
  if (!me) return reply({ error: "unknown_player" }, 403);
  const bad = validateProfile(data);
  if (bad) return reply({ error: "invalid", ...bad }, 400);
  try {
    await env.DB.prepare("UPDATE players SET emoji = ?2, nickname = ?3, nick_norm = ?4, updated_at = ?5 WHERE id = ?1")
      .bind(me.id, data.emoji, cleanNickname(data.nickname), nickKey(data.nickname), Date.now()).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return reply({ error: "taken", ...(await clash(env, data, me.id)) }, 409);
    throw e;
  }
  return reply({ ok: true, emoji: data.emoji, nickname: cleanNickname(data.nickname) });
}

async function leave(env, data, reply) {
  const me = await authed(env, data);
  if (!me) return reply({ ok: true }); // already gone
  await env.DB.batch([
    env.DB.prepare("DELETE FROM times WHERE player_id = ?1").bind(me.id),
    env.DB.prepare("DELETE FROM players WHERE id = ?1").bind(me.id),
  ]);
  return reply({ ok: true });
}

async function scores(env, data, reply) {
  const me = await authed(env, data);
  if (!me) return reply({ error: "unknown_player" }, 403);
  if (!Array.isArray(data.times) || data.times.length > 100) throw new BadRequest("times must be a list of up to 100.");
  const now = Date.now();
  const seen = new Set();
  const rows = [];
  for (const t of data.times) {
    if (!t || typeof t.c !== "string" || !CELL.test(t.c) || seen.has(t.c)) continue;
    const ms = Math.round(Number(t.ms) / 100) * 100; // tenths of a second: equal at that precision is a tie
    const at = Math.min(Math.floor(Number(t.at)), now);
    if (!(ms >= MIN_MS && ms <= MAX_MS) || !(at > now - WINDOW_MS)) continue;
    seen.add(t.c);
    rows.push({ c: t.c, ms, at });
  }
  const list = JSON.stringify(rows);
  await env.DB.batch([
    // Facts that no longer qualify (a wrong answer, or older than 2 weeks) come off the board.
    env.DB.prepare(
      "DELETE FROM times WHERE player_id = ?1 AND cell NOT IN (SELECT json_extract(value, '$.c') FROM json_each(?2))"
    ).bind(me.id, list),
    // Keep "since" when the time is unchanged, so the first to reach a time keeps a tie.
    env.DB.prepare(
      `INSERT INTO times (player_id, cell, ms, at, since)
       SELECT ?1, json_extract(value, '$.c'), json_extract(value, '$.ms'), json_extract(value, '$.at'), ?3
         FROM json_each(?2) WHERE true
       ON CONFLICT (player_id, cell) DO UPDATE SET
         since = CASE WHEN times.ms = excluded.ms THEN times.since ELSE excluded.since END,
         ms = excluded.ms,
         at = excluded.at
       WHERE times.ms != excluded.ms OR times.at != excluded.at`
    ).bind(me.id, list, now),
  ]);
  return reply({ ok: true, counted: rows.length });
}

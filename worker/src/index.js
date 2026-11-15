// Times Table Stars leaderboard endpoint.
//
// The only way in or out of the leaderboard data. The game calls these routes; nobody gets
// direct access to the database except the account owner in the Cloudflare dashboard.
//
//   GET  /health                               is the service up?
//   GET  /board?game=mul                       best player for each fact, and the players' right-answer share
//   GET  /taken?exclude=<id>                   emojis already chosen by someone else
//   GET  /check?nickname=..&exclude=..         can this nickname be used?
//   POST /join      {emoji, nickname, adj, animal}        -> {id, key}
//   POST /profile   {id, key, emoji, nickname}            change emoji or nickname
//   POST /recovery  {id, key, adj, animal}                set the recovery words
//   POST /recover   {nickname, adj, animal}               -> {id, key, emoji, nickname, progress}
//   POST /progress  {id, key, data}                       save the player's whole game
//   POST /leave     {id, key}                             remove the player and everything about them
//   POST /scores    {id, key, game, times:[{c, ms, at}], acc:{right, total}}

import { EMOJIS, ADJECTIVES, ANIMALS, cleanNickname, nickKey, nicknameProblem } from "./name-rules.js";

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // only times from the last 2 weeks count
const MIN_MS = 300;
const MAX_MS = 60000;
const CELL = /^(10|[1-9])x(10|[1-9])$/;
const GAME = /^[a-z]{2,12}$/;
const RECOVER_TRIES = 5;                       // wrong recovery guesses allowed...
const RECOVER_LOCK_MS = 24 * 60 * 60 * 1000;   // ...before that nickname is locked for a day
const MAX_PROGRESS = 200000;                   // characters of saved game per player

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
        case "GET /board": return reply(await board(env, gameOf(url.searchParams.get("game"))));
        case "GET /taken": return reply(await taken(env, url.searchParams.get("exclude")));
        case "GET /check": return reply(await check(env, url.searchParams.get("nickname"), url.searchParams.get("exclude")));
        case "POST /join": return await join(env, await body(request), reply);
        case "POST /profile": return await profile(env, await body(request), reply);
        case "POST /recovery": return await setRecovery(env, await body(request), reply);
        case "POST /recover": return await recover(env, await body(request), reply);
        case "POST /progress": return await saveProgress(env, await body(request, MAX_PROGRESS + 2000), reply);
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

function gameOf(g) {
  if (g == null || g === "") return "mul";
  if (!GAME.test(String(g))) throw new BadRequest("Unknown game.");
  return String(g);
}

async function body(request, limit = 20000) {
  const text = await request.text();
  if (text.length > limit) throw new BadRequest("Too large.");
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
const wordsOk = (d) => ADJECTIVES.includes(d.adj) && ANIMALS.includes(d.animal);
// Salted with the player's id, so the same two words hash differently for every player.
const recoveryHash = (id, adj, animal) => sha256(id + "|" + adj + "|" + animal);

/** The player, if the id and secret key match; otherwise null. */
async function authed(env, data) {
  if (typeof data.id !== "string" || typeof data.key !== "string" || data.key.length > 200) return null;
  const row = await env.DB.prepare("SELECT id, key_hash FROM players WHERE id = ?1").bind(data.id).first();
  if (!row) return null;
  return row.key_hash === (await sha256(data.key)) ? row : null;
}

async function board(env, game) {
  const since = Date.now() - WINDOW_MS;
  const { results } = await env.DB.prepare(
    `SELECT t.cell, t.ms, t.since, p.id, p.emoji, p.nickname
       FROM times t JOIN players p ON p.id = t.player_id
      WHERE t.game = ?1 AND t.at > ?2
      ORDER BY t.cell, t.ms, t.since`
  ).bind(game, since).all();
  const cells = {};
  const holders = {};
  for (const r of results) {
    if (cells[r.cell]) continue; // rows are sorted: the first per fact is the fastest, earliest on a tie
    cells[r.cell] = { ms: r.ms, p: r.id };
    holders[r.id] = holders[r.id] || { id: r.id, emoji: r.emoji, nickname: r.nickname, squares: 0 };
    holders[r.id].squares += 1;
  }
  const ids = Object.keys(holders);
  if (ids.length) {
    const st = await env.DB.prepare(
      `SELECT player_id, acc_right, acc_total FROM stats WHERE game = ?1 AND player_id IN (SELECT value FROM json_each(?2))`
    ).bind(game, JSON.stringify(ids)).all();
    for (const s of st.results) {
      holders[s.player_id].right = s.acc_right;
      holders[s.player_id].total = s.acc_total;
    }
  }
  const players = Object.values(holders).sort((a, b) => b.squares - a.squares || a.nickname.localeCompare(b.nickname));
  return { game, cells, players, windowDays: 14 };
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
  if (!wordsOk(data)) return reply({ error: "invalid", field: "words", reason: "Pick one word from each list." }, 400);
  const id = "p_" + randomHex(12);
  const key = randomHex(32);
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO players (id, key_hash, emoji, nickname, nick_norm, created_at, updated_at, recovery_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)`
    ).bind(id, await sha256(key), data.emoji, cleanNickname(data.nickname), nickKey(data.nickname), now,
      await recoveryHash(id, data.adj, data.animal)).run();
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

async function setRecovery(env, data, reply) {
  const me = await authed(env, data);
  if (!me) return reply({ error: "unknown_player" }, 403);
  if (!wordsOk(data)) return reply({ error: "invalid", field: "words", reason: "Pick one word from each list." }, 400);
  await env.DB.prepare("UPDATE players SET recovery_hash = ?2, updated_at = ?3 WHERE id = ?1")
    .bind(me.id, await recoveryHash(me.id, data.adj, data.animal), Date.now()).run();
  return reply({ ok: true });
}

async function recover(env, data, reply) {
  const noMatch = (triesLeft) => reply({ error: "no_match", reason: "That nickname and those words don't match.", triesLeft }, 403);
  if (typeof data.nickname !== "string" || !wordsOk(data)) return noMatch(null);
  const p = await env.DB.prepare(
    "SELECT id, emoji, nickname, recovery_hash, rec_fails, rec_lock_until FROM players WHERE nick_norm = ?1"
  ).bind(nickKey(data.nickname)).first();
  if (!p || !p.recovery_hash) return noMatch(null);
  const now = Date.now();
  if (p.rec_lock_until > now) {
    return reply({ error: "locked", reason: "Too many wrong tries for this nickname. Try again tomorrow." }, 429);
  }
  if ((await recoveryHash(p.id, data.adj, data.animal)) !== p.recovery_hash) {
    const fails = p.rec_fails + 1;
    if (fails >= RECOVER_TRIES) {
      await env.DB.prepare("UPDATE players SET rec_fails = 0, rec_lock_until = ?2 WHERE id = ?1").bind(p.id, now + RECOVER_LOCK_MS).run();
      return reply({ error: "locked", reason: "Too many wrong tries for this nickname. Try again tomorrow." }, 429);
    }
    await env.DB.prepare("UPDATE players SET rec_fails = ?2 WHERE id = ?1").bind(p.id, fails).run();
    return noMatch(RECOVER_TRIES - fails);
  }
  // Right words: give this device a new secret key. The old device's key stops working.
  const key = randomHex(32);
  await env.DB.prepare("UPDATE players SET key_hash = ?2, rec_fails = 0, rec_lock_until = 0, updated_at = ?3 WHERE id = ?1")
    .bind(p.id, await sha256(key), now).run();
  const prog = await env.DB.prepare("SELECT data FROM progress WHERE player_id = ?1").bind(p.id).first();
  let progress = null;
  try { progress = prog ? JSON.parse(prog.data) : null; } catch (e) { progress = null; }
  return reply({ id: p.id, key, emoji: p.emoji, nickname: p.nickname, progress });
}

async function saveProgress(env, data, reply) {
  const me = await authed(env, data);
  if (!me) return reply({ error: "unknown_player" }, 403);
  if (!data.data || typeof data.data !== "object") throw new BadRequest("data must be an object.");
  const text = JSON.stringify(data.data);
  if (text.length > MAX_PROGRESS) throw new BadRequest("Too large.");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO progress (player_id, data, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (player_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(me.id, text, now).run();
  return reply({ ok: true });
}

async function leave(env, data, reply) {
  const me = await authed(env, data);
  if (!me) return reply({ ok: true }); // already gone
  await env.DB.batch([
    env.DB.prepare("DELETE FROM times WHERE player_id = ?1").bind(me.id),
    env.DB.prepare("DELETE FROM stats WHERE player_id = ?1").bind(me.id),
    env.DB.prepare("DELETE FROM progress WHERE player_id = ?1").bind(me.id),
    env.DB.prepare("DELETE FROM players WHERE id = ?1").bind(me.id),
  ]);
  return reply({ ok: true });
}

async function scores(env, data, reply) {
  const me = await authed(env, data);
  if (!me) return reply({ error: "unknown_player" }, 403);
  const game = gameOf(data.game);
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
  const steps = [
    // Facts that no longer qualify (a wrong answer, or older than 2 weeks) come off the board.
    env.DB.prepare(
      "DELETE FROM times WHERE player_id = ?1 AND game = ?3 AND cell NOT IN (SELECT json_extract(value, '$.c') FROM json_each(?2))"
    ).bind(me.id, list, game),
    // Keep "since" when the time is unchanged, so the first to reach a time keeps a tie.
    env.DB.prepare(
      `INSERT INTO times (player_id, game, cell, ms, at, since)
       SELECT ?1, ?4, json_extract(value, '$.c'), json_extract(value, '$.ms'), json_extract(value, '$.at'), ?3
         FROM json_each(?2) WHERE true
       ON CONFLICT (player_id, game, cell) DO UPDATE SET
         since = CASE WHEN times.ms = excluded.ms THEN times.since ELSE excluded.since END,
         ms = excluded.ms,
         at = excluded.at
       WHERE times.ms != excluded.ms OR times.at != excluded.at`
    ).bind(me.id, list, now, game),
  ];
  const acc = data.acc || {};
  const total = Math.floor(Number(acc.total));
  const right = Math.floor(Number(acc.right));
  if (total >= 1 && total <= 100 && right >= 0 && right <= total) {
    steps.push(env.DB.prepare(
      `INSERT INTO stats (player_id, game, acc_right, acc_total, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (player_id, game) DO UPDATE SET acc_right = excluded.acc_right, acc_total = excluded.acc_total, updated_at = excluded.updated_at`
    ).bind(me.id, game, right, total, now));
  }
  await env.DB.batch(steps);
  return reply({ ok: true, counted: rows.length });
}

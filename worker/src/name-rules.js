import { SUBSTRING_WORDS, WHOLE_WORDS } from "./blocklist.js";

// The 50 emojis players can choose from. Each one can belong to only one player.
export const EMOJIS = [
  "🦊", "🐼", "🐨", "🐯", "🦁", "🐸", "🐵", "🐧", "🐢", "🐙",
  "🦄", "🐲", "🦖", "🦕", "🐬", "🐳", "🦈", "🦉", "🦋", "🐝",
  "🐞", "🦀", "🐰", "🐶", "🐱", "🐹", "🦔", "🦒", "🦓", "🐘",
  "🦩", "🦜", "🐌", "🦥", "🍕", "🍩", "🍓", "🍉", "🍦", "🧁",
  "🌮", "🍪", "🚀", "🌈", "🎨", "🌙", "⚡", "🎈", "🎸", "⚽",
];

export const NICK_MIN = 2;
export const NICK_MAX = 18;

const rot13 = (w) => w.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
const SUBSTR = SUBSTRING_WORDS.map(rot13);
const WHOLE = new Set(WHOLE_WORDS.map(rot13));

// Letters that people swap in to sneak words past a filter.
const LOOKALIKE = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "8": "b", "9": "g" };

/** Tidy what the player typed: trim and collapse spaces. */
export function cleanNickname(raw) {
  return String(raw || "").normalize("NFC").replace(/\s+/g, " ").trim();
}

/** The form used to decide whether two nicknames are "the same": no case, no spaces, no accents. */
export function nickKey(nick) {
  return cleanNickname(nick).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function plain(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[0-9!|@$]/g, (c) => LOOKALIKE[c] || c);
}
const squeeze = (s) => s.replace(/(.)\1+/g, "$1"); // "fuuuun" -> "fun"

/** True when the nickname contains a word that isn't allowed. */
export function isBlocked(nick) {
  const p = plain(cleanNickname(nick));
  const joined = p.replace(/[^a-z]/g, "");
  const words = p.split(/[^a-z]+/).filter(Boolean);
  const forms = [joined, squeeze(joined)];
  if (forms.some((f) => SUBSTR.some((w) => f.includes(w)))) return true;
  const wholes = words.concat(words.map(squeeze), forms);
  return wholes.some((w) => WHOLE.has(w));
}

/** null when fine, otherwise a short reason a child can read. */
export function nicknameProblem(raw) {
  const nick = cleanNickname(raw);
  if (nick.length < NICK_MIN) return "Use at least " + NICK_MIN + " letters.";
  if (nick.length > NICK_MAX) return "Use " + NICK_MAX + " characters or fewer.";
  if (!/^[\p{L}\p{N} ]+$/u.test(nick)) return "Use only letters, numbers and spaces.";
  if (!/\p{L}/u.test(nick)) return "Use at least one letter.";
  if (isBlocked(nick)) return "Please pick a different nickname.";
  return null;
}

// Recovery words: a player picks one adjective and one animal. With their nickname, they
// bring the player (and all their progress) back on another device.
export const ADJECTIVES = [
  "fuzzy", "sunny", "brave", "happy", "sleepy", "bouncy", "clever", "gentle", "jolly", "lucky",
  "mighty", "quiet", "speedy", "sparkly", "silly", "swift", "tiny", "giant", "curious", "friendly",
];
export const ANIMALS = [
  "bear", "otter", "panda", "tiger", "koala", "penguin", "dolphin", "rabbit", "turtle", "falcon",
  "giraffe", "zebra", "lion", "fox", "owl", "whale", "puppy", "kitten", "hedgehog", "octopus",
];

# Fun with Numbers: Times Table Stars

A multiplication practice game for kids learning the 1 × 1 to 10 × 10 table. It adapts to
how the player is doing, tracks speed for every fact, and has an optional public leaderboard.

- **Play:** https://adela-123.github.io/fun-with-numbers/
- **The game** is a single file, `index.html`. Each player's progress is saved in the
  browser they play in.
- **The leaderboard service** is in `worker/`: a small Cloudflare Worker with a D1 database.
  The game only talks to it for players who chose to join the leaderboard, and only sends
  their emoji, nickname and per-fact times. Nobody gets direct access to the data except the
  Cloudflare account owner.

## How the leaderboard works

- A 10 × 10 grid. Each square shows the emoji of the player who is currently fastest at that fact.
- A player's time on a fact counts once they have answered it at least 2 times and the last 2
  were right. (Stars on the player's own chart still need 3 in a row.) The time is recent-weighted, from the last 2 weeks, and the faster of normal and
  insane mode is used.
- On a tie (to a tenth of a second), whoever reached that time first keeps the square.
- Players pick one of 50 emojis and a nickname. Both must be unused, and nicknames are checked
  against a list of words not suitable for kids.

## Deploying the leaderboard service

`.github/workflows/deploy-api.yml` deploys `worker/` to Cloudflare whenever it changes on
`main`, or when run by hand from the Actions tab. It needs two repository secrets:

| Secret | Where to find it |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → Account ID (right-hand side) |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template, plus **Account → D1 → Edit** |

The workflow creates the `fun-with-numbers` database on its first run, sets up its tables,
and deploys the Worker. Its run summary shows the service's address.

## The backup

`backup-v1-before-leaderboard` is the game exactly as it was on 2026-11-14, before any
leaderboard work.

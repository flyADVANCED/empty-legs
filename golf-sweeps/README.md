# ⛳ Golf Sweeps

A small web app for running 4-man team sweeps at a private club.

- **Players & handicaps**: roster with GHIN numbers. Handicap Index is pulled from GHIN, either one player at a time, for everyone at once, or automatically right before a draw. Manual entry and CSV import also work.
- **A/B/C/D tiers**: the field is ranked by Playing Handicap (best → worst) and split into four equal letters.
- **Balanced teams**: each team gets exactly one A, B, C and D player. Then players of the same letter are swapped between teams until team handicap totals are as close as possible. You can also do a classic random draw by letter. If the field isn't a multiple of 4, short teams get a **blind draw** D player whose scores also count for them. Tap two players on the Teams tab to swap them by hand.
- **Game formats** (any combination per event, each with its own share of the pot and payout places):
  | Game | How it scores |
  |---|---|
  | 1 / 2 / 3 Best Balls, All 4 Count | N lowest scores per hole |
  | 1-2-3 (Cha-Cha-Cha), 3-2-1 | rotating number of balls per hole |
  | Par Ladder | 1 ball on par 5s, 2 on par 4s, 3 on par 3s |
  | Stableford: Best 2 / All 4 | team points, highest wins |
  | 4-Man Scramble | team handicap = 25% A + 20% B + 15% C + 10% D |
  | Individual Flights | low net within each A/B/C/D flight |
  | Skins | net or gross, optional carryovers |
- **Handicap math** follows the World Handicap System: Course Handicap = Index × Slope/113 + (CR − Par), then an allowance % gives the Playing Handicap. Strokes are given by hole stroke index, plus handicaps give strokes back, and you can choose to play off the low man.
- **Scoring & payouts**: live leaderboard, card-off tiebreaks (back 9, 6, 3, 18th) or split ties, per-player payouts, and a money list.

## Run it

Requires Node 18+. There are no npm dependencies.

```bash
cd golf-sweeps
npm start            # http://localhost:3000
npm test             # unit tests for handicaps, team draws, games, GHIN client
```

Environment variables:

| Variable | Purpose |
|---|---|
| `PORT` | default `3000` |
| `DATA_FILE` | JSON database path (default `./data/db.json`) |
| `ADMIN_PIN` | if set, any change (scores, draws, roster) needs this PIN; leaderboards stay public |
| `GHIN_USERNAME`, `GHIN_PASSWORD` | turns on GHIN sync (see below) |

## About the GHIN connection

The USGA doesn't offer an open public GHIN API. Software access is licensed through the USGA / state golf associations. `lib/ghin.js` uses the same endpoints as the GHIN mobile app (`api2.ghin.com`). It logs in on the server with a GHIN member account (credentials stay on the server and never reach the browser) and looks golfers up by GHIN number or name.

Things to know:

- That API is unofficial, so it can change without notice, and you should make sure using it is acceptable to your association. If the club gets official API credentials, `lib/ghin.js` is the only file that needs to change.
- If GHIN is unavailable, everything still works with manually entered or CSV-imported indexes. The Players page flags any handicap more than 14 days old.

## Typical Saturday

1. **Players**: import the roster once (CSV: `first,last,ghin,index`), then press **Update all from GHIN**.
2. **Course**: enter your scorecard (par and stroke index for each hole) plus each tee's rating and slope.
3. **Events → New sweeps**: set the entry fee and allowance, add games and their pot split, then tick who's playing.
4. **Draw teams**: handicaps refresh from GHIN, letters get assigned, and teams are balanced.
5. **Scores**: enter gross scores by team (dots show strokes). The **Leaderboard** updates live and shows payouts.

## Code map

```
server.js        HTTP server + JSON API (no framework)
lib/handicap.js  WHS course/playing handicap, strokes per hole, Stableford
lib/teams.js     A/B/C/D tiering, balanced & random draws, blind draws
lib/games.js     game definitions, scoring, tiebreaks, payouts
lib/ghin.js      GHIN lookup client
lib/store.js     JSON-file storage
public/          single-page front end (vanilla JS)
test/            node:test unit tests
```

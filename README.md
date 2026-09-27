# Zinger

A party game of one-liners, in the spirit of Quiplash. One shared screen for the room, everyone plays on their phone. No app, no accounts, no server to run.

## Play

1. Open the site on a TV or laptop and click **Host on this screen**.
2. 3 to 8 players open the same site on their phones (or scan the QR code) and enter the room code.
3. The first player in (👑 VIP) starts the game from their phone, or the host clicks **Start game**.

**Rounds**
- **Round 1 and 2:** each prompt goes to two players. Everyone else votes for the funnier answer. Points are your share of the votes (1,000 per matchup, doubled in Round 2). Take every vote for a **Shutout** bonus.
- **The Last Word:** one prompt for everyone. Each player gets 3 votes to spread across the other answers. 400 points per vote.

Host controls at the bottom of the big screen: read prompts aloud, pause, skip.

## Prompt decks

Default is **After Dark (25+)**. Switch to Mixed or Classic (family friendly) in the lobby under *Settings & custom prompts*.

## Custom prompts

- **Quick:** in the lobby, open *Settings & custom prompts* and paste your own, one per line. They save on that device. Tick *Only use my prompts* for an all-custom game.
- **Permanent:** edit `prompts.js` (`ZINGER_PROMPTS_DARK` for After Dark, `ZINGER_PROMPTS` for Classic). One string per prompt, `____` for a blank.

## How it works

It's a static site (HTML/CSS/JS), so GitHub Pages can host it. The host screen holds the game state; phones connect to it directly over WebRTC using [PeerJS](https://peerjs.com) and its free public matchmaking server. No data is stored anywhere except the host's browser.

Rejoining: if a phone locks or refreshes mid-game, it reconnects on its own. Rejoining with the same name also works.

## Testing flags

- `?fast` shortens every timer.
- `?local` runs over BroadcastChannel instead of the network, so you can play with several tabs in one browser (host in one tab, players in others).

## Deploy your own copy

1. Put these files in a GitHub repo.
2. Settings → Pages → Deploy from a branch → `main` / root.
3. Your game is live at `https://<you>.github.io/<repo>/`.

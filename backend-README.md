# RAT PHONK — Backend Setup

## Install
npm install

## Configure
cp .env.example .env
# Fill in all values in .env

## Run
npm start          # production
npm run dev        # development (auto-restarts)

## File Structure
server.js          - Fastify API + Discord OAuth
db.js              - SQLite schema (auto-creates on first run)
wom-sync.js        - WOM cron worker
discord-bot.js     - Discord broadcast parser
data/ratphonk.db   - SQLite database (auto-created)

## API Endpoints

PUBLIC
  GET  /auth/discord                    Redirect to Discord OAuth
  GET  /auth/discord/callback           OAuth callback
  POST /auth/link-rsn                   Link Discord to approved RSN
  GET  /auth/me                         Get current user
  POST /auth/logout
  POST /api/applications                Submit application (verifies via WOM)
  GET  /api/events                      Public events list
  GET  /api/stats                       Clan stats for landing page
  GET  /api/wom/player/:rsn             WOM player proxy

MEMBERS ONLY (requires login)
  GET  /api/members                     All verified members
  GET  /api/members/:rsn                Single member + latest snapshot
  GET  /api/drops                       Drop ledger
  GET  /api/pvp                         PvP kill log
  GET  /api/leaderboards                Leaderboard data
       ?category=xp|boss|clog|pvp
       &period=weekly|monthly|alltime

ADMIN/OFFICER ONLY
  GET  /api/admin/applications          Pending applications
  POST /api/admin/applications/:id/approve
  POST /api/admin/applications/:id/reject
  PATCH /api/admin/members/:id          Update role / RSN
  POST /api/events                      Create event

## How Data Gets In

1. WOM CRON (automatic)
   - Runs every 6 hours
   - Fetches all member stats from WOM API
   - Stores in xp_snapshots table
   - Leaderboards computed as deltas between snapshots

2. DISCORD BOT (automatic, real-time)
   - Listens to your TrackScape broadcast channel
   - Parses drop and PvP kill embeds
   - Inserts into drop_ledger / pvp_ledger automatically
   - No manual entry needed for anything TrackScape already catches

3. MANUAL SUBMISSION (member-submitted)
   - Members can submit drops/kills via the site
   - Officers verify via admin dashboard

## Discord Bot Setup
1. Go to discord.com/developers/applications
2. Create a new application
3. Add a Bot user
4. Enable "Message Content Intent" under Privileged Gateway Intents
5. Copy the bot token → DISCORD_BOT_TOKEN in .env
6. Invite the bot to your server with permissions:
   View Channels, Read Message History

## WOM Group Setup
1. Make sure your clan is registered at wiseoldman.net
2. Find your group ID in the URL: wiseoldman.net/groups/{ID}
3. Set WOM_GROUP_ID in .env

## Connecting to TrackScape
TrackScape does NOT expose a public API, but your Discord bot
reads the same broadcast channel that TrackScape posts to.
So you get the same data automatically, stored in your own DB.
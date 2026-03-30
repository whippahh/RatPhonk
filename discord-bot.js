import { Client, GatewayIntentBits, Events } from 'discord.js';
import db from './db.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // required for reading message content
  ]
});

// ── BROADCAST PARSERS ─────────────────────────────────────────
// TrackScape sends Discord embeds for drops, KC milestones, levels, PvP.
// We parse the embed fields to extract structured data.

function parseDropBroadcast(embed) {
  // TrackScape embed format:
  // Title: "PlayerName received a drop: ItemName"
  // Fields: { Boss, Value, Team split? }
  const title = embed.title || embed.description || '';
  const match = title.match(/(.+?) (?:received a drop:|got a drop:)\s*(.+)/i);
  if (!match) return null;

  return {
    rsn:      match[1].trim(),
    item:     match[2].trim(),
    boss:     embed.fields?.find(f => f.name.toLowerCase().includes('boss'))?.value ?? 'Unknown',
    value:    parseGpValue(embed.fields?.find(f => f.name.toLowerCase().includes('value'))?.value ?? '0'),
    imageUrl: embed.image?.url ?? null,
  };
}

function parsePvpBroadcast(embed) {
  // "KillerRSN has defeated VictimRSN"
  const title = embed.title || embed.description || '';
  const match = title.match(/(.+?) (?:has defeated|killed) (.+)/i);
  if (!match) return null;

  return {
    killer:   match[1].trim(),
    victim:   match[2].trim(),
    location: embed.fields?.find(f => f.name.toLowerCase().includes('location'))?.value ?? 'Unknown',
    loot:     parseGpValue(embed.fields?.find(f => f.name.toLowerCase().includes('loot'))?.value ?? '0'),
  };
}

function parseLevelBroadcast(embed) {
  const title = embed.title || embed.description || '';
  // "PlayerName has reached level 99 in Slayer!"
  const match = title.match(/(.+?) has reached level (\d+) in (.+)/i);
  if (!match) return null;

  return {
    rsn:   match[1].trim(),
    level: parseInt(match[2]),
    skill: match[3].replace('!','').trim(),
  };
}

function parseKcBroadcast(embed) {
  const title = embed.title || embed.description || '';
  // "PlayerName has reached 100 kills for Vorkath"
  const match = title.match(/(.+?) has reached (\d+) kills? (?:for|at) (.+)/i);
  if (!match) return null;

  return {
    rsn:  match[1].trim(),
    kc:   parseInt(match[2]),
    boss: match[3].trim(),
  };
}

function parseGpValue(str) {
  // "1,240,000 gp" → 1240000
  const n = str.replace(/[^0-9.kmb]/gi, '');
  const mult = str.toLowerCase().includes('b') ? 1e9
             : str.toLowerCase().includes('m') ? 1e6
             : str.toLowerCase().includes('k') ? 1e3
             : 1;
  return Math.floor(parseFloat(n) * mult) || 0;
}

// ── DETERMINE BROADCAST TYPE ──────────────────────────────────
function classifyBroadcast(embed) {
  const text = (embed.title || embed.description || '').toLowerCase();
  if (text.includes('received a drop') || text.includes('got a drop')) return 'drop';
  if (text.includes('has defeated') || text.includes('killed'))         return 'pvp';
  if (text.includes('has reached level'))                               return 'level';
  if (text.includes('kills for') || text.includes('kills at'))         return 'kc';
  return 'unknown';
}

// ── PROCESS BROADCAST ─────────────────────────────────────────
function processBroadcast(message) {
  const embeds = message.embeds;
  if (!embeds?.length) return;

  for (const embed of embeds) {
    const type = classifyBroadcast(embed);
    const raw  = JSON.stringify({ title: embed.title, description: embed.description, fields: embed.fields });

    // Log all broadcasts regardless
    db.prepare(`
      INSERT INTO webhook_events (event_type, discord_user, raw_payload)
      VALUES (?,?,?)
    `).run(type, message.author?.username ?? 'TrackScape', raw);

    if (type === 'drop') {
      const parsed = parseDropBroadcast(embed);
      if (!parsed) continue;

      const member = db.prepare(
        'SELECT id FROM members WHERE rsn=? COLLATE NOCASE'
      ).get(parsed.rsn);

      if (!member) continue; // not one of our tracked members

      db.prepare(`
        INSERT INTO drop_ledger (reporter_id, boss_name, item_name, item_value_gp, source, raw_message)
        VALUES (?,?,?,?,?,?)
      `).run(member.id, parsed.boss, parsed.item, parsed.value, 'discord_bot', raw);

      console.log(`[BOT] Drop logged: ${parsed.rsn} → ${parsed.item} (${parsed.boss})`);
    }

    else if (type === 'pvp') {
      const parsed = parsePvpBroadcast(embed);
      if (!parsed) continue;

      const killer = db.prepare(
        'SELECT id FROM members WHERE rsn=? COLLATE NOCASE'
      ).get(parsed.killer);

      if (!killer) continue;

      db.prepare(`
        INSERT INTO pvp_ledger (reporter_id, victim_rsn, location, loot_gp, source, raw_message)
        VALUES (?,?,?,?,?,?)
      `).run(killer.id, parsed.victim, parsed.location, parsed.loot, 'discord_bot', raw);

      console.log(`[BOT] PvP logged: ${parsed.killer} killed ${parsed.victim}`);
    }

    // Level ups and KC milestones are captured via WOM snapshots,
    // but we log them here too for the Discord feed / activity log
    else if (type === 'level' || type === 'kc') {
      console.log(`[BOT] ${type} broadcast logged for audit`);
    }
  }
}

// ── BOT STARTUP ───────────────────────────────────────────────
export function startBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn('[BOT] No DISCORD_BOT_TOKEN set — Discord bot disabled');
    return;
  }

  client.once(Events.ClientReady, () => {
    console.log(`[BOT] Logged in as ${client.user.tag}`);
  });

  client.on(Events.MessageCreate, message => {
    // Only listen to the designated broadcast channel
    const broadcastChannelId = process.env.DISCORD_BROADCAST_CHANNEL_ID;
    if (message.channelId !== broadcastChannelId) return;
    processBroadcast(message);
  });

  client.login(token);
}
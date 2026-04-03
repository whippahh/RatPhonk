import cron from 'node-cron';
import db from './db.js';

const WOM_BASE = 'https://api.wiseoldman.net/v2';
const WOM_GROUP_ID = process.env.WOM_GROUP_ID;

async function womFetch(path) {
  const res = await fetch(`${WOM_BASE}${path}`, {
    headers: { 'User-Agent': 'RatPhonk-ClanSite/1.0' }
  });
  if (!res.ok) throw new Error(`WOM ${path} -> ${res.status}`);
  return res.json();
}

export async function syncMemberList() {
  if (!WOM_GROUP_ID) return console.warn('[WOM] No WOM_GROUP_ID set');
  console.log('[WOM] Syncing member list via hiscores endpoint...');
  try {
    const data = await womFetch(`/groups/${WOM_GROUP_ID}/hiscores?metric=overall&limit=50`);
    for (const entry of data) {
      const player = entry.player;
      if (!player) continue;
      db.prepare(`
        INSERT INTO members (rsn, wom_player_id, is_verified)
        VALUES (?, ?, 1)
        ON CONFLICT(rsn) DO UPDATE SET wom_player_id = excluded.wom_player_id
      `).run(player.displayName, player.id);
    }
    console.log(`[WOM] Synced ${data.length} members via hiscores`);
  } catch (err) {
    console.error('[WOM] Member sync failed:', err.message);
  }
}

export async function takeSnapshots() {
  if (!WOM_GROUP_ID) return;
  console.log('[WOM] Taking XP snapshots...');

  const members = db.prepare(
    'SELECT id, rsn, wom_player_id FROM members WHERE is_active=1 AND is_verified=1'
  ).all();

  let success = 0, failed = 0;

  for (const member of members) {
    try {
      const player = await womFetch(`/players/${encodeURIComponent(member.rsn)}`);
      if (!player?.latestSnapshot) continue;

      const skills = player.latestSnapshot.data?.skills || {};
      const bosses = player.latestSnapshot.data?.bosses || {};

      const s = (key) => skills[key]?.experience ?? 0;
      const b = (key) => bosses[key]?.kills ?? 0;

      db.prepare(`
        INSERT INTO xp_snapshots (
          member_id, captured_at,
          overall_xp, overall_level,
          attack_xp, defence_xp, strength_xp, hitpoints_xp,
          ranged_xp, prayer_xp, magic_xp, cooking_xp,
          woodcutting_xp, fletching_xp, fishing_xp, firemaking_xp,
          crafting_xp, smithing_xp, mining_xp, herblore_xp,
          agility_xp, thieving_xp, slayer_xp, farming_xp,
          runecraft_xp, hunter_xp, construction_xp,
          vorkath_kc, zulrah_kc, cox_kc, tob_kc, toa_kc,
          cerberus_kc, gauntlet_kc, nightmare_kc, corp_kc,
          graardor_kc, zilyana_kc, kreearra_kc, kril_kc,
          abyssal_sire_kc, kraken_kc, callisto_kc,
          venenatis_kc, vetion_kc,
          collection_log_count
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        member.id, Math.floor(Date.now() / 1000),
        s('overall'), skills.overall?.level ?? 0,
        s('attack'), s('defence'), s('strength'), s('hitpoints'),
        s('ranged'), s('prayer'), s('magic'), s('cooking'),
        s('woodcutting'), s('fletching'), s('fishing'), s('firemaking'),
        s('crafting'), s('smithing'), s('mining'), s('herblore'),
        s('agility'), s('thieving'), s('slayer'), s('farming'),
        s('runecrafting'), s('hunter'), s('construction'),
        b('vorkath'), b('zulrah'), b('chambers_of_xeric'),
        b('theatre_of_blood'), b('tombs_of_amascut'),
        b('cerberus'), b('corrupted_gauntlet'), b('nightmare'), b('corporeal_beast'),
        b('general_graardor'), b('commander_zilyana'), b('kreearra'), b('kril_tsutsaroth'),
        b('abyssal_sire'), b('kraken'), b('callisto'),
        b('venenatis'), b('vetion'),
        player.collectionLogCount ?? 0
      );

      if (player.id && !member.wom_player_id) {
        db.prepare('UPDATE members SET wom_player_id=? WHERE id=?').run(player.id, member.id);
      }

      success++;
      await new Promise(r => setTimeout(r, 400));

    } catch (err) {
      console.warn(`[WOM] Snapshot failed for ${member.rsn}: ${err.message}`);
      failed++;
    }
  }
  console.log(`[WOM] Snapshots done: ${success} success, ${failed} failed`);

  // Auto-initialise leaderboard periods if none exist yet
  for (const periodType of ['weekly', 'monthly']) {
    const open = db.prepare(
      'SELECT id FROM leaderboard_periods WHERE period_type=? AND ends_at IS NULL'
    ).get(periodType);
    if (!open) {
      const startSnap = db.prepare('SELECT id FROM xp_snapshots ORDER BY captured_at ASC LIMIT 1').get();
      if (startSnap) {
        const label = periodType === 'weekly'
          ? `Week of ${new Date().toISOString().slice(0,10)}`
          : `Month of ${new Date().toISOString().slice(0,7)}`;
        db.prepare('INSERT INTO leaderboard_periods (label,period_type,starts_at,snapshot_start_id) VALUES (?,?,?,?)')
          .run(label, periodType, startSnap.captured_at ?? Math.floor(Date.now()/1000), startSnap.id);
        console.log(`[WOM] Auto-created open ${periodType} period`);
      }
    }
  }
}

function managePeriodBoundary(periodType) {
  const now = Math.floor(Date.now() / 1000);
  const open = db.prepare(
    'SELECT * FROM leaderboard_periods WHERE period_type=? AND ends_at IS NULL'
  ).get(periodType);

  if (open) {
    const endSnap = db.prepare('SELECT id FROM xp_snapshots ORDER BY captured_at DESC LIMIT 1').get();
    if (endSnap) {
      db.prepare('UPDATE leaderboard_periods SET ends_at=?, snapshot_end_id=? WHERE id=?')
        .run(now, endSnap.id, open.id);
      console.log(`[WOM] Closed ${periodType} period #${open.id}`);
    }
  }

  const startSnap = db.prepare('SELECT id FROM xp_snapshots ORDER BY captured_at DESC LIMIT 1').get();
  if (startSnap) {
    const label = periodType === 'weekly'
      ? `Week of ${new Date().toISOString().slice(0, 10)}`
      : `Month of ${new Date().toISOString().slice(0, 7)}`;
    db.prepare('INSERT INTO leaderboard_periods (label,period_type,starts_at,snapshot_start_id) VALUES (?,?,?,?)')
      .run(label, periodType, now, startSnap.id);
    console.log(`[WOM] Opened new ${periodType} period`);
  }
}

export function startCrons() {
  cron.schedule('0 */6 * * *', takeSnapshots);
  cron.schedule('5 0 * * 1',   () => managePeriodBoundary('weekly'));
  cron.schedule('5 0 1 * *',   () => managePeriodBoundary('monthly'));
  console.log('[WOM] Crons started');
}

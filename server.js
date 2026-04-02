import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import db from './db.js';
import { startBot } from './discord-bot.js';
import { startCrons, syncMemberList, takeSnapshots } from './wom-sync.js';

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: [
    'https://whippahh.github.io',
    'http://localhost:5173',
    'http://localhost:3000',
  ],
  credentials: true,
});
await app.register(cookie);
await app.register(session, {
  secret: process.env.SESSION_SECRET || 'changeme_32chars_minimum_please!!',
  cookie: {
    secure:   true,
    sameSite: 'none',
    httpOnly: true,
    maxAge:   7 * 24 * 60 * 60 * 1000,
  },
  saveUninitialized: false,
});

// ── MIDDLEWARE ────────────────────────────────────────────────
function requireAuth(req, reply, done) {
  if (!req.session.memberId) return reply.status(401).send({ error: 'Not authenticated' });
  done();
}
function requireAdmin(req, reply, done) {
  if (!req.session.memberId) return reply.status(401).send({ error: 'Not authenticated' });
  const member = db.prepare('SELECT role FROM members WHERE id=?').get(req.session.memberId);
  if (!member || !['admin','officer'].includes(member.role))
    return reply.status(403).send({ error: 'Insufficient permissions' });
  done();
}

// ── DISCORD OAUTH2 ────────────────────────────────────────────
app.get('/auth/discord', async (req, reply) => {
  const intent = req.query.intent || 'login';
  req.session.oauthIntent = intent;
  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    redirect_uri:  process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify',
  });
  reply.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, reply) => {
  const { code } = req.query;
  if (!code) return reply.status(400).send({ error: 'No code' });

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  process.env.DISCORD_REDIRECT_URI,
    }),
  });

  // Guard: Discord sometimes returns HTML on bad credentials
  const tokenText = await tokenRes.text();
  let tokens;
  try { tokens = JSON.parse(tokenText); }
  catch(e) {
    app.log.error('Discord token exchange returned non-JSON: ' + tokenText.slice(0, 200));
    return reply.status(500).send({ error: 'Discord token exchange failed — check DISCORD_CLIENT_SECRET and DISCORD_REDIRECT_URI env vars' });
  }
  if (!tokens.access_token) {
    app.log.error('Discord token exchange error: ' + JSON.stringify(tokens));
    return reply.redirect(`${process.env.FRONTEND_URL}/index.html?notfound=1`);
  }

  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userText = await userRes.text();
  let discordUser;
  try { discordUser = JSON.parse(userText); }
  catch(e) {
    return reply.status(500).send({ error: 'Failed to fetch Discord user' });
  }
  if (!discordUser.id) {
    app.log.error('Discord user fetch failed: ' + JSON.stringify(discordUser));
    return reply.status(500).send({ error: 'Discord user fetch failed' });
  }
  const intent = req.session.oauthIntent || 'login';
  delete req.session.oauthIntent;

  const member = db.prepare('SELECT * FROM members WHERE discord_id=?').get(discordUser.id);

  if (member) {
    // Existing member — log them in regardless of intent
    req.session.memberId = member.id;
    req.session.role     = member.role;
    reply.redirect(`${process.env.FRONTEND_URL}/profile.html?rsn=${encodeURIComponent(member.rsn)}`);
  } else if (intent === 'apply') {
    // New user applying — store Discord identity in session, redirect to apply form
    req.session.pendingDiscord = { id: discordUser.id, username: discordUser.username, tag: discordUser.username };
    reply.redirect(`${process.env.FRONTEND_URL}/index.html?apply=1`);
  } else {
    // New user tried to log in — check if they have an approved application
    const approvedApp = db.prepare(
      "SELECT * FROM applications WHERE discord_id=? AND status='approved'"
    ).get(discordUser.id);

    if (approvedApp) {
      // Approved — create member record and log them in
      const result = db.prepare(
        `INSERT INTO members (discord_id, discord_tag, rsn, wom_player_id, role, is_verified) VALUES (?,?,?,?,'member',1)`
      ).run(discordUser.id, discordUser.username, approvedApp.rsn, approvedApp.wom_player_id);
      req.session.memberId = result.lastInsertRowid;
      req.session.role     = 'member';
      reply.redirect(`${process.env.FRONTEND_URL}/profile.html?rsn=${encodeURIComponent(approvedApp.rsn)}`);
    } else {
      // No account, no approved app — send to apply
      reply.redirect(`${process.env.FRONTEND_URL}/index.html?notfound=1`);
    }
  }
});

app.post('/auth/link-rsn', async (req, reply) => {
  const { rsn, inviteCode } = req.body;
  const pending = req.session.pendingDiscord;
  if (!pending) return reply.status(400).send({ error: 'No pending Discord session' });

  const application = db.prepare(
    "SELECT * FROM applications WHERE rsn=? COLLATE NOCASE AND status='approved' AND invite_code=? AND invite_used=0"
  ).get(rsn, inviteCode);

  if (!application) return reply.status(400).send({ error: 'Invalid or expired invite code' });

  const result = db.prepare(
    'INSERT INTO members (discord_id, discord_tag, rsn, wom_player_id, is_verified) VALUES (?,?,?,?,1)'
  ).run(pending.id, pending.username, rsn, application.wom_player_id);

  db.prepare('UPDATE applications SET invite_used=1 WHERE id=?').run(application.id);

  req.session.memberId = result.lastInsertRowid;
  req.session.role     = 'member';
  delete req.session.pendingDiscord;

  reply.send({ success: true });
});

app.get('/auth/me', { preHandler: requireAuth }, (req, reply) => {
  const member = db.prepare('SELECT id, rsn, discord_tag, role FROM members WHERE id=?')
    .get(req.session.memberId);
  reply.send(member);
});

app.post('/auth/logout', (req, reply) => {
  req.session.destroy();
  reply.send({ success: true });
});

// ── APPLICATIONS ──────────────────────────────────────────────
app.post('/api/applications', async (req, reply) => {
  const { rsn, referral, playstyle, notes } = req.body;
  if (!rsn) return reply.status(400).send({ error: 'RSN required' });

  const womRes = await fetch(
    `https://api.wiseoldman.net/v2/players/${encodeURIComponent(rsn)}`,
    { headers: { 'User-Agent': 'RatPhonk-ClanSite/1.0' } }
  );
  if (!womRes.ok) return reply.status(400).send({ error: 'RSN not found on Wise Old Man' });
  const womPlayer = await womRes.json();

  // Attach Discord identity if they came via OAuth apply flow
  const pending = req.session.pendingDiscord || null;
  const discord_id  = pending?.id       || null;
  const discord_tag = pending?.username || null;

  const refId = 'APP-' + Math.floor(10000 + Math.random() * 90000);
  try {
    db.prepare(
      'INSERT INTO applications (rsn, wom_player_id, referral, playstyle, notes, discord_id, discord_tag) VALUES (?,?,?,?,?,?,?)'
    ).run(rsn, womPlayer.id, referral, playstyle, notes, discord_id, discord_tag);
    reply.send({ success: true, refId, hasDiscord: !!discord_id });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return reply.status(409).send({ error: 'Application already exists for this RSN' });
    throw e;
  }
});

app.get('/api/admin/applications', { preHandler: requireAdmin }, (req, reply) => {
  const { status = 'pending' } = req.query;
  reply.send(db.prepare(
    'SELECT * FROM applications WHERE status=? ORDER BY submitted_at DESC'
  ).all(status));
});

app.post('/api/admin/applications/:id/approve', { preHandler: requireAdmin }, async (req, reply) => {
  const application = db.prepare('SELECT * FROM applications WHERE id=?').get(req.params.id);
  if (!application) return reply.status(404).send({ error: 'Not found' });

  // Mark approved
  db.prepare(
    "UPDATE applications SET status='approved', reviewed_by=?, reviewed_at=unixepoch() WHERE id=?"
  ).run(req.session.memberId, req.params.id);

  // If Discord ID was captured at apply time, create member record immediately
  if (application.discord_id) {
    const existing = db.prepare('SELECT id FROM members WHERE discord_id=?').get(application.discord_id);
    if (!existing) {
      db.prepare(
        `INSERT INTO members (discord_id, discord_tag, rsn, wom_player_id, role, is_verified) VALUES (?,?,?,?,'member',1)`
      ).run(application.discord_id, application.discord_tag, application.rsn, application.wom_player_id);
    }
    return reply.send({ success: true, memberCreated: true });
  }

  // No Discord ID — they can still log in via OAuth after approval
  // The callback will create the member record when they authenticate
  reply.send({ success: true, memberCreated: false });
});

app.post('/api/admin/applications/:id/reject', { preHandler: requireAdmin }, (req, reply) => {
  const { reason } = req.body;
  db.prepare(
    "UPDATE applications SET status='rejected', reviewed_by=?, reviewed_at=unixepoch(), reject_reason=? WHERE id=?"
  ).run(req.session.memberId, reason, req.params.id);
  reply.send({ success: true });
});

// ── LEADERBOARDS ──────────────────────────────────────────────
app.get('/api/leaderboards', (req, reply) => {
  const { category = 'xp', period = 'weekly' } = req.query;

  const colMap = {
    xp:     'overall_xp',
    slayer: 'slayer_xp',
    boss:   'vorkath_kc',
    clog:   'collection_log_count',
  };
  const col = colMap[category] || 'overall_xp';

  if (period === 'alltime') {
    const rows = db.prepare(`
      WITH latest AS (
        SELECT member_id, MAX(captured_at) as max_ts FROM xp_snapshots GROUP BY member_id
      )
      SELECT m.rsn, s.${col} as value
      FROM xp_snapshots s
      JOIN latest l ON s.member_id=l.member_id AND s.captured_at=l.max_ts
      JOIN members m ON m.id=s.member_id
      WHERE m.is_active=1
      ORDER BY value DESC LIMIT 15
    `).all();
    return reply.send({ entries: rows, period: { label: 'All Time' } });
  }

  const p = db.prepare(
    "SELECT * FROM leaderboard_periods WHERE period_type=? AND ends_at IS NULL ORDER BY starts_at DESC LIMIT 1"
  ).get(period);

  if (!p) return reply.send({ entries: [], period: null });

  const rows = db.prepare(`
    WITH
      period_start AS (
        SELECT member_id, ${col} as val FROM xp_snapshots
        WHERE captured_at <= ? GROUP BY member_id HAVING MAX(captured_at)
      ),
      period_end AS (
        SELECT member_id, ${col} as val FROM xp_snapshots
        GROUP BY member_id HAVING MAX(captured_at)
      )
    SELECT m.rsn, (pe.val - COALESCE(ps.val,0)) as value
    FROM period_end pe
    LEFT JOIN period_start ps ON pe.member_id=ps.member_id
    JOIN members m ON m.id=pe.member_id
    WHERE m.is_active=1
    ORDER BY value DESC LIMIT 15
  `).all(p.starts_at);

  reply.send({ entries: rows, period: p });
});

// ── MEMBERS ───────────────────────────────────────────────────
app.get('/api/members', { preHandler: requireAuth }, (req, reply) => {
  reply.send(db.prepare(
    'SELECT id, rsn, discord_tag, role, joined_at FROM members WHERE is_verified=1 ORDER BY rsn'
  ).all());
});

app.get('/api/members/:rsn', (req, reply) => {
  const member = db.prepare(
    'SELECT id, rsn, role, joined_at FROM members WHERE rsn=? COLLATE NOCASE'
  ).get(req.params.rsn);
  if (!member) return reply.status(404).send({ error: 'Not found' });

  const snap = db.prepare(
    'SELECT * FROM xp_snapshots WHERE member_id=? ORDER BY captured_at DESC LIMIT 1'
  ).get(member.id);

  reply.send({ ...member, snapshot: snap });
});

app.post('/api/admin/sync', { preHandler: requireAdmin }, async (req, reply) => {
  try {
    await syncMemberList();
    await takeSnapshots();
    reply.send({ success: true, message: 'WOM sync complete' });
  } catch(e) {
    reply.status(500).send({ error: e.message });
  }
});

app.patch('/api/admin/members/:id', { preHandler: requireAdmin }, (req, reply) => {
  const { role, rsn } = req.body;
  if (role) db.prepare('UPDATE members SET role=? WHERE id=?').run(role, req.params.id);
  if (rsn)  db.prepare('UPDATE members SET rsn=?  WHERE id=?').run(rsn,  req.params.id);
  reply.send({ success: true });
});

// ── LEDGERS ───────────────────────────────────────────────────
app.get('/api/drops', { preHandler: requireAuth }, (req, reply) => {
  const { limit = 50, offset = 0, boss, member } = req.query;
  const params = [];
  let where = 'WHERE 1=1';
  if (boss)   { where += ' AND d.boss_name=?';          params.push(boss); }
  if (member) { where += ' AND m.rsn=? COLLATE NOCASE'; params.push(member); }
  params.push(Number(limit), Number(offset));

  reply.send(db.prepare(`
    SELECT d.*, m.rsn as reporter_rsn FROM drop_ledger d
    JOIN members m ON m.id=d.reporter_id
    ${where} ORDER BY d.occurred_at DESC LIMIT ? OFFSET ?
  `).all(...params));
});

app.get('/api/pvp', { preHandler: requireAuth }, (req, reply) => {
  const { limit = 50, offset = 0 } = req.query;
  reply.send(db.prepare(`
    SELECT p.*, m.rsn as killer_rsn FROM pvp_ledger p
    JOIN members m ON m.id=p.reporter_id
    ORDER BY p.occurred_at DESC LIMIT ? OFFSET ?
  `).all(Number(limit), Number(offset)));
});

// ── EVENTS ────────────────────────────────────────────────────
app.get('/api/events', (req, reply) => {
  reply.send(db.prepare(`
    SELECT e.*, m.rsn as created_by_rsn, COUNT(r.member_id) as rsvp_count
    FROM events e
    JOIN members m ON m.id=e.created_by
    LEFT JOIN event_rsvps r ON r.event_id=e.id AND r.status='going'
    WHERE e.is_cancelled=0
    GROUP BY e.id ORDER BY e.starts_at ASC
  `).all());
});

app.post('/api/events', { preHandler: requireAdmin }, (req, reply) => {
  const { title, description, event_type, starts_at, ends_at, max_attendees } = req.body;
  const result = db.prepare(
    'INSERT INTO events (created_by,title,description,event_type,starts_at,ends_at,max_attendees) VALUES (?,?,?,?,?,?,?)'
  ).run(req.session.memberId, title, description, event_type, starts_at, ends_at, max_attendees);
  reply.send({ id: result.lastInsertRowid });
});

// ── CLAN STATS (public) ───────────────────────────────────────
app.get('/api/stats', (req, reply) => {
  reply.send({
    memberCount: db.prepare("SELECT COUNT(*) as c FROM members WHERE is_active=1 AND is_verified=1").get().c,
    killCount:   db.prepare("SELECT COUNT(*) as c FROM pvp_ledger").get().c,
    dropGp:      db.prepare("SELECT COALESCE(SUM(item_value_gp),0) as c FROM drop_ledger").get().c,
    dropCount:   db.prepare("SELECT COUNT(*) as c FROM drop_ledger").get().c,
  });
});

// ── WOM PROXY ─────────────────────────────────────────────────
app.get('/api/wom/player/:rsn', async (req, reply) => {
  const res = await fetch(
    `https://api.wiseoldman.net/v2/players/${encodeURIComponent(req.params.rsn)}`,
    { headers: { 'User-Agent': 'RatPhonk-ClanSite/1.0' } }
  );
  reply.status(res.status).send(await res.json());
});

// ── START ─────────────────────────────────────────────────────
const start = async () => {
  try {
    // Bootstrap first admin via env vars
    // Set ADMIN_RSN + ADMIN_DISCORD_ID in Railway, then remove after first login
    if (process.env.ADMIN_RSN && process.env.ADMIN_DISCORD_ID) {
      const existing = db.prepare('SELECT id FROM members WHERE discord_id=? OR rsn=? COLLATE NOCASE')
        .get(process.env.ADMIN_DISCORD_ID, process.env.ADMIN_RSN);

      if (existing) {
        // Member exists — just ensure they are admin
        db.prepare("UPDATE members SET role='admin' WHERE id=?").run(existing.id);
        console.log(`[bootstrap] Ensured ${process.env.ADMIN_RSN} is admin`);
      } else {
        // No member record yet — create one
        db.prepare(
          `INSERT OR IGNORE INTO members (discord_id, discord_tag, rsn, role, is_verified) VALUES (?,?,?,'admin',1)`
        ).run(process.env.ADMIN_DISCORD_ID, process.env.ADMIN_RSN, process.env.ADMIN_RSN);
        console.log(`[bootstrap] Created admin member record for ${process.env.ADMIN_RSN}`);
      }
    } else if (process.env.ADMIN_RSN) {
      // Fallback: promote existing member by RSN only
      const promoted = db.prepare("UPDATE members SET role='admin' WHERE rsn=? COLLATE NOCASE")
        .run(process.env.ADMIN_RSN);
      if (promoted.changes > 0) {
        console.log(`[bootstrap] Promoted ${process.env.ADMIN_RSN} to admin`);
      } else {
        console.log(`[bootstrap] ADMIN_RSN set but no member found — also set ADMIN_DISCORD_ID to auto-create`);
      }
    }

    await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });
    startBot();
    startCrons();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();

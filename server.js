/* ============================================================
   Cordis — servidor web + WebSocket
   HTTP: arquivos estáticos + upload de avatar embutido em JSON
   WS: autenticação, servidores, canais, chat, DMs, voz (WebRTC)
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const S = require('./server/store');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

/* ---------------- HTTP estático ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/api/db-status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(S.getDbInfo(), null, 2));
  }
  if (urlPath === '/api/db-snapshot') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(S.getDbSnapshot(), null, 2));
  }
  if (urlPath === '/db') urlPath = '/db.html';
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------------- WebSocket ---------------- */
const wss = new WebSocketServer({ server });
const clients = new Map(); // ws -> { userId, user }

function send(ws, json) { if (ws.readyState === 1) ws.send(JSON.stringify(json)); }
function res(ws, id, ok, data, error) { send(ws, { t: 'res', id, ok, data: ok ? data : undefined, error: ok ? undefined : error }); }
function ev(ws, event, data) { send(ws, { t: 'ev', event, data }); }
function evAll(event, data, except) {
  const raw = JSON.stringify({ t: 'ev', event, data });
  for (const c of wss.clients) if (c.readyState === 1 && c !== except) c.send(raw);
}
function evGuild(guild, event, data, except) {
  const raw = JSON.stringify({ t: 'ev', event, data });
  for (const [ws, meta] of clients) {
    if (ws.readyState === 1 && ws !== except && guild.members.includes(meta.userId)) ws.send(raw);
  }
}
function evUsers(userIds, event, data, except) {
  const raw = JSON.stringify({ t: 'ev', event, data });
  for (const [ws, meta] of clients) {
    if (ws.readyState === 1 && ws !== except && userIds.includes(meta.userId)) ws.send(raw);
  }
}

/* presença em runtime: userId -> { status, customStatus, voice, muted, cam, screen, deafened } */
const presence = new Map();
function presenceOf(userId, ws) {
  const meta = ws ? clients.get(ws) : null;
  const u = S.db.users[userId];
  const p = presence.get(userId) || {};
  return {
    userId,
    status: p.status || (u ? u.status : 'online'),
    customStatus: p.customStatus ?? (u ? u.customStatus : null),
    voice: p.voice || null,
    muted: !!p.muted, cam: !!p.cam, screen: !!p.screen, deafened: !!p.deafened,
    online: [...clients.values()].some((m) => m.userId === userId),
  };
}
function broadcastPresence() {
  const all = Object.keys(S.db.users).map((id) => presenceOf(id));
  evAll('presence', { users: all });
}

function guildPayload(g) {
  return {
    id: g.id, name: g.name, icon: g.icon, color: g.color, ownerId: g.ownerId,
    members: g.members, categories: g.categories, channels: g.channels,
    invites: g.invites, voice: g.voice, createdAt: g.createdAt,
  };
}
function findChannel(guild, channelId) { return guild.channels.find((c) => c.id === channelId); }

function touchUnread(channelId, guild) {
  /* marcações de "não lido" são tratadas no cliente por timestamp */
}

/* ============================================================
   Protocolo
   ============================================================ */
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (process.env.DEBUG_WS) console.log('WS>', m.action);
    try { handle(ws, m); }
    catch (e) { if (m && m.id) res(ws, m.id, false, null, e.message || 'Erro interno'); }
  });

  ws.on('close', () => {
    const meta = clients.get(ws);
    if (!meta) return;
    const p = presence.get(meta.userId) || {};
    if (p.voice) {
      const g = Object.values(S.db.guilds).find((g) => g.voice[p.voice]);
      if (g) {
        g.voice[p.voice] = (g.voice[p.voice] || []).filter((uid) => uid !== meta.userId);
        evGuild(g, 'voice:leave', { channelId: p.voice, userId: meta.userId });
      }
      p.voice = null;
      presence.set(meta.userId, p);
    }
    clients.delete(ws);
    broadcastPresence();
  });

  function handle(ws, m) {
    const meta = clients.get(ws);
    const me = meta ? S.db.users[meta.userId] : null;
    const { id: rid, action, data = {} } = m;

    /* ---------- autenticação ---------- */
    if (action === 'auth:register') {
      const u = S.createUser(data);
      const token = S.createToken(u.id);
      clients.set(ws, { userId: u.id });
      presence.set(u.id, { status: 'online' });
      evAll('user:update', { user: S.publicUser(u) }, ws);
      broadcastPresence();
      return res(ws, rid, true, { token, user: S.publicUser(u) });
    }
    if (action === 'auth:login') {
      const u = S.login(String(data.email || data.identifier || '').trim(), data.password);
      const token = S.createToken(u.id);
      clients.set(ws, { userId: u.id });
      evAll('user:update', { user: S.publicUser(u) }, ws);
      broadcastPresence();
      return res(ws, rid, true, { token, user: S.publicUser(u) });
    }
    if (action === 'auth:hello') {
      const u = S.userByToken(data.token);
      if (!u) return res(ws, rid, false, null, 'Sessão inválida');
      const ban = S.banState(u);
      if (ban) return res(ws, rid, false, null, S.banMessage(ban));
      clients.set(ws, { userId: u.id });
      evAll('user:update', { user: S.publicUser(u) }, ws);
      broadcastPresence();
      return res(ws, rid, true, { user: S.publicUser(u) });
    }
    if (action === 'auth:logout') {
      if (data.token) delete S.db.tokens[data.token];
      clients.delete(ws);
      S.save();
      return res(ws, rid, true, {});
    }
    if (!me) return res(ws, rid, false, null, 'Não autenticado');

    /* ---------- snapshot inicial ---------- */
    if (action === 'sync') {
      const guilds = S.guildsOf(me.id).map(guildPayload);
      const dms = [];
      Object.keys(S.db.messages).filter((k) => k.startsWith('dm:')).forEach((k) => {
        const [, a, b] = k.split(':');
        if (a === me.id || b === me.id) {
          const otherId = a === me.id ? b : a;
          if (S.db.users[otherId]) dms.push({ id: k, with: S.publicUser(S.db.users[otherId]) });
        }
      });
      const users = Object.values(S.db.users).map(S.publicUser);
      return res(ws, rid, true, {
        self: S.publicUser(me),
        users, guilds, dms,
        badges: Object.values(S.db.badges),
        nitroTiers: S.NITRO_TIERS,
        presence: Object.keys(S.db.users).map((uid) => presenceOf(uid)),
      });
    }
    if (action === 'history') {
      const cid = String(data.channelId || '');
      // validação de acesso
      const isDM = cid.startsWith('dm:');
      const guild = Object.values(S.db.guilds).find((g) => g.channels.some((c) => c.id === cid));
      if (isDM && !cid.split(':').includes(me.id)) return res(ws, rid, false, null, 'Sem acesso');
      if (!isDM && (!guild || !guild.members.includes(me.id))) return res(ws, rid, false, null, 'Sem acesso');
      const msgs = S.getMessages(cid).map((x) => S.publicMessage(x));
      return res(ws, rid, true, { channelId: cid, messages: msgs });
    }

    /* ---------- perfil / presença ---------- */
    if (action === 'profile:update') {
      const u = me;
      if (typeof data.username === 'string' && data.username.trim()) u.username = data.username.trim().slice(0, 32);
      if (typeof data.color === 'string') u.color = data.color.slice(0, 24);
      if (typeof data.bannerColor === 'string') u.bannerColor = data.bannerColor.slice(0, 24);
      if (typeof data.about === 'string') u.about = data.about.slice(0, 190);
      if (typeof data.avatar === 'string' && data.avatar.startsWith('data:image/')) {
        if (data.avatar.length > 700000) throw new Error('Avatar muito grande (máx ~500KB).');
        u.avatar = data.avatar;
      }
      if (data.avatar === null) u.avatar = null;
      S.save();
      const pub = S.publicUser(u);
      evAll('user:update', { user: pub });
      return res(ws, rid, true, { user: pub });
    }
    if (action === 'presence:update') {
      const p = presence.get(me.id) || {};
      if (data.status && ['online', 'ausente', 'ocupado', 'invisivel'].includes(data.status)) {
        p.status = data.status; me.status = data.status;
      }
      if ('customStatus' in data) {
        p.customStatus = data.customStatus ? String(data.customStatus).slice(0, 40) : null;
        me.customStatus = p.customStatus;
      }
      presence.set(me.id, p);
      S.save();
      broadcastPresence();
      return res(ws, rid, true, {});
    }

    /* ---------- servidores ---------- */
    if (action === 'guild:create') {
      const g = S.createGuild({ name: data.name, icon: data.icon, color: data.color }, me.id);
      // primeiro canal de texto — criado pelo dono em seguida automaticamente
      return res(ws, rid, true, { guild: guildPayload(g) });
    }
    if (action === 'guild:update') {
      const g = S.canAccessGuild(me.id, data.guildId);
      if (!g) throw new Error('Servidor não encontrado.');
      if (g.ownerId !== me.id) throw new Error('Apenas o dono pode editar o servidor.');
      if (typeof data.name === 'string' && data.name.trim()) g.name = data.name.trim().slice(0, 60);
      if (typeof data.icon === 'string') g.icon = data.icon.slice(0, 4);
      if (typeof data.color === 'string') g.color = data.color.slice(0, 24);
      S.save();
      evGuild(g, 'guild:update', { guild: guildPayload(g) });
      return res(ws, rid, true, { guild: guildPayload(g) });
    }
    if (action === 'guild:delete') {
      const g = S.canAccessGuild(me.id, data.guildId);
      if (!g) throw new Error('Servidor não encontrado.');
      if (g.ownerId !== me.id) throw new Error('Apenas o dono pode excluir o servidor.');
      g.channels.forEach((c) => delete S.db.messages[c.id]);
      delete S.db.guilds[g.id];
      S.save();
      evAll('guild:remove', { guildId: g.id });
      return res(ws, rid, true, {});
    }
    if (action === 'guild:leave') {
      const g = S.canAccessGuild(me.id, data.guildId);
      if (!g) throw new Error('Servidor não encontrado.');
      if (g.ownerId === me.id) throw new Error('O dono não pode sair. Exclua o servidor.');
      g.members = g.members.filter((uid) => uid !== me.id);
      Object.keys(g.voice).forEach((ch) => { g.voice[ch] = (g.voice[ch] || []).filter((uid) => uid !== me.id); });
      S.save();
      evUsers([me.id], 'guild:remove', { guildId: g.id });
      evGuild(g, 'guild:update', { guild: guildPayload(g) });
      return res(ws, rid, true, {});
    }
    if (action === 'guild:invite') {
      const g = S.canAccessGuild(me.id, data.guildId);
      if (!g) throw new Error('Servidor não encontrado.');
      const code = S.CODE();
      g.invites.push(code);
      S.save();
      return res(ws, rid, true, { code, url: location_hint(code) });
    }
    if (action === 'guild:join') {
      const code = String(data.code || '').trim();
      const g = Object.values(S.db.guilds).find((g) => g.invites.includes(code));
      if (!g) throw new Error('Convite inválido ou expirado.');
      if (!g.members.includes(me.id)) {
        g.members.push(me.id);
        S.save();
        evGuild(g, 'guild:update', { guild: guildPayload(g) });
        evUsers([me.id], 'guild:add', { guild: guildPayload(g) });
        broadcastPresence();
      }
      return res(ws, rid, true, { guild: guildPayload(g) });
    }

    /* ---------- categorias ---------- */
    if (action === 'category:create') {
      const g = S.canAccessGuild(me.id, data.guildId);
      if (!g) throw new Error('Servidor não encontrado.');
      const cat = { id: S.id('k'), name: String(data.name || 'Categoria').slice(0, 40) };
      g.categories.push(cat);
      S.save();
      evGuild(g, 'category:add', { guildId: g.id, category: cat });
      return res(ws, rid, true, { category: cat });
    }
    if (action === 'category:update') {
      const g = S.canAccessGuild(me.id, data.guildId);
      if (!g) throw new Error('Servidor não encontrado.');
      const cat = g.categories.find((c) => c.id === data.categoryId);
      if (!cat) throw new Error('Categoria não encontrada.');
      if (typeof data.name === 'string' && data.name.trim()) cat.name = data.name.trim().slice(0, 40);
      S.save();
      evGuild(g, 'category:update', { guildId: g.id, category: cat });
      return res(ws, rid, true, { category: cat });
    }
    if (action === 'category:delete') {
      const g = S.canAccessGuild(me.id, data.guildId);
      if (!g) throw new Error('Servidor não encontrado.');
      g.categories = g.categories.filter((c) => c.id !== data.categoryId);
      g.channels.forEach((ch) => { if (ch.categoryId === data.categoryId) ch.categoryId = null; });
      S.save();
      evGuild(g, 'category:remove', { guildId: g.id, categoryId: data.categoryId });
      return res(ws, rid, true, {});
    }

    /* ---------- canais ---------- */
    if (action === 'channel:create') {
      const g = S.canAccessGuild(me.id, data.guildId);
      if (!g) throw new Error('Servidor não encontrado.');
      const ch = S.addChannel(g, { name: data.name, type: data.type, categoryId: data.categoryId || null });
      evGuild(g, 'channel:add', { guildId: g.id, channel: ch });
      return res(ws, rid, true, { channel: ch });
    }
    if (action === 'channel:update') {
      const g = S.canAccessGuild(me.id, data.guildId);
      if (!g) throw new Error('Servidor não encontrado.');
      const ch = findChannel(g, data.channelId);
      if (!ch) throw new Error('Canal não encontrado.');
      if (typeof data.name === 'string' && data.name.trim()) {
        ch.name = data.name.trim().slice(0, 40).toLowerCase().replace(/\s+/g, '-').replace(/[^\wÀ-ÿ\-]/g, '') || ch.name;
      }
      if (typeof data.topic === 'string') ch.topic = data.topic.slice(0, 200);
      if ('categoryId' in data) ch.categoryId = data.categoryId || null;
      S.save();
      evGuild(g, 'channel:update', { guildId: g.id, channel: ch });
      return res(ws, rid, true, { channel: ch });
    }
    if (action === 'channel:delete') {
      const g = S.canAccessGuild(me.id, data.guildId);
      if (!g) throw new Error('Servidor não encontrado.');
      const ch = findChannel(g, data.channelId);
      if (!ch) throw new Error('Canal não encontrado.');
      g.channels = g.channels.filter((c) => c.id !== ch.id);
      delete S.db.messages[ch.id];
      S.save();
      evGuild(g, 'channel:remove', { guildId: g.id, channelId: ch.id });
      return res(ws, rid, true, {});
    }

    /* ---------- mensagens ---------- */
    if (action === 'message:send') {
      const cid = String(data.channelId || '');
      const text = String(data.text || '');
      const isDM = cid.startsWith('dm:');
      const guild = Object.values(S.db.guilds).find((g) => g.channels.some((c) => c.id === cid));
      const ch = guild ? findChannel(guild, cid) : null;
      if (isDM && !cid.split(':').includes(me.id)) throw new Error('Sem acesso.');
      if (!isDM && (!guild || !ch || !guild.members.includes(me.id))) throw new Error('Sem acesso.');
      if (isDM && !cid.split(':').includes(me.id)) throw new Error('Sem acesso.');
      if (!text.trim() && !(data.attachments && data.attachments.length)) throw new Error('Mensagem vazia.');
      const msg = {
        id: S.id('m'),
        userId: me.id,
        text: text.slice(0, 2000),
        ts: Date.now(),
        editedTs: null,
        replyTo: data.replyTo ? { userId: data.replyTo.userId, username: data.replyTo.username, text: String(data.replyTo.text || '').slice(0, 120) } : null,
        attachments: (Array.isArray(data.attachments) ? data.attachments : []).slice(0, 4)
          .filter((a) => a && typeof a.url === 'string' && a.url.startsWith('data:image/'))
          .map((a) => ({ name: String(a.name || 'imagem').slice(0, 60), size: a.size | 0, url: a.url.slice(0, 2500000) })),
        reactions: {},
      };
      S.getMessages(cid).push(msg);
      S.save();
      const pub = S.publicMessage(msg);
      if (isDM) {
        const [, a, b] = cid.split(':');
        evUsers([a, b], 'message', { channelId: cid, message: pub });
      } else {
        evGuild(guild, 'message', { channelId: cid, message: pub });
      }
      return res(ws, rid, true, { message: pub });
    }
    if (action === 'message:edit') {
      const { channelId: cid, messageId, text } = data;
      const list = S.getMessages(cid);
      const msg = list.find((x) => x.id === messageId && x.userId === me.id);
      if (!msg) throw new Error('Mensagem não encontrada.');
      msg.text = String(text || '').slice(0, 2000);
      msg.editedTs = Date.now();
      S.save();
      broadcastMessageEvent(cid, 'message:update', { channelId: cid, message: S.publicMessage(msg) });
      return res(ws, rid, true, { message: S.publicMessage(msg) });
    }
    if (action === 'message:delete') {
      const { channelId: cid, messageId } = data;
      const list = S.getMessages(cid);
      const msg = list.find((x) => x.id === messageId);
      if (!msg) throw new Error('Mensagem não encontrada.');
      if (msg.userId !== me.id) throw new Error('Você só pode apagar suas mensagens.');
      S.db.messages[cid] = list.filter((x) => x.id !== messageId);
      S.save();
      broadcastMessageEvent(cid, 'message:remove', { channelId: cid, messageId });
      return res(ws, rid, true, {});
    }
    if (action === 'message:react') {
      const { channelId: cid, messageId, emoji } = data;
      const list = S.getMessages(cid);
      const msg = list.find((x) => x.id === messageId);
      if (!msg) throw new Error('Mensagem não encontrada.');
      const e = String(emoji || '').slice(0, 8);
      msg.reactions[e] = msg.reactions[e] || [];
      if (msg.reactions[e].includes(me.id)) msg.reactions[e] = msg.reactions[e].filter((uid) => uid !== me.id);
      else msg.reactions[e].push(me.id);
      if (!msg.reactions[e].length) delete msg.reactions[e];
      S.save();
      broadcastMessageEvent(cid, 'message:update', { channelId: cid, message: S.publicMessage(msg) });
      return res(ws, rid, true, {});
    }

    /* ---------- DMs ---------- */
    if (action === 'dm:open') {
      const other = S.db.users[data.userId];
      if (!other) throw new Error('Usuário não encontrado.');
      const cid = S.ensureDM(me.id, other.id);
      evUsers([me.id, other.id], 'dm:add', { dm: { id: cid, with: S.publicUser(other) } });
      return res(ws, rid, true, { channelId: cid, with: S.publicUser(other) });
    }

    /* ---------- digitação ---------- */
    if (action === 'typing') {
      const cid = String(data.channelId || '');
      const payload = { channelId: cid, userId: me.id, username: me.username };
      if (cid.startsWith('dm:')) {
        const [, a, b] = cid.split(':');
        evUsers([a, b], 'typing', payload, ws);
      } else {
        const guild = Object.values(S.db.guilds).find((g) => g.channels.some((c) => c.id === cid));
        if (guild) evGuild(guild, 'typing', payload, ws);
      }
      return res(ws, rid, true, {});
    }

    /* ---------- voz ---------- */
    if (action === 'voice:join') {
      const g = S.canAccessGuild(me.id, data.guildId);
      if (!g) throw new Error('Servidor não encontrado.');
      const ch = findChannel(g, data.channelId);
      if (!ch || ch.type !== 'voice') throw new Error('Canal de voz não encontrado.');
      const p = presence.get(me.id) || {};
      // sai de onde estiver
      if (p.voice && p.voice !== ch.id) {
        Object.values(S.db.guilds).forEach((gg) => {
          if (gg.voice[p.voice]) {
            gg.voice[p.voice] = gg.voice[p.voice].filter((uid) => uid !== me.id);
            evGuild(gg, 'voice:leave', { channelId: p.voice, userId: me.id });
          }
        });
      }
      const room = (g.voice[ch.id] = g.voice[ch.id] || []);
      const peers = room.filter((uid) => uid !== me.id).map((uid) => ({
        userId: uid,
        ...(presenceOf(uid)),
        user: S.publicUser(S.db.users[uid]),
      }));
      if (!room.includes(me.id)) room.push(me.id);
      p.voice = ch.id; p.muted = !!data.muted; p.cam = false; p.screen = false;
      presence.set(me.id, p);
      evGuild(g, 'voice:join', { channelId: ch.id, userId: me.id, user: S.publicUser(me), media: { muted: p.muted, cam: false, screen: false } });
      broadcastPresence();
      return res(ws, rid, true, { channelId: ch.id, peers });
    }
    if (action === 'voice:leave') {
      const p = presence.get(me.id) || {};
      if (p.voice) {
        const g = Object.values(S.db.guilds).find((gg) => gg.voice[p.voice]);
        if (g) {
          g.voice[p.voice] = (g.voice[p.voice] || []).filter((uid) => uid !== me.id);
          evGuild(g, 'voice:leave', { channelId: p.voice, userId: me.id });
        }
        p.voice = null; p.cam = false; p.screen = false;
        presence.set(me.id, p);
        broadcastPresence();
      }
      return res(ws, rid, true, {});
    }
    if (action === 'voice:media') {
      const p = presence.get(me.id) || {};
      p.muted = !!data.muted; p.cam = !!data.cam; p.screen = !!data.screen; p.deafened = !!data.deafened;
      presence.set(me.id, p);
      const payload = { userId: me.id, muted: p.muted, cam: p.cam, screen: p.screen, deafened: p.deafened };
      if (p.voice) {
        const g = Object.values(S.db.guilds).find((gg) => gg.voice[p.voice]);
        if (g) evGuild(g, 'voice:media', payload, ws);
      }
      broadcastPresence();
      return res(ws, rid, true, {});
    }
    if (action === 'signal') {
      const target = [...clients.entries()].find(([, meta]) => meta.userId === String(data.to));
      if (target) send(target[0], { t: 'ev', event: 'signal', data: { from: me.id, data: data.data } });
      return res(ws, rid, true, {});
    }

    /* ============================================================
       PAINEL DE ADMINISTRAÇÃO
       ============================================================ */
    if (action === 'badges:list') {
      return res(ws, rid, true, {
        badges: Object.values(S.db.badges),
        nitroTiers: S.NITRO_TIERS,
      });
    }

    if (action.startsWith('admin:')) {
      if (!me.isAdmin) return res(ws, rid, false, null, 'Apenas administradores podem fazer isso.');

      const forceLogout = (userId, event, payload) => {
        for (const [sock, meta] of clients) {
          if (meta.userId === userId && sock.readyState === 1) {
            ev(sock, event, payload);
            if (event === 'account:removed' || event === 'account:banned') {
              setTimeout(() => { try { sock.close(); } catch {} }, 400);
            }
          }
        }
      };
      const broadcastUser = (u) => evAll('user:update', { user: S.publicUser(u) });
      const overview = () => S.adminOverview();

      if (action === 'admin:overview') return res(ws, rid, true, overview());

      /* ---------- insígnias ---------- */
      if (action === 'admin:create-badge') {
        const b = S.createBadge(data);
        evAll('badges:update', { badges: Object.values(S.db.badges) });
        return res(ws, rid, true, { badge: b, overview: overview() });
      }
      if (action === 'admin:delete-badge') {
        S.deleteBadge(String(data.badgeId || ''));
        evAll('badges:update', { badges: Object.values(S.db.badges) });
        for (const u of Object.values(S.db.users)) broadcastUser(u);
        return res(ws, rid, true, { overview: overview() });
      }
      if (action === 'admin:give-badge') {
        const u = S.giveBadge(String(data.userId || ''), String(data.badgeId || ''));
        broadcastUser(u);
        return res(ws, rid, true, { user: S.publicUser(u), overview: overview() });
      }
      if (action === 'admin:revoke-badge') {
        const u = S.revokeBadge(String(data.userId || ''), String(data.badgeId || ''));
        broadcastUser(u);
        return res(ws, rid, true, { user: S.publicUser(u), overview: overview() });
      }

      /* ---------- Cordis Aurora (Nitro) ---------- */
      if (action === 'admin:set-nitro') {
        const u = S.setNitro(String(data.userId || ''), data.tier || 'aurora', data.days);
        broadcastUser(u);
        return res(ws, rid, true, { user: S.publicUser(u), overview: overview() });
      }
      if (action === 'admin:remove-nitro') {
        const u = S.removeNitro(String(data.userId || ''));
        broadcastUser(u);
        return res(ws, rid, true, { user: S.publicUser(u), overview: overview() });
      }

      /* ---------- moderação ---------- */
      if (action === 'admin:ban') {
        const days = data.days ? Number(data.days) : 0;
        const until = days > 0 ? Date.now() + days * 86400000 : null;
        const u = S.banUser(String(data.userId || ''), { reason: data.reason, until, by: me.id });
        broadcastUser(u);
        forceLogout(u.id, 'account:banned', { reason: u.banned.reason, until: u.banned.until });
        broadcastPresence();
        return res(ws, rid, true, { user: S.publicUser(u), overview: overview() });
      }
      if (action === 'admin:unban') {
        const u = S.unbanUser(String(data.userId || ''));
        broadcastUser(u);
        return res(ws, rid, true, { user: S.publicUser(u), overview: overview() });
      }
      if (action === 'admin:delete-user') {
        const uid = String(data.userId || '');
        forceLogout(uid, 'account:removed', {});
        S.deleteUser(uid);
        evAll('account:delete', { userId: uid });
        broadcastPresence();
        return res(ws, rid, true, { overview: overview() });
      }

      /* ---------- conversar diretamente ---------- */
      if (action === 'admin:dm') {
        const other = S.db.users[String(data.userId || '')];
        if (!other) return res(ws, rid, false, null, 'Conta não encontrada.');
        const cid = S.ensureDM(me.id, other.id);
        evUsers([other.id], 'dm:add', { dm: { id: cid, with: S.publicUser(me) } });
        return res(ws, rid, true, { channelId: cid, with: S.publicUser(other) });
      }
    }

    res(ws, rid, false, null, 'Ação desconhecida: ' + action);
  }
});

function broadcastMessageEvent(cid, event, data) {
  if (cid.startsWith('dm:')) {
    const [, a, b] = cid.split(':');
    evUsers([a, b], event, data);
  } else {
    const guild = Object.values(S.db.guilds).find((g) => g.channels.some((c) => c.id === cid));
    if (guild) evGuild(guild, event, data);
  }
}
function location_hint(code) { return code; }

/* keepalive */
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

S.init().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Cordis (Discord Total) rodando em http://localhost:${PORT}`);
  });
});

process.on('SIGINT', () => { S.flushNow(); process.exit(0); });
process.on('SIGTERM', () => { S.flushNow(); process.exit(0); });

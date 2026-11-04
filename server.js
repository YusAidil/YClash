require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { ActionRowBuilder, ApplicationCommandOptionType, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Events, GatewayIntentBits } = require('discord.js');

const app = express();
const port = Number(process.env.PORT) || 3000;
const dataDirectory = process.env.YCLASH_DATA_DIRECTORY || path.join(__dirname, 'data');
const legacyDataFile = path.join(dataDirectory, 'upgrades.json');
const accountsFile = path.join(dataDirectory, 'accounts.json');
const userStatesFile = path.join(dataDirectory, 'user-states.json');
const sessions = new Map();
const adminSessions = new Map();
const authFailures = new Map();
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL = 2 * 60 * 60 * 1000;
const AUTH_WINDOW = 15 * 60 * 1000;
const AUTH_LIMIT = 10;
const DISCORD_LINK_TTL = 10 * 60 * 1000;
const MAX_VILLAGE_PROFILES = 10;
const PLAYER_CACHE_TTL = 5 * 60 * 1000;
const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;
const discordLinkCodes = new Map();
const playerCache = new Map();
const POTION_TYPES = {
  builder: { name: 'Builder Potion', duration: 60 * 60 * 1000 },
  clock_tower: { name: 'Clock Tower Potion', duration: 30 * 60 * 1000 },
  hero: { name: 'Hero Potion', duration: 60 * 60 * 1000 },
  pet: { name: 'Pet Potion', duration: 60 * 60 * 1000 },
  power: { name: 'Power Potion', duration: 60 * 60 * 1000 },
  research: { name: 'Research Potion', duration: 60 * 60 * 1000 },
  resource: { name: 'Resource Potion', duration: 24 * 60 * 60 * 1000 },
  training: { name: 'Training Potion', duration: 60 * 60 * 1000 },
  super: { name: 'Super Potion', duration: 3 * 24 * 60 * 60 * 1000 }
};
let accounts = [];
let userStates = new Map();
let accountsWriteQueue = Promise.resolve();
let statesWriteQueue = Promise.resolve();
let discordClient = null;
let discordLinkCommandReady = false;

function emptyVillageState() {
  return { active: [], completed: [], potions: [], builders: 5, playerTag: null };
}

function emptyState() {
  return { activeProfileId: 'main', profiles: [{ id: 'main', name: 'Desa Utama', ...emptyVillageState() }] };
}

function normalizeVillageState(saved) {
  return {
    active: Array.isArray(saved?.active) ? saved.active : [],
    completed: Array.isArray(saved?.completed) ? saved.completed : [],
    potions: Array.isArray(saved?.potions) ? saved.potions : [],
    builders: Number(saved?.builders) || 5,
    playerTag: typeof saved?.playerTag === 'string' ? saved.playerTag : null
  };
}

function normalizePlayerTag(value) {
  const tag = typeof value === 'string' ? value.trim().toUpperCase().replace(/^#/, '').replaceAll('O', '0') : '';
  return /^[0289PYLQGRJCUV]{3,15}$/.test(tag) ? `#${tag}` : null;
}

function summarizePlayer(player) {
  const summarizeItems = items => Array.isArray(items) ? items.map(item => ({
    name: typeof item.name === 'string' ? item.name : 'Unknown',
    level: Number.isFinite(item.level) ? item.level : null,
    maxLevel: Number.isFinite(item.maxLevel) ? item.maxLevel : null,
    village: typeof item.village === 'string' ? item.village : 'home'
  })) : [];
  return {
    tag: player.tag,
    name: player.name,
    townHallLevel: Number.isFinite(player.townHallLevel) ? player.townHallLevel : null,
    townHallWeaponLevel: Number.isFinite(player.townHallWeaponLevel) ? player.townHallWeaponLevel : null,
    expLevel: Number.isFinite(player.expLevel) ? player.expLevel : null,
    trophies: Number.isFinite(player.trophies) ? player.trophies : null,
    bestTrophies: Number.isFinite(player.bestTrophies) ? player.bestTrophies : null,
    warStars: Number.isFinite(player.warStars) ? player.warStars : null,
    attackWins: Number.isFinite(player.attackWins) ? player.attackWins : null,
    defenseWins: Number.isFinite(player.defenseWins) ? player.defenseWins : null,
    builderHallLevel: Number.isFinite(player.builderHallLevel) ? player.builderHallLevel : null,
    builderBaseTrophies: Number.isFinite(player.builderBaseTrophies) ? player.builderBaseTrophies : null,
    clan: player.clan ? {
      tag: typeof player.clan.tag === 'string' ? player.clan.tag : null,
      name: typeof player.clan.name === 'string' ? player.clan.name : null,
      level: Number.isFinite(player.clan.clanLevel) ? player.clan.clanLevel : null,
      members: Number.isFinite(player.clan.members) ? player.clan.members : null
    } : null,
    league: player.league && typeof player.league.name === 'string' ? player.league.name : null,
    heroes: summarizeItems(player.heroes),
    equipment: Array.isArray(player.heroes) ? player.heroes.flatMap(hero => summarizeItems(hero.equipment).map(item => ({ ...item, hero: hero.name }))) : [],
    troops: summarizeItems(player.troops),
    spells: summarizeItems(player.spells)
  };
}

function normalizeState(saved) {
  if (Array.isArray(saved?.profiles)) {
    const profiles = saved.profiles.filter(profile => profile && typeof profile === 'object').map(profile => ({
      id: typeof profile.id === 'string' && profile.id ? profile.id : crypto.randomUUID(),
      name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim().slice(0, 32) : 'Desa',
      ...normalizeVillageState(profile)
    }));
    if (profiles.length) {
      const activeProfileId = profiles.some(profile => profile.id === saved.activeProfileId) ? saved.activeProfileId : profiles[0].id;
      return { activeProfileId, profiles };
    }
  }
  return { activeProfileId: 'main', profiles: [{ id: 'main', name: 'Desa Utama', ...normalizeVillageState(saved) }] };
}

function getCurrentVillage(state) {
  return state.profiles.find(profile => profile.id === state.activeProfileId) || state.profiles[0];
}

function getVillageSummaries(state) {
  return state.profiles.map(({ id, name, builders, active, completed, potions }) => ({
    id,
    name,
    builders,
    activeUpgradeCount: active.length,
    completedCount: completed.length,
    activePotionCount: potions.filter(item => item.endsAt > Date.now()).length
  }));
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, account) {
  const expected = Buffer.from(account.passwordHash, 'hex');
  const actual = Buffer.from(hashPassword(password, account.passwordSalt), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return fallback;
  }
}

async function readLegacyState() {
  return normalizeVillageState(await readJson(legacyDataFile, emptyVillageState()));
}

async function ensurePrivateDataDirectory() {
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(dataDirectory, 0o700);
}

async function writeJsonAtomically(file, value) {
  await ensurePrivateDataDirectory();
  const temporaryFile = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporaryFile, file);
}

function saveAccounts() {
  accountsWriteQueue = accountsWriteQueue.then(() => writeJsonAtomically(accountsFile, accounts));
  return accountsWriteQueue;
}

function saveUserStates() {
  statesWriteQueue = statesWriteQueue.then(() => writeJsonAtomically(userStatesFile, Object.fromEntries(userStates)));
  return statesWriteQueue;
}

async function initializeUserData() {
  await ensurePrivateDataDirectory();
  const accountsFileExists = await fs.access(accountsFile).then(() => true).catch(error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  accounts = await readJson(accountsFile, []);
  const savedStates = await readJson(userStatesFile, {});
  userStates = new Map(Object.entries(savedStates).map(([id, saved]) => [id, normalizeState(saved)]));

  if (!accountsFileExists) {
    const legacyPassword = process.env.ADMIN_PASSWORD;
    if (legacyPassword && legacyPassword.length >= 16) {
      const passwordSalt = crypto.randomBytes(16).toString('hex');
      const owner = {
        id: crypto.randomUUID(),
        username: 'owner',
        passwordSalt,
        passwordHash: hashPassword(legacyPassword, passwordSalt),
        createdAt: Date.now()
      };
      accounts.push(owner);
      userStates.set(owner.id, normalizeState(await readLegacyState()));
      await saveAccounts();
      await saveUserStates();
      console.log('Existing tracker data migrated to the owner account.');
    } else {
      await saveAccounts();
    }
  }

  for (const account of accounts) {
    if (!userStates.has(account.id)) userStates.set(account.id, emptyState());
  }
  await saveUserStates();
}

function isAuthRateLimited(request, response) {
  const attempts = authFailures.get(request.ip);
  if (!attempts || attempts.expiresAt <= Date.now() || attempts.count < AUTH_LIMIT) return false;
  response.set('Retry-After', String(Math.ceil((attempts.expiresAt - Date.now()) / 1000)));
  response.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi 15 menit.' });
  return true;
}

function recordAuthFailure(request) {
  const attempts = authFailures.get(request.ip);
  const count = attempts && attempts.expiresAt > Date.now() ? attempts.count + 1 : 1;
  authFailures.set(request.ip, { count, expiresAt: Date.now() + AUTH_WINDOW });
}

function createSession(request, response, account) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionId, { userId: account.id, expiresAt: Date.now() + SESSION_TTL });
  response.cookie('upgrade_session', sessionId, {
    httpOnly: true,
    secure: request.secure,
    sameSite: 'strict',
    maxAge: SESSION_TTL,
    path: '/'
  });
}

function getAuthenticatedUser(request) {
  const sessionId = getSessionId(request);
  const session = sessionId && sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    if (sessionId) sessions.delete(sessionId);
    return null;
  }
  const account = accounts.find(item => item.id === session.userId);
  if (!account || account.disabled) {
    sessions.delete(sessionId);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL;
  return account;
}

function requireUser(request, response, next) {
  const account = getAuthenticatedUser(request);
  if (!account) return response.status(401).json({ error: 'Masuk ke akun terlebih dahulu.' });
  request.user = account;
  next();
}

function getAdminSessionId(request) {
  const cookie = request.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)yclash_admin_session=([a-f0-9]+)/);
  return match ? match[1] : null;
}

function getAuthenticatedAdmin(request) {
  const sessionId = getAdminSessionId(request);
  const session = sessionId && adminSessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    if (sessionId) adminSessions.delete(sessionId);
    return false;
  }
  session.expiresAt = Date.now() + ADMIN_SESSION_TTL;
  return true;
}

function requireAdmin(request, response, next) {
  if (!getAuthenticatedAdmin(request)) return response.status(401).json({ error: 'Login admin diperlukan.' });
  response.set('Cache-Control', 'no-store');
  next();
}

function revokeUserSessions(userId) {
  for (const [sessionId, session] of sessions) {
    if (session.userId === userId) sessions.delete(sessionId);
  }
  for (const [code, pending] of discordLinkCodes) {
    if (pending.accountId === userId) discordLinkCodes.delete(code);
  }
}

function formatDuration(milliseconds) {
  const totalMinutes = Math.max(1, Math.round(milliseconds / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return [days && `${days} hari`, hours && `${hours} jam`, minutes && `${minutes} menit`].filter(Boolean).join(' ');
}

function calculateBuilderPotionDuration(baseDuration, builderPotionHours) {
  const potionDuration = builderPotionHours * 60 * 60 * 1000;
  const potionTimeUsed = Math.min(potionDuration, baseDuration / 10);
  return Math.ceil(potionTimeUsed + Math.max(0, baseDuration - potionDuration * 10));
}

function getSessionId(request) {
  const cookie = request.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)upgrade_session=([a-f0-9]+)/);
  return match ? match[1] : null;
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));

app.get('/api/state', (request, response) => {
  response.set('Cache-Control', 'no-store');
  const account = getAuthenticatedUser(request);
  if (!account) return response.json({ ...emptyVillageState(), isAuthenticated: false, username: null, discordLinked: false, discordUsername: null, discordHandle: null, discordAvatarUrl: null, profiles: [], selectedProfileId: null });
  const accountState = userStates.get(account.id) || emptyState();
  const village = getCurrentVillage(accountState);
  response.json({
    ...village,
    isAuthenticated: true,
    username: account.username,
    discordLinked: Boolean(account.discordUserId),
    discordUsername: account.discordUsername || null,
    discordHandle: account.discordHandle || null,
    discordAvatarUrl: account.discordAvatarUrl || null,
    profiles: getVillageSummaries(accountState),
    selectedProfileId: village.id
  });
});

app.post('/api/player/lookup', requireUser, async (request, response, next) => {
  response.set('Cache-Control', 'no-store');
  const tag = normalizePlayerTag(request.body.tag);
  if (!tag) return response.status(400).json({ error: 'Tag pemain tidak valid.' });
  const village = getCurrentVillage(userStates.get(request.user.id));
  const previousTag = village.playerTag;
  village.playerTag = tag;
  try {
    await saveUserStates();
  } catch (error) {
    village.playerTag = previousTag;
    return next(error);
  }
  const token = process.env.COC_API_TOKEN?.trim();
  if (!token) return response.status(503).json({ error: 'Review akun belum dikonfigurasi. Admin perlu mengatur COC_API_TOKEN di server.' });

  let cached = playerCache.get(tag);
  if (cached && cached.expiresAt <= Date.now()) {
    playerCache.delete(tag);
    cached = null;
  }
  const wasCached = Boolean(cached);
  let player;
  let cachedAt;
  if (cached) {
    ({ player, cachedAt } = cached);
  } else {
    let upstream;
    try {
      upstream = await fetch(`https://api.clashofclans.com/v1/players/${encodeURIComponent(tag)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      });
    } catch (error) {
      console.error('CoC player lookup failed:', error.message);
      return response.status(503).json({ error: 'API Clash of Clans sedang tidak bisa dijangkau.' });
    }
    if (upstream.status === 404) return response.status(404).json({ error: 'Tag pemain tidak ditemukan.' });
    if (upstream.status === 401 || upstream.status === 403) return response.status(503).json({ error: 'Kunci API CoC ditolak. Pastikan token dan IP server sudah benar.' });
    if (upstream.status === 429) return response.status(429).json({ error: 'Batas permintaan API tercapai. Coba lagi sebentar.' });
    if (!upstream.ok) return response.status(503).json({ error: 'API Clash of Clans sedang bermasalah.' });
    try {
      player = await upstream.json();
    } catch {
      return response.status(502).json({ error: 'Respons profil dari API CoC tidak valid.' });
    }
    if (!player || typeof player.name !== 'string' || normalizePlayerTag(player.tag) !== tag) {
      return response.status(502).json({ error: 'Respons profil dari API CoC tidak valid.' });
    }
    cachedAt = Date.now();
    if (playerCache.size >= 100) playerCache.delete(playerCache.keys().next().value);
    playerCache.set(tag, { player, cachedAt, expiresAt: cachedAt + PLAYER_CACHE_TTL });
  }

  response.json({ player: summarizePlayer(player), cached: wasCached, updatedAt: cachedAt });
});

app.post('/api/profiles', requireUser, async (request, response, next) => {
  const name = typeof request.body.name === 'string' ? request.body.name.trim() : '';
  if (!name || name.length > 32) return response.status(400).json({ error: 'Nama profil harus 1-32 karakter.' });
  const accountState = userStates.get(request.user.id);
  if (accountState.profiles.length >= MAX_VILLAGE_PROFILES) return response.status(409).json({ error: `Maksimal ${MAX_VILLAGE_PROFILES} profil desa per akun.` });
  if (accountState.profiles.some(profile => profile.name.toLowerCase() === name.toLowerCase())) return response.status(409).json({ error: 'Nama profil sudah digunakan.' });
  const previousProfileId = accountState.activeProfileId;
  const profile = { id: crypto.randomUUID(), name, ...emptyVillageState() };
  accountState.profiles.push(profile);
  accountState.activeProfileId = profile.id;
  try {
    await saveUserStates();
    response.status(201).json({ ok: true, profile: { id: profile.id, name: profile.name, builders: profile.builders } });
  } catch (error) {
    accountState.profiles = accountState.profiles.filter(item => item.id !== profile.id);
    accountState.activeProfileId = previousProfileId;
    next(error);
  }
});

app.post('/api/profiles/:id/select', requireUser, async (request, response, next) => {
  const accountState = userStates.get(request.user.id);
  if (!accountState.profiles.some(profile => profile.id === request.params.id)) return response.status(404).json({ error: 'Profil desa tidak ditemukan.' });
  const previousProfileId = accountState.activeProfileId;
  accountState.activeProfileId = request.params.id;
  try {
    await saveUserStates();
    response.json({ ok: true, selectedProfileId: accountState.activeProfileId });
  } catch (error) {
    accountState.activeProfileId = previousProfileId;
    next(error);
  }
});

app.patch('/api/profiles/:id', requireUser, async (request, response, next) => {
  const name = typeof request.body.name === 'string' ? request.body.name.trim() : '';
  if (!name || name.length > 32) return response.status(400).json({ error: 'Nama profil harus 1-32 karakter.' });
  const accountState = userStates.get(request.user.id);
  const profile = accountState.profiles.find(item => item.id === request.params.id);
  if (!profile) return response.status(404).json({ error: 'Profil desa tidak ditemukan.' });
  if (accountState.profiles.some(item => item.id !== profile.id && item.name.toLowerCase() === name.toLowerCase())) return response.status(409).json({ error: 'Nama profil sudah digunakan.' });
  const previousName = profile.name;
  profile.name = name;
  try {
    await saveUserStates();
    response.json({ ok: true, profile: { id: profile.id, name: profile.name, builders: profile.builders } });
  } catch (error) {
    profile.name = previousName;
    next(error);
  }
});

app.delete('/api/profiles/:id', requireUser, async (request, response, next) => {
  const accountState = userStates.get(request.user.id);
  if (accountState.profiles.length <= 1) return response.status(409).json({ error: 'Profil desa terakhir tidak dapat dihapus.' });
  const profile = accountState.profiles.find(item => item.id === request.params.id);
  if (!profile) return response.status(404).json({ error: 'Profil desa tidak ditemukan.' });
  const previousProfiles = accountState.profiles;
  const previousProfileId = accountState.activeProfileId;
  accountState.profiles = accountState.profiles.filter(item => item.id !== profile.id);
  if (accountState.activeProfileId === profile.id) accountState.activeProfileId = accountState.profiles[0].id;
  try {
    await saveUserStates();
    response.json({ ok: true, selectedProfileId: accountState.activeProfileId });
  } catch (error) {
    accountState.profiles = previousProfiles;
    accountState.activeProfileId = previousProfileId;
    next(error);
  }
});

app.post('/api/discord/link/start', requireUser, (request, response) => {
  if (!discordClient?.isReady() || !discordLinkCommandReady) {
    return response.status(503).json({ error: 'Fitur tautkan Discord belum siap. Coba lagi sebentar.' });
  }
  if (request.user.discordUserId) return response.status(409).json({ error: 'Akun Discord sudah tertaut.' });

  const now = Date.now();
  for (const [code, pending] of discordLinkCodes) {
    if (pending.expiresAt <= now || pending.accountId === request.user.id) discordLinkCodes.delete(code);
  }
  const code = crypto.randomBytes(6).toString('hex').toUpperCase();
  discordLinkCodes.set(code, { accountId: request.user.id, expiresAt: now + DISCORD_LINK_TTL });
  response.json({ code, expiresInSeconds: DISCORD_LINK_TTL / 1000 });
});

app.delete('/api/discord/link', requireUser, async (request, response, next) => {
  const previousDiscordUserId = request.user.discordUserId;
  const previousDiscordUsername = request.user.discordUsername;
  const previousDiscordHandle = request.user.discordHandle;
  const previousDiscordAvatarUrl = request.user.discordAvatarUrl;
  if (!previousDiscordUserId) return response.json({ ok: true });

  for (const [code, pending] of discordLinkCodes) {
    if (pending.accountId === request.user.id) discordLinkCodes.delete(code);
  }
  delete request.user.discordUserId;
  delete request.user.discordUsername;
  delete request.user.discordHandle;
  delete request.user.discordAvatarUrl;
  try {
    await saveAccounts();
    response.json({ ok: true });
  } catch (error) {
    request.user.discordUserId = previousDiscordUserId;
    request.user.discordUsername = previousDiscordUsername;
    if (previousDiscordHandle) request.user.discordHandle = previousDiscordHandle;
    if (previousDiscordAvatarUrl) request.user.discordAvatarUrl = previousDiscordAvatarUrl;
    next(error);
  }
});

app.post('/api/register', async (request, response, next) => {
  if (isAuthRateLimited(request, response)) return;
  const username = typeof request.body.username === 'string' ? request.body.username.trim().toLowerCase() : '';
  const password = typeof request.body.password === 'string' ? request.body.password : '';
  if (!USERNAME_PATTERN.test(username) || password.length < 12 || password.length > 128) {
    return response.status(400).json({ error: 'Nama pengguna harus 3-24 karakter (huruf, angka, _), password 12-128 karakter.' });
  }
  if (accounts.some(account => account.username === username)) {
    return response.status(409).json({ error: 'Nama pengguna sudah dipakai.' });
  }

  const passwordSalt = crypto.randomBytes(16).toString('hex');
  const account = {
    id: crypto.randomUUID(),
    username,
    passwordSalt,
    passwordHash: hashPassword(password, passwordSalt),
    createdAt: Date.now()
  };
  accounts.push(account);
  userStates.set(account.id, emptyState());
  try {
    await Promise.all([saveAccounts(), saveUserStates()]);
  } catch (error) {
    accounts = accounts.filter(item => item.id !== account.id);
    userStates.delete(account.id);
    return next(error);
  }
  authFailures.delete(request.ip);
  createSession(request, response, account);
  response.status(201).json({ ok: true, username: account.username });
});

app.post('/api/login', (request, response) => {
  if (isAuthRateLimited(request, response)) return;
  const username = typeof request.body.username === 'string' ? request.body.username.trim().toLowerCase() : '';
  const password = typeof request.body.password === 'string' ? request.body.password : '';
  const account = accounts.find(item => item.username === username);
  if (!account || account.disabled || password.length > 128 || !verifyPassword(password, account)) {
    recordAuthFailure(request);
    return response.status(401).json({ error: 'Username atau password salah.' });
  }
  authFailures.delete(request.ip);
  createSession(request, response, account);
  response.json({ ok: true, username: account.username });
});

app.post('/api/logout', requireUser, (request, response) => {
  sessions.delete(getSessionId(request));
  response.clearCookie('upgrade_session', { httpOnly: true, secure: request.secure, sameSite: 'strict', path: '/' });
  response.json({ ok: true });
});

app.post('/api/admin/login', (request, response) => {
  response.set('Cache-Control', 'no-store');
  if (isAuthRateLimited(request, response)) return;
  const expectedPassword = process.env.ADMIN_PASSWORD || '';
  if (expectedPassword.length < 16) return response.status(503).json({ error: 'Login admin belum dikonfigurasi dengan aman.' });
  const password = typeof request.body.password === 'string' ? request.body.password : '';
  const expectedDigest = crypto.createHash('sha256').update(expectedPassword).digest();
  const actualDigest = crypto.createHash('sha256').update(password).digest();
  if (password.length > 128 || !crypto.timingSafeEqual(actualDigest, expectedDigest)) {
    recordAuthFailure(request);
    return response.status(401).json({ error: 'Password admin salah.' });
  }
  authFailures.delete(request.ip);
  const sessionId = crypto.randomBytes(32).toString('hex');
  adminSessions.set(sessionId, { expiresAt: Date.now() + ADMIN_SESSION_TTL });
  response.cookie('yclash_admin_session', sessionId, {
    httpOnly: true,
    secure: request.secure,
    sameSite: 'strict',
    maxAge: ADMIN_SESSION_TTL,
    path: '/api/admin'
  });
  response.json({ ok: true });
});

app.get('/api/admin/session', (request, response) => {
  response.set('Cache-Control', 'no-store');
  response.json({ authenticated: getAuthenticatedAdmin(request) });
});

app.post('/api/admin/logout', (request, response) => {
  const sessionId = getAdminSessionId(request);
  if (sessionId) adminSessions.delete(sessionId);
  response.clearCookie('yclash_admin_session', { httpOnly: true, secure: request.secure, sameSite: 'strict', path: '/api/admin' });
  response.json({ ok: true });
});

app.get('/api/admin/accounts', requireAdmin, (request, response) => {
  const now = Date.now();
  response.json(accounts.map(account => {
    const state = userStates.get(account.id) || emptyState();
    const activeUpgradeCount = state.profiles.reduce((count, profile) => count + profile.active.length, 0);
    const potionCount = state.profiles.reduce((count, profile) => count + profile.potions.filter(item => item.endsAt > now).length, 0);
    const completedCount = state.profiles.reduce((count, profile) => count + profile.completed.length, 0);
    return {
      id: account.id,
      username: account.username,
      createdAt: account.createdAt,
      disabled: Boolean(account.disabled),
      discordLinked: Boolean(account.discordUserId),
      discordUsername: account.discordUsername || null,
      discordHandle: account.discordHandle || null,
      discordAvatarUrl: account.discordAvatarUrl || null,
      villageCount: state.profiles.length,
      activeUpgradeCount,
      potionCount,
      completedCount
    };
  }));
});

app.get('/api/admin/accounts/:id', requireAdmin, (request, response) => {
  const account = accounts.find(item => item.id === request.params.id);
  if (!account) return response.status(404).json({ error: 'Akun tidak ditemukan.' });
  const state = userStates.get(account.id) || emptyState();
  response.json({
    account: {
      id: account.id,
      username: account.username,
      createdAt: account.createdAt,
      disabled: Boolean(account.disabled),
      discordLinked: Boolean(account.discordUserId),
      discordUsername: account.discordUsername || null,
      discordHandle: account.discordHandle || null,
      discordAvatarUrl: account.discordAvatarUrl || null
    },
    selectedProfileId: state.activeProfileId,
    profiles: state.profiles
  });
});

app.patch('/api/admin/accounts/:id/status', requireAdmin, async (request, response, next) => {
  const account = accounts.find(item => item.id === request.params.id);
  if (!account) return response.status(404).json({ error: 'Akun tidak ditemukan.' });
  if (typeof request.body.disabled !== 'boolean') return response.status(400).json({ error: 'Status akun tidak valid.' });
  if (account.username === 'owner' && request.body.disabled) return response.status(409).json({ error: 'Akun owner utama tidak dapat dinonaktifkan.' });
  const wasDisabled = Boolean(account.disabled);
  if (wasDisabled === request.body.disabled) return response.json({ ok: true });
  if (request.body.disabled) account.disabled = true;
  else delete account.disabled;
  try {
    await saveAccounts();
    if (request.body.disabled) revokeUserSessions(account.id);
    response.json({ ok: true, disabled: Boolean(account.disabled) });
  } catch (error) {
    if (wasDisabled) account.disabled = true;
    else delete account.disabled;
    next(error);
  }
});

app.delete('/api/admin/accounts/:id', requireAdmin, async (request, response, next) => {
  const account = accounts.find(item => item.id === request.params.id);
  if (!account) return response.status(404).json({ error: 'Akun tidak ditemukan.' });
  if (account.username === 'owner') return response.status(409).json({ error: 'Akun owner utama tidak dapat dihapus.' });
  const previousAccounts = accounts;
  const previousStates = userStates;
  accounts = accounts.filter(item => item.id !== account.id);
  userStates = new Map(userStates);
  userStates.delete(account.id);
  try {
    await Promise.all([saveAccounts(), saveUserStates()]);
    revokeUserSessions(account.id);
    response.json({ ok: true });
  } catch (error) {
    accounts = previousAccounts;
    userStates = previousStates;
    try { await Promise.all([saveAccounts(), saveUserStates()]); }
    catch (rollbackError) { console.error('Gagal memulihkan data akun setelah penghapusan gagal:', rollbackError.message); }
    next(error);
  }
});

app.post('/api/upgrades', requireUser, async (request, response, next) => {
  try {
    const building = typeof request.body.building === 'string' ? request.body.building.trim().slice(0, 48) : '';
    const level = typeof request.body.level === 'string' ? request.body.level.trim().slice(0, 20) : '';
    const duration = Number(request.body.duration);
    if (!building || !level || !Number.isSafeInteger(duration) || duration < 60000 || duration > 3650 * 86400000) {
      return response.status(400).json({ error: 'Nama, level, atau durasi upgrade tidak valid.' });
    }
    const state = getCurrentVillage(userStates.get(request.user.id));
    const startedAt = Date.now();
    const upgrade = {
      id: crypto.randomUUID(),
      building,
      level,
      startedAt,
      baseDuration: duration,
      effectiveDuration: duration,
      endsAt: startedAt + duration
    };
    state.active.push(upgrade);
    state.builders = Math.min(10, Math.max(1, Number(request.body.builders) || 1));
    await saveUserStates();
    response.status(201).json({ ok: true, endsAt: upgrade.endsAt, effectiveDuration: duration });
  } catch (error) { next(error); }
});

app.post('/api/upgrades/:id/complete', requireUser, async (request, response, next) => {
  try {
    const state = getCurrentVillage(userStates.get(request.user.id));
    const index = state.active.findIndex(item => item.id === request.params.id);
    if (index < 0) return response.status(404).json({ error: 'Upgrade tidak ditemukan.' });
    const [upgrade] = state.active.splice(index, 1);
    upgrade.finishedAt = Date.now();
    state.completed.unshift(upgrade);
    state.completed = state.completed.slice(0, 100);
    await saveUserStates();
    response.json({ ok: true });
  } catch (error) { next(error); }
});

app.delete('/api/upgrades/:id', requireUser, async (request, response, next) => {
  try {
    const state = getCurrentVillage(userStates.get(request.user.id));
    const originalLength = state.active.length;
    state.active = state.active.filter(item => item.id !== request.params.id);
    if (state.active.length === originalLength) return response.status(404).json({ error: 'Upgrade tidak ditemukan.' });
    await saveUserStates();
    response.json({ ok: true });
  } catch (error) { next(error); }
});

app.delete('/api/completed/:id', requireUser, async (request, response, next) => {
  try {
    const state = getCurrentVillage(userStates.get(request.user.id));
    const originalLength = state.completed.length;
    state.completed = state.completed.filter(item => item.id !== request.params.id);
    if (state.completed.length === originalLength) return response.status(404).json({ error: 'Upgrade selesai tidak ditemukan.' });
    await saveUserStates();
    response.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/potions', requireUser, async (request, response, next) => {
  const type = typeof request.body.type === 'string' ? request.body.type : '';
  if (!Object.hasOwn(POTION_TYPES, type)) return response.status(400).json({ error: 'Jenis potion tidak valid.' });
  const quantity = request.body.quantity === undefined ? 1 : Number(request.body.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 168) {
    return response.status(400).json({ error: 'Jumlah potion harus 1-168.' });
  }
  const potion = POTION_TYPES[type];
  const addedDuration = potion.duration * quantity;
  const state = getCurrentVillage(userStates.get(request.user.id));
  const now = Date.now();
  const activeTimer = state.potions.find(item => item.type === type && item.endsAt > now);
  const stacked = Boolean(activeTimer);
  const previousTimer = stacked ? {
    endsAt: activeTimer.endsAt,
    stackCount: activeTimer.stackCount,
    hadStackCount: Object.hasOwn(activeTimer, 'stackCount')
  } : null;
  const previousStackCount = stacked && Number.isSafeInteger(activeTimer.stackCount) && activeTimer.stackCount >= 1 ? activeTimer.stackCount : stacked ? 1 : 0;
  if (!Number.isSafeInteger(previousStackCount + quantity)) {
    return response.status(400).json({ error: 'Jumlah stack potion melebihi batas.' });
  }
  const timer = activeTimer || { id: crypto.randomUUID(), type, name: potion.name, startedAt: now, endsAt: now + addedDuration, stackCount: quantity };
  if (stacked) {
    timer.endsAt = Number(timer.endsAt) + addedDuration;
    timer.stackCount = previousStackCount + quantity;
  } else {
    state.potions.unshift(timer);
  }

  const changedUpgrades = [];
  if (type === 'builder') {
    const potionHours = addedDuration / (60 * 60 * 1000);
    for (const upgrade of state.active) {
      const remaining = Number(upgrade.endsAt) - now;
      if (!Number.isFinite(remaining) || remaining <= 0) continue;
      changedUpgrades.push({
        upgrade,
        endsAt: upgrade.endsAt,
        builderPotionHours: upgrade.builderPotionHours,
        hadBuilderPotionHours: Object.hasOwn(upgrade, 'builderPotionHours')
      });
      upgrade.endsAt = now + calculateBuilderPotionDuration(remaining, potionHours);
      upgrade.builderPotionHours = (Number.isSafeInteger(upgrade.builderPotionHours) && upgrade.builderPotionHours >= 0 ? upgrade.builderPotionHours : 0) + potionHours;
    }
  }

  try {
    await saveUserStates();
    response.status(stacked ? 200 : 201).json({ ok: true, stacked, quantity, timer, affectedUpgrades: changedUpgrades.length });
  } catch (error) {
    if (stacked) {
      timer.endsAt = previousTimer.endsAt;
      if (previousTimer.hadStackCount) timer.stackCount = previousTimer.stackCount;
      else delete timer.stackCount;
    } else {
      state.potions = state.potions.filter(item => item.id !== timer.id);
    }
    for (const change of changedUpgrades) {
      change.upgrade.endsAt = change.endsAt;
      if (change.hadBuilderPotionHours) change.upgrade.builderPotionHours = change.builderPotionHours;
      else delete change.upgrade.builderPotionHours;
    }
    return next(error);
  }
});

app.delete('/api/potions/:id', requireUser, async (request, response, next) => {
  const state = getCurrentVillage(userStates.get(request.user.id));
  const originalLength = state.potions.length;
  state.potions = state.potions.filter(item => item.id !== request.params.id);
  if (state.potions.length === originalLength) return response.status(404).json({ error: 'Timer potion tidak ditemukan.' });
  try {
    await saveUserStates();
    response.json({ ok: true });
  } catch (error) { next(error); }
});

app.use('/data', (request, response) => response.sendStatus(404));
app.use(express.static(__dirname, { extensions: ['html'], index: 'coc-upgrade-tracker.html' }));
app.use((error, request, response, next) => {
  console.error(error);
  if (!response.headersSent) response.status(500).json({ error: 'Terjadi kesalahan server.' });
});

async function finishDueUpgrades(discordClient) {
  let channel = null;
  if (discordClient && process.env.DISCORD_CHANNEL_ID) {
    try { channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID); }
    catch (error) { console.error('Gagal membuka channel Discord:', error.message); }
  }

  let stateChanged = false;
  for (const account of accounts) {
    const accountState = userStates.get(account.id);
    if (!accountState) continue;
    for (const state of accountState.profiles) {
      const dueUpgrades = state.active.filter(item => item.endsAt <= Date.now());
      for (const upgrade of dueUpgrades) {
      if (discordClient && process.env.DISCORD_CHANNEL_ID && !channel) continue;
      if (channel) {
        try {
          const finishedAt = Date.now();
          const embed = new EmbedBuilder()
            .setColor(0xe3a940)
            .setAuthor({ name: `YClash · ${account.username}`, ...(account.discordAvatarUrl ? { iconURL: account.discordAvatarUrl } : {}) })
            .setTitle('Upgrade selesai')
            .setDescription(`**${upgrade.building}** berhasil mencapai **${upgrade.level}** dan siap digunakan.`)
            .addFields(
              { name: 'Desa', value: state.name || 'Desa Utama', inline: true },
              { name: 'Tag pemain', value: state.playerTag || 'Belum ditautkan', inline: true },
              { name: 'Durasi', value: formatDuration(finishedAt - upgrade.startedAt), inline: true },
              { name: 'Mulai', value: `<t:${Math.floor(upgrade.startedAt / 1000)}:f>`, inline: true },
              { name: 'Selesai', value: `<t:${Math.floor(finishedAt / 1000)}:R>`, inline: true }
            )
            .setFooter({ text: 'YClash · Clash of Clans' })
            .setTimestamp(finishedAt);
          const discordUserId = /^\d{17,20}$/.test(account.discordUserId || '') ? account.discordUserId : null;
          const message = {
            embeds: [embed],
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setLabel('Buka YClash').setStyle(ButtonStyle.Link).setURL('https://yclash.duckdns.org/')
            )],
            allowedMentions: { parse: [], ...(discordUserId ? { users: [discordUserId] } : {}) }
          };
          if (discordUserId) message.content = `<@${discordUserId}>`;
          await channel.send(message);
        } catch (error) {
          console.error(`Gagal mengirim notifikasi upgrade ${upgrade.id}:`, error.message);
          continue;
        }
      }

      const index = state.active.findIndex(item => item.id === upgrade.id);
      if (index >= 0) {
        const [finished] = state.active.splice(index, 1);
        finished.finishedAt = Date.now();
        state.completed.unshift(finished);
        state.completed = state.completed.slice(0, 100);
        stateChanged = true;
      }
      }
    }
  }
  if (stateChanged) await saveUserStates();
}

async function registerDiscordLinkCommand(client) {
  const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
  if (!channel?.guild) throw new Error('Channel not found in a Discord server.');

  const command = {
    name: 'yclash-link',
    description: 'Tautkan akun Discord ke akun YClash',
    options: [{
      type: ApplicationCommandOptionType.String,
      name: 'code',
      description: 'Kode tautan dari dashboard YClash',
      required: true,
      min_length: 12,
      max_length: 12
    }]
  };
  const commands = await channel.guild.commands.fetch();
  const existing = commands.find(item => item.name === command.name);
  if (existing) await existing.edit(command);
  else await channel.guild.commands.create(command);
}

async function handleDiscordLinkInteraction(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'yclash-link') return;
  await interaction.deferReply({ ephemeral: true });

  const code = interaction.options.getString('code', true).trim().toUpperCase();
  const pending = discordLinkCodes.get(code);
  if (!pending || pending.expiresAt <= Date.now()) {
    discordLinkCodes.delete(code);
    await interaction.editReply('Kode tautan tidak valid atau sudah kedaluwarsa. Buat kode baru dari dashboard YClash.');
    return;
  }

  discordLinkCodes.delete(code);
  const account = accounts.find(item => item.id === pending.accountId);
  if (!account || account.discordUserId) {
    await interaction.editReply('Akun YClash tidak tersedia atau sudah tertaut. Buat kode baru dari dashboard.');
    return;
  }
  if (accounts.some(item => item.id !== account.id && item.discordUserId === interaction.user.id)) {
    await interaction.editReply('Akun Discord ini sudah tertaut ke akun YClash lain.');
    return;
  }

  account.discordUserId = interaction.user.id;
  account.discordUsername = interaction.user.globalName || interaction.user.username;
  account.discordHandle = interaction.user.username;
  account.discordAvatarUrl = interaction.user.displayAvatarURL({ extension: 'png', size: 128 });
  try {
    await saveAccounts();
    await interaction.editReply(`Discord berhasil ditautkan ke akun YClash **${account.username}**.`);
  } catch (error) {
    delete account.discordUserId;
    delete account.discordUsername;
    delete account.discordHandle;
    delete account.discordAvatarUrl;
    console.error('Gagal menyimpan tautan Discord:', error.message);
    await interaction.editReply('Tautan gagal disimpan. Buat kode baru dari dashboard YClash.');
  }
}

async function refreshLinkedDiscordProfiles(client) {
  let changed = false;
  for (const account of accounts.filter(item => item.discordUserId && (!item.discordAvatarUrl || !item.discordHandle))) {
    try {
      const user = await client.users.fetch(account.discordUserId);
      account.discordUsername = user.globalName || user.username;
      account.discordHandle = user.username;
      account.discordAvatarUrl = user.displayAvatarURL({ extension: 'png', size: 128 });
      changed = true;
    } catch (error) {
      console.error(`Gagal memperbarui profil Discord ${account.username}:`, error.message);
    }
  }
  if (changed) await saveAccounts();
}

async function start() {
  await initializeUserData();
  const discordConfigured = process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CHANNEL_ID;
  if (discordConfigured) {
    discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
    discordClient.once(Events.ClientReady, async client => {
      console.log(`Discord bot aktif: ${client.user.tag}`);
      refreshLinkedDiscordProfiles(client).catch(error => console.error('Gagal menyimpan profil Discord:', error.message));
      try {
        await registerDiscordLinkCommand(client);
        discordLinkCommandReady = true;
        console.log('Slash command /yclash-link aktif.');
      } catch (error) {
        console.error('Gagal mendaftarkan /yclash-link:', error.message);
      }
    });
    discordClient.on(Events.InteractionCreate, interaction => {
      handleDiscordLinkInteraction(interaction).catch(error => console.error('Gagal memproses tautan Discord:', error.message));
    });
    discordClient.on('error', error => console.error('Discord bot error:', error.message));
    discordClient.login(process.env.DISCORD_BOT_TOKEN).catch(error => console.error('Login Discord gagal:', error.message));
  } else {
    console.log('Bot Discord belum dikonfigurasi; timer tetap berjalan tanpa notifikasi Discord.');
  }

  let checking = false;
  setInterval(async () => {
    if (checking) return;
    checking = true;
    try { await finishDueUpgrades(discordClient); }
    catch (error) { console.error('Gagal memeriksa timer:', error.message); }
    finally { checking = false; }
  }, 5000);

  app.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`YClash berjalan di port ${port}`));
}

start().catch(error => { console.error(error); process.exit(1); });
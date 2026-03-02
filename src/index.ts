import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WAMessage,
  MessageUpsertType,
  jidNormalizedUser,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import axios from 'axios';
import pino from 'pino';
import readline from 'readline';
import fs from 'fs';
import FormData from 'form-data';

// CONFIGURATION
const BRAIN_URL = 'http://127.0.0.1:8001/grove/input';
const AUTH_FOLDER = 'auth_info_baileys';

// GLOBAL STATE
let configuredPhoneNumber: string | undefined;
let pairingCodeRequested = false;

// ANTI-LOOP CACHE: Track IDs of messages WE sent
const sentMsgIds = new Set<string>();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve));

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  if (!state.creds.registered && configuredPhoneNumber === undefined) {
    console.log('\n--- GROVE BRIDGE AUTHENTICATION ---');
    console.log('Option 1: Scan QR Code (Press ENTER)');
    console.log('Option 2: Pairing Code (Enter Phone Number e.g. 2347016736717)');
    const answer = await question('Selection: ');
    configuredPhoneNumber = answer.replace(/[^0-9]/g, '');

    if (configuredPhoneNumber) {
      console.log(`\n> Selected Pairing Code for: ${configuredPhoneNumber}`);
    } else {
      console.log('\n> Selected QR Code');
    }
  }

  const isPairing = !!configuredPhoneNumber;

  console.log('[GROVE] Fetching latest Baileys version...');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[GROVE] Using WA v${version.join('.')} (Latest: ${isLatest})`);

  const pinoLogger = ((pino as unknown as any).default || (pino as unknown as any))({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger: pinoLogger,
    printQRInTerminal: !isPairing,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pinoLogger),
    },
    // BROWSER: Firefox/Ubuntu (Proven Stable)
    browser: Browsers.ubuntu('Firefox'),
    // STEALTH MODE: Reduce load/crypto errors by disabling full sync
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    retryRequestDelayMs: 500,
    keepAliveIntervalMs: 30000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });

  if (sock.authState.creds.registered) {
    console.log('[GROVE] Session Active. Listening for "Note to Self"...');
  }

  if (isPairing && !sock.authState.creds.registered && !pairingCodeRequested) {
    pairingCodeRequested = true;
    console.log('[GROVE] Waiting for socket open...');
    setTimeout(async () => {
      try {
        if (sock.ws.isOpen) {
          console.log(`[GROVE] Requesting code for ${configuredPhoneNumber}...`);
          const code = await sock.requestPairingCode(configuredPhoneNumber!);
          console.log(`\n### CODE: ${code} ###\n`);
        }
      } catch (err) {
        console.error('[GROVE] Failed to request code:', err);
        pairingCodeRequested = false;
      }
    }, 4000);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[GROVE] Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        console.log('[GROVE] ⚠️ SESSION INVALIDATED. Clearing credentials.');
        try {
          sock.ws.close();
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          process.exit(0);
        } catch (e) { }
      }
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, (statusCode === 405 ? 2000 : 1000));
      }
    } else if (connection === 'open') {
      console.log('[GROVE] SOVEREIGN BRIDGE ESTABLISHED. 🟢');
      try { rl.close(); } catch (e) { }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // WATERMARK PROTOCOL
  const INVISIBLE_WATERMARK = '\u200B';

  // --- MESSAGE HANDLER (NOTE-TO-SELF + WATERMARK) ---
  sock.ev.on('messages.upsert', async (m: { messages: WAMessage[], type: MessageUpsertType }) => {
    const msg = m.messages[0];
    if (m.type !== 'notify') return;

    const sender = msg.key.remoteJid;
    if (!sender) return;

    // 1. EXTRACT TEXT
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
    if (!text) return;

    // 2. THE WATERMARK CHECK (Stateless Loop Prevention)
    if (text.endsWith(INVISIBLE_WATERMARK)) {
      // It's me (Bot) talking. Ignore.
      return;
    }

    // 3. IDENTIFY SELF (Optional: Still good to keep strict mode)
    const myJid = jidNormalizedUser(sock.user?.id);
    if (sender !== myJid) return; // Strict Note-to-Self

    // 4. IGNORE STATUS/BROADCASTS
    if (sender === 'status@broadcast') return;

    console.log(`[GROVE] Note to Self: ${text}`);


    try {
      // 1. PREPARE FORM DATA
      const formData = new FormData();
      formData.append('user_id', sender);
      formData.append('text', text || "");

      // 2. DETECT MEDIA (IMAGE/AUDIO)
      const messageType = Object.keys(msg.message || {})[0];
      const isImage = messageType === 'imageMessage';
      const isAudio = messageType === 'audioMessage';

      if (isImage || isAudio) {
        console.log(`[BRIDGE] Downloading ${messageType}...`);
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: sock.logger, reuploadRequest: sock.updateMediaMessage }
        );
        const filename = isImage ? 'image.jpg' : 'voice_note.ogg';
        formData.append('file', buffer, filename);
        formData.append('media_type', isImage ? 'image' : 'audio');
      }

      // 3. SEND WITH HEADERS
      const brainResponse = await axios.post(BRAIN_URL, formData, {
        headers: {
          ...formData.getHeaders()
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });

      let replyText = brainResponse.data.reply || "Thinking...";
      console.log(`[GROVE] Brain Reply: ${replyText}`);

      // APPEND WATERMARK
      replyText += INVISIBLE_WATERMARK;

      // 1. SEND TEXT
      await sock.sendMessage(sender, { text: replyText });

      // 2. SEND AUDIO (If Brain sent it)
      if (brainResponse.data.audio) {
        console.log("[GROVE] Receiving Voice Transmission...");
        const audioBuffer = Buffer.from(brainResponse.data.audio, 'base64');

        await sock.sendMessage(sender, {
          audio: audioBuffer,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true // Send as Voice Note (Green Waveform)
        });
        console.log("[GROVE] Voice Note Sent. 🎙️");
      }

    } catch (error: any) {
      console.log("[GROVE] BRAIN ERROR (Server Offline?)");
      if (error.response) {
        console.error(`[GROVE] STATUS: ${error.response.status}`);
        console.error(`[GROVE] DATA: ${JSON.stringify(error.response.data)}`);
      } else {
        console.error("[BRIDGE ERROR]", error.message);
      }
      // Don't reply on error
    }
  });
}

console.log("[GROVE] Initializing Sovereign Bridge (Safe Mode)...");
connectToWhatsApp();

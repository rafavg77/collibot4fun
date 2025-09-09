import 'reflect-metadata';
import { Client, LocalAuth } from 'whatsapp-web.js';
import fs from 'fs';
import path from 'path';
// @ts-ignore
const qrcode = require('qrcode-terminal');
import { initDatabase } from './database';
import { handleIncomingMessage } from './controllers/messageController';
import { AppDataSource } from './database';
import { Usuario, UserType, Auditoria } from './database/models';
import { ENV, splitCommaList } from './config';
import http from 'http';
import { globalMutex } from './utils/concurrency';
import { installConsoleTimestampPrefix, installStdIoLinePrefix, audit } from './utils/logger';


async function ensureStartupAdmins() {
  const notifyNumbers = ENV.STARTUP_NOTIFY_NUMBERS; // puede estar vacío
  if (!notifyNumbers || notifyNumbers.trim() === '') return;
  const numbers = notifyNumbers.split(',').map(n => n.trim());
  const userRepo = AppDataSource.getRepository(Usuario);
  const auditRepo = AppDataSource.getRepository(Auditoria);
  for (const number of numbers) {
    let user = await userRepo.findOneBy({ numeroWhatsapp: number });
    if (!user) {
      user = userRepo.create({ numeroWhatsapp: number, nombre: number, tipo: UserType.ADMIN, activo: true });
      await userRepo.save(user);
      await auditRepo.save(auditRepo.create({
        usuario: user,
        accion: 'startup_admin_create',
        detalles: { numeroWhatsapp: number },
      }));
    } else if (user.tipo !== UserType.ADMIN) {
      user.tipo = UserType.ADMIN;
      await userRepo.save(user);
      await auditRepo.save(auditRepo.create({
        usuario: user,
        accion: 'startup_admin_update',
        detalles: { numeroWhatsapp: number },
      }));
    } else {
      await auditRepo.save(auditRepo.create({
        usuario: user,
        accion: 'startup_admin_exists',
        detalles: { numeroWhatsapp: number },
      }));
    }
  }
}

// Inject minimal stealth to reduce WhatsApp Web headless/automation detection
async function applyStealthWhenReady(client: Client) {
  const anyClient: any = client as any;
  const desiredUA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
  const acceptLang = 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7';
  let applied = false;
  const iv = setInterval(async () => {
    if (applied) { clearInterval(iv); return; }
    const page = anyClient?.pupPage;
    if (!page) return;
    try {
      await page.evaluateOnNewDocument(() => {
        // @ts-ignore
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        // @ts-ignore
        Object.defineProperty(navigator, 'languages', { get: () => ['es-ES', 'es'] });
        // @ts-ignore
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        // @ts-ignore
        (window as any).chrome = (window as any).chrome || { runtime: {} };
      });
      try { await page.setUserAgent(desiredUA); } catch {}
      try { await page.setExtraHTTPHeaders({ 'Accept-Language': acceptLang }); } catch {}
      applied = true;
  audit('stealth_injected');
      clearInterval(iv);
    } catch (e: any) {
  audit('stealth_injection_failed', { error: e?.message || String(e) });
    }
  }, 500);
}

async function startupNotify(client: Client) {
  const notifyNumbers = ENV.STARTUP_NOTIFY_NUMBERS;
  if (notifyNumbers && notifyNumbers.trim() !== '') {
    const numbers = notifyNumbers.split(',').map(n => n.trim()).filter(n => n.length > 0);
    const auditRepo = AppDataSource.getRepository(Auditoria);
    const nowStr = new Date().toLocaleString();
  const env = ENV.NODE_ENV;
  const botName = ENV.BOT_NAME;
    const startupMessage = [
      `🤖 ${botName} iniciado`,
      '',
      '✅ Sistema operativo correctamente',
      `📅 ${nowStr}`,
      `🌐 Ambiente: ${env}`,
      '',
      '¡Listo para recibir mensajes! 🚀'
    ].join('\n');

    const resolveChatId = async (raw: string): Promise<string | null> => {
      const digits = raw.replace(/[^0-9]/g, '');
      if (!digits) return null;
      try {
        // getNumberId devuelve null si no es válido / no tiene WA
        const waid = await client.getNumberId(digits);
        if (waid && waid._serialized) return waid._serialized; // p.ej. 521XXXXXXXXXX@c.us
        // fallback directo
        return digits.endsWith('@c.us') ? digits : `${digits}@c.us`;
      } catch {
        return digits.endsWith('@c.us') ? digits : `${digits}@c.us`;
      }
    };

    for (const rawNumber of numbers) {
      try {
        const chatId = await resolveChatId(rawNumber);
        if (!chatId) {
          await auditRepo.save(auditRepo.create({ usuario: null as any, accion: 'startup_notify_invalid_number', detalles: { rawNumber } }));
          audit('startup_notify_invalid_number', { rawNumber });
          continue;
        }
        // Verificar si es usuario registrado y admin
        const userRepo = AppDataSource.getRepository(Usuario);
        const numeroWhatsapp = chatId.replace(/@c\.us$/, '');
        const user = await userRepo.findOneBy({ numeroWhatsapp });
        if (!user) {
          await auditRepo.save(auditRepo.create({ usuario: null as any, accion: 'startup_notify_user_not_found', detalles: { chatId } }));
        }
        // serialize sends to avoid Puppeteer/session races
        const release = await globalMutex.lock();
        try {
          await client.sendMessage(chatId, startupMessage);
        } finally {
          release();
        }
        await auditRepo.save(auditRepo.create({ usuario: user || null as any, accion: 'startup_notify_ok', detalles: { chatId } }));
      } catch (err: any) {
  audit('startup_notify_error', { rawNumber, error: err?.message || String(err) });
        try {
          const auditRepo = AppDataSource.getRepository(Auditoria);
          await auditRepo.save(auditRepo.create({ usuario: null as any, accion: 'startup_notify_error', detalles: { rawNumber, error: err?.message || String(err) } }));
        } catch {}
      }
    }
  }
}

// Try to auto-click common WhatsApp Web prompts (e.g., "Use here" takeover)
function driveWhatsAppUI(client: Client) {
  const anyClient: any = client as any;
  let tries = 0;
  const iv = setInterval(async () => {
    tries += 1;
    if (tries > 30) { clearInterval(iv); return; } // stop after ~3-4 minutes
    const page = anyClient?.pupPage;
    if (!page) return;
    try {
      await page.evaluate(() => {
        const texts = ['Use here', 'Usar aquí', 'Usar aqui', 'Controlar aquí', 'Controlar aqui', 'Continue', 'Continuar'];
        const nodes: Element[] = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], [data-testid], [aria-label]'));
        for (const el of nodes) {
          const t = (el as HTMLElement).innerText?.trim() || (el as HTMLElement).ariaLabel || '';
          if (!t) continue;
          for (const key of texts) {
            if (t.toLowerCase().includes(key.toLowerCase())) {
              (el as HTMLElement).click();
              (window as any).__wa_ui_clicked = key;
              return;
            }
          }
        }
      });
    } catch {}
  }, 7000);
}

async function main() {
  // Install timestamped logs early
  installConsoleTimestampPrefix();
  installStdIoLinePrefix();
  await initDatabase();
  await ensureStartupAdmins();

  const authDir = ENV.WHATSAPP_AUTH_DIR;
  if (!authDir) {
    throw new Error('Falta WHATSAPP_AUTH_DIR en variables de entorno');
  }
  audit('auth_dir', { dir: authDir });
  try {
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }
    // Crear subcarpeta session que LocalAuth espera
    const sessionDir = authDir.endsWith('/') ? authDir + 'session' : authDir + '/session';
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
  } catch (e) {
  audit('auth_dir_prepare_error', { dir: authDir, error: (e as any)?.message || String(e) });
  }

  const executablePath = ENV.CHROMIUM_PATH;
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authDir }),
    // Use remote web version cache to avoid being stuck at 95-100% when WA updates
    // This fetches the latest compatible web build metadata at runtime
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/last.json'
    } as any,
    // If the environment provides an explicit WA Web version, pass it through
    // @ts-ignore
    webVersion: ENV.WA_WEB_VERSION || undefined,
    // Harden auth flows and conflicts
    // @ts-ignore - some fields are not in the typings across versions
    restartOnAuthFail: true,
    // @ts-ignore
    takeoverOnConflict: true,
    // @ts-ignore
    takeoverTimeoutMs: 60000,
    authTimeoutMs: 120000,
    qrMaxRetries: 6,
    puppeteer: {
      headless: true,
      executablePath,
      // Remove automation switch to reduce detection
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--use-gl=swiftshader',
        '--window-size=1366,768',
        // Removed '--single-process' and '--no-zygote' which can hang Chromium in some container setups
        '--remote-debugging-port=9222',
        '--remote-debugging-address=0.0.0.0',
        // Help bypass UA/headless checks
        '--disable-blink-features=AutomationControlled',
        '--lang=es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
        '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
      ],
      defaultViewport: { width: 1366, height: 768 }
    }
  });

  // Helper to capture a diagnostic screenshot of the puppeteer page
  const takePageScreenshot = async (tag: string) => {
    try {
      const anyClient: any = client as any;
      const page = anyClient?.pupPage;
      if (!page) return;
      const dir = '/data/screenshots';
      try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
      const file = path.join(dir, `wa_${tag}_${Date.now()}.png`);
      await page.screenshot({ path: file, fullPage: true });
  audit('screenshot_saved', { file });
    } catch (e: any) {
  audit('screenshot_failed', { error: e?.message || String(e) });
    }
  };

  let readyFired = false;
  let reloadAttempts = 0;
  let reloadTimer: NodeJS.Timeout | null = null;
  let capturedNear100 = false;

  // Start stealth hook before initialize to inject as soon as the page is available
  applyStealthWhenReady(client).catch(() => {});
  // Try gently driving UI prompts that block readiness
  driveWhatsAppUI(client);

  // Attach page debug listeners when puppeteer page becomes available
  (async () => {
    const anyClient: any = client as any;
    let attached = false;
    const iv = setInterval(() => {
      if (attached) { clearInterval(iv); return; }
      const page = anyClient?.pupPage;
      if (!page) return;
      try {
        page.on('console', (msg: any) => {
          try { audit('page_console', { type: msg.type?.(), text: msg.text?.() }); } catch {}
        });
  page.on('pageerror', (err: any) => audit('page_error', { error: err?.message || String(err) }));
  page.on('requestfailed', (req: any) => audit('network_failed', { url: req.url?.(), error: req.failure?.()?.errorText }));
        attached = true;
      } catch {}
    }, 1000);
  })();

  client.on('qr', (qr) => {
  audit('qr_received');
    qrcode.generate(qr, { small: true });
  });

  client.on('loading_screen', (percent: number, message: string) => {
  audit('loading_screen', { percent, message });
    // Take a one-time screenshot when close to 100% to diagnose stuck states
    if (!capturedNear100 && percent >= 95) {
      capturedNear100 = true;
      takePageScreenshot(`loading_${percent}`).catch(() => {});
    }
    // When reaching 100%, arm a watchdog to reload once if ready doesn't fire soon
    if (percent === 100 && !reloadTimer) {
      reloadTimer = setTimeout(async () => {
        if (readyFired) return;
        try {
          const anyClient: any = client as any;
          const page = anyClient?.pupPage;
          if (page) {
            audit('watchdog_reload', { reason: 'ready_not_fired_after_100' });
            await takePageScreenshot('before_reload');
            await page.reload({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
            await takePageScreenshot('after_reload');
            reloadAttempts += 1;
            // Schedule another watchdog if still not ready, up to 3 times
            if (!readyFired && reloadAttempts < 3) {
              if (reloadTimer) { clearTimeout(reloadTimer); }
              reloadTimer = setTimeout(async () => {
                if (readyFired) return;
                try {
                  audit('watchdog_second_reload');
                  await takePageScreenshot(`before_reload_${reloadAttempts}`);
                  await page.reload({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
                  await takePageScreenshot(`after_reload_${reloadAttempts}`);
                } catch {}
              }, 20000);
            }
          }
        } catch (e) {
          audit('watchdog_reload_failed');
        } finally {}
      }, 15000); // 15s after hitting 100%
    }
  });

  client.on('auth_failure', (msg) => {
  audit('auth_failure', { message: msg });
  });
  client.on('authenticated', () => {
  audit('authenticated');
    // Nudge WA to complete init and surface state
    setTimeout(async () => {
      try {
        // calling these APIs often drives the client to finalize readiness
  const st = await (client as any).getState?.();
  audit('get_state', { state: st });
        // small fetch to warm
        await client.getChats().catch(()=>{});
      } catch {}
    }, 5000);
  });

  client.on('disconnected', (reason) => {
  audit('disconnected', { reason });
  });

  // Extra debug hooks
  client.on('message_create', (m) => {
    const dir = (m as any)?.fromMe ? 'out' : 'in';
  audit('message_create', { dir, from: m.from, body: (m.body||'').slice(0,120) });
  });
  client.on('change_state', (s) => audit('change_state', { state: s }));

  client.on('ready', async () => {
  audit('bot_ready');
    readyFired = true;
    if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
    await startupNotify(client);
  });

  client.on('message', async (msg) => {
    await handleIncomingMessage(client, msg);
  });

  client.initialize();

  // Lightweight HTTP server for on-demand screenshot
  const server = http.createServer(async (req, res) => {
    if (!req.url) { res.statusCode = 400; return res.end('bad request'); }
    if (req.url.startsWith('/health')) {
      res.statusCode = 200; return res.end('ok');
    }
    if (req.url.startsWith('/state')) {
      try {
        const st = await (client as any).getState?.().catch(() => undefined);
        const info = (client as any).info || undefined;
        // @ts-ignore
        const webVer = (client as any).options?.webVersion || null;
        const payload = { readyFired, reloadAttempts, state: st || null, info: info || null, webVersion: webVer };
        res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(payload));
      } catch (e: any) {
        res.statusCode = 500; return res.end(e?.message || 'error');
      }
    }
    if (req.url.startsWith('/reload')) {
      try {
        const anyClient: any = client as any; const page = anyClient?.pupPage;
        if (!page) { res.statusCode = 503; return res.end('page not ready'); }
        await page.reload({ waitUntil: 'networkidle2', timeout: 45000 }).catch(()=>{});
        return res.end('reloaded');
      } catch (e:any) { res.statusCode = 500; return res.end(e?.message||'error'); }
    }
    if (req.url.startsWith('/sw-clear')) {
      try {
        const anyClient: any = client as any; const page = anyClient?.pupPage;
        if (!page) { res.statusCode = 503; return res.end('page not ready'); }
        await page.evaluate(async () => {
          const regs = await navigator.serviceWorker?.getRegistrations?.();
          if (regs) { for (const r of regs) { try { await r.unregister(); } catch {} } }
          try { caches?.keys?.().then(keys => keys.forEach(k => caches.delete(k))); } catch {}
        });
        return res.end('sw-cleared');
      } catch (e:any) { res.statusCode = 500; return res.end(e?.message||'error'); }
    }
    if (req.url.startsWith('/click')) {
      try {
        const q = decodeURIComponent((req.url.split('?')[1] || '')).replace(/^text=/,'');
        if (!q) { res.statusCode = 400; return res.end('need ?text=label'); }
        const anyClient: any = client as any; const page = anyClient?.pupPage;
        if (!page) { res.statusCode = 503; return res.end('page not ready'); }
  const clicked = await page.evaluate((needle: string) => {
          const nodes: Element[] = Array.from(document.querySelectorAll('button,[role="button"],*[data-testid],*[aria-label]'));
          for (const el of nodes) {
            const t = (el as HTMLElement).innerText?.trim() || (el as HTMLElement).ariaLabel || '';
            if (t && t.toLowerCase().includes(needle.toLowerCase())) { (el as HTMLElement).click(); return t; }
          }
          return '';
        }, q);
        res.statusCode = 200; return res.end(clicked ? `clicked: ${clicked}` : 'no-match');
      } catch (e: any) {
        res.statusCode = 500; return res.end(e?.message || 'error');
      }
    }
    if (req.url.startsWith('/screenshot')) {
      try {
        const anyClient: any = client as any;
        const page = anyClient?.pupPage;
        if (!page) { res.statusCode = 503; return res.end('page not ready'); }
        const buf: Buffer = await page.screenshot({ fullPage: true, type: 'png' });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/png');
        res.end(buf);
      } catch (e: any) {
        res.statusCode = 500; res.end(e?.message || 'error');
      }
      return;
    }
    res.statusCode = 404; res.end('not found');
  });
  server.listen(ENV.HTTP_PORT, () => audit('http_listening', { port: ENV.HTTP_PORT }));
}

main().catch(err => {
  audit('bot_start_error', { error: err?.message || String(err) });
});

import 'reflect-metadata';
import { Client, LocalAuth } from 'whatsapp-web.js';
import fs from 'fs';
// @ts-ignore
const qrcode = require('qrcode-terminal');
import { initDatabase } from './database';
import { handleIncomingMessage } from './controllers/messageController';
import { AppDataSource } from './database';
import { Usuario, UserType, Auditoria } from './database/models';
import { ENV, splitCommaList } from './config';


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
          console.warn('Número inválido para notificación startup:', rawNumber);
          continue;
        }
        // Verificar si es usuario registrado y admin
        const userRepo = AppDataSource.getRepository(Usuario);
        const numeroWhatsapp = chatId.replace(/@c\.us$/, '');
        const user = await userRepo.findOneBy({ numeroWhatsapp });
        if (!user) {
          await auditRepo.save(auditRepo.create({ usuario: null as any, accion: 'startup_notify_user_not_found', detalles: { chatId } }));
        }
  await client.sendMessage(chatId, startupMessage);
        await auditRepo.save(auditRepo.create({ usuario: user || null as any, accion: 'startup_notify_ok', detalles: { chatId } }));
      } catch (err: any) {
        console.error('Error enviando notificación startup a', rawNumber, err?.message || err);
        try {
          const auditRepo = AppDataSource.getRepository(Auditoria);
          await auditRepo.save(auditRepo.create({ usuario: null as any, accion: 'startup_notify_error', detalles: { rawNumber, error: err?.message || String(err) } }));
        } catch {}
      }
    }
  }
}

async function main() {
  await initDatabase();
  await ensureStartupAdmins();

  const authDir = ENV.WHATSAPP_AUTH_DIR;
  if (!authDir) {
    throw new Error('Falta WHATSAPP_AUTH_DIR en variables de entorno');
  }
  console.log('Usando directorio de autenticación:', authDir);
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
    console.error('No se pudo preparar auth dir:', authDir, (e as any)?.message);
  }

  const executablePath = ENV.CHROMIUM_PATH;
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authDir }),
    puppeteer: {
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--single-process',
        '--no-zygote'
      ]
    }
  });

  client.on('qr', (qr) => {
    console.log('QR recibido. Escanéalo con tu WhatsApp.');
    qrcode.generate(qr, { small: true });
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`Cargando ${percent}% - ${message}`);
  });

  client.on('auth_failure', (msg) => {
    console.error('Fallo de autenticación:', msg);
  });

  client.on('disconnected', (reason) => {
    console.warn('Cliente desconectado:', reason);
  });

  client.on('ready', async () => {
    console.log('Bot listo');
    await startupNotify(client);
  });

  client.on('message', async (msg) => {
    await handleIncomingMessage(client, msg);
  });

  client.initialize();
}

main().catch(err => {
  console.error('Error al iniciar el bot:', err);
});

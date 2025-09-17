import { Client, Message, MessageMedia } from 'whatsapp-web.js';
import { Usuario, Blacklist, Attempt, UserType, AuditContext, Auditoria } from '../database/models';
import { openDoor } from '../services/doorService';
import { AppDataSource } from '../database';
import { getGateSnapshot, getFrontDoorSnapshot, getFrontDoorClip } from '../services/cameraService';
import { createUserManual, listUsers, updateUser, deleteUser, listBlacklist, removeFromBlacklist, updateUserPhone, searchUsers } from '../services/userService';
import { createAudit } from '../services/auditService';
import { globalMutex } from '../utils/concurrency';
import { audit } from '../utils/logger';

const MENU_TRIGGER_REGEX = /^(men[uú]|Men[uú]|MEN[uÚ])$/;
const ATTEMPT_THRESHOLD = 10;
const AUDIT_CONTEXT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

// --- Ephemeral states (no persistence needed) ---
const blacklistMenuAdmins = new Set<string>();
const blacklistRemovalAwait = new Set<string>();
const auditMenuActive = new Set<string>();
const userMenuAdmins = new Set<string>();

// Estados interactivos de gestión de usuarios
interface CreateUserState { step: 1|2|3; numero?: string; nombre?: string; }
interface UpdateUserState { phase: 'askNumero' | 'attrMenu' | 'attrValue' | 'attrPhone'; numero?: string; attr?: 'nombre' | 'rol' | 'activo' | 'telefono'; }
interface DeleteUserState { step: 1|2; numero?: string; }
interface SearchUserState { phase: 'askQuery'; }
const createUserStates = new Map<string, CreateUserState>();
const updateUserStates = new Map<string, UpdateUserState>();
const deleteUserStates = new Map<string, DeleteUserState>();
const searchUserStates = new Map<string, SearchUserState>();

// ---- Audit Context helpers ----
async function getOrCreateAuditCtx(adminNumero: string) {
  const repo = AppDataSource.getRepository(AuditContext);
  let ctx = await repo.findOneBy({ adminNumeroWhatsapp: adminNumero });
  if (!ctx) {
    ctx = repo.create({ adminNumeroWhatsapp: adminNumero, offset: 0, lastInteraction: new Date() as any, awaitingFilter: false });
    await repo.save(ctx);
  }
  return ctx;
}
async function updateAuditCtx(ctx: AuditContext, changes: Partial<AuditContext>) {
  const repo = AppDataSource.getRepository(AuditContext);
  Object.assign(ctx, changes, { lastInteraction: new Date() as any });
  await repo.save(ctx);
}
async function expireOldAuditCtx() {
  const repo = AppDataSource.getRepository(AuditContext);
  const all = await repo.find();
  const now = Date.now();
  for (const c of all) {
    if (c.lastInteraction && now - new Date(c.lastInteraction).getTime() > AUDIT_CONTEXT_TIMEOUT_MS) {
      await repo.remove(c);
    }
  }
}

// ---- Menus ----
function buildMenu(isAdmin: boolean) {
  const lines = [
    '📋 *Menú Principal*',
    '',
    '1️⃣  Abrir portón visitas 🚗',
    '2️⃣  Abrir portón peatonal 🚶',
    '3️⃣  Mostrar portón visitas 🖼️',
    '4️⃣  Mostrar portón peatonal 🖼️',
    '5️⃣  Estatus del sistema 📊',
  ];
  if (isAdmin) {
    lines.push('6️⃣  Gestión de usuarios 👤');
    lines.push('7️⃣  Auditoría 📜');
  lines.push('8️⃣  Blacklist 🚫');
  lines.push('9️⃣  Snapshot cámara frontal 🖼️');
  lines.push('🔟  Video 30s cámara frontal 🎥');
  }
  lines.push('', 'Responde con el número de la opción.');
  return lines.join('\n');
}
function buildUserAdminHelp() {
  return [
    '👤 *Gestión de Usuarios*',
    '',
    'Comandos:',
    '!usuario alta <numero> <nombre> <admin|normal>',
    '!usuario listar',
    '!usuario actualizar <numero> [nombre=Nuevo Nombre] [rol=admin|normal] [activo=true|false]',
    '!usuario borrar <numero>',
    '',
    'Blacklist:',
    '!blacklist listar',
    '!blacklist remover <numero>'
  ].join('\n');
}
function buildAuditMenu(ctx?: AuditContext) {
  const filterInfo = ctx?.filterNumeroWhatsapp ? ` (Filtro: ${ctx.filterNumeroWhatsapp})` : '';
  return [
    `📜 *Menú Auditoría*${filterInfo}`,
    '',
    '1️⃣  Últimos 10 mensajes',
    '2️⃣  Últimos 100 mensajes',
    '3️⃣  Últimos 200 mensajes',
    '4️⃣  Exportar CSV mensajes',
    '5️⃣  Volver al menú principal',
    '6️⃣  Establecer filtro por número',
    '7️⃣  Limpiar filtro',
    '8️⃣  Siguiente página (100)',
    '9️⃣  Reset paginación',
    '',
    'Envía el número de la opción.'
  ].join('\n');
}

// ---- Main handler ----
export async function handleIncomingMessage(client: Client, msg: Message) {
  audit('process_message', { from: msg.from, body: msg.body });
  const bodyTrim = msg.body.trim();
  const numero = msg.from.replace(/@c\.us$/, '');

  // Blacklist / attempt gating
  const blacklistRepo = AppDataSource.getRepository(Blacklist);
  const bl = await blacklistRepo.findOneBy({ numeroWhatsapp: numero });
  if (bl) return;
  const userRepo = AppDataSource.getRepository(Usuario);
  const attemptRepo = AppDataSource.getRepository(Attempt);
  let user = await userRepo.findOneBy({ numeroWhatsapp: numero });
  if (!user) {
    let attempt = await attemptRepo.findOneBy({ numeroWhatsapp: numero });
    if (!attempt) {
      attempt = attemptRepo.create({ numeroWhatsapp: numero, conteo: 1, ultimaActualizacion: new Date() as any });
    } else {
      attempt.conteo += 1;
      attempt.ultimaActualizacion = new Date() as any;
    }
    await attemptRepo.save(attempt);
    if (attempt.conteo >= ATTEMPT_THRESHOLD) {
      const newBl = blacklistRepo.create({ numeroWhatsapp: numero, activo: true });
      await blacklistRepo.save(newBl);
      await createAudit({ usuario: null, accion: 'blacklist_add', detalles: { numeroWhatsapp: numero, attempts: attempt.conteo } });
    } else {
      await createAudit({ usuario: null, accion: 'unregistered_attempt', detalles: { numeroWhatsapp: numero, attempt: attempt.conteo } });
    }
    return; // silencio para no revelar bot
  }
  const isAdmin = user.tipo === 'admin';

  const sendReply = async (text: string) => {
    const release = await globalMutex.lock();
    try {
      await client.sendMessage(msg.from, text);
    } finally {
      release();
    }
    try { await createAudit({ usuario: user, accion: 'msg_out', detalles: { body: text } }); } catch {}
  };

  if (bodyTrim === '!ping') {
    try { await createAudit({ usuario: user, accion: 'msg_in', detalles: { body: bodyTrim } }); } catch {}
    await client.sendMessage(msg.from, '🏓 pong');
    try { await createAudit({ usuario: user, accion: 'msg_out', detalles: { body: '🏓 pong' } }); } catch {}
    return;
  }

  // Log inbound
  try { await createAudit({ usuario: user, accion: 'msg_in', detalles: { body: bodyTrim } }); } catch {}

  // Audit context lifecycle
  await expireOldAuditCtx();
  const auditCtxRepo = AppDataSource.getRepository(AuditContext);
  let auditCtx = await auditCtxRepo.findOneBy({ adminNumeroWhatsapp: numero });
  if (auditCtx && auditCtx.lastInteraction && Date.now() - new Date(auditCtx.lastInteraction).getTime() > AUDIT_CONTEXT_TIMEOUT_MS) {
    await auditCtxRepo.remove(auditCtx);
    auditCtx = undefined as any;
  }

  // --- Global RESET command ---
  if (bodyTrim.toLowerCase() === 'reset') {
    try { if (auditCtx) await auditCtxRepo.remove(auditCtx); } catch {}
    blacklistMenuAdmins.delete(numero);
    blacklistRemovalAwait.delete(numero);
  userMenuAdmins.delete(numero);
  createUserStates.delete(numero);
  updateUserStates.delete(numero);
  deleteUserStates.delete(numero);
  searchUserStates.delete(numero);
  await sendReply('🔄 Contextos reiniciados. Escribe "menu" para ver opciones.');
    return;
  }

  // Audit filter input state
  if (auditCtx && auditCtx.awaitingFilter) {
    if (/^\d{8,15}$/.test(bodyTrim)) {
      await updateAuditCtx(auditCtx, { filterNumeroWhatsapp: bodyTrim, awaitingFilter: false, offset: 0 });
      await sendReply('✅ Filtro aplicado.');
      await sendReply(buildAuditMenu(auditCtx));
    } else if (bodyTrim === '0') {
      await updateAuditCtx(auditCtx, { awaitingFilter: false });
      await sendReply('Filtro cancelado.');
      await sendReply(buildAuditMenu(auditCtx));
    } else {
      await sendReply('Ingresa un número válido (8-15 dígitos) o 0 para cancelar.');
    }
    return;
  }

  // --- Blacklist removal awaiting state ---
  if (blacklistRemovalAwait.has(numero)) {
    if (!isAdmin) {
      blacklistRemovalAwait.delete(numero);
      blacklistMenuAdmins.delete(numero);
      await sendReply('⛔ No autorizado.');
      return;
    }
    if (bodyTrim === '0') {
      blacklistRemovalAwait.delete(numero);
      await sendReply('Operación cancelada.');
      await sendReply('*Menú Blacklist*\n1️⃣ Listar\n2️⃣ Remover número\n3️⃣ Volver');
      return;
    }
    if (/^\d{5,15}$/.test(bodyTrim)) {
      try {
        await removeFromBlacklist(bodyTrim);
        await sendReply('✅ Número removido (si existía)');
      } catch (e: any) {
        await sendReply('❌ Error removiendo: ' + (e.message || '')); 
      }
    } else {
      await sendReply('Formato inválido. Envía solo dígitos o 0 para cancelar.');
      return;
    }
    blacklistRemovalAwait.delete(numero);
    await sendReply('*Menú Blacklist*\n1️⃣ Listar\n2️⃣ Remover número\n3️⃣ Volver');
    return;
  }

  // --- User creation flow ---
  if (createUserStates.has(numero)) {
    if (!isAdmin) { createUserStates.delete(numero); userMenuAdmins.delete(numero); await sendReply('⛔ No autorizado.'); return; }
    const st = createUserStates.get(numero)!;
    const cancel = bodyTrim.toLowerCase() === 'cancelar' || bodyTrim === '0';
  if (cancel) { createUserStates.delete(numero); await sendReply('Operación cancelada.'); await sendReply('*Gestión Usuarios*\n1️⃣ Crear\n2️⃣ Listar\n3️⃣ Actualizar\n4️⃣ Borrar\n5️⃣ Buscar\n6️⃣ Volver'); return; }
    if (st.step === 1) {
      if (!/^\d{8,15}$/.test(bodyTrim)) { await sendReply('Número inválido. Debe tener 8-15 dígitos.'); return; }
      const existing = await AppDataSource.getRepository(Usuario).findOneBy({ numeroWhatsapp: bodyTrim });
      if (existing) { await sendReply('Ese número ya existe, ingresa otro.'); return; }
      st.numero = bodyTrim; st.step = 2; createUserStates.set(numero, st); await sendReply('📛 Ingresa el nombre de usuario:'); return;
    }
    if (st.step === 2) {
      if (bodyTrim.length < 2) { await sendReply('Nombre muy corto.'); return; }
      st.nombre = bodyTrim; st.step = 3; createUserStates.set(numero, st); await sendReply('👮 ¿Será usuario administrador? (si/no)'); return;
    }
    if (st.step === 3) {
      const ans = bodyTrim.toLowerCase();
      if (!['si','no','sí'].includes(ans)) { await sendReply('Responde si o no.'); return; }
      const tipo = (ans === 'si' || ans === 'sí') ? UserType.ADMIN : UserType.NORMAL;
      try { await createUserManual(st.numero!, st.nombre!, tipo); await sendReply('✅ Usuario creado.'); } catch(e:any){ await sendReply('❌ Error: '+ (e.message||'')); }
      createUserStates.delete(numero);
  await sendReply('*Gestión Usuarios*\n1️⃣ Crear\n2️⃣ Listar\n3️⃣ Actualizar\n4️⃣ Borrar\n5️⃣ Buscar\n6️⃣ Volver');
      return;
    }
  }

  // --- User update flow ---
  if (updateUserStates.has(numero)) {
    if (!isAdmin) { updateUserStates.delete(numero); userMenuAdmins.delete(numero); await sendReply('⛔ No autorizado.'); return; }
    const st = updateUserStates.get(numero)!;
    const cancel = bodyTrim.toLowerCase() === 'cancelar' || bodyTrim === '0';
  if (cancel) { updateUserStates.delete(numero); await sendReply('Operación cancelada.'); await sendReply('*Gestión Usuarios*\n1️⃣ Crear\n2️⃣ Listar\n3️⃣ Actualizar\n4️⃣ Borrar\n5️⃣ Buscar\n6️⃣ Volver'); return; }
    if (st.phase === 'askNumero') {
      if (!/^\d{8,15}$/.test(bodyTrim)) { await sendReply('Número inválido.'); return; }
      const existing = await AppDataSource.getRepository(Usuario).findOneBy({ numeroWhatsapp: bodyTrim });
      if (!existing) { await sendReply('No existe ese usuario. Ingresa otro o 0 para cancelar.'); return; }
      st.numero = bodyTrim; st.phase = 'attrMenu'; updateUserStates.set(numero, st);
      await sendReply('¿Qué deseas modificar?\n1️⃣ Nombre\n2️⃣ Rol\n3️⃣ Activo (toggle)\n4️⃣ Cancelar');
      return;
    }
    if (st.phase === 'attrMenu') {
      if (!/^[1-4]$/.test(bodyTrim)) { await sendReply('Selecciona 1-4.'); return; }
      const opt = parseInt(bodyTrim,10);
      if (opt === 5) { updateUserStates.delete(numero); await sendReply('Cancelado.'); await sendReply('*Gestión Usuarios*\n1️⃣ Crear\n2️⃣ Listar\n3️⃣ Actualizar\n4️⃣ Borrar\n5️⃣ Buscar\n6️⃣ Volver'); return; }
      if (opt === 1) { st.attr = 'nombre'; st.phase='attrValue'; updateUserStates.set(numero, st); await sendReply('Nuevo nombre:'); return; }
      if (opt === 2) { st.attr = 'rol'; st.phase='attrValue'; updateUserStates.set(numero, st); await sendReply('Nuevo rol (admin/normal):'); return; }
      if (opt === 3) { // toggle activo
        const repo = AppDataSource.getRepository(Usuario); const u = await repo.findOneBy({ numeroWhatsapp: st.numero! }); if (u){ await updateUser(u.numeroWhatsapp, { activo: !u.activo }); await sendReply(`Estado activo ahora: ${!u.activo}`); }
        updateUserStates.delete(numero); await sendReply('*Gestión Usuarios*\n1️⃣ Crear\n2️⃣ Listar\n3️⃣ Actualizar\n4️⃣ Borrar\n5️⃣ Buscar\n6️⃣ Volver'); return; }
      if (opt === 4) { st.attr='telefono'; st.phase='attrPhone'; updateUserStates.set(numero, st); await sendReply('Nuevo número (8-15 dígitos):'); return; }
    }
    if (st.phase === 'attrValue') {
      if (st.attr === 'nombre') {
        if (bodyTrim.length < 2) { await sendReply('Nombre muy corto.'); return; }
        await updateUser(st.numero!, { nombre: bodyTrim });
        await sendReply('Nombre actualizado.');
      } else if (st.attr === 'rol') {
        const v = bodyTrim.toLowerCase(); if (!['admin','normal'].includes(v)) { await sendReply('Valor inválido. Usa admin o normal.'); return; }
        await updateUser(st.numero!, { tipo: v === 'admin' ? UserType.ADMIN : UserType.NORMAL });
        await sendReply('Rol actualizado.');
      }
      updateUserStates.delete(numero);
      await sendReply('*Gestión Usuarios*\n1️⃣ Crear\n2️⃣ Listar\n3️⃣ Actualizar\n4️⃣ Borrar\n5️⃣ Buscar\n6️⃣ Volver');
      return;
    }
    if (st.phase === 'attrPhone') {
      if (!/^\d{8,15}$/.test(bodyTrim)) { await sendReply('Número inválido.'); return; }
      try { await updateUserPhone(st.numero!, bodyTrim); await sendReply('Número actualizado.'); } catch(e:any){ await sendReply('❌ Error: '+(e.message||'')); }
      updateUserStates.delete(numero);
      await sendReply('*Gestión Usuarios*\n1️⃣ Crear\n2️⃣ Listar\n3️⃣ Actualizar\n4️⃣ Borrar\n5️⃣ Buscar\n6️⃣ Volver');
      return;
    }
  }

  // --- User delete flow ---
  if (deleteUserStates.has(numero)) {
    if (!isAdmin) { deleteUserStates.delete(numero); userMenuAdmins.delete(numero); await sendReply('⛔ No autorizado.'); return; }
    const st = deleteUserStates.get(numero)!;
    const cancel = bodyTrim.toLowerCase() === 'cancelar' || bodyTrim === '0';
  if (cancel) { deleteUserStates.delete(numero); await sendReply('Operación cancelada.'); await sendReply('*Gestión Usuarios*\n1️⃣ Crear\n2️⃣ Listar\n3️⃣ Actualizar\n4️⃣ Borrar\n5️⃣ Buscar\n6️⃣ Volver'); return; }
    if (st.step === 1) {
      if (!/^\d{8,15}$/.test(bodyTrim)) { await sendReply('Número inválido.'); return; }
      const existing = await AppDataSource.getRepository(Usuario).findOneBy({ numeroWhatsapp: bodyTrim });
      if (!existing) { await sendReply('No existe ese usuario. Ingresa otro o 0 para cancelar.'); return; }
      st.numero = bodyTrim; st.step = 2; deleteUserStates.set(numero, st); await sendReply('Confirma eliminación (si/no):'); return;
    }
    if (st.step === 2) {
      const ans = bodyTrim.toLowerCase();
      if (!['si','no','sí'].includes(ans)) { await sendReply('Responde si o no.'); return; }
      if (ans === 'si' || ans === 'sí') {
        try { await deleteUser(st.numero!); await sendReply('✅ Usuario eliminado.'); } catch (e:any) { await sendReply('❌ Error: '+(e.message||'')); }
      } else { await sendReply('Eliminación cancelada.'); }
      deleteUserStates.delete(numero);
  await sendReply('*Gestión Usuarios*\n1️⃣ Crear\n2️⃣ Listar\n3️⃣ Actualizar\n4️⃣ Borrar\n5️⃣ Buscar\n6️⃣ Volver');
      return;
    }
  }

  // --- Blacklist interactive menu ---
  if (blacklistMenuAdmins.has(numero)) {
    if (!isAdmin) { // seguridad extra
      blacklistMenuAdmins.delete(numero);
      await sendReply('⛔ No autorizado.');
      return;
    }
    if (/^[123]$/.test(bodyTrim)) {
      const opt = parseInt(bodyTrim, 10);
      if (opt === 1) {
        const list = await listBlacklist();
        const lines = list.map(b => b.numeroWhatsapp + (b.activo ? '' : ' (inactivo)'));
        await sendReply(lines.length ? '*Blacklist*\n' + lines.join('\n') : 'Blacklist vacía');
      } else if (opt === 2) {
        blacklistRemovalAwait.add(numero);
        await sendReply('Envía el número a remover o 0 para cancelar.');
        return;
      } else if (opt === 3) {
        blacklistMenuAdmins.delete(numero);
        await sendReply(buildMenu(isAdmin));
        return;
      }
      // after 1 keep menu
      if (opt === 1) await sendReply('*Menú Blacklist*\n1️⃣ Listar\n2️⃣ Remover número\n3️⃣ Volver');
      return;
    } else {
      await sendReply('Opción inválida. Usa 1,2,3.');
      return;
    }
  }

  // Audit interactive numeric mode
  if (auditCtx && auditMenuActive.has(numero) && /^[1-9]$/.test(bodyTrim)) {
    const choice = parseInt(bodyTrim, 10);
    const auditRepo = AppDataSource.getRepository(Auditoria);
    const fetchLimit = 1500; // window
    const rows = await auditRepo.find({ order: { id: 'DESC' }, take: fetchLimit, relations: ['usuario'] });
    let filtered = rows.filter(r => r.accion === 'msg_in' || r.accion === 'msg_out');
    if (auditCtx?.filterNumeroWhatsapp) {
      const target = auditCtx.filterNumeroWhatsapp; // local to assure not null
      filtered = filtered.filter(r => r.usuario?.numeroWhatsapp === target);
    }
    const pageSize = 100;
    if (choice >=1 && choice <=3) {
      const mapChoice: Record<number, number> = {1:10,2:100,3:200};
      const slice = filtered.slice(0, mapChoice[choice]);
      const lines = slice.map(r => `${r.id} ${r.accion === 'msg_in' ? '>>' : '<<'} ${r.detalles?.body || ''}`);
      await sendReply(lines.join('\n') || 'Sin mensajes');
    } else if (choice === 4) {
      const header = 'id,tipo,numero,fecha,body';
      const csvLines = filtered.map(r => {
        const body = (r.detalles?.body || '').replace(/"/g,'""');
        return `${r.id},${r.accion},${r.usuario?.numeroWhatsapp || ''},${r.fechaHora.toISOString()},"${body}"`;
      });
      const csv = [header, ...csvLines].join('\n');
      const media = new MessageMedia('text/csv', Buffer.from(csv).toString('base64'), 'mensajes.csv');
      const release = await globalMutex.lock();
      try {
        await client.sendMessage(msg.from, media);
      } finally { release(); }
      try { await createAudit({ usuario: user, accion: 'msg_out', detalles: { body: '[CSV mensajes enviado]' } }); } catch {}
    } else if (choice === 5) {
      await auditCtxRepo.remove(auditCtx);
  auditMenuActive.delete(numero);
      await sendReply(buildMenu(isAdmin));
      return;
    } else if (choice === 6) {
      await updateAuditCtx(auditCtx, { awaitingFilter: true });
      await sendReply('Ingresa el número a filtrar (solo dígitos) o 0 para cancelar.');
    } else if (choice === 7) {
      await updateAuditCtx(auditCtx, { filterNumeroWhatsapp: null as any, offset: 0 });
      await sendReply('Filtro limpiado.');
    } else if (choice === 8) {
      const newOffset = (auditCtx.offset || 0) + pageSize;
      const page = filtered.slice(newOffset, newOffset + pageSize);
      if (!page.length) {
        await sendReply('No hay más páginas.');
      } else {
        await updateAuditCtx(auditCtx, { offset: newOffset });
        const lines = page.map(r => `${r.id} ${r.accion === 'msg_in' ? '>>' : '<<'} ${r.detalles?.body || ''}`);
        await sendReply(lines.join('\n'));
      }
    } else if (choice === 9) {
      await updateAuditCtx(auditCtx, { offset: 0 });
      await sendReply('Paginación reiniciada.');
    } else {
      await sendReply('Opción inválida.');
    }
    if (choice !==5) await sendReply(buildAuditMenu(auditCtx));
    return;
  }

  // User admin commands
  if (bodyTrim.startsWith('!usuario') && isAdmin) {
    const parts = bodyTrim.split(/\s+/).slice(1);
    const action = parts[0];
    try {
      if (action === 'alta') {
        const numeroNuevo = parts[1];
        const nombreNuevo = parts[2];
        const rol = parts[3];
        if (!numeroNuevo || !nombreNuevo || !rol) throw new Error('Uso: !usuario alta <numero> <nombre> <admin|normal>');
        const tipo = rol === 'admin' ? UserType.ADMIN : UserType.NORMAL;
        await createUserManual(numeroNuevo, nombreNuevo, tipo);
  const release2 = await globalMutex.lock();
  try { await client.sendMessage(msg.from, '✅ Usuario creado'); } finally { release2(); }
      } else if (action === 'listar') {
        const usuarios = await listUsers();
        const lines = usuarios.map(u => `${u.numeroWhatsapp} | ${u.nombre} | ${u.tipo} | ${u.activo ? 'activo' : 'inactivo'}`);
  const release3 = await globalMutex.lock();
  try { await client.sendMessage(msg.from, lines.length ? lines.join('\n') : 'No hay usuarios'); } finally { release3(); }
      } else if (action === 'actualizar') {
        const numeroTarget = parts[1];
        if (!numeroTarget) throw new Error('Uso: !usuario actualizar <numero> [nombre=..] [rol=admin|normal] [activo=true|false]');
        const updates: any = {};
        for (const token of parts.slice(2)) {
          const [k, v] = token.split('=');
          if (k === 'nombre') updates.nombre = v;
          if (k === 'rol') updates.tipo = v === 'admin' ? UserType.ADMIN : UserType.NORMAL;
          if (k === 'activo') updates.activo = v === 'true';
        }
        await updateUser(numeroTarget, updates);
  const release4 = await globalMutex.lock();
  try { await client.sendMessage(msg.from, '✅ Usuario actualizado'); } finally { release4(); }
      } else if (action === 'borrar') {
        const numeroTarget = parts[1];
        if (!numeroTarget) throw new Error('Uso: !usuario borrar <numero>');
        await deleteUser(numeroTarget);
  const release5 = await globalMutex.lock();
  try { await client.sendMessage(msg.from, '✅ Usuario borrado'); } finally { release5(); }
      } else {
  const release6 = await globalMutex.lock();
  try { await client.sendMessage(msg.from, buildUserAdminHelp()); } finally { release6(); }
      }
    } catch (e: any) {
  const releaseErr = await globalMutex.lock();
  try { await client.sendMessage(msg.from, `❌ ${e.message}`); } finally { releaseErr(); }
    }
    return;
  }

  // Blacklist commands
  if (bodyTrim.startsWith('!blacklist') && isAdmin) {
    const parts = bodyTrim.split(/\s+/).slice(1);
    const action = parts[0];
    try {
      if (action === 'listar') {
        const list = await listBlacklist();
        const lines = list.map(b => b.numeroWhatsapp);
  const release7 = await globalMutex.lock();
  try { await client.sendMessage(msg.from, lines.length ? '*Blacklist*\n' + lines.join('\n') : 'Blacklist vacía'); } finally { release7(); }
      } else if (action === 'remover') {
        const numeroTarget = parts[1];
        if (!numeroTarget) throw new Error('Uso: !blacklist remover <numero>');
        await removeFromBlacklist(numeroTarget);
  const release8 = await globalMutex.lock();
  try { await client.sendMessage(msg.from, '✅ Número removido del blacklist'); } finally { release8(); }
      } else {
  const release9 = await globalMutex.lock();
  try { await client.sendMessage(msg.from, 'Comandos: !blacklist listar | !blacklist remover <numero>'); } finally { release9(); }
      }
    } catch (e: any) {
      await client.sendMessage(msg.from, `❌ ${e.message}`);
    }
    return;
  }

  // Menu trigger
  if (MENU_TRIGGER_REGEX.test(bodyTrim)) {
    // Al abrir menú principal limpiamos contextos secundarios para evitar confusión
    if (auditCtx) {
      const repo = AppDataSource.getRepository(AuditContext);
      try { await repo.remove(auditCtx); } catch {}
    }
    blacklistMenuAdmins.delete(numero);
    blacklistRemovalAwait.delete(numero);
  userMenuAdmins.delete(numero);
  createUserStates.delete(numero);
  updateUserStates.delete(numero);
  deleteUserStates.delete(numero);
  searchUserStates.delete(numero);
  auditMenuActive.delete(numero);
    await sendReply(buildMenu(isAdmin));
    return;
  }

  // Main numeric menu (solo si NO estamos en submenús/flows)
  const inAnyUserFlow = userMenuAdmins.has(numero) || createUserStates.has(numero) || updateUserStates.has(numero) || deleteUserStates.has(numero) || searchUserStates.has(numero);
  const inBlacklistFlow = blacklistMenuAdmins.has(numero) || blacklistRemovalAwait.has(numero);
  const inAuditFlow = auditMenuActive.has(numero) || (auditCtx && auditCtx.awaitingFilter);
  if (!inAnyUserFlow && !inBlacklistFlow && !inAuditFlow && /^([1-9]|10)$/.test(bodyTrim)) {
    const option = parseInt(bodyTrim, 10);
    switch (option) {
      case 1: {
  const releaseOpen = await globalMutex.lock();
  try { await client.sendMessage(msg.from, '🚗 Solicitando apertura de portón de visitas...'); } finally { releaseOpen(); }
        const res = await openDoor('visits');
  const releaseOpen2 = await globalMutex.lock();
  try { await client.sendMessage(msg.from, res.ok ? '✅ Apertura de visitas procesada.' : res.message); } finally { releaseOpen2(); }
        return; }
      case 2: {
  const releaseOpen3 = await globalMutex.lock();
  try { await client.sendMessage(msg.from, '🚶 Solicitando apertura de portón peatonal...'); } finally { releaseOpen3(); }
        const res = await openDoor('pedestrian');
  const releaseOpen4 = await globalMutex.lock();
  try { await client.sendMessage(msg.from, res.ok ? '✅ Apertura peatonal procesada.' : res.message); } finally { releaseOpen4(); }
        return; }
      case 3: {
  const releaseSnapStart = await globalMutex.lock();
  try { await client.sendMessage(msg.from, '🖼️ Capturando imagen del portón de visitas...'); } finally { releaseSnapStart(); }
        const snap = await getGateSnapshot('visits');
        if (snap.ok && snap.buffer) {
          const media = new MessageMedia('image/jpeg', snap.buffer.toString('base64'), 'visitas.jpg');
          const releaseSnapSend = await globalMutex.lock();
          try { await client.sendMessage(msg.from, media, { caption: 'Portón visitas' }); } finally { releaseSnapSend(); }
        } else {
          const releaseSnapFail = await globalMutex.lock();
          try { await client.sendMessage(msg.from, snap.message || '❌ No se obtuvo imagen.'); } finally { releaseSnapFail(); }
        }
        return; }
      case 4: {
  const releaseSnapStart2 = await globalMutex.lock();
  try { await client.sendMessage(msg.from, '🖼️ Capturando imagen del portón peatonal...'); } finally { releaseSnapStart2(); }
        const snap = await getGateSnapshot('pedestrian');
        if (snap.ok && snap.buffer) {
          const media = new MessageMedia('image/jpeg', snap.buffer.toString('base64'), 'peatonal.jpg');
          const releaseSnapSend2 = await globalMutex.lock();
          try { await client.sendMessage(msg.from, media, { caption: 'Portón peatonal' }); } finally { releaseSnapSend2(); }
        } else {
          const releaseSnapFail2 = await globalMutex.lock();
          try { await client.sendMessage(msg.from, snap.message || '❌ No se obtuvo imagen.'); } finally { releaseSnapFail2(); }
        }
        return; }
      case 5: {
        const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
        const uptime = Math.floor(process.uptime());
        await sendReply(`📊 *Estatus del sistema*\n🕒 Uptime: ${uptime}s\n🧠 Memoria RSS: ${mem} MB`);
        return; }
      case 6:
        if (!isAdmin) { await sendReply('⛔ No autorizado.'); return; }
  userMenuAdmins.add(numero);
  await sendReply('*Gestión Usuarios*\n1️⃣ Crear\n2️⃣ Listar\n3️⃣ Actualizar\n4️⃣ Borrar\n5️⃣ Buscar\n6️⃣ Volver');
        return;
      case 7:
        if (!isAdmin) { await sendReply('⛔ No autorizado.'); return; }
        auditCtx = await getOrCreateAuditCtx(numero);
  auditMenuActive.add(numero);
        await sendReply(buildAuditMenu(auditCtx));
        return;
      case 8:
        if (!isAdmin) { await sendReply('⛔ No autorizado.'); return; }
        blacklistMenuAdmins.add(numero);
        await sendReply('*Menú Blacklist*\n1️⃣ Listar\n2️⃣ Remover número\n3️⃣ Volver');
        return;
      case 9: {
        if (!isAdmin) { await sendReply('⛔ No autorizado.'); return; }
        const rel1 = await globalMutex.lock();
        try { await client.sendMessage(msg.from, '🖼️ Capturando imagen de cámara frontal...'); } finally { rel1(); }
        const snap = await getFrontDoorSnapshot();
        if (snap.ok && snap.buffer) {
          const media = new MessageMedia('image/jpeg', snap.buffer.toString('base64'), 'front-door.jpg');
          const rel2 = await globalMutex.lock();
          try { await client.sendMessage(msg.from, media, { caption: 'Cámara frontal' }); } finally { rel2(); }
        } else {
          await sendReply(snap.message || '❌ No se obtuvo imagen.');
        }
        return; }
      case 10: {
        if (!isAdmin) { await sendReply('⛔ No autorizado.'); return; }
        const rel3 = await globalMutex.lock();
        try { await client.sendMessage(msg.from, '🎥 Grabando clip de 30s de la cámara frontal, espera...'); } finally { rel3(); }
        try {
          const clip = await getFrontDoorClip(30);
          if (clip.ok && clip.buffer) {
            const media = new MessageMedia('video/mp4', clip.buffer.toString('base64'), 'front-door-30s.mp4');
            const rel4 = await globalMutex.lock();
            try {
              await client.sendMessage(msg.from, media, { sendMediaAsDocument: true, caption: 'Cámara frontal (30s)' });
            } finally { rel4(); }
          } else {
            await sendReply(clip.message || '❌ No se pudo generar el video.');
          }
        } catch (e:any) {
          await sendReply('❌ Falló el envío del video. Intentaré con menor calidad.');
          const clip2 = await getFrontDoorClip(20);
          if (clip2.ok && clip2.buffer) {
            const media2 = new MessageMedia('video/mp4', clip2.buffer.toString('base64'), 'front-door.mp4');
            const rel5 = await globalMutex.lock();
            try { await client.sendMessage(msg.from, media2, { sendMediaAsDocument: true, caption: 'Cámara frontal' }); } finally { rel5(); }
          } else {
            await sendReply(clip2.message || '❌ No se pudo enviar el video.');
          }
        }
        return; }
    }
  }

  // --- User management menu numeric handling ---
  if (userMenuAdmins.has(numero)) {
    if (!isAdmin) { userMenuAdmins.delete(numero); await sendReply('⛔ No autorizado.'); return; }
    // búsqueda en curso
    if (searchUserStates.has(numero)) {
      if (bodyTrim === '0' || bodyTrim.toLowerCase() === 'cancelar') { searchUserStates.delete(numero); await sendReply('Búsqueda cancelada.'); await sendReply('*Gestión Usuarios*\n1️⃣ Crear\n2️⃣ Listar\n3️⃣ Actualizar\n4️⃣ Borrar\n5️⃣ Buscar\n6️⃣ Volver'); return; }
      const results = await searchUsers(bodyTrim);
      const lines = results.map(u => `${u.numeroWhatsapp} | ${u.nombre} | ${u.tipo} | ${u.activo?'activo':'inactivo'}`);
      await sendReply(lines.length? lines.join('\n') : 'Sin coincidencias');
      searchUserStates.delete(numero);
      await sendReply('*Gestión Usuarios*\n1️⃣ Crear\n2️⃣ Listar\n3️⃣ Actualizar\n4️⃣ Borrar\n5️⃣ Buscar\n6️⃣ Volver');
      return;
    }
    if (/^[1-6]$/.test(bodyTrim)) {
      const opt = parseInt(bodyTrim,10);
      switch(opt){
        case 1:
          createUserStates.set(numero, { step:1 });
          await sendReply('📞 Ingresa el número de teléfono (solo dígitos) o 0 para cancelar:');
          return;
        case 2: {
          const usuarios = await listUsers();
          const lines = usuarios.map(u => `${u.numeroWhatsapp} | ${u.nombre} | ${u.tipo} | ${u.activo?'activo':'inactivo'}`);
          await sendReply(lines.length? lines.join('\n') : 'No hay usuarios');
          await sendReply('*Gestión Usuarios*\n1️⃣ Crear\n2️⃣ Listar\n3️⃣ Actualizar\n4️⃣ Borrar\n5️⃣ Buscar\n6️⃣ Volver');
          return; }
        case 3:
          updateUserStates.set(numero, { phase:'askNumero' });
          await sendReply('Ingresa el número del usuario a actualizar o 0 para cancelar:');
          return;
        case 4:
          deleteUserStates.set(numero, { step:1 });
          await sendReply('Ingresa el número del usuario a borrar o 0 para cancelar:');
          return;
        case 5:
          searchUserStates.set(numero, { phase:'askQuery' });
          await sendReply('🔍 Ingresa texto / número a buscar (0 cancelar):');
          return;
        case 6:
          userMenuAdmins.delete(numero);
          await sendReply(buildMenu(isAdmin));
          return;
      }
    } else {
      // If it's part of ongoing sub-flows they are handled earlier; else invalid option
      if (!createUserStates.has(numero) && !updateUserStates.has(numero) && !deleteUserStates.has(numero) && !searchUserStates.has(numero)) {
        await sendReply('Opción inválida. Usa 1-6.');
      }
      return;
    }
  }
}

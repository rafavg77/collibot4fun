import { AppDataSource } from '../database';
import { Usuario, UserType, Blacklist } from '../database/models';
import { createAudit } from './auditService';

export async function findOrCreateUser(numeroWhatsapp: string, nombre: string, tipo: UserType = UserType.NORMAL) {
  const repo = AppDataSource.getRepository(Usuario);
  let user = await repo.findOneBy({ numeroWhatsapp });
  if (!user) {
    user = repo.create({ numeroWhatsapp, nombre, tipo });
    await repo.save(user);
    await createAudit({ usuario: user, accion: 'user_create', detalles: { numeroWhatsapp, nombre, tipo } });
  }
  return user;
}

export async function listUsers(): Promise<Usuario[]> {
  return AppDataSource.getRepository(Usuario).find();
}

export async function createUserManual(numeroWhatsapp: string, nombre: string, tipo: UserType) {
  const repo = AppDataSource.getRepository(Usuario);
  const existing = await repo.findOneBy({ numeroWhatsapp });
  if (existing) throw new Error('Usuario ya existe');
  const user = repo.create({ numeroWhatsapp, nombre, tipo });
  await repo.save(user);
  await createAudit({ usuario: user, accion: 'user_create_manual', detalles: { numeroWhatsapp, nombre, tipo } });
  return user;
}

export async function updateUser(numeroWhatsapp: string, data: Partial<{ nombre: string; tipo: UserType; activo: boolean }>) {
  const repo = AppDataSource.getRepository(Usuario);
  const user = await repo.findOneBy({ numeroWhatsapp });
  if (!user) throw new Error('Usuario no encontrado');
  const before = { nombre: user.nombre, tipo: user.tipo, activo: user.activo };
  if (data.nombre !== undefined) user.nombre = data.nombre;
  if (data.tipo !== undefined) user.tipo = data.tipo;
  if (data.activo !== undefined) user.activo = data.activo;
  await repo.save(user);
  await createAudit({ usuario: user, accion: 'user_update', detalles: { before, after: data } });
  return user;
}

export async function updateUserPhone(oldNumero: string, newNumero: string) {
  const repo = AppDataSource.getRepository(Usuario);
  const existingNew = await repo.findOneBy({ numeroWhatsapp: newNumero });
  if (existingNew) throw new Error('El nuevo número ya existe');
  const user = await repo.findOneBy({ numeroWhatsapp: oldNumero });
  if (!user) throw new Error('Usuario no encontrado');
  const before = { numeroWhatsapp: oldNumero };
  user.numeroWhatsapp = newNumero;
  await repo.save(user);
  await createAudit({ usuario: user, accion: 'user_update_phone', detalles: { before, after: { numeroWhatsapp: newNumero } } });
  return user;
}

export async function searchUsers(query: string): Promise<Usuario[]> {
  const repo = AppDataSource.getRepository(Usuario);
  // naive search (SQLite) using LIKE for nombre or exact for número
  return repo.createQueryBuilder('u')
    .where('u.numeroWhatsapp LIKE :q', { q: `%${query}%` })
    .orWhere('u.nombre LIKE :q', { q: `%${query}%` })
    .getMany();
}

export async function deleteUser(numeroWhatsapp: string) {
  const repo = AppDataSource.getRepository(Usuario);
  const user = await repo.findOneBy({ numeroWhatsapp });
  if (!user) throw new Error('Usuario no encontrado');
  await repo.remove(user);
  await createAudit({ usuario: user, accion: 'user_delete', detalles: { numeroWhatsapp } });
}

export async function listBlacklist(): Promise<Blacklist[]> {
  return AppDataSource.getRepository(Blacklist).find();
}

export async function removeFromBlacklist(numeroWhatsapp: string) {
  const repo = AppDataSource.getRepository(Blacklist);
  const item = await repo.findOneBy({ numeroWhatsapp });
  if (!item) throw new Error('Número no está en blacklist');
  await repo.remove(item);
  await createAudit({ usuario: null, accion: 'blacklist_remove', detalles: { numeroWhatsapp } });
}

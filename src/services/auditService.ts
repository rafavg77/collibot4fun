import { AppDataSource } from '../database';
import { Auditoria, Usuario } from '../database/models';

export async function createAudit(options: { usuario?: Usuario | null; accion: string; detalles?: any }) {
  const repo = AppDataSource.getRepository(Auditoria);
  await repo.save(repo.create({ usuario: (options.usuario as any) || null, accion: options.accion, detalles: options.detalles }));
}

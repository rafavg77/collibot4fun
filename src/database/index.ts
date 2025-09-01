import { DataSource } from 'typeorm';
import { Usuario, Auditoria, Blacklist, Attempt, AuditContext } from './models';
import { ENV } from '../config';

export const AppDataSource = new DataSource({
  type: 'sqlite',
  database: ENV.DB_PATH,
  entities: [Usuario, Auditoria, Blacklist, Attempt, AuditContext],
  synchronize: true, // crea tablas automáticamente
  logging: false,
});

export async function initDatabase() {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }
}

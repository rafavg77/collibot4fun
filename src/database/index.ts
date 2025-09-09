import { DataSource } from 'typeorm';
import { Usuario, Auditoria, Blacklist, Attempt, AuditContext } from './models';
import { ENV } from '../config';
import fs from 'fs';
import { audit } from '../utils/logger';
import path from 'path';

export const AppDataSource = new DataSource({
  type: 'sqlite',
  database: ENV.DB_PATH,
  entities: [Usuario, Auditoria, Blacklist, Attempt, AuditContext],
  synchronize: true, // crea tablas automáticamente
  logging: false,
});

export async function initDatabase() {
  // Defensive: ensure parent dir and DB file exist and are writable before TypeORM touches it.
  const dbPath = ENV.DB_PATH;
  try {
    const parent = path.dirname(dbPath);
    try {
      // runtime identity info for easier debugging in container logs
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      const gid = typeof process.getgid === 'function' ? process.getgid() : null;
  audit('db_runtime_ident', { uid, gid, dbPath });
    } catch (e) {
  audit('db_runtime_ident_failed');
    }
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
  audit('db_parent_dir_created', { parent });
    }
    if (!fs.existsSync(dbPath)) {
      // create an empty sqlite file so the process (running as non-root) can open it
      try {
        fs.writeFileSync(dbPath, '');
  audit('db_file_created', { dbPath });
      } catch (e) {
  audit('db_file_create_failed', { dbPath, error: (e as any)?.message || String(e) });
      }
    }
    // try to ensure we have read/write access and surface file stats
    try {
      fs.chmodSync(dbPath, 0o660);
    } catch {}
    try {
      const st = fs.statSync(dbPath);
  audit('db_file_stat', { uid: st.uid, gid: st.gid, mode: (st.mode & 0o777).toString(8), size: st.size });
    } catch (e) {
  audit('db_stat_failed', { dbPath, error: (e as any)?.message || String(e) });
    }

    try {
      fs.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (err) {
      // attempt an explicit open to surface the OS error code
      try {
        const fd = fs.openSync(dbPath, 'r+');
        fs.closeSync(fd);
      } catch (openErr) {
        throw new Error(`DB file not accessible (R/W): ${dbPath} - open error: ${(openErr as any)?.message || openErr}`);
      }
    }
  } catch (e) {
    // If this fails, surface a clear message but still attempt initialize; TypeORM will provide its own error.
  audit('db_preinit_failed', { error: (e as any)?.message || String(e) });
  }

  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }
}

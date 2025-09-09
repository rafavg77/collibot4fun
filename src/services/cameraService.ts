import { spawn } from 'child_process';
import { ENV } from '../config';
import { globalMutex } from '../utils/concurrency';

const SNAP_TIMEOUT_MS = 15_000; // 15s para intentar obtener frame

export type GateKind = 'visits' | 'pedestrian';

export interface SnapshotResult {
  ok: boolean;
  buffer?: Buffer;
  message: string;
}

function rtspUrl(kind: GateKind): string {
  return kind === 'visits' ? ENV.RTSP_VISITS_URL : ENV.RTSP_PEDESTRIAN_URL;
}

export async function getGateSnapshot(kind: GateKind): Promise<SnapshotResult> {
  const release = await globalMutex.lock();
  try {
    const url = rtspUrl(kind);
    return await new Promise((resolve) => {
      const args = [
        '-rtsp_transport', 'tcp',
        '-i', url,
        '-frames:v', '1',
        '-q:v', '2',
        '-f', 'image2',
        'pipe:1'
      ];
      let stdoutChunks: Buffer[] = [];
      let stderrData = '';
      let finished = false;
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      const timeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        proc.kill('SIGKILL');
        resolve({ ok: false, message: '⏱️ Tiempo agotado capturando imagen.' });
      }, SNAP_TIMEOUT_MS);

      proc.stdout.on('data', (d: Buffer) => stdoutChunks.push(d));
      proc.stderr.on('data', (d: Buffer) => {
        // Guardar algo de stderr para debug (limitado)
        if (stderrData.length < 2000) stderrData += d.toString();
      });
      proc.on('error', (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve({ ok: false, message: `❌ Error ejecutando ffmpeg: ${err.message}` });
      });
      proc.on('close', (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (code === 0 && stdoutChunks.length) {
          const buffer = Buffer.concat(stdoutChunks);
          resolve({ ok: true, buffer, message: 'OK' });
        } else {
          resolve({ ok: false, message: '❌ No se pudo capturar imagen.' });
        }
      });
    });
  } finally {
    release();
  }
}

import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ENV } from '../config';
import { globalMutex } from '../utils/concurrency';

const SNAP_TIMEOUT_MS = 15_000; // 15s para intentar obtener frame
const CLIP_TIMEOUT_MS = 40_000; // 30s de video + margen

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

export async function getFrontDoorSnapshot(): Promise<SnapshotResult> {
  const release = await globalMutex.lock();
  try {
    const url = ENV.RTSP_FRONT_DOOR_URL;
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
      let finished = false;
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const timeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        proc.kill('SIGKILL');
        resolve({ ok: false, message: '⏱️ Tiempo agotado capturando imagen.' });
      }, SNAP_TIMEOUT_MS);
      proc.stdout.on('data', (d: Buffer) => stdoutChunks.push(d));
      proc.on('error', (err) => {
        if (finished) return; finished = true; clearTimeout(timeout);
        resolve({ ok: false, message: `❌ Error ejecutando ffmpeg: ${err.message}` });
      });
      proc.on('close', (code) => {
        if (finished) return; finished = true; clearTimeout(timeout);
        if (code === 0 && stdoutChunks.length) {
          resolve({ ok: true, buffer: Buffer.concat(stdoutChunks), message: 'OK' });
        } else {
          resolve({ ok: false, message: '❌ No se pudo capturar imagen.' });
        }
      });
    });
  } finally {
    release();
  }
}

export interface ClipResult {
  ok: boolean;
  buffer?: Buffer;
  message: string;
}

export async function getFrontDoorClip(seconds = 30): Promise<ClipResult> {
  const release = await globalMutex.lock();
  try {
    const url = ENV.RTSP_FRONT_DOOR_URL;
    const tmpBase = mkdtempSync(join(tmpdir(), 'front-clip-'));
    const outPath = join(tmpBase, 'clip.mp4');
    return await new Promise((resolve) => {
      const args = [
        '-rtsp_transport', 'tcp',
        '-i', url,
        '-t', String(seconds),
        // reduce resolution and fps to keep size small
        '-vf', 'scale=640:-2,fps=15',
        '-c:v', 'libx264',
        '-profile:v', 'baseline',
        '-level', '3.0',
        '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast',
        '-crf', '30',
        // cap bitrate and size as extra safety
        '-maxrate', '600k',
        '-bufsize', '1200k',
        '-fs', String(6 * 1024 * 1024),
        '-an',
        // write moov at the start for fast start streaming
        '-movflags', '+faststart',
        outPath
      ];
      let finished = false;
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      const timeout = setTimeout(() => {
        if (finished) return; finished = true; proc.kill('SIGKILL');
        try { unlinkSync(outPath); } catch {}
        resolve({ ok: false, message: '⏱️ Tiempo agotado grabando clip.' });
      }, Math.max(CLIP_TIMEOUT_MS, (seconds + 8) * 1000));
      proc.on('error', (err) => {
        if (finished) return; finished = true; clearTimeout(timeout);
        try { unlinkSync(outPath); } catch {}
        resolve({ ok: false, message: `❌ Error ejecutando ffmpeg: ${err.message}` });
      });
      proc.on('close', (code) => {
        if (finished) return; finished = true; clearTimeout(timeout);
        if (code === 0) {
          try {
            const data = readFileSync(outPath);
            try { unlinkSync(outPath); } catch {}
            resolve({ ok: true, buffer: data, message: 'OK' });
          } catch (e:any) {
            try { unlinkSync(outPath); } catch {}
            resolve({ ok: false, message: '❌ No se pudo leer el clip.' });
          }
        } else {
          try { unlinkSync(outPath); } catch {}
          resolve({ ok: false, message: '❌ No se pudo grabar clip.' });
        }
      });
    });
  } finally {
    release();
  }
}

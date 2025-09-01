import axios from 'axios';
import { ENV } from '../config';

const TIMEOUT_MS = 60_000; // 60 segundos

const baseURL = () => ENV.DOOR_API_BASE;

export type DoorKind = 'visits' | 'pedestrian';

export interface DoorOpenResult {
  ok: boolean;
  message: string;
  raw?: any;
}

export async function openDoor(kind: DoorKind): Promise<DoorOpenResult> {
  const url = `${baseURL()}/open-door/${kind}`;
  try {
    const resp = await axios.post(url, {}, { timeout: TIMEOUT_MS, headers: { accept: 'application/json' } });
    const msg: string | undefined = resp.data?.message;
    const expectedFrag = kind === 'pedestrian' ? 'AccessType.PEDESTRIAN' : 'AccessType.VISITS';
    const ok = !!msg && msg.includes(expectedFrag);
    return { ok, message: msg || 'Respuesta sin mensaje', raw: resp.data };
  } catch (err: any) {
    if (err?.code === 'ECONNABORTED') {
      return { ok: false, message: '⏱️ Tiempo de espera agotado al solicitar apertura.' };
    }
    return { ok: false, message: `❌ Error solicitando apertura: ${err?.message || err}` };
  }
}

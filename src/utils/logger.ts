// Simple console logger with ISO timestamps and levels
type ConsoleMethod = (...args: any[]) => void;

function stamp(level: string, args: any[]) {
  const ts = new Date().toISOString();
  // Join message parts in a compact, readable way
  const parts = args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  });
  return `[${ts}] [${level}] ${parts.join(' ')}`;
}

export function installConsoleTimestampPrefix() {
  const origLog: ConsoleMethod = console.log.bind(console);
  const origInfo: ConsoleMethod = console.info?.bind(console) || origLog;
  const origWarn: ConsoleMethod = console.warn.bind(console);
  const origError: ConsoleMethod = console.error.bind(console);

  console.log = (...args: any[]) => origLog(stamp('INFO', args));
  console.info = (...args: any[]) => origInfo(stamp('INFO', args));
  console.warn = (...args: any[]) => origWarn(stamp('WARN', args));
  console.error = (...args: any[]) => origError(stamp('ERROR', args));
}

// Prefix each stdout/stderr line with timestamp + level. Helps when libraries write directly to stdout.
export function installStdIoLinePrefix() {
  const wrap = (orig: any, level: 'INFO'|'ERROR') => {
    let carry = '';
    return (chunk: any, encoding?: any, cb?: any) => {
      try {
        const str = Buffer.isBuffer(chunk) ? chunk.toString(encoding || 'utf8') : String(chunk);
        carry += str;
        const lines = carry.split(/\r?\n/);
        carry = lines.pop() || '';
        for (const line of lines) {
          // Avoid double prefix if already starts with [YYYY-...]
          const prefixed = /^\[\d{4}-\d{2}-\d{2}T/.test(line) ? line : `[${new Date().toISOString()}] [${level}] ${line}`;
          orig.call(process.stdout, prefixed + '\n');
        }
        if (typeof cb === 'function') cb();
      } catch (e) {
        try { orig.call(process.stdout, chunk, encoding, cb); } catch {}
      }
      return true;
    };
  };
  // @ts-ignore
  if (!(process as any).__stdout_wrapped) {
    // @ts-ignore
    (process as any).__stdout_wrapped = true;
    const oStdout = process.stdout.write.bind(process.stdout);
    const oStderr = process.stderr.write.bind(process.stderr);
    // @ts-ignore
    process.stdout.write = wrap(oStdout, 'INFO');
    // @ts-ignore
    process.stderr.write = wrap(oStderr, 'ERROR');
  }
}

// Optional helper for explicit audit events
export function audit(event: string, details?: Record<string, any>) {
  const ts = new Date().toISOString();
  const payload = details ? ` ${JSON.stringify(details)}` : '';
  console.log(`[AUDIT] ${event}${payload} @ ${ts}`);
}

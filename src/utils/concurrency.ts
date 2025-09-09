// Utilidad para manejar concurrencia básica en Node.js
// Puedes expandir esto según las necesidades del bot

export class Mutex {
  private _locked = false;
  private _waiters: Array<() => void> = [];

  /**
   * Acquires the mutex and returns an unlock function.
   * Usage:
   * const release = await mutex.lock();
   * try { ... } finally { release(); }
   */
  async lock(): Promise<() => void> {
    return new Promise<() => void>(resolve => {
      const unlock = () => {
        const next = this._waiters.shift();
        if (next) {
          // hand off lock to next waiter
          next();
        } else {
          this._locked = false;
        }
      };

      const waiter = () => resolve(unlock);

      if (this._locked) {
        this._waiters.push(waiter);
      } else {
        this._locked = true;
        waiter();
      }
    });
  }
}

// Export a singleton mutex to protect shared resources (puppeteer, session, ffmpeg, sendMessage)
export const globalMutex = new Mutex();

// Utilidad para manejar concurrencia básica en Node.js
// Puedes expandir esto según las necesidades del bot

export class Mutex {
  private mutex = Promise.resolve();

  lock(): PromiseLike<() => void> {
    let begin: (unlock: () => void) => void = unlock => {};
    this.mutex = this.mutex.then(() => {
      return new Promise(begin);
    });
    return new Promise(res => {
      begin = res;
    });
  }
}

export class SseClientRegistry {
  #clients = new Set();

  constructor({
    maxClients = 16,
    maxBufferedBytes = 1_048_576,
    drainTimeoutMs = 5_000,
    onEvict = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.maxClients = requirePositiveInteger(maxClients, 'maxClients');
    this.maxBufferedBytes = requirePositiveInteger(maxBufferedBytes, 'maxBufferedBytes');
    this.drainTimeoutMs = requirePositiveInteger(drainTimeoutMs, 'drainTimeoutMs');
    this.onEvict = onEvict;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  get size() {
    return this.#clients.size;
  }

  add(request, response) {
    if (this.#clients.size >= this.maxClients) return null;

    const client = {
      request,
      response,
      blocked: false,
      closed: false,
      drainTimer: null,
      onClose: null,
      onDrain: null,
      onError: null,
    };
    client.onClose = () => this.#remove(client);
    client.onDrain = () => this.#handleDrain(client);
    client.onError = () => this.#remove(client);

    request.once('close', client.onClose);
    response.once('close', client.onClose);
    response.once('error', client.onError);
    response.on('drain', client.onDrain);
    this.#clients.add(client);
    return client;
  }

  write(client, frame) {
    if (!this.#clients.has(client) || client.closed || client.blocked) return false;
    if (client.response.destroyed || client.response.writableEnded) {
      this.#remove(client);
      return false;
    }

    const frameBytes = Buffer.byteLength(frame);
    const bufferedBytes = writableLength(client.response);
    if (frameBytes > this.maxBufferedBytes
        || bufferedBytes > this.maxBufferedBytes - frameBytes) {
      this.#evict(client, 'buffer-limit');
      return false;
    }

    try {
      const canContinue = client.response.write(frame);
      if (writableLength(client.response) > this.maxBufferedBytes) {
        this.#evict(client, 'buffer-limit');
        return false;
      }
      if (!canContinue) {
        this.#markBlocked(client);
        return false;
      }
      return true;
    } catch {
      this.#evict(client, 'write-error');
      return false;
    }
  }

  broadcast(frame) {
    for (const client of [...this.#clients]) {
      this.write(client, frame);
    }
  }

  closeAll() {
    for (const client of [...this.#clients]) {
      const { response, blocked } = client;
      this.#remove(client);
      if (response.destroyed || response.writableEnded) continue;
      try {
        if (blocked) {
          response.destroy();
        } else {
          response.end();
        }
      } catch {
        if (!response.destroyed) response.destroy();
      }
    }
  }

  #markBlocked(client) {
    if (!this.#clients.has(client) || client.blocked) return;
    client.blocked = true;
    client.drainTimer = this.setTimer(() => {
      this.#evict(client, 'drain-timeout');
    }, this.drainTimeoutMs);
    client.drainTimer?.unref?.();
  }

  #handleDrain(client) {
    if (!this.#clients.has(client) || !client.blocked) return;
    this.#clearDrainTimer(client);
    client.blocked = false;
  }

  #evict(client, reason) {
    if (!this.#clients.has(client)) return;
    const { response } = client;
    this.#remove(client);
    if (!response.destroyed) response.destroy();
    try {
      this.onEvict({ reason });
    } catch {
      // Observability callbacks must not keep a stalled client alive.
    }
  }

  #remove(client) {
    if (!this.#clients.delete(client)) return;
    client.closed = true;
    this.#clearDrainTimer(client);
    client.request.off?.('close', client.onClose);
    client.response.off?.('close', client.onClose);
    client.response.off?.('error', client.onError);
    client.response.off?.('drain', client.onDrain);
  }

  #clearDrainTimer(client) {
    if (client.drainTimer === null) return;
    this.clearTimer(client.drainTimer);
    client.drainTimer = null;
  }
}

function writableLength(response) {
  const value = Number(response.writableLength || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

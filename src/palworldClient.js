class PalworldApiError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'PalworldApiError';
    if (cause) this.cause = cause;
  }
}

function createPalworldClient({ baseUrl, password }) {
  const authHeader = `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;

  async function request(method, endpoint, body) {
    let response;
    try {
      response = await fetch(`${baseUrl}${endpoint}`, {
        method,
        headers: {
          Authorization: authHeader,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new PalworldApiError('Palworld server is unreachable', { cause: err });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new PalworldApiError(`Palworld API error ${response.status}: ${text}`);
    }

    const contentType = response.headers.get('content-type') || '';
    return contentType.includes('application/json') ? response.json() : undefined;
  }

  return {
    getInfo: () => request('GET', '/v1/api/info'),
    getPlayers: () => request('GET', '/v1/api/players'),
    getMetrics: () => request('GET', '/v1/api/metrics'),
    announce: (message) => request('POST', '/v1/api/announce', { message }),
    kick: (userid, message) => request('POST', '/v1/api/kick', { userid, message }),
    ban: (userid, message) => request('POST', '/v1/api/ban', { userid, message }),
    unban: (userid) => request('POST', '/v1/api/unban', { userid }),
    save: () => request('POST', '/v1/api/save'),
    shutdown: (waittime, message) => request('POST', '/v1/api/shutdown', { waittime, message }),
    stop: () => request('POST', '/v1/api/stop'),
  };
}

module.exports = { createPalworldClient, PalworldApiError };

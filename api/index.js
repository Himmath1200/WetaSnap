const path = require('node:path');
const fs = require('node:fs');

let serverHandler = null;
let initPromise = null;

function findServerModule() {
  const candidates = [
    path.resolve(__dirname, '../services/api/dist/server.js'),
    path.resolve(__dirname, 'services/api/dist/server.js'),
    path.resolve(process.cwd(), 'services/api/dist/server.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

async function getHandler() {
  if (serverHandler) return serverHandler;
  if (!initPromise) {
    initPromise = (async () => {
      const express = require('express');
      const expressApp = express();
      const serverPath = findServerModule();
      const serverModule = require(serverPath);
      await serverModule.configureApp(expressApp);
      serverHandler = expressApp;
      return expressApp;
    })();
  }
  return initPromise;
}

function resolvePath(req) {
  const urlObj = new URL(req.url || '/', 'http://localhost');
  const fallbackPath = urlObj.searchParams.get('__v_path');
  const matchedPath = req.headers && req.headers['x-matched-path'];

  let target = (typeof matchedPath === 'string' && matchedPath) ? matchedPath : (fallbackPath || urlObj.pathname);

  if (target.startsWith('/api/')) {
    target = target.slice(4);
  } else if (target === '/api' || target === '') {
    target = '/health';
  }

  urlObj.searchParams.delete('__v_path');
  const query = urlObj.searchParams.toString();
  if (query && !target.includes('?')) {
    target = target + '?' + query;
  }

  return target;
}

async function handler(req, res) {
  try {
    req.url = resolvePath(req);
    const app = await getHandler();
    return app(req, res);
  } catch (err) {
    console.error('[Vercel API Error]', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        ok: false,
        error: err && err.message ? err.message : 'Internal Server Error',
        tip: 'Ensure DATABASE_URL and environment variables are set in your Vercel project settings.',
      }),
    );
  }
}

module.exports = handler;
module.exports.default = handler;
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

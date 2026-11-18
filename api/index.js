require('reflect-metadata');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

let serverHandler = null;
let initPromise = null;

let serverModule = null;
try {
  serverModule = require('../services/api/dist/server.js');
} catch {
  try {
    serverModule = require('./services/api/dist/server.js');
  } catch {}
}

function loadServerModule() {
  if (serverModule) return serverModule;
  const candidates = [
    path.resolve(__dirname, '../services/api/dist/server.js'),
    path.resolve(__dirname, 'services/api/dist/server.js'),
    path.resolve(process.cwd(), 'services/api/dist/server.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  return require(candidates[0]);
}

async function getHandler() {
  if (serverHandler) return serverHandler;
  if (!initPromise) {
    initPromise = (async () => {
      const expressApp = express();
      const mod = loadServerModule();
      await mod.configureApp(expressApp);
      serverHandler = expressApp;
      return expressApp;
    })();
  }
  return initPromise;
}

function resolvePath(req) {
  const urlObj = new URL(req.url || '/', 'http://localhost');
  const queryPath = urlObj.searchParams.get('__v_path');
  const forwardedUri = req.headers && (req.headers['x-forwarded-uri'] || req.headers['x-invoke-path']);

  let target = queryPath || forwardedUri || urlObj.pathname;

  if (target === '/api' || target === '/api/index' || target === '') {
    target = '/health';
  } else if (target.startsWith('/api/index')) {
    target = target.slice(10) || '/health';
  } else if (target.startsWith('/api/')) {
    target = target.slice(4);
  }

  urlObj.searchParams.delete('__v_path');
  const query = urlObj.searchParams.toString();
  if (query) {
    target = target.includes('?') ? `${target}&${query}` : `${target}?${query}`;
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

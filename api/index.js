require('reflect-metadata');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

let serverHandler = null;
let initPromise = null;

function loadServerModule() {
  const candidates = [
    path.resolve(__dirname, 'dist/server.js'),
    path.resolve(__dirname, '../services/api/dist/server.js'),
    path.resolve(process.cwd(), 'api/dist/server.js'),
    path.resolve(process.cwd(), 'services/api/dist/server.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  return require('./dist/server.js');
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
  const url = req.url || '/';
  let target = url.replace(/^\/api(?=\/|\?|$)/, '') || '/health';
  if (target === '' || target === '/') target = '/health';
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

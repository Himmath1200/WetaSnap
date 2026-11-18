require('reflect-metadata');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

let serverHandler = null;
let initPromise = null;

function loadServerModule() {
  const candidates = [
    path.resolve(__dirname, '_dist/server.js'),
    path.resolve(__dirname, '../services/api/dist/server.js'),
    path.resolve(process.cwd(), 'api/_dist/server.js'),
    path.resolve(process.cwd(), 'services/api/dist/server.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  return require('./_dist/server.js');
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
  let url = req.url || '/';
  if (url.includes('__v_path=')) {
    const urlObj = new URL(url, 'http://localhost');
    const vPath = urlObj.searchParams.get('__v_path') || '';
    urlObj.searchParams.delete('__v_path');
    const query = urlObj.searchParams.toString();
    url = query ? vPath + '?' + query : vPath;
  }
  if (url === '/api' || url === '/api/index' || url === '/api/index.js' || url === '/' || url === '') {
    return '/health';
  }
  if (url.startsWith('/api/')) {
    url = url.slice(4);
  }
  return url.startsWith('/') ? url : '/' + url;
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

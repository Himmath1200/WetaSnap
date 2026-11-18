require('reflect-metadata');
const express = require('express');
const serverModule = require('./_dist/server.js');

let serverHandler = null;
let initPromise = null;

async function getHandler() {
  if (serverHandler) return serverHandler;
  if (!initPromise) {
    initPromise = (async () => {
      const expressApp = express();
      await serverModule.configureApp(expressApp);
      serverHandler = expressApp;
      return expressApp;
    })();
  }
  return initPromise;
}

function resolvePath(req) {
  const urlObj = new URL(req.url || '/', 'http://localhost');
  const vPath = urlObj.searchParams.get('__v_path');
  const forwarded = req.headers && (
    req.headers['x-forwarded-uri'] ||
    req.headers['x-invoke-path'] ||
    (req.headers['x-matched-path'] && req.headers['x-matched-path'] !== '/api' ? req.headers['x-matched-path'] : null)
  );

  let target = vPath || forwarded || urlObj.pathname;
  if (target === '/api' || target === '/api/index' || target === '/' || target === '') {
    target = '/health';
  } else if (target.startsWith('/api/')) {
    target = target.slice(4);
  }
  if (!target.startsWith('/')) {
    target = '/' + target;
  }

  urlObj.searchParams.delete('__v_path');
  const query = urlObj.searchParams.toString();
  return query ? (target.includes('?') ? `${target}&${query}` : `${target}?${query}`) : target;
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

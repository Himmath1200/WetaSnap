import { spawn } from 'node:child_process';

console.log('\x1b[36m[WeTa Snap]\x1b[0m Starting Backend API and Web Frontend...\n');

const api = spawn('npm', ['run', 'dev', '-w', '@wetasnap/api'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

const web = spawn('npm', ['run', 'dev', '-w', '@wetasnap/web'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

api.on('error', (err) => {
  console.error('\x1b[31m[API Error]\x1b[0m', err.message);
});

web.on('error', (err) => {
  console.error('\x1b[31m[Web Error]\x1b[0m', err.message);
});

function cleanup() {
  try { api.kill(); } catch {}
  try { web.kill(); } catch {}
  process.exit();
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

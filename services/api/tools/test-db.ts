import { Client } from 'pg';
import { loadEnv } from '../src/common/env';

function cleanDbUrl(url: string): string {
  return url.replace(/([?&])sslmode=[^&]+(&|$)/, '$1').replace(/[?&]$/, '');
}

async function testConnection() {
  console.log('Testing WeTa Snap database connection...\n');
  const env = loadEnv();

  console.log('DATABASE_URL:', env.DATABASE_URL.replace(/:[^:@]+@/, ':****@'));
  console.log('SERVICE_DATABASE_URL:', env.SERVICE_DATABASE_URL.replace(/:[^:@]+@/, ':****@'));
  console.log('SSL:', env.DATABASE_SSL ? 'true (required for Supabase)' : 'false');
  console.log('----------------------------------------------------');

  const client = new Client({
    connectionString: cleanDbUrl(env.SERVICE_DATABASE_URL),
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5000,
  });

  try {
    await client.connect();
    const res = await client.query('select current_database(), current_user, version()');
    console.log('SUCCESS: Connected to database!');
    console.log('Database:', res.rows[0].current_database);
    console.log('User:', res.rows[0].current_user);
    console.log('PostgreSQL Version:', res.rows[0].version.split(' ')[1]);

    const tables = await client.query(`
      select table_name from information_schema.tables 
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name;
    `);
    console.log('\nFound', tables.rows.length, 'tables in public schema.');
    if (tables.rows.length === 0) {
      console.log('Note: No tables found yet. Run supabase-setup.sql in your Supabase SQL editor.');
    } else {
      console.log('Tables:', tables.rows.map(r => r.table_name).join(', '));
    }
  } catch (err: any) {
    console.error('\nCONNECTION ERROR:', err.message);
    if (err.message.includes('password authentication failed')) {
      console.error('\n→ Check the password in services/api/.env.');
    } else if (err.message.includes('timeout') || err.code === 'ETIMEDOUT') {
      console.error('\n→ OUTBOUND PORT BLOCKED: Connection timed out.');
      console.error('  Your current Wi-Fi/network firewall is blocking outbound database ports (5432 & 6543).');
      console.error('  Quick fix: Connect to your phone\'s Mobile Hotspot or turn on VPN (e.g. ExpressVPN).');
    } else if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      console.error('\n→ Could not reach host. Verify host address and port in services/api/.env.');
    }
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

testConnection();

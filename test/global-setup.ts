import dotenv from 'dotenv';
import path from 'path';

export async function setupSB() {
  // 1. Load the secret environment variables
  console.debug(`dotenv from ${__dirname}`)
  dotenv.config({ path: path.resolve(__dirname, '../../secret.env') });

  const { ACCESS_TOKEN, REFRESH_TOKEN } = process.env;
  // console.log(`dotenv process.env`, process.env)

  if (!ACCESS_TOKEN || !REFRESH_TOKEN) {
    throw new Error('Tokens missing in secret.env');
  }

  // 2. Format the Supabase session object
  const session = {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    expires_at: Math.floor(Date.now() / 1000) + 3600, // Valid for 1 hour
    token_type: 'bearer',
    user: {} // Supabase client will fetch full user data automatically
  };

  // 3. Inject into global localStorage for the test environment
  // Note: Vitest uses jsdom or happy-dom which provides a global localStorage
  globalThis.localStorage.setItem(
    'sb-auth-token', 
    JSON.stringify(session)
  );
}

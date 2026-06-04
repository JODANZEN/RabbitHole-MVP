import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anon) {
  // Surfaced in the console to make misconfiguration obvious during setup.
  console.error('[RabbitHole] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in web/.env');
}

export const supabase = createClient(url, anon);

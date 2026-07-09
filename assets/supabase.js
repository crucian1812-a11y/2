// ============================================================
// Единый клиент Supabase для всего приложения.
// supabase-js v2 подключается из CDN как ES-модуль — без сборщиков.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

/** true, если в config.js ещё не вписаны реальные ключи проекта */
export const isConfigured =
  !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.includes('YOUR-ANON-KEY');

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

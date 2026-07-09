// ============================================================
// Конфигурация Supabase.
//
// ВАЖНО: anon key — ПУБЛИЧНЫЙ ключ, его можно спокойно коммитить
// в открытый репозиторий. Он даёт лишь те права, которые разрешены
// политиками Row Level Security (RLS) в базе. Данные защищает
// не секретность ключа, а сами политики: читать могут все,
// писать — только залогиненные члены семьи.
//
// Скопируйте значения из панели Supabase:
// Project Settings → API → Project URL / anon public key.
// ============================================================

export const SUPABASE_URL = https://ihhkaeybdsehewcfsmws.supabase.co/rest/v1/;
export const SUPABASE_ANON_KEY = sb_publishable_mjySYY1NzhURpuFz00AVzQ_FIUGuXYL;

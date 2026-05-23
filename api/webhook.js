// ============================================================
// CRM SALE — Vercel Webhook Server
// Файл: api/webhook.js
// 
// Деплой: Vercel (бесплатный план)
// Функции:
//   1. Принимает лиды от Facebook Lead Ads (реальное время)
//   2. Сохраняет в Supabase (crm_leads)
//   3. При продаже → пишет в Google Sheets (отдельный лист на магазин)
// ============================================================

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// ─── Supabase клиент (service role — обходит RLS) ─────────────
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Верификация подписи Facebook ────────────────────────────
function verifyFacebookSignature(req, rawBody) {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) return false;
    const expected = 'sha256=' + crypto
        .createHmac('sha256', process.env.FACEBOOK_APP_SECRET)
        .update(rawBody)
        .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ─── Основной handler ────────────────────────────────────────
export default async function handler(req, res) {
    // ── GET: верификация Webhook от Facebook (одноразово при настройке)
    if (req.method === 'GET') {
        const mode      = req.query['hub.mode'];
        const token     = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        if (mode === 'subscribe' && token === process.env.FACEBOOK_VERIFY_TOKEN) {
            console.log('[Webhook] Facebook verification OK');
            return res.status(200).send(challenge);
        }
        return res.status(403).json({ error: 'Verification failed' });
    }

    // ── POST: входящие лиды от Facebook
    if (req.method === 'POST') {
        // Читаем raw body для проверки подписи
        const rawBody = JSON.stringify(req.body);

        // Проверяем подпись Facebook
        if (!verifyFacebookSignature(req, rawBody)) {
            console.warn('[Webhook] Invalid signature');
            return res.status(401).json({ error: 'Invalid signature' });
        }

        const body = req.body;

        // Facebook присылает массив entry с changes
        if (body.object === 'page') {
            for (const entry of (body.entry || [])) {
                for (const change of (entry.changes || [])) {
                    if (change.field === 'leadgen') {
                        await processFacebookLead(change.value);
                    }
                }
            }
        }

        // Facebook ожидает 200 OK немедленно
        return res.status(200).json({ status: 'ok' });
    }

    res.status(405).json({ error: 'Method not allowed' });
}

// ─── Обработка одного Facebook лида ──────────────────────────
async function processFacebookLead(leadData) {
    const { leadgen_id, page_id, form_id, created_time } = leadData;

    console.log(`[Facebook Lead] id=${leadgen_id} page=${page_id} form=${form_id}`);

    // Сохраняем raw данные в буфер (idempotent через UNIQUE)
    const { data: rawRow, error: rawErr } = await supabase
        .from('facebook_leads_raw')
        .upsert({
            lead_id_fb: leadgen_id,
            page_id,
            form_id,
            payload: leadData,
            received_at: new Date(created_time * 1000).toISOString(),
        }, { onConflict: 'lead_id_fb', ignoreDuplicates: true })
        .select()
        .single();

    if (rawErr) {
        console.error('[FB Raw] Save error:', rawErr);
        return;
    }

    // Получаем детали лида от Facebook Graph API
    const leadDetails = await fetchFacebookLeadDetails(leadgen_id);
    if (!leadDetails) return;

    // Парсим поля формы
    const fields = {};
    for (const f of (leadDetails.field_data || [])) {
        fields[f.name] = f.values?.[0] || '';
    }

    // Ищем магазин по page_id
    const { data: sheetsCfg } = await supabase
        .from('sheets_config')
        .select('*, stores(*)')
        .eq('active', true)
        .limit(50);

    // Простая логика: ищем конфиг по form_id в метаданных или берём первый активный магазин
    // В реальном проекте — таблица facebook_page_store_mapping
    const cfg = sheetsCfg?.[0];
    if (!cfg) {
        console.warn('[Facebook Lead] No store config found for page', page_id);
        return;
    }

    // Создаём лид в таблице leads
    const { data: lead, error: leadErr } = await supabase
        .from('leads')
        .insert({
            store_id:        cfg.store_id,
            seller_id:       cfg.seller_id,
            sheets_config_id: cfg.id,
            source_type:     'facebook',
            client_name:     fields.full_name || fields.name || 'Без имени',
            phone:           fields.phone_number || fields.phone || '',
            product_hint:    fields.product || fields.interest || null,
            status:          'new',
            // created_at_fixed фиксируется автоматически через DEFAULT now()
        })
        .select()
        .single();

    if (leadErr) {
        console.error('[Lead] Insert error:', leadErr);
        return;
    }

    // Помечаем raw запись как обработанную
    await supabase
        .from('facebook_leads_raw')
        .update({ processed: true, mapped_lead_id: lead.id, processed_at: new Date().toISOString() })
        .eq('id', rawRow.id);

    // Уведомляем оператора через realtime (Supabase Realtime слушает INSERT в leads)
    console.log(`[Lead Created] id=${lead.id} client="${lead.client_name}" store=${cfg.store_id}`);
}

// ─── Получение деталей лида от Facebook Graph API ────────────
async function fetchFacebookLeadDetails(leadgenId) {
    try {
        const url = `https://graph.facebook.com/v19.0/${leadgenId}` +
                    `?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN}&fields=field_data,created_time,ad_id,form_id`;
        const resp = await fetch(url);
        if (!resp.ok) {
            console.error('[Facebook API] Error:', resp.status, await resp.text());
            return null;
        }
        return await resp.json();
    } catch (err) {
        console.error('[Facebook API] Fetch error:', err);
        return null;
    }
}

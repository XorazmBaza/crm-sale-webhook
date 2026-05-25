// ============================================================
// CRM Sale — api/sheets-leads.js
// Только принимает лиды — ничего не пишет обратно в таблицу
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const { client_name, product_hint, phone, seller_login } = req.body;

  if (!client_name || !phone || !seller_login) {
    return res.status(400).json({ error: 'Missing: client_name, phone, seller_login' });
  }

  try {
    // 1. Найти продавца
    const { data: seller } = await supabase
      .from('users').select('id')
      .eq('login', seller_login).eq('role', 'seller').eq('active', true)
      .single();

    if (!seller) return res.status(404).json({ error: 'Seller not found: ' + seller_login });

    // 2. Найти магазин
    const { data: store } = await supabase
      .from('stores').select('id')
      .eq('owner_user_id', seller.id).maybeSingle();

    // 3. Проверить дубликат по телефону за последние 24 часа
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await supabase
      .from('leads').select('id')
      .eq('seller_id', seller.id)
      .eq('phone', phone.trim())
      .gte('created_at_fixed', since)
      .maybeSingle();

    if (existing) {
      console.log(`[Sheets] Duplicate skipped: ${phone}`);
      return res.status(200).json({ ok: true, duplicate: true });
    }

    // 4. Создать лид
    const { data: lead, error } = await supabase
      .from('leads').insert({
        seller_id:    seller.id,
        store_id:     store?.id || null,
        client_name:  client_name.trim(),
        phone:        phone.trim(),
        product_hint: product_hint?.trim() || null,
        source_type:  'google_sheets',
        status:       'new',
      }).select('id').single();

    if (error) return res.status(500).json({ error: error.message });

    console.log(`[Sheets] Lead: ${client_name} | ${phone}`);
    return res.status(200).json({ ok: true, lead_id: lead.id });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

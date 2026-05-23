// ============================================================
// CRM SALE — Google Sheets интеграция продаж
// Файл: api/sheets-sale.js
//
// Вызывается из Supabase Database Webhook (pg_webhooks)
// при INSERT в таблицу sales_orders
//
// Логика: каждый магазин → отдельный лист в одном Google Sheets
// ============================================================

import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Google Sheets Auth (Service Account) ────────────────────
function getGoogleAuth() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
}

// ─── Handler для Supabase Database Webhook ───────────────────
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Проверяем секретный токен от Supabase webhook
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (token !== process.env.WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { type, record } = req.body;

    // Только новые продажи (INSERT)
    if (type !== 'INSERT') {
        return res.status(200).json({ skipped: true });
    }

    try {
        await writeSaleToGoogleSheets(record);
        return res.status(200).json({ ok: true });
    } catch (err) {
        console.error('[Sheets] Error:', err);
        return res.status(500).json({ error: err.message });
    }
}

// ─── Основная функция записи продажи в Google Sheets ─────────
async function writeSaleToGoogleSheets(order) {
    // Получаем конфиг Google Sheets (единый для всей системы)
    const { data: cfg, error: cfgErr } = await supabase
        .from('sheets_sales_config')
        .select('*')
        .eq('active', true)
        .single();

    if (cfgErr || !cfg) {
        console.warn('[Sheets] No active sales sheets config');
        return;
    }

    // Получаем данные магазина
    const { data: store } = await supabase
        .from('stores')
        .select('name')
        .eq('id', order.store_id)
        .single();

    // Получаем данные оператора
    const { data: operator } = await supabase
        .from('users')
        .select('name')
        .eq('id', order.operator_id)
        .single();

    // Получаем товар
    const { data: product } = await supabase
        .from('products')
        .select('name')
        .eq('id', order.product_id)
        .single();

    // Получаем бонус
    let bonusName = '';
    if (order.bonus_id) {
        const { data: bonus } = await supabase
            .from('product_bonuses')
            .select('bonus_name')
            .eq('id', order.bonus_id)
            .single();
        bonusName = bonus?.bonus_name || '';
    }

    const storeName = store?.name || 'Неизвестный магазин';
    const spreadsheetId = cfg.sheet_id;

    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // Проверяем существует ли лист с именем магазина
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const existingSheets = spreadsheet.data.sheets.map(s => s.properties.title);

    if (!existingSheets.includes(storeName)) {
        // Создаём новый лист для магазина
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: [{
                    addSheet: {
                        properties: { title: storeName }
                    }
                }]
            }
        });

        // Добавляем заголовки
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `'${storeName}'!A1:S1`,
            valueInputOption: 'RAW',
            requestBody: {
                values: [[
                    'Дата продажи',
                    'Магазин',
                    'Оператор',
                    'Имя клиента',
                    'Первый номер',
                    'Второй номер',
                    'Платформа',
                    'Номер договора',
                    'Товар',
                    'Модель',
                    'Цвет',
                    'Бонус',
                    'Сумма',
                    'Адрес',
                    'Город Ташкент',
                    'Локация',
                    'Статус заказа',
                    'Трек заказа',
                    'ID заказа'
                ]]
            }
        });

        // Форматируем заголовок (жирный)
        const sheetId = (await sheets.spreadsheets.get({ spreadsheetId }))
            .data.sheets.find(s => s.properties.title === storeName)
            ?.properties.sheetId;

        if (sheetId !== undefined) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [{
                        repeatCell: {
                            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                            cell: {
                                userEnteredFormat: {
                                    textFormat: { bold: true },
                                    backgroundColor: { red: 0.2, green: 0.5, blue: 0.8 }
                                }
                            },
                            fields: 'userEnteredFormat(textFormat,backgroundColor)'
                        }
                    }]
                }
            });
        }
    }

    // Форматируем дату: дд.мм
    const soldDate = new Date(order.sold_at);
    const dateStr = `${String(soldDate.getDate()).padStart(2, '0')}.${String(soldDate.getMonth() + 1).padStart(2, '0')}`;

    // Строка данных
    const row = [
        dateStr,
        storeName,
        operator?.name || '',
        order.client_name || '',
        order.phone_1 || '',
        order.phone_2 || '',
        order.platform || '',
        order.contract_number || '',
        product?.name || '',
        order.model || '',
        order.color || '',
        bonusName,
        order.amount || 0,
        order.address || '',
        order.city_tashkent ? 'Да' : 'Нет',
        order.location_coords || '',
        translateOrderStatus(order.status),
        order.tracking_number || '',
        order.id
    ];

    // Добавляем строку в конец листа
    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `'${storeName}'!A:S`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] }
    });

    console.log(`[Sheets] Sale written to sheet "${storeName}", order ${order.id}`);
}

// ─── Перевод статуса ─────────────────────────────────────────
function translateOrderStatus(status) {
    const map = {
        waiting: 'Ожидание',
        sent: 'Отправлен',
        delivered: 'Доставлен',
        cancelled: 'Отменён',
    };
    return map[status] || status;
}

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(express);
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bcrypt = require('bcrypt');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(session({
    store: new pgSession({ pool: pool, tableName: 'session' }),
    secret: process.env.SESSION_SECRET || 'tpb_secret_key_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// Statiske filer
app.use(express.static(__dirname));

// -------------------------------------------------------------
// AI KORT-VURDERING (PRE-GRADE)
// -------------------------------------------------------------
app.post('/api/ai-grade', async (req, res) => {
    try {
        const { imageBase64, cardName } = req.body || {};
        if (!imageBase64) return res.status(400).json({ error: 'Intet billede modtaget.' });

        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        if (!apiKey) return res.status(503).json({ error: 'AI-vurdering er ikke konfigureret på serveren endnu.' });

        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: `Du er en professionel CGC / PSA kort-grader for samlekort (Pokémon / One Piece). Analyser dette kort (${cardName || 'Ukendt kort'}) ud fra de fire underområder: Centering, Corners (hjørner), Edges (kanter) og Surface (overflade). Giv en estimeret CGC-karakter samt en konstruktiv, ærlig begrundelse på dansk i et skarpt format med overskrifter. Husk at nævne klart, at vurderingen udelukkende er vejledende.` },
                        { inline_data: { mime_type: 'image/jpeg', data: base64Data } }
                    ]
                }]
            })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(`Gemini API fejl: ${JSON.stringify(errData)}`);
        }

        const data = await response.json();
        const evaluation = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Kunne ikke generere vurdering.';

        res.json({ success: true, evaluation });
    } catch (err) {
        console.error('AI Grade Fejl:', err);
        res.status(500).json({ error: 'Kunne ikke gennemføre AI-vurdering. Prøv igen senere.' });
    }
});

// -------------------------------------------------------------
// PULJE STATUS API
// -------------------------------------------------------------
app.get('/api/pool-status', async (req, res) => {
    try {
        const result = await pool.query('SELECT count FROM pool_status WHERE id = 1');
        const count = result.rows[0] ? result.rows[0].count : 0;
        res.json({ count });
    } catch (e) {
        res.json({ count: 12 });
    }
});

app.post('/api/admin/pool-status', async (req, res) => {
    const adminPass = req.headers['x-admin-password'];
    if (adminPass !== (process.env.ADMIN_PASSWORD || 'admin123')) {
        return res.status(401).json({ error: 'Ugyldig adgangskode' });
    }
    const { count } = req.body;
    try {
        await pool.query('INSERT INTO pool_status (id, count) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET count = $1', [count]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Kunne ikke opdatere pulje' });
    }
});

// -------------------------------------------------------------
// AUTH API (Bruger login & session)
// -------------------------------------------------------------
app.get('/api/auth/me', async (req, res) => {
    if (!req.session.userId) return res.json({ loggedIn: false });
    try {
        const userRes = await pool.query('SELECT id, name, email, phone, membership_active FROM users WHERE id = $1', [req.session.userId]);
        if (!userRes.rows[0]) return res.json({ loggedIn: false });
        res.json({ loggedIn: true, user: { ...userRes.rows[0], membership: { active: userRes.rows[0].membership_active } } });
    } catch (e) {
        res.json({ loggedIn: false });
    }
});

// -------------------------------------------------------------
// STRIPE CHECKOUT & ORDRE API
// -------------------------------------------------------------
app.post('/api/checkout', async (req, res) => {
    try {
        const { name, email, phone, address, postal, city, qty, tier, shippingMethod, notes, coupon } = req.body;
        
        const basePrices = { bulk: 279, economy: 299, standard: 499, express: 899, walkthrough: 2199, unlimited: 2199 };
        let pricePerCard = basePrices[tier] || 279;

        if (req.session.userId) {
            const userRes = await pool.query('SELECT membership_active FROM users WHERE id = $1', [req.session.userId]);
            if (userRes.rows[0]?.membership_active) {
                if (tier === 'bulk') pricePerCard = 249;
                else pricePerCard = Math.round(pricePerCard * 0.95);
            }
        }

        let subtotal = qty * pricePerCard;
        let shipPrice = shippingMethod === 'hjemmelevering' ? 69 : 49;
        let totalDkk = subtotal + shipPrice;

        if (coupon && coupon.trim().toUpperCase() === 'MASTER2026') {
            totalDkk -= Math.round(totalDkk * 0.10);
        }

        const orderId = 'TPB-' + Math.floor(100000 + Math.random() * 900000);

        const sessionStripe = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'dkk',
                    product_data: { name: `CGC Grading (${tier.toUpperCase()}) - ${qty} stk.` },
                    unit_amount: Math.round((totalDkk / qty) * 100),
                },
                quantity: qty,
            }],
            mode: 'payment',
            success_url: `${req.protocol}://${req.get('host')}/success.html?order=${orderId}`,
            cancel_url: `${req.protocol}://${req.get('host')}/index.html#order`,
        });

        await pool.query(
            `INSERT INTO orders (order_id, customer_name, customer_email, customer_phone, customer_address, customer_postal, customer_city, qty, tier, shipping_method, total_dkk, payment_status, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', 'modtaget')`,
            [orderId, name, email, phone, address, postal, city, qty, tier, shippingMethod, totalDkk]
        );

        res.json({ url: sessionStripe.url });
    } catch (err) {
        console.error('Checkout fejl:', err);
        res.status(500).json({ error: 'Kunne ikke oprette betaling.' });
    }
});

// Admin Ordrer Endpoint
app.get('/api/admin/orders', async (req, res) => {
    const adminPass = req.headers['x-admin-password'];
    if (adminPass !== (process.env.ADMIN_PASSWORD || 'admin123')) {
        return res.status(401).json({ error: 'Ugyldig adgangskode' });
    }
    try {
        const orders = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        const poolRes = await pool.query('SELECT count FROM pool_status WHERE id = 1');
        const membersRes = await pool.query('SELECT COUNT(*) FROM users WHERE membership_active = true');
        const revenueRes = await pool.query("SELECT SUM(total_dkk) FROM orders WHERE payment_status = 'paid'");

        res.json({
            orders: orders.rows,
            stats: {
                poolCards: poolRes.rows[0]?.count || 0,
                members: membersRes.rows[0]?.count || 0,
                paidRevenueDkk: revenueRes.rows[0]?.sum || 0,
                orders: orders.rowCount
            },
            statuses: {
                'modtaget': 'Ordre Modtaget',
                'under_behandling': 'Under Behandling',
                'sendt_cgc': 'Sendt til CGC',
                'hos_cgc': 'Hos CGC (Gradering)',
                'retur': 'Pakket & Retur til Kunde'
            }
        });
    } catch (e) {
        res.status(500).json({ error: 'Databasefejl' });
    }
});

app.listen(port, () => {
    console.log(`Server kører på port ${port}`);
});

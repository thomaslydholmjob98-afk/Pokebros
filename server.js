const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bcrypt = require('bcrypt');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS session (
                sid VARCHAR NOT NULL COLLATE "default",
                sess JSON NOT NULL,
                expire TIMESTAMP(6) NOT NULL,
                CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
            );
            CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON session ("expire");

            CREATE TABLE IF NOT EXISTS pool_status (
                id INT PRIMARY KEY,
                count INT NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255),
                email VARCHAR(255) UNIQUE NOT NULL,
                phone VARCHAR(50),
                password_hash VARCHAR(255),
                membership_active BOOLEAN DEFAULT false,
                membership_plan VARCHAR(50),
                points INT DEFAULT 100,
                last_spin_date TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                category VARCHAR(100),
                price_dkk INT NOT NULL,
                image_url TEXT,
                status VARCHAR(50) DEFAULT 'til salg',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                order_id VARCHAR(50) UNIQUE NOT NULL,
                customer_name VARCHAR(255),
                customer_email VARCHAR(255),
                customer_phone VARCHAR(50),
                customer_address TEXT,
                customer_postal VARCHAR(20),
                customer_city VARCHAR(100),
                qty INT,
                tier VARCHAR(50),
                shipping_method VARCHAR(50),
                total_dkk INT,
                payment_status VARCHAR(50) DEFAULT 'pending',
                status VARCHAR(50) DEFAULT 'modtaget',
                tracking_number VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS sell_requests (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255),
                email VARCHAR(255),
                phone VARCHAR(50),
                details TEXT,
                expected_price VARCHAR(100),
                status VARCHAR(50) DEFAULT 'modtaget',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE SEQUENCE IF NOT EXISTS users_id_seq;
            ALTER TABLE users ALTER COLUMN id SET DEFAULT nextval('users_id_seq');
            ALTER SEQUENCE users_id_seq OWNED BY users.id;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_active BOOLEAN DEFAULT false;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_plan VARCHAR(50);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS points INT DEFAULT 100;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS last_spin_date TIMESTAMP;
        `).catch(() => {});

        await pool.query(`
            INSERT INTO pool_status (id, count) VALUES (1, 12)
            ON CONFLICT (id) DO NOTHING;
        `);
        console.log('Supabase database tabeller er initialiseret korrekt.');
    } catch (err) {
        console.error('DB Init Fejl:', err.message);
    }
}
initDb();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(session({
    store: new pgSession({ 
        pool: pool, 
        tableName: 'session',
        createTableIfMissing: true 
    }),
    secret: process.env.SESSION_SECRET || 'tpb_secret_key_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

app.use(express.static(__dirname));

function checkAdmin(req, res, next) {
    const adminPass = (req.headers['x-admin-password'] || '').trim();
    if (adminPass !== 'Lydholm9320') {
        return res.status(401).json({ error: 'Ugyldig adgangskode' });
    }
    next();
}

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body || {};
    if ((password || '').trim() === 'Lydholm9320') {
        return res.json({ success: true });
    }
    return res.status(401).json({ error: 'Forkert adgangskode' });
});

// ADMIN: HENT ALLE BRUGERE
app.get('/api/admin/users', checkAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, email, phone, membership_active, membership_plan, points, created_at FROM users ORDER BY created_at DESC');
        res.json({ users: result.rows });
    } catch (e) {
        res.status(500).json({ error: 'Kunne ikke hente brugere' });
    }
});

// ADMIN: OPDATÉR BRUGER MEDLEMSKAB
app.patch('/api/admin/users/:id', checkAdmin, async (req, res) => {
    const { id } = req.params;
    const { membership_active, membership_plan } = req.body;
    try {
        await pool.query(
            'UPDATE users SET membership_active = $1, membership_plan = $2 WHERE id = $3',
            [membership_active, membership_plan || null, id]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('Opdateringsfejl:', e);
        res.status(500).json({ error: 'Kunne ikke opdatere bruger' });
    }
});

// ADMIN: OPDATÉR BRUGERS POKECOINS
app.patch('/api/admin/users/:id/points', checkAdmin, async (req, res) => {
    const { id } = req.params;
    const { points } = req.body;
    
    const parsedPoints = parseInt(points, 10);
    if (isNaN(parsedPoints)) {
        return res.status(400).json({ error: 'Ugyldigt antal point' });
    }

    try {
        const result = await pool.query(
            'UPDATE users SET points = $1 WHERE id = $2 RETURNING id, points',
            [parsedPoints, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Brugeren blev ikke fundet i databasen' });
        }

        res.json({ success: true, updatedPoints: result.rows[0].points });
    } catch (e) {
        console.error('Fejl ved opdatering af PokeCoins:', e.message);
        res.status(500).json({ error: 'Kunne ikke opdatere PokeCoins: ' + e.message });
    }
});

// ADMIN: FULD SLETNING AF BRUGER OG ALT DERES DATA
app.delete('/api/admin/users/:id', checkAdmin, async (req, res) => {
    const userId = req.params.id;
    try {
        const userRes = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length > 0) {
            const userEmail = userRes.rows[0].email;
            await pool.query('DELETE FROM orders WHERE customer_email = $1', [userEmail]);
        }

        await pool.query(`DELETE FROM session WHERE sess::text LIKE $1`, [`%"userId":${userId}%`]);
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);

        res.json({ success: true });
    } catch (e) {
        console.error('Sletning af bruger fejlede:', e);
        res.status(500).json({ error: 'Kunne ikke slette bruger: ' + e.message });
    }
});

// FÆLLES HJÆLPEFUNKTION TIL SØGNING / TRACKING AF ORDRE
async function handleOrderLookup(orderId, res) {
    if (!orderId) {
        return res.status(400).json({ error: 'Ordre ID mangler.' });
    }

    try {
        const cleanOrderId = orderId.trim();
        const orderRes = await pool.query('SELECT * FROM orders WHERE order_id = $1', [cleanOrderId]);
        
        if (orderRes.rows.length === 0) {
            return res.status(404).json({ error: 'Ordren blev ikke fundet i systemet.' });
        }
        
        const o = orderRes.rows[0];
        
        const statusLabels = {
            'modtaget': 'Ordre Modtaget',
            'under_behandling': 'Under Behandling',
            'sendt_cgc': 'Sendt til CGC',
            'hos_cgc': 'Hos CGC (Gradering)',
            'retur': 'Pakket & Retur til Kunde'
        };

        return res.json({
            success: true,
            order: {
                orderId: o.order_id,
                createdAt: o.created_at,
                qty: o.qty,
                tier: o.tier,
                totalDkk: o.total_dkk,
                status: o.status,
                statusLabel: statusLabels[o.status] || o.status,
                trackingNumber: o.tracking_number,
                customer_name: o.customer_name,
                customer_email: o.customer_email,
                customer_address: o.customer_address,
                customer_postal: o.customer_postal,
                customer_city: o.customer_city
            }
        });
    } catch (err) {
        console.error('Ordre lookup fejl:', err);
        return res.status(500).json({ error: 'Der opstod en databasefejl ved søgning.' });
    }
}

// UNIVERSAL CATCH-ALL FOR FORESPØRGSLER MED QUERY-PARAMETRE (f.eks. /api/orders?orderId=...)
app.get(['/api/orders', '/api/track', '/api/order'], async (req, res) => {
    const orderId = req.query.orderId || req.query.id || req.query.q;
    return handleOrderLookup(orderId, res);
});

// ALLE TÆNKELIGE URL-PARAMETRE RUTER
app.get('/api/orders/lookup/:orderId', async (req, res) => {
    return handleOrderLookup(req.params.orderId, res);
});

app.get('/api/track/:orderId', async (req, res) => {
    return handleOrderLookup(req.params.orderId, res);
});

app.get('/api/order/:orderId', async (req, res) => {
    return handleOrderLookup(req.params.orderId, res);
});

app.get('/api/orders/:orderId', async (req, res) => {
    return handleOrderLookup(req.params.orderId, res);
});

// OFFENTLIG ORDREHENTNING TIL PAKKESEDDEL
app.get('/api/track-public/:orderId', async (req, res) => {
    const { orderId } = req.params;
    try {
        const orderRes = await pool.query('SELECT * FROM orders WHERE order_id = $1', [orderId]);
        if (orderRes.rows.length === 0) {
            return res.status(404).json({ error: 'Ordren blev ikke fundet.' });
        }
        const o = orderRes.rows[0];
        
        const statusLabels = {
            'modtaget': 'Ordre Modtaget',
            'under_behandling': 'Under Behandling',
            'sendt_cgc': 'Sendt til CGC',
            'hos_cgc': 'Hos CGC (Gradering)',
            'retur': 'Pakket & Retur til Kunde'
        };

        res.json({
            orderId: o.order_id,
            createdAt: o.created_at,
            qty: o.qty,
            tier: o.tier,
            totalDkk: o.total_dkk,
            status: o.status,
            statusLabel: statusLabels[o.status] || o.status,
            trackingNumber: o.tracking_number,
            customer_name: o.customer_name,
            customer_email: o.customer_email,
            customer_address: o.customer_address,
            customer_postal: o.customer_postal,
            customer_city: o.customer_city
        });
    } catch (err) {
        res.status(500).json({ error: 'Databasefejl' });
    }
});

// BREVO: FUNKTION TIL AT SENDE VELKOMSTMAIL
async function sendWelcomeEmail({ name, email }) {
    const brevoApiKey = process.env.BREVO_API_KEY;
    if (!brevoApiKey) {
        console.error('BREVO_API_KEY mangler i miljøvariablerne!');
        return;
    }

    const senderEmail = 'kontakt@thepokebros.com';

    try {
        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'api-key': brevoApiKey,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                sender: { name: 'The Poke Bros', email: senderEmail },
                to: [{ email: email, name: name || 'Samler' }],
                subject: '🔥 Velkommen til The Poke Bros – Din guide til CGC Grading & Samlekort!',
                htmlContent: `
                    <div style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px; color: #333;">
                        <div style="max-width: 600px; margin: 0 auto; background: #111318; color: #fff; padding: 40px; border-radius: 12px; border: 1px solid #222;">
                            <h1 style="color: #e63946; margin-top: 0; text-align: center;">Velkommen til The Poke Bros! 🚀</h1>
                            <p>Hej <b>${name || 'samler'}</b>,</p>
                            <p>Mange tak for din oprettelse af en konto hos <b>The Poke Bros</b>! Som velkomstbonus har vi indsat <b>100 PokeCoins</b> på din konto.</p>
                            
                            <hr style="border: 0; border-top: 1px solid #333; margin: 20px 0;">
                            
                            <h3 style="color: #2ec4b6;">Hvad kan du på platformen?</h3>
                            <ul style="line-height: 1.6; color: #ccc;">
                                <li><b>Nem CGC Gradering:</b> Få graded dine kort hos CGC uden at skulle samle en stor submission selv. Vi sender fra bare 1 kort!</li>
                                <li><b>Optjen PokeCoins:</b> Du optjener 1 PokeCoin for hver krone du bruger, som kan bruges til rabat.</li>
                                <li><b>Sporing af ordrer:</b> Følg dine kort hele vejen fra modtagelse, til de er sendt til CGC, under gradering, og når de er på vej retur til dig.</li>
                            </ul>

                            <p style="margin-top: 30px;">Har du spørgsmål undervejs, er du altid velkommen til at svare direkte på denne e-mail.</p>
                            
                            <p style="margin-top: 40px; text-align: center; color: #888; font-size: 13px;">
                                De bedste hilsner,<br>
                                <b>The Poke Bros Team</b><br>
                                <a href="https://www.thepokebros.com" style="color: #e63946; text-decoration: none;">www.thepokebros.com</a>
                            </p>
                        </div>
                    </div>
                `
            })
        });

        const data = await response.json();
        if (!response.ok) {
            console.error('Brevo fejl ved velkomstmail:', JSON.stringify(data));
        } else {
            console.log('Velkomstmail sendt succesfuldt til:', email);
        }
    } catch (err) {
        console.error('Kunne ikke sende velkomstmail via Brevo:', err.message);
    }
}

// BREVO: FUNKTION TIL AT SENDE ORDREKVITTERING VED BETALING
async function sendOrderReceiptEmail(order) {
    const brevoApiKey = process.env.BREVO_API_KEY;
    if (!brevoApiKey || !order.customer_email) {
        console.log('Brevo mangler nøgle eller kunde-email til kvittering.');
        return;
    }

    try {
        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'api-key': brevoApiKey,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                sender: { name: 'The Poke Bros', email: 'kontakt@thepokebros.com' },
                to: [{ email: order.customer_email, name: order.customer_name || 'Kunde' }],
                subject: `🧾 Kvittering for din ordre (${order.order_id})`,
                htmlContent: `
                    <div style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px; color: #333;">
                        <div style="max-width: 600px; margin: 0 auto; background: #111318; color: #fff; padding: 40px; border-radius: 12px; border: 1px solid #222;">
                            <h2 style="color: #2ec4b6; margin-top: 0; text-align: center;">Tak for din bestilling! 🧾</h2>
                            <p>Hej <b>${order.customer_name || 'Samler'}</b>,</p>
                            <p>Vi har modtaget din betaling for ordre <b>${order.order_id}</b>. Dine kort er nu klar til at blive sendt ind i vores næste CGC-pulje!</p>
                            
                            <div style="background: #1a1e29; padding: 20px; border-radius: 8px; border: 1px solid #333; margin: 25px 0;">
                                <h3 style="margin-top: 0; color: #e63946; font-size: 16px;">Ordredetaljer</h3>
                                <p style="margin: 5px 0;"><b>Ordre ID:</b> ${order.order_id}</p>
                                <p style="margin: 5px 0;"><b>Service / Tier:</b> ${order.tier.toUpperCase()}</p>
                                <p style="margin: 5px 0;"><b>Antal kort:</b> ${order.qty} stk.</p>
                                <p style="margin: 5px 0;"><b>Returfragt:</b> ${order.shipping_method}</p>
                                <hr style="border: 0; border-top: 1px solid #444; margin: 15px 0;">
                                <p style="margin: 5px 0; font-size: 16px;"><b>Samlet pris:</b> <span style="color: #2ec4b6;">${order.total_dkk} kr.</span></p>
                            </div>

                            <h3 style="color: #2ec4b6; font-size: 16px;">Hvad sker der nu?</h3>
                            <ol style="line-height: 1.6; color: #ccc; font-size: 14px;">
                                <li>Pak dine kort forsvarligt i sleeves og toploaders.</li>
                                <li>Udskriv din <a href="https://www.thepokebros.com/packingslip.html?order=${order.order_id}" style="color: #e63946;">pakkeseddel her</a> og læg den ved.</li>
                                <li>Send pakken til os – du kan følge status på din konto.</li>
                            </ol>
                            
                            <p style="margin-top: 40px; text-align: center; color: #888; font-size: 13px;">
                                De bedste hilsner,<br>
                                <b>The Poke Bros Team</b>
                            </p>
                        </div>
                    </div>
                `
            })
        });

        const data = await response.json();
        if (!response.ok) {
            console.error('Brevo fejl ved kvitteringsmail:', JSON.stringify(data));
        } else {
            console.log('Kvitteringsmail sendt succesfuldt til:', order.customer_email);
        }
    } catch (err) {
        console.error('Kunne ikke sende kvitteringsmail via Brevo:', err.message);
    }
}

// BRUGER AUTHENTICATION & KONTO DATA
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, phone, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'E-mail og adgangskode er påkrævet.' });

        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'E-mailen er allerede i brug.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (name, email, phone, password_hash, points) VALUES ($1, $2, $3, $4, 100) RETURNING id, name, email, phone, membership_active, membership_plan, points',
            [name || '', email, phone || '', hashedPassword]
        );

        const user = result.rows[0];
        req.session.userId = user.id;

        sendWelcomeEmail({ name: user.name, email: user.email });

        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ error: 'Kunne ikke oprette konto.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Indtast e-mail og adgangskode.' });

        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0 || !result.rows[0].password_hash) {
            return res.status(401).json({ error: 'Ugyldig e-mail eller adgangskode.' });
        }

        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Ugyldig e-mail eller adgangskode.' });

        req.session.userId = user.id;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Kunne ikke logge ind.' });
    }
});

app.get('/api/auth/me', async (req, res) => {
    if (!req.session.userId) return res.json({ loggedIn: false });
    try {
        const result = await pool.query('SELECT id, name, email, phone, membership_active, membership_plan, points FROM users WHERE id = $1', [req.session.userId]);
        if (result.rows.length === 0) {
            req.session.destroy(() => {});
            return res.json({ loggedIn: false });
        }

        const user = result.rows[0];
        res.json({
            loggedIn: true,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                points: user.points || 0,
                membership: { active: user.membership_active, plan: user.membership_plan }
            }
        });
    } catch (err) {
        res.json({ loggedIn: false });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

app.get('/api/account', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Ikke logget ind' });
    try {
        const userRes = await pool.query('SELECT id, name, email, phone, membership_active, membership_plan, points, last_spin_date FROM users WHERE id = $1', [req.session.userId]);
        if (userRes.rows.length === 0) {
            req.session.destroy(() => {});
            return res.status(401).json({ error: 'Bruger ikke fundet' });
        }
        const user = userRes.rows[0];

        const ordersRes = await pool.query('SELECT * FROM orders WHERE customer_email = $1 ORDER BY created_at DESC', [user.email]);
        
        const statusLabels = {
            'modtaget': 'Ordre Modtaget',
            'under_behandling': 'Under Behandling',
            'sendt_cgc': 'Sendt til CGC',
            'hos_cgc': 'Hos CGC (Gradering)',
            'retur': 'Pakket & Retur til Kunde'
        };

        const orders = ordersRes.rows.map(o => ({
            orderId: o.order_id,
            createdAt: o.created_at,
            qty: o.qty,
            tier: o.tier,
            totalDkk: o.total_dkk,
            statusLabel: statusLabels[o.status] || o.status,
            trackingNumber: o.tracking_number
        }));

        let canSpin = true;
        let nextSpinIn = null;
        if (user.last_spin_date) {
            const lastSpin = new Date(user.last_spin_date).getTime();
            const now = new Date().getTime();
            const diffHours = (now - lastSpin) / (1000 * 60 * 60);
            if (diffHours < 24) {
                canSpin = false;
                nextSpinIn = Math.ceil(24 - diffHours);
            }
        }

        res.json({
            user: {
                name: user.name,
                email: user.email,
                points: user.points || 0,
                canSpin,
                nextSpinIn,
                membership: {
                    active: user.membership_active,
                    plan: user.membership_plan
                }
            },
            orders
        });
    } catch (err) {
        res.status(500).json({ error: 'Databasefejl' });
    }
});

// POKE-WHEEL / DAGLIG SPIN API
app.post('/api/spin-wheel', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Du skal være logget ind for at spinne.' });
    
    try {
        const userRes = await pool.query('SELECT points, last_spin_date FROM users WHERE id = $1', [req.session.userId]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: 'Bruger ikke fundet.' });

        const user = userRes.rows[0];

        if (user.last_spin_date) {
            const lastSpin = new Date(user.last_spin_date).getTime();
            const now = new Date().getTime();
            const diffHours = (now - lastSpin) / (1000 * 60 * 60);
            if (diffHours < 24) {
                const hoursLeft = Math.ceil(24 - diffHours);
                return res.status(400).json({ error: `Du har allerede spunnet i dag! Prøv igen om ca. ${hoursLeft} time(r).` });
            }
        }

        const weightedPrizes = [10, 10, 10, 15, 15, 20, 20, 25, 30, 40, 50, 75, 100];
        const wonCoins = weightedPrizes[Math.floor(Math.random() * weightedPrizes.length)];

        await pool.query(
            'UPDATE users SET points = COALESCE(points, 0) + $1, last_spin_date = CURRENT_TIMESTAMP WHERE id = $2',
            [wonCoins, req.session.userId]
        );

        const updatedUser = await pool.query('SELECT points FROM users WHERE id = $1', [req.session.userId]);

        res.json({ 
            success: true, 
            wonCoins, 
            newPoints: updatedUser.rows[0].points,
            message: `Tillykke! Du vandt ${wonCoins} PokeCoins på hjulet! ⚡`
        });
    } catch (err) {
        console.error('Spin fejl:', err);
        res.status(500).json({ error: 'Kunne ikke gennemføre spin.' });
    }
});

async function sendBrevoEmail({ name, email, phone, details, expectedPrice }) {
    const brevoApiKey = process.env.BREVO_API_KEY;
    if (!brevoApiKey) return;

    const recipientEmail = 'kontakt@thepokebros.com';

    try {
        await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'api-key': brevoApiKey,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                sender: { name: 'The Poke Bros Platform', email: recipientEmail },
                to: [{ email: recipientEmail, name: 'Thomas Lydholm' }],
                subject: `🔥 Ny Salgshenvendelse fra ${name || 'Kunde'}`,
                htmlContent: `
                    <h2>Ny henvendelse: Sælg din samling</h2>
                    <p><b>Navn:</b> ${name || '-'}</p>
                    <p><b>E-mail:</b> <a href="mailto:${email}">${email || '-'}</a></p>
                    <p><b>Telefon:</b> ${phone || '-'}</p>
                    <p><b>Forventet pris:</b> ${expectedPrice || '-'}</p>
                    <hr>
                    <h3>Beskrivelse af samlingen:</h3>
                    <p style="white-space: pre-wrap; background: #f4f4f4; padding: 15px; border-radius: 5px;">${details || '-'}</p>
                `
            })
        });
    } catch (err) {
        console.error('Kunne ikke sende e-mail via Brevo:', err.message);
    }
}

const handleSellRequest = async (req, res) => {
    try {
        const { name, email, phone, details, description, expectedPrice, price } = req.body || {};
        const textDetails = details || description || '';
        const priceValue = expectedPrice || price || '';

        await pool.query(
            'INSERT INTO sell_requests (name, email, phone, details, expected_price) VALUES ($1, $2, $3, $4, $5)',
            [name || '', email || '', phone || '', textDetails, priceValue]
        );

        sendBrevoEmail({ name, email, phone, details: textDetails, expectedPrice: priceValue });

        res.json({ success: true, message: 'Mange tak! Din henvendelse er modtaget.' });
    } catch (err) {
        res.json({ success: true, message: 'Din henvendelse er modtaget!' });
    }
};

app.post('/api/sell', handleSellRequest);
app.post('/api/sell-collection', handleSellRequest);
app.post('/api/contact/sell', handleSellRequest);

app.get('/api/admin/sell-requests', checkAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM sell_requests ORDER BY created_at DESC');
        res.json({ requests: result.rows });
    } catch (e) {
        res.status(500).json({ error: 'Kunne ikke hente salgshenvendelser' });
    }
});

// UDVIDET AI-GRADE MED PRIS- OG MARKEDSESTIMAT (CARDMARKET / EBAY)
app.post('/api/ai-grade', async (req, res) => {
    try {
        const { frontImageBase64, backImageBase64, cardName } = req.body || {};
        if (!frontImageBase64) return res.status(400).json({ error: 'Billede af forsiden mangler.' });

        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        if (!apiKey) return res.status(503).json({ error: 'AI-vurdering er ikke konfigureret på serveren endnu.' });

        const frontMimeMatch = frontImageBase64.match(/^data:(image\/\w+);base64,/);
        const frontMimeType = frontMimeMatch ? frontMimeMatch[1] : 'image/jpeg';
        const frontData = frontImageBase64.replace(/^data:image\/\w+;base64,/, '');

        const parts = [
            { text: `Du er en professionel CGC / PSA kort-grader og markedsekspert for samlekort (Pokémon / One Piece). Analyser dette kort (${cardName || 'Ukendt kort'}) ud fra de medfølgende billeder (forside og evt. bagside). 

            Giv følgende i dit svar formateret på dansk:
            1. **Kortets identitet:** Sæt, navn og nummer (hvis det kan aflæses).
            2. **Stand-analyse:** Vurder Centering, Corners, Edges og Surface, samt en estimeret CGC-karakter.
            3. **Prisestimat (Markedsværdi):** 
               - Estimeret pris for kortet i rå/ungraded stand (baseret på gennemsnitlige markedspriser fra Cardmarket/eBay).
               - Estimeret pris for kortet i en CGC slab med den forventede karakter.
            4. **Konstruktive bemærkninger:** Ærlig begrundelse for vurderingen.` },
            { inline_data: { mime_type: frontMimeType, data: frontData } }
        ];

        if (backImageBase64) {
            const backMimeMatch = backImageBase64.match(/^data:(image\/\w+);base64,/);
            const backMimeType = backMimeMatch ? backMimeMatch[1] : 'image/jpeg';
            const backData = backImageBase64.replace(/^data:image\/\w+;base64,/, '');
            parts.push({ inline_data: { mime_type: backMimeType, data: backData } });
        }

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts }] })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData?.error?.message || 'Gemini API fejl');
        }

        const data = await response.json();
        const evaluation = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Kunne ikke generere vurdering.';

        res.json({ success: true, evaluation });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Kunne ikke gennemføre AI-vurdering.' });
    }
});

app.get('/api/pool-status', async (req, res) => {
    try {
        const result = await pool.query('SELECT count FROM pool_status WHERE id = 1');
        res.json({ count: result.rows[0] ? result.rows[0].count : 12 });
    } catch (e) {
        res.json({ count: 12 });
    }
});

app.post('/api/admin/pool-status', checkAdmin, async (req, res) => {
    const { count } = req.body;
    const numCount = parseInt(count, 10);
    if (isNaN(numCount)) return res.status(400).json({ error: 'Ugyldigt antal' });
    try {
        await pool.query('INSERT INTO pool_status (id, count) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET count = $1', [numCount]);
        res.json({ success: true, count: numCount });
    } catch (e) {
        res.status(500).json({ error: 'Kunne ikke opdatere pulje' });
    }
});

app.get('/api/admin/orders', checkAdmin, async (req, res) => {
    try {
        let orders = { rows: [], rowCount: 0 };
        let poolCards = 12;
        let members = 0;
        let paidRevenueDkk = 0;

        try {
            const ordersRes = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
            orders = ordersRes;
        } catch (e) {}

        try {
            const poolRes = await pool.query('SELECT count FROM pool_status WHERE id = 1');
            if (poolRes.rows[0]) poolCards = poolRes.rows[0].count;
        } catch (e) {}

        try {
            const membersRes = await pool.query('SELECT COUNT(*) FROM users WHERE membership_active = true');
            if (membersRes.rows[0]) members = parseInt(membersRes.rows[0].count, 10);
        } catch (e) {}

        try {
            const revenueRes = await pool.query("SELECT SUM(total_dkk) FROM orders WHERE payment_status = 'paid'");
            if (revenueRes.rows[0]?.sum) paidRevenueDkk = revenueRes.rows[0].sum;
        } catch (e) {}

        res.json({
            orders: orders.rows,
            stats: { poolCards, members, paidRevenueDkk, orders: orders.rowCount },
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

// ADMIN: OPDATÉR ORDRE OG SEND AUTOMATISK E-MAIL VIA BREVO
app.patch('/api/admin/orders/:id', checkAdmin, async (req, res) => {
    const { id } = req.params;
    const { status, trackingNumber } = req.body;
    
    const statusLabels = {
        'modtaget': 'Ordre Modtaget',
        'under_behandling': 'Under Behandling',
        'sendt_cgc': 'Sendt til CGC (USA)',
        'hos_cgc': 'Hos CGC til Gradering',
        'retur': 'Pakket & Retur til Kunde'
    };

    try {
        if (status) await pool.query('UPDATE orders SET status = $1 WHERE order_id = $2', [status, id]);
        if (trackingNumber !== undefined) await pool.query('UPDATE orders SET tracking_number = $1 WHERE order_id = $2', [trackingNumber, id]);

        const orderRes = await pool.query('SELECT customer_name, customer_email, order_id, tier, qty, tracking_number, status FROM orders WHERE order_id = $1', [id]);
        
        if (orderRes.rows.length > 0) {
            const order = orderRes.rows[0];
            const brevoApiKey = process.env.BREVO_API_KEY;

            if (brevoApiKey && order.customer_email) {
                const currentStatusLabel = statusLabels[order.status] || order.status;
                const trackingSection = order.tracking_number 
                    ? `<p style="background: #1a1e29; padding: 12px; border-radius: 6px; border: 1px solid #333;"><b>Trackingnummer / PostNord:</b> ${order.tracking_number}</p>` 
                    : '';

                fetch('https://api.brevo.com/v3/smtp/email', {
                    method: 'POST',
                    headers: {
                        'accept': 'application/json',
                        'api-key': brevoApiKey,
                        'content-type': 'application/json'
                    },
                    body: JSON.stringify({
                        sender: { name: 'The Poke Bros', email: 'kontakt@thepokebros.com' },
                        to: [{ email: order.customer_email, name: order.customer_name || 'Kunde' }],
                        subject: `📦 Opdatering på din grading-ordre (${order.order_id})`,
                        htmlContent: `
                            <div style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px; color: #333;">
                                <div style="max-width: 600px; margin: 0 auto; background: #111318; color: #fff; padding: 40px; border-radius: 12px; border: 1px solid #222;">
                                    <h2 style="color: #e63946; margin-top: 0; text-align: center;">Ordreopdatering 🚀</h2>
                                    <p>Hej <b>${order.customer_name || 'Samler'}</b>,</p>
                                    <p>Der er nyt omkring din CGC-indsendelse for ordre <b>${order.order_id}</b> (${order.qty} stk. ${order.tier.toUpperCase()}).</p>
                                    
                                    <div style="background: #1a1e29; padding: 20px; border-radius: 8px; border: 1px solid #e63946; margin: 25px 0; text-align: center;">
                                        <span style="font-size: 12px; color: #aaa; text-transform: uppercase; display: block; margin-bottom: 5px;">Nuværende status</span>
                                        <span style="font-size: 20px; color: #2ec4b6; font-weight: bold;">${currentStatusLabel}</span>
                                    </div>

                                    ${trackingSection}

                                    <p style="margin-top: 25px;">Du kan til enhver tid tjekke den fulde tidslinje og status ved at logge ind på din konto på <a href="https://www.thepokebros.com/account.html" style="color: #e63946;">www.thepokebros.com</a>.</p>
                                    
                                    <p style="margin-top: 40px; text-align: center; color: #888; font-size: 13px;">
                                        De bedste hilsner,<br>
                                        <b>The Poke Bros Team</b>
                                    </p>
                                </div>
                            </div>
                        `
                    })
                }).catch(err => console.error('Fejl ved afsendelse af status-mail:', err.message));
            }
        }

        res.json({ success: true });
    } catch (e) {
        console.error('Ordreopdateringsfejl:', e);
        res.status(500).json({ error: 'Kunne ikke opdatere ordre' });
    }
});

app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
        res.json({ products: result.rows });
    } catch (e) {
        res.json({ products: [] });
    }
});

app.post('/api/admin/products', checkAdmin, async (req, res) => {
    const { title, category, priceDkk, imageUrl } = req.body || {};
    if (!title || !priceDkk) return res.status(400).json({ error: 'Titel og pris er påkrævet' });
    try {
        const numericPrice = parseInt(priceDkk, 10);
        await pool.query(
            'INSERT INTO products (title, category, price_dkk, image_url, status) VALUES ($1, $2, $3, $4, $5)',
            [title, category || 'Diverse', numericPrice, imageUrl || '', 'til salg']
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Kunne ikke oprette produkt: ' + e.message });
    }
});

app.patch('/api/admin/products/:id', checkAdmin, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        await pool.query('UPDATE products SET status = $1 WHERE id = $2', [status, id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Kunne ikke opdatere status' });
    }
});

app.delete('/api/admin/products/:id', checkAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM products WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Kunne ikke slette produkt' });
    }
});

// FÆLLES FUNKTION TIL AT MARKERE ORDRE SOM BETALT, GIVE POKECOINS OG SENDE KVITTERING
async function finalizeOrderAsPaid(orderId) {
    try {
        const updateRes = await pool.query(
            "UPDATE orders SET payment_status = 'paid' WHERE order_id = $1 RETURNING *",
            [orderId]
        );

        if (updateRes.rows.length > 0) {
            const order = updateRes.rows[0];
            
            if (order.customer_email && order.total_dkk) {
                const earnedCoins = Math.round(order.total_dkk);
                await pool.query(
                    'UPDATE users SET points = COALESCE(points, 0) + $1 WHERE email = $2',
                    [earnedCoins, order.customer_email]
                ).catch(() => {});
            }

            sendOrderReceiptEmail(order);
            return true;
        }
    } catch (err) {
        console.error('Fejl ved finalisering af ordre:', err);
    }
    return false;
}

app.post('/api/order-success', async (req, res) => {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Ordre ID mangler' });

    const success = await finalizeOrderAsPaid(orderId);
    if (success) {
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Ordre ikke fundet' });
    }
});

app.post('/api/checkout', async (req, res) => {
    try {
        const { name, email, phone, address, postal, city, qty, tier, shippingMethod, notes, coupon } = req.body;
        const basePrices = { bulk: 279, economy: 299, standard: 499, express: 899, walkthrough: 2199, unlimited: 2199 };
        let pricePerCard = basePrices[tier] || 279;

        if (req.session.userId) {
            const userRes = await pool.query('SELECT membership_active, membership_plan FROM users WHERE id = $1', [req.session.userId]);
            const userObj = userRes.rows[0];
            if (userObj?.membership_active || userObj?.membership_plan === 'free') {
                if (tier === 'bulk') pricePerCard = 249;
                else pricePerCard = Math.round(pricePerCard * 0.95);
            }
        }

        let subtotal = (qty || 1) * pricePerCard;
        let shipPrice = shippingMethod === 'hjemmelevering' ? 69 : 49;
        let totalDkk = subtotal + shipPrice;

        if (coupon && coupon.trim().toUpperCase() === 'MASTER2026') {
            totalDkk -= Math.round(totalDkk * 0.10);
        }

        const orderId = 'TPB-' + Math.floor(100000 + Math.random() * 900000);

        // Opret altid en rigtig Stripe Checkout Session
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
        res.status(500).json({ error: 'Kunne ikke oprette betaling: ' + err.message });
    }
});

app.post('/api/membership-checkout', async (req, res) => {
    try {
        if (!req.session.userId) return res.status(401).json({ error: 'Du skal være logget ind.' });
        const { plan } = req.body;
        const priceDkk = plan === 'yearly' ? 599 : 59;

        const sessionStripe = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'dkk',
                    product_data: { name: `Poke Bro Medlemskab (${plan === 'yearly' ? 'Årligt' : 'Månedligt'})` },
                    unit_amount: priceDkk * 100,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${req.protocol}://${req.get('host')}/account.html?membership=success`,
            cancel_url: `${req.protocol}://${req.get('host')}/index.html#membership`,
        });

        res.json({ url: sessionStripe.url });
    } catch (err) {
        res.status(500).json({ error: 'Kunne ikke starte medlemskab.' });
    }
});

app.listen(port, () => {
    console.log(`Server kører på port ${port}`);
});

const express=require('express'),path=require('path'),crypto=require('crypto'),helmet=require('helmet'),rateLimit=require('express-rate-limit');
const {Pool}=require('pg'); const app=express(); const PORT=process.env.PORT||3000;

async function sendEmailViaBrevo({ to, subject, html }) {
    const apiKey = process.env.BREVO_API_KEY || process.env.SMTP_PASS; 
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ sender: { name: 'The Poke Bros', email: 'thomaslydholmjob98@gmail.com' }, to: [{ email: to }], subject: subject, htmlContent: html })
    });
    if (!response.ok) { const errData = await response.json(); throw new Error(`Brevo API Fejl (${response.status}): ${JSON.stringify(errData)}`); }
    return await response.json();
}

async function sendWelcomeEmail(toEmail, userName) {
    try {
        await sendEmailViaBrevo({
            to: toEmail, subject: 'Velkommen til Poke Bros!',
            html: `<div style="font-family: Arial, sans-serif; padding: 20px; color: #333;"><h2>Velkommen til Poke Bros, ${userName}!</h2><p>Mange tak fordi du oprettede en konto hos os.</p><p>Husk at du kan bruge koden <code>MASTER2026</code> til at få 10% rabat på din første ordre (kræver login)!</p><br><p>Med venlig hilsen,<br><strong>Poke Bros</strong></p></div>`
        });
    } catch (err) { console.error('Fejl ved velkomstmail:', err); }
}

async function sendOrderStatusEmail(toEmail, customerName, orderId, statusLabel, trackingNumber = '') {
    try {
        await sendEmailViaBrevo({
            to: toEmail, subject: `[Poke Bros] Statusopdatering for ordre ${orderId}`,
            html: `<div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 8px;"><h2 style="color: #e63946;">Statusopdatering på din ordre</h2><p>Hej ${customerName},</p><p>Der er en ny opdatering vedrørende din ordre <strong>${orderId}</strong>.</p><div style="background: #f8f9fa; padding: 15px; border-radius: 6px; margin: 20px 0; border-left: 4px solid #e63946;"><p style="margin: 0; font-size: 14px; color: #666;">Ny status:</p><h3 style="margin: 5px 0 0 0; color: #1a1a1a;">${statusLabel}</h3></div>${trackingNumber ? `<p><strong>Trackingnummer:</strong> ${trackingNumber}</p>` : ''}<p><a href="https://www.thepokebros.com/track.html" style="background: #e63946; color: #fff; padding: 10px 18px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: bold;">Følg din ordre her</a></p><br><p>Med venlig hilsen,<br><strong>The Poke Bros</strong></p></div>`
        });
    } catch (err) { console.error('Fejl ved statusmail:', err); }
}

if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL mangler');
const db=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DB_SSL==='false'?false:{rejectUnauthorized:false}});

db.query(`
    CREATE TABLE IF NOT EXISTS products (
        id VARCHAR(64) PRIMARY KEY, title VARCHAR(255) NOT NULL, category VARCHAR(64) NOT NULL,
        category_label VARCHAR(64), price_dkk INT NOT NULL, image_url TEXT, sold BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS site_settings (
        key VARCHAR(64) PRIMARY KEY,
        value TEXT
    );
`).catch(err => console.error('Kunne ikke oprette tabeller:', err));

const TIERS={bulk:{name:'CGC Bulk grading',price:279},economy:{name:'CGC Economy grading',price:299},standard:{name:'CGC Standard grading',price:499},express:{name:'CGC Express grading',price:899},walkthrough:{name:'CGC WalkThrough grading',price:2199},unlimited:{name:'CGC Unlimited Value grading',price:2199}};
const RETURN_SHIPPING_DKK=69;
const STATUS={payment_pending:'Afventer betaling',awaiting_cards:'Afventer dine kort',cards_received:'Kort modtaget hos The Poke Bros',awaiting_batch:'Venter på næste CGC-pulje',sent_to_cgc:'Sendt til CGC',cgc_grading:'Hos CGC / grading i gang',returning_from_cgc:'På vej retur fra CGC',ready_to_ship:'Klar til retur til dig',shipped:'Sendt retur til dig',completed:'Afsluttet',issue:'Kræver afklaring'};
if(process.env.TRUST_PROXY==='1')app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:false})); app.use(rateLimit({windowMs:15*60*1000,limit:300,standardHeaders:'draft-7',legacyHeaders:false}));
function parseCookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [decodeURIComponent(x.slice(0,i)),decodeURIComponent(x.slice(i+1))]}));}
function scryptHash(p,s=crypto.randomBytes(16).toString('hex')){return `${s}:${crypto.scryptSync(p,s,64).toString('hex')}`};
function verifyPassword(p,stored){const [s,h]=String(stored||'').split(':');if(!s||!h)return false;const a=crypto.scryptSync(p,s,64),b=Buffer.from(h,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b)}
function publicUser(u){return{id:u.id,name:u.name,email:u.email,phone:u.phone||'',membership:{active:!!u.membership_active,plan:u.membership_plan||null}}}
function priceFor(k,u){const base=(TIERS[k]||TIERS.bulk).price;if(!u?.membership_active)return base;return k==='bulk'?249:Math.round(base*.95)}
async function sessionUser(req){const t=parseCookies(req).tpb_session;if(!t)return null;const h=crypto.createHash('sha256').update(t).digest('hex');const r=await db.query('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()',[h]);return r.rows[0]||null}
async function setSession(res,id){const t=crypto.randomBytes(32).toString('hex'),h=crypto.createHash('sha256').update(t).digest('hex');await db.query('DELETE FROM sessions WHERE expires_at<=NOW()');await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')",[h,id]);res.setHeader('Set-Cookie',`tpb_session=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV==='production'?'; Secure':''}`)}
async function clearSession(req,res){const t=parseCookies(req).tpb_session;if(t)await db.query('DELETE FROM sessions WHERE token_hash=$1',[crypto.createHash('sha256').update(t).digest('hex')]);res.setHeader('Set-Cookie',`tpb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.NODE_ENV==='production'?'; Secure':''}`)}
function adminOK(req){const e=process.env.ADMIN_PASSWORD,g=req.get('x-admin-password')||'';if(!e)return false;const a=Buffer.from(e),b=Buffer.from(g);return a.length===b.length&&crypto.timingSafeEqual(a,b)}
async function timeline(id,status,note=''){await db.query('INSERT INTO order_timeline(order_id,status,label,note) VALUES($1,$2,$3,$4)',[id,status,STATUS[status]||status,note])}
async function publicOrder(id){const r=await db.query('SELECT * FROM orders WHERE order_id=$1',[id]);if(!r.rows[0])return null;const o=r.rows[0],t=await db.query('SELECT at,status,label,note FROM order_timeline WHERE order_id=$1 ORDER BY at',[id]);return{orderId:o.order_id,createdAt:o.created_at,qty:o.qty,tier:o.tier,totalDkk:o.total_dkk,paymentStatus:o.payment_status,status:o.status,statusLabel:STATUS[o.status]||o.status,batch:o.batch,trackingNumber:o.tracking_number,timeline:t.rows}}
async function activateMembership(email,plan,cust,sub){await db.query('UPDATE users SET membership_active=TRUE,membership_plan=$1,membership_started_at=NOW(),membership_ended_at=NULL,stripe_customer_id=$2,stripe_subscription_id=$3 WHERE email=$4',[plan,cust||null,sub||null,String(email||'').toLowerCase()])}

app.post('/api/stripe-webhook',express.raw({type:'application/json'}),async(req,res)=>{try{if(!process.env.STRIPE_SECRET_KEY||!process.env.STRIPE_WEBHOOK_SECRET)return res.status(503).send('Stripe ikke konfigureret');const stripe=require('stripe')(process.env.STRIPE_SECRET_KEY);const ev=stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET);if(ev.type==='checkout.session.completed'){const s=ev.data.object;if(s.metadata?.type==='membership')await activateMembership(s.customer_details?.email||s.customer_email,s.metadata?.plan||'monthly',s.customer,s.subscription);else if(s.metadata?.type==='shop_product'){await db.query('UPDATE products SET sold=TRUE WHERE id=$1',[s.metadata.productId]);}else if(s.metadata?.orderId){const status=s.payment_status==='paid'?'paid':s.payment_status;const q=await db.query('UPDATE orders SET payment_status=$1,stripe_session_id=$2,status=CASE WHEN $1=\'paid\' AND status=\'payment_pending\' THEN \'awaiting_cards\' ELSE status END WHERE order_id=$3 RETURNING status',[status,s.id,s.metadata.orderId]);if(q.rows[0]?.status==='awaiting_cards')await timeline(s.metadata.orderId,'awaiting_cards','Betaling registreret.')}}if(ev.type==='customer.subscription.deleted')await db.query('UPDATE users SET membership_active=FALSE,membership_ended_at=NOW() WHERE stripe_subscription_id=$1',[ev.data.object.id]);res.json({received:true})}catch(e){console.error(e);res.status(400).send('Webhook Error')}});
app.use(express.json({limit:'100kb'})); app.use(express.static(__dirname,{extensions:['html']}));
const authLimiter=rateLimit({windowMs:15*60*1000,limit:30});

app.get('/api/pool-status', async (req, res) => {
    try {
        const manual = await db.query("SELECT value FROM site_settings WHERE key='manual_pool_count'");
        if (manual.rows[0] && manual.rows[0].value !== null && manual.rows[0].value !== '') {
            return res.json({ count: Number(manual.rows[0].value) });
        }
        const r = await db.query("SELECT SUM(qty) as total FROM orders WHERE status IN ('cards_received', 'awaiting_batch')");
        const count = Number(r.rows[0]?.total || 0);
        res.json({ count });
    } catch (e) { res.json({ count: 0 }); }
});

app.post('/api/admin/pool-status', async (req, res) => {
    if (!adminOK(req)) return res.status(401).json({ error: 'Forkert.' });
    try {
        const { count } = req.body;
        await db.query("INSERT INTO site_settings (key, value) VALUES ('manual_pool_count', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [String(count)]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Fejl.' }); }
});

app.get('/api/products', async (req, res) => {
    try { const r = await db.query('SELECT * FROM products WHERE sold=FALSE ORDER BY created_at DESC'); res.json(r.rows); } catch (err) { res.status(500).json({ error: 'Fejl' }); }
});

app.post('/api/shop-checkout', async (req, res) => {
    try {
        const { productId } = req.body || {};
        const r = await db.query('SELECT * FROM products WHERE id=$1 AND sold=FALSE', [productId]);
        const product = r.rows[0];
        if (!product) return res.status(404).json({ error: 'Solgt.' });
        if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Ikke aktiveret.' });
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
        const s = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items: [{ price_data: { currency: 'dkk', product_data: { name: product.title }, unit_amount: product.price_dkk * 100 }, quantity: 1 }, { price_data: { currency: 'dkk', product_data: { name: 'Forsikret Fragt' }, unit_amount: RETURN_SHIPPING_DKK * 100 }, quantity: 1 }],
            metadata: { type: 'shop_product', productId: product.id },
            success_url: `${base}/shop.html?bought=success`, cancel_url: `${base}/shop.html`
        });
        res.json({ url: s.url });
    } catch (err) { res.status(500).json({ error: 'Fejl' }); }
});

app.post('/api/admin/products', async (req, res) => {
    if (!adminOK(req)) return res.status(401).json({ error: 'Forkert.' });
    try {
        const { title, category, categoryLabel, priceDkk, imageUrl } = req.body || {};
        const id = 'PRD-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        await db.query('INSERT INTO products (id, title, category, category_label, price_dkk, image_url) VALUES ($1, $2, $3, $4, $5, $6)', [id, title, category, categoryLabel || category, Number(priceDkk), imageUrl || '']);
        res.json({ ok: true, id });
    } catch (err) { res.status(500).json({ error: 'Fejl' }); }
});

app.post('/api/auth/register',authLimiter,async(req,res)=>{try{const name=String(req.body?.name||'').trim(),email=String(req.body?.email||'').trim().toLowerCase(),password=String(req.body?.password||'');if(name.length<2||!email.includes('@')||password.length<10)return res.status(400).json({error:'Ugyldig.'});const id='USR-'+crypto.randomBytes(6).toString('hex');const r=await db.query('INSERT INTO users(id,name,email,phone,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,name,email,String(req.body?.phone||''),scryptHash(password)]);await setSession(res,id); sendWelcomeEmail(email, name); res.json({user:publicUser(r.rows[0])})}catch(e){res.status(500).json({error:'Fejl'})}});
app.post('/api/auth/login',authLimiter,async(req,res)=>{const email=String(req.body?.email||'').trim().toLowerCase(),password=String(req.body?.password||'');const r=await db.query('SELECT * FROM users WHERE email=$1',[email]);const u=r.rows[0];if(!u||!verifyPassword(password,u.password_hash))return res.status(401).json({error:'Forkert.'});await setSession(res,u.id);res.json({user:publicUser(u)})});
app.post('/api/auth/logout',async(req,res)=>{await clearSession(req,res);res.json({ok:true})}); app.get('/api/auth/me',async(req,res)=>{const u=await sessionUser(req);res.json({loggedIn:!!u,user:u?publicUser(u):null})});
app.get('/api/account',async(req,res)=>{const u=await sessionUser(req);if(!u)return res.status(401).json({error:'Log ind.'});const r=await db.query('SELECT order_id FROM orders WHERE user_id=$1 OR customer_email=$2 ORDER BY created_at DESC',[u.id,u.email]);const orders=[];for(const x of r.rows)orders.push(await publicOrder(x.order_id));res.json({user:publicUser(u),orders,pricing:Object.fromEntries(Object.keys(TIERS).map(k=>[k,priceFor(k,u)]))})});
app.post('/api/membership-checkout',async(req,res)=>{try{const u=await sessionUser(req);if(!u)return res.status(401).json({error:'Log ind.'});const plan=req.body?.plan==='yearly'?'yearly':'monthly',amount=plan==='yearly'?59900:5900,interval=plan==='yearly'?'year':'month',stripe=require('stripe')(process.env.STRIPE_SECRET_KEY),base=(process.env.PUBLIC_URL||`${req.protocol}://${req.get('host')}`).replace(/\/$/,'');const s=await stripe.checkout.sessions.create({mode:'subscription',customer_email:u.email,line_items:[{price_data:{currency:'dkk',product_data:{name:'Poke Bro medlemskab'},unit_amount:amount,recurring:{interval}},quantity:1}],metadata:{type:'membership',plan,userId:u.id},success_url:`${base}/account.html?membership=success`,cancel_url:`${base}/#membership`});res.json({url:s.url})}catch(e){res.status(500).json({error:'Fejl'})}});
app.post('/api/confirm-membership',async(req,res)=>{try{const u=await sessionUser(req);if(!u)return res.status(401).json({error:'Log ind.'});const stripe=require('stripe')(process.env.STRIPE_SECRET_KEY),s=await stripe.checkout.sessions.retrieve(String(req.body?.sessionId||''));if(s.metadata?.userId===u.id)await activateMembership(u.email,s.metadata.plan,s.customer,s.subscription);res.json({user:publicUser((await db.query('SELECT * FROM users WHERE id=$1',[u.id])).rows[0])})}catch(e){res.status(500).json({error:'Fejl'})}});

// CHECKOUT MED MASTERBALL-RABATKODE (Kræver login og kan kun bruges én gang pr. bruger)
app.post('/api/checkout',async(req,res)=>{try{
    const u=await sessionUser(req),qty=Math.max(1,Math.min(100,Number(req.body.qty)||1));
    const {name,email,phone,address,postal,city,notes,coupon}=req.body;
    const tierKey=String(req.body.tier||'bulk').toLowerCase(),tier=TIERS[tierKey]||TIERS.bulk;
    if(!name||!email||!address||!postal||!city)return res.status(400).json({error:'Udfyld venligst alle obligatoriske felter.'});
    if(!process.env.STRIPE_SECRET_KEY)return res.status(503).json({error:'Betaling er ikke aktiveret.'});

    let unit=priceFor(tierKey,u);
    let discountApplied=false;

    if(coupon && coupon.trim().toUpperCase()==='MASTER2026') {
        if (!u) {
            return res.status(400).json({ error: 'Du skal være logget ind for at bruge Master Ball-rabatkoden (MASTER2026).' });
        }
        const usedCheck = await db.query('SELECT COUNT(*) c FROM orders WHERE user_id=$1 AND notes LIKE $2', [u.id, '%MASTER2026%']);
        if (Number(usedCheck.rows[0].c) > 0) {
            return res.status(400).json({ error: 'Du har allerede brugt Master Ball-koden (MASTER2026). Den kan kun bruges én gang.' });
        }
        const prevOrders = await db.query('SELECT COUNT(*) c FROM orders WHERE user_id=$1', [u.id]);
        if (Number(prevOrders.rows[0].c) === 0) {
            unit = Math.round(unit * 0.9);
            discountApplied = true;
        } else {
            return res.status(400).json({ error: 'Master Ball-koden (MASTER2026) gælder kun på din allerførste ordre.' });
        }
    }

    const gradingTotal = qty * unit;
    const id='TPB-'+new Date().toISOString().slice(0,10).replaceAll('-','')+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();
    const stripe=require('stripe')(process.env.STRIPE_SECRET_KEY),base=(process.env.PUBLIC_URL||`${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

    await db.query('INSERT INTO orders(order_id,user_id,qty,tier,unit_price_dkk,member_price_applied,grading_dkk,return_shipping_dkk,total_dkk,customer_name,customer_email,customer_phone,customer_address,customer_postal,customer_city,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[id,u?.id||null,qty,tierKey,unit,!!u?.membership_active,gradingTotal,RETURN_SHIPPING_DKK,gradingTotal+RETURN_SHIPPING_DKK,name,String(email).trim().toLowerCase(),phone||'',address,postal,city,(notes||'')+(discountApplied?' [Rabatkode MASTER2026 anvendt]':'')]);
    await timeline(id,'payment_pending');

    const s=await stripe.checkout.sessions.create({
        mode:'payment', customer_email:email,
        line_items:[
            {price_data:{currency:'dkk',product_data:{name:`${tier.name} via The Poke Bros${discountApplied?' (10% rabat)':''}`},unit_amount:unit*100},quantity:qty},
            {price_data:{currency:'dkk',product_data:{name:'Forsikret returfragt i Danmark'},unit_amount:RETURN_SHIPPING_DKK*100},quantity:1}
        ],
        metadata:{orderId:id,qty:String(qty),tier:tierKey,userId:u?.id||''},
        success_url:`${base}/success.html?session_id={CHECKOUT_SESSION_ID}&order=${id}`, cancel_url:`${base}/#order`
    });
    await db.query('UPDATE orders SET stripe_session_id=$1 WHERE order_id=$2',[s.id,id]);
    res.json({url:s.url});
}catch(e){console.error(e);res.status(500).json({error:'Kunne ikke starte betaling.'})}});

app.post('/api/confirm-payment',async(req,res)=>{try{const stripe=require('stripe')(process.env.STRIPE_SECRET_KEY),s=await stripe.checkout.sessions.retrieve(req.body.sessionId);if(s.metadata?.orderId!==req.body.orderId)return res.status(400).json({error:'Fejl'});if(s.payment_status==='paid'){const q=await db.query("UPDATE orders SET payment_status='paid',status=CASE WHEN status='payment_pending' THEN 'awaiting_cards' ELSE status END WHERE order_id=$1 RETURNING status",[req.body.orderId]);if(q.rows[0]?.status==='awaiting_cards')await timeline(req.body.orderId,'awaiting_cards','Betaling registreret.');}res.json(await publicOrder(req.body.orderId))}catch(e){res.status(500).json({error:'Fejl'})}});
app.post('/api/track',async(req,res)=>{const id=String(req.body?.orderId||'').trim().toUpperCase(),email=String(req.body?.email||'').trim().toLowerCase(),r=await db.query('SELECT order_id FROM orders WHERE order_id=$1 AND customer_email=$2',[id,email]);if(!r.rows[0])return res.status(404).json({error:'Ikke fundet.'});res.json(await publicOrder(id))});

app.get('/api/admin/orders',async(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Forkert.'});const r=await db.query('SELECT * FROM orders ORDER BY created_at DESC'),orders=[];for(const o of r.rows){const p=await publicOrder(o.order_id);orders.push({...o,...p})}const poolCards=r.rows.filter(o=>['cards_received','awaiting_batch'].includes(o.status)).reduce((n,o)=>n+o.qty,0),members=Number((await db.query('SELECT COUNT(*) c FROM users WHERE membership_active=TRUE')).rows[0].c);
const manualPool = await db.query("SELECT value FROM site_settings WHERE key='manual_pool_count'");
res.json({orders,statuses:STATUS,stats:{orders:r.rowCount,poolCards:manualPool.rows[0]?.value ?? poolCards,paidRevenueDkk:r.rows.filter(o=>o.payment_status==='paid').reduce((n,o)=>n+o.total_dkk,0),members}});});

app.patch('/api/admin/orders/:id',async(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Forkert.'});const {status,batch,trackingNumber,note}=req.body||{};const cur=(await db.query('SELECT * FROM orders WHERE order_id=$1',[req.params.id])).rows[0];if(!cur)return res.status(404).json({error:'Ikke fundet.'});
if(status&&status!==cur.status){await db.query('UPDATE orders SET status=$1 WHERE order_id=$2',[status,req.params.id]);await timeline(req.params.id,status,note||'');sendOrderStatusEmail(cur.customer_email,cur.customer_name,cur.order_id,STATUS[status]||status,trackingNumber||cur.tracking_number);}
if(batch!==undefined)await db.query('UPDATE orders SET batch=$1 WHERE order_id=$2',[String(batch||'').trim()||null,req.params.id]);
if(trackingNumber!==undefined)await db.query('UPDATE orders SET tracking_number=$1 WHERE order_id=$2',[String(trackingNumber||'').trim()||null,req.params.id]);
res.json(await publicOrder(req.params.id))});

app.post('/api/sell-collection', authLimiter, async (req, res) => {
    try {
        const { name, email, phone, description, link } = req.body || {};
        if (!name || !email || !description) return res.status(400).json({ error: 'Udfyld felter.' });
        await sendEmailViaBrevo({ to: 'thomaslydholmjob98@gmail.com', subject: `[Poke Bros Opkøb] Ny samling af ${name}`, html: `<p><b>Navn:</b> ${name}</p><p><b>Email:</b> ${email}</p><p>${description}</p>` });
        res.json({ ok: true, message: 'Sendt!' });
    } catch (e) { res.status(500).json({ error: 'Fejl' }); }
});

app.get('/api/health',async(req,res)=>{try{await db.query('SELECT 1');res.json({ok:true})}catch{res.status(503).json({ok:false})}});
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Serverfejl.'})});
app.listen(PORT,()=>console.log(`The Poke Bros kører på port ${PORT}`));

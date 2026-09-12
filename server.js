const express=require('express'),path=require('path'),crypto=require('crypto'),helmet=require('helmet'),rateLimit=require('express-rate-limit');
const {Pool}=require('pg'); const app=express(); const PORT=process.env.PORT||3000;
const nodemailer = require('nodemailer');

// Opret transporter ud fra variablerne på Render
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// Hjælpefunktion til at sende velkomstmail
async function sendWelcomeEmail(toEmail, userName) {
    try {
        await transporter.sendMail({
            from: process.env.EMAIL_FROM || 'Poke Bros <noreply@thepokebros.com>',
            to: toEmail,
            subject: 'Velkommen til Poke Bros!',
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                    <h2>Velkommen til Poke Bros, ${userName}!</h2>
                    <p>Mange tak fordi du oprettede en konto hos os.</p>
                    <p>Du kan til enhver tid logge ind og se din konto på <a href="https://www.thepokebros.com/account.html">thepokebros.com</a>.</p>
                    <br>
                    <p>Med venlig hilsen,<br><strong>Poke Bros</strong></p>
                </div>
            `
        });
        console.log(`Velkomstmail sendt til ${toEmail}`);
    } catch (err) {
        console.error('Fejl ved afsendelse af e-mail:', err);
    }
}

if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL mangler');
const db=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DB_SSL==='false'?false:{rejectUnauthorized:false}});
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
app.post('/api/stripe-webhook',express.raw({type:'application/json'}),async(req,res)=>{try{if(!process.env.STRIPE_SECRET_KEY||!process.env.STRIPE_WEBHOOK_SECRET)return res.status(503).send('Stripe ikke konfigureret');const stripe=require('stripe')(process.env.STRIPE_SECRET_KEY);const ev=stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET);if(ev.type==='checkout.session.completed'){const s=ev.data.object;if(s.metadata?.type==='membership')await activateMembership(s.customer_details?.email||s.customer_email,s.metadata?.plan||'monthly',s.customer,s.subscription);else if(s.metadata?.orderId){const status=s.payment_status==='paid'?'paid':s.payment_status;const q=await db.query('UPDATE orders SET payment_status=$1,stripe_session_id=$2,status=CASE WHEN $1=\'paid\' AND status=\'payment_pending\' THEN \'awaiting_cards\' ELSE status END WHERE order_id=$3 RETURNING status',[status,s.id,s.metadata.orderId]);if(q.rows[0]?.status==='awaiting_cards')await timeline(s.metadata.orderId,'awaiting_cards','Betaling registreret.')}}if(ev.type==='customer.subscription.deleted')await db.query('UPDATE users SET membership_active=FALSE,membership_ended_at=NOW() WHERE stripe_subscription_id=$1',[ev.data.object.id]);res.json({received:true})}catch(e){console.error(e);res.status(400).send('Webhook Error')}});
app.use(express.json({limit:'100kb'})); app.use(express.static(__dirname,{extensions:['html']}));
const authLimiter=rateLimit({windowMs:15*60*1000,limit:30});

app.post('/api/auth/register',authLimiter,async(req,res)=>{try{const name=String(req.body?.name||'').trim(),email=String(req.body?.email||'').trim().toLowerCase(),password=String(req.body?.password||'');if(name.length<2||!email.includes('@')||password.length<10)return res.status(400).json({error:'Brug navn, gyldig e-mail og mindst 10 tegn i adgangskoden.'});const id='USR-'+crypto.randomBytes(6).toString('hex');const r=await db.query('INSERT INTO users(id,name,email,phone,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,name,email,String(req.body?.phone||''),scryptHash(password)]);await setSession(res,id);

// Send automatisk velkomstmail
sendWelcomeEmail(email, name);

res.json({user:publicUser(r.rows[0])})}catch(e){if(e.code==='23505')return res.status(409).json({error:'Der findes allerede en konto med den e-mail.'});console.error(e);res.status(500).json({error:'Kontoen kunne ikke oprettes.'})}});

app.post('/api/auth/login',authLimiter,async(req,res)=>{const email=String(req.body?.email||'').trim().toLowerCase(),password=String(req.body?.password||'');const r=await db.query('SELECT * FROM users WHERE email=$1',[email]);const u=r.rows[0];if(!u||!verifyPassword(password,u.password_hash))return res.status(401).json({error:'Forkert e-mail eller adgangskode.'});await setSession(res,u.id);res.json({user:publicUser(u)})});
app.post('/api/auth/logout',async(req,res)=>{await clearSession(req,res);res.json({ok:true})}); app.get('/api/auth/me',async(req,res)=>{const u=await sessionUser(req);res.json({loggedIn:!!u,user:u?publicUser(u):null})});
app.get('/api/account',async(req,res)=>{const u=await sessionUser(req);if(!u)return res.status(401).json({error:'Log ind for at se din konto.'});const r=await db.query('SELECT order_id FROM orders WHERE user_id=$1 OR customer_email=$2 ORDER BY created_at DESC',[u.id,u.email]);const orders=[];for(const x of r.rows)orders.push(await publicOrder(x.order_id));res.json({user:publicUser(u),orders,pricing:Object.fromEntries(Object.keys(TIERS).map(k=>[k,priceFor(k,u)]))})});
app.post('/api/membership-checkout',async(req,res)=>{try{const u=await sessionUser(req);if(!u)return res.status(401).json({error:'Log ind først.'});if(u.membership_active)return res.status(400).json({error:'Du har allerede et aktivt medlemskab.'});if(!process.env.STRIPE_SECRET_KEY)return res.status(503).json({error:'Betaling er ikke aktiveret.'});const plan=req.body?.plan==='yearly'?'yearly':'monthly',amount=plan==='yearly'?59900:5900,interval=plan==='yearly'?'year':'month',stripe=require('stripe')(process.env.STRIPE_SECRET_KEY),base=(process.env.PUBLIC_URL||`${req.protocol}://${req.get('host')}`).replace(/\/$/,'');const s=await stripe.checkout.sessions.create({mode:'subscription',customer_email:u.email,line_items:[{price_data:{currency:'dkk',product_data:{name:'Poke Bro medlemskab'},unit_amount:amount,recurring:{interval}},quantity:1}],metadata:{type:'membership',plan,userId:u.id},success_url:`${base}/account.html?membership=success&session_id={CHECKOUT_SESSION_ID}`,cancel_url:`${base}/#membership`});res.json({url:s.url})}catch(e){console.error(e);res.status(500).json({error:'Medlemsbetalingen kunne ikke startes.'})}});
app.post('/api/confirm-membership',async(req,res)=>{try{const u=await sessionUser(req);if(!u)return res.status(401).json({error:'Log ind igen.'});const stripe=require('stripe')(process.env.STRIPE_SECRET_KEY),s=await stripe.checkout.sessions.retrieve(String(req.body?.sessionId||''));if(s.metadata?.type!=='membership'||s.metadata?.userId!==u.id)return res.status(400).json({error:'Betalingen matcher ikke kontoen.'});if(s.payment_status==='paid'||s.status==='complete')await activateMembership(u.email,s.metadata.plan,s.customer,s.subscription);const f=(await db.query('SELECT * FROM users WHERE id=$1',[u.id])).rows[0];res.json({user:publicUser(f)})}catch(e){res.status(500).json({error:'Kunne ikke bekræfte medlemskabet.'})}});
app.post('/api/checkout',async(req,res)=>{try{const u=await sessionUser(req),qty=Math.max(1,Math.min(100,Number(req.body.qty)||1)),{name,email,phone,address,postal,city,notes}=req.body,tierKey=String(req.body.tier||'bulk').toLowerCase(),tier=TIERS[tierKey]||TIERS.bulk;if(!name||!email||!address||!postal||!city)return res.status(400).json({error:'Udfyld navn, e-mail og adresse.'});if(u&&String(email).trim().toLowerCase()!==u.email)return res.status(400).json({error:'Brug samme e-mail som din konto.'});if(!process.env.STRIPE_SECRET_KEY)return res.status(503).json({error:'Betaling er ikke aktiveret.'});const unit=priceFor(tierKey,u),id='TPB-'+new Date().toISOString().slice(0,10).replaceAll('-','')+'-'+crypto.randomBytes(3).toString('hex').toUpperCase(),stripe=require('stripe')(process.env.STRIPE_SECRET_KEY),base=(process.env.PUBLIC_URL||`${req.protocol}://${req.get('host')}`).replace(/\/$/,'');await db.query('INSERT INTO orders(order_id,user_id,qty,tier,unit_price_dkk,member_price_applied,grading_dkk,return_shipping_dkk,total_dkk,customer_name,customer_email,customer_phone,customer_address,customer_postal,customer_city,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[id,u?.id||null,qty,tierKey,unit,!!u?.membership_active,qty*unit,RETURN_SHIPPING_DKK,qty*unit+RETURN_SHIPPING_DKK,name,String(email).trim().toLowerCase(),phone||'',address,postal,city,notes||'']);await timeline(id,'payment_pending');const s=await stripe.checkout.sessions.create({mode:'payment',customer_email:email,line_items:[{price_data:{currency:'dkk',product_data:{name:`${tier.name} via The Poke Bros`,description:tierKey==='unlimited'?`${qty} kort • CGC FMV-tillæg afregnes særskilt`:`${qty} kort`},unit_amount:unit*100},quantity:qty},{price_data:{currency:'dkk',product_data:{name:'Returfragt i Danmark'},unit_amount:RETURN_SHIPPING_DKK*100},quantity:1}],metadata:{orderId:id,qty:String(qty),tier:tierKey,userId:u?.id||''},success_url:`${base}/success.html?session_id={CHECKOUT_SESSION_ID}&order=${id}`,cancel_url:`${base}/#order`});await db.query('UPDATE orders SET stripe_session_id=$1 WHERE order_id=$2',[s.id,id]);res.json({url:s.url})}catch(e){console.error(e);res.status(500).json({error:'Betalingen kunne ikke startes.'})}});
app.post('/api/confirm-payment',async(req,res)=>{try{const stripe=require('stripe')(process.env.STRIPE_SECRET_KEY),s=await stripe.checkout.sessions.retrieve(req.body.sessionId);if(s.metadata?.orderId!==req.body.orderId)return res.status(400).json({error:'Ordren matcher ikke betalingen.'});if(s.payment_status==='paid'){const q=await db.query("UPDATE orders SET payment_status='paid',status=CASE WHEN status='payment_pending' THEN 'awaiting_cards' ELSE status END WHERE order_id=$1 RETURNING status",[req.body.orderId]);if(q.rows[0]?.status==='awaiting_cards')await timeline(req.body.orderId,'awaiting_cards','Betaling registreret.')}res.json(await publicOrder(req.body.orderId))}catch(e){res.status(500).json({error:'Kunne ikke bekræfte betalingen.'})}});
app.post('/api/track',async(req,res)=>{const id=String(req.body?.orderId||'').trim().toUpperCase(),email=String(req.body?.email||'').trim().toLowerCase(),r=await db.query('SELECT order_id FROM orders WHERE order_id=$1 AND customer_email=$2',[id,email]);if(!r.rows[0])return res.status(404).json({error:'Ordren blev ikke fundet.'});res.json(await publicOrder(id))});
app.get('/api/admin/orders',async(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Forkert admin-adgangskode.'});const r=await db.query('SELECT * FROM orders ORDER BY created_at DESC'),orders=[];for(const o of r.rows){const p=await publicOrder(o.order_id);orders.push({...o,...p})}const poolCards=r.rows.filter(o=>['cards_received','awaiting_batch'].includes(o.status)).reduce((n,o)=>n+o.qty,0),members=Number((await db.query('SELECT COUNT(*) c FROM users WHERE membership_active=TRUE')).rows[0].c);res.json({orders,statuses:STATUS,stats:{orders:r.rowCount,poolCards,paidRevenueDkk:r.rows.filter(o=>o.payment_status==='paid').reduce((n,o)=>n+o.total_dkk,0),members}})});
app.patch('/api/admin/orders/:id',async(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Forkert admin-adgangskode.'});const {status,batch,trackingNumber,note}=req.body||{};if(status&&!STATUS[status])return res.status(400).json({error:'Ukendt status.'});const cur=(await db.query('SELECT * FROM orders WHERE order_id=$1',[req.params.id])).rows[0];if(!cur)return res.status(404).json({error:'Ordren blev ikke fundet.'});if(status&&status!==cur.status){await db.query('UPDATE orders SET status=$1 WHERE order_id=$2',[status,req.params.id]);await timeline(req.params.id,status,note||'')}if(batch!==undefined)await db.query('UPDATE orders SET batch=$1 WHERE order_id=$2',[String(batch||'').trim()||null,req.params.id]);if(trackingNumber!==undefined)await db.query('UPDATE orders SET tracking_number=$1 WHERE order_id=$2',[String(trackingNumber||'').trim()||null,req.params.id]);res.json(await publicOrder(req.params.id))});
app.get('/api/health',async(req,res)=>{try{await db.query('SELECT 1');res.json({ok:true})}catch{res.status(503).json({ok:false})}});
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Der opstod en serverfejl.'})});
app.listen(PORT,()=>console.log(`The Poke Bros kører på port ${PORT}`));
// Route til "Sælg din samling" formularen
app.post('/api/sell-collection', authLimiter, async (req, res) => {
    try {
        const { name, email, phone, description, link } = req.body;

        if (!name || !email || !description) {
            return res.status(400).json({ error: 'Udfyld venligst navn, e-mail og beskrivelse af samlingen.' });
        }

        // Send mail til dig selv om det nye tilbud
        await transporter.sendMail({
            from: process.env.EMAIL_FROM || 'Poke Bros <thomaslydholmjob98@gmail.com>',
            to: 'thomaslydholmjob98@gmail.com',
            subject: `[Poke Bros Opkøb] Ny samling indsendt af ${name}`,
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                    <h2>Ny henvendelse: Sælg Samling</h2>
                    <p><strong>Navn:</strong> ${name}</p>
                    <p><strong>E-mail:</strong> ${email}</p>
                    <p><strong>Telefon:</strong> ${phone || 'Ikke angivet'}</p>
                    <hr style="border: 0; border-top: 1px solid #ccc;">
                    <h3>Beskrivelse af samlingen:</h3>
                    <p style="white-space: pre-wrap;">${description}</p>
                    ${link ? `<p><strong>Link til billeder / Drive / Imgur:</strong> <a href="${link}" target="_blank">${link}</a></p>` : ''}
                </div>
            `
        });

        res.json({ ok: true, message: 'Tak for din henvendelse! Vi vender tilbage med et tilbud inden for 24 timer.' });
    } catch (err) {
        console.error('Fejl ved indsendelse af samling:', err);
        res.status(500).json({ error: 'Kunne ikke sende din henvendelse. Prøv igen senere.' });
    }
});

THE POKE BROS – LAUNCH BUILD V9

Denne build er gjort produktionsklar i selve koden: PostgreSQL-database, server-side sessions, hashed passwords, rate limiting, Helmet security headers, Stripe Checkout/webhook, ordretracking, admin, medlemskab og juridiske basissider.

DU SKAL STADIG TILFØJE EKSTERNE KONTO-OPLYSNINGER – de kan ikke bygges ind sikkert på forhånd:
1) Opret PostgreSQL (fx Render PostgreSQL/Supabase) og kopier DATABASE_URL.
2) Kør: npm install
3) Sæt environment variables fra .env.example på hosten.
4) Kør én gang: npm run db:init
5) Start: npm start
6) I Stripe: opret webhook til https://thepokebros.com/api/stripe-webhook og vælg checkout.session.completed + customer.subscription.deleted. Gem signing secret som STRIPE_WEBHOOK_SECRET.
7) Brug først Stripe TEST-nøgler. Lav komplet testordre og medlemskab. Skift derefter til live-nøgler.
8) Sæt PUBLIC_URL=https://thepokebros.com og peg Wix DNS på hosten, når testlinket virker.
9) Brug en lang, unik ADMIN_PASSWORD.

VIGTIGT FØR KOMMERCIEL LANCERING:
- Bekræft skriftligt den faktiske forsikringsdækning for tredjemands samlekort og USA-transport. Siden lover ikke ubegrænset dækning.
- Bekræft CGC-vilkår for indsendelse på vegne af kunder.
- Afklar dansk CVR/moms/skat/forbrugerregler, når aktiviteten er erhvervsmæssig eller registreringspligtig.
- Juridiske sider er praktiske basisskabeloner, ikke individuel advokatrådgivning.

PRISER I BUILD:
Bulk 279 kr.; Economy 299 kr.; Standard 499 kr.; Express 899 kr.; WalkThrough 2.199 kr.; Unlimited Value fra 2.199 kr. + evt. CGC-værdigebyr. Returfragt 69 kr.
Poke Bro: 59 kr./md. eller 599 kr./år. Medlem Bulk 249 kr.; øvrige faste tiers 5% rabat.

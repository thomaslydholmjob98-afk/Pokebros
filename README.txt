THE POKE BROS – V8 KUNDEKONTO + MEDLEMSKAB

Denne version indeholder:
- Forside med CGC grading-priser og Poke Bro-medlemskab
- Kundeoprettelse og login
- Sikker password-hashing med Node.js scrypt
- HttpOnly session-cookie (30 dage)
- Min konto-side med medlemsstatus, medlemspris, ordrer og tracking
- Aktive medlemmer får automatisk Bulk til 249 kr./kort og 5 % rabat på øvrige faste tiers
- Stripe Checkout til grading og Stripe abonnement til 59 kr./md. eller 599 kr./år
- Stripe webhook der aktiverer/deaktiverer medlemsstatus
- Ordretracking
- Admin-dashboard til ordrestatus, CGC-pulje og trackingnummer
- Kundens indsendelsesadresse vises efter bestilling

START LOKALT
1. Installer Node.js 18+
2. Kør: npm install
3. Kopiér .env.example til dine miljøvariabler hos hosten
4. Sæt STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, ADMIN_PASSWORD og PUBLIC_URL
5. Kør: npm start

STRIPE WEBHOOK
Webhook endpoint: /api/stripe-webhook
Relevante events:
- checkout.session.completed
- customer.subscription.deleted

VIGTIGT FØR RIGTIG DRIFT
Denne version bruger lokale JSON-filer (orders.json, users.json, sessions.json). Det er fint til prototype/test, men bør erstattes af en rigtig database på en produktionsserver, så ordrer, brugere og sessions ikke kan mistes ved deploy/genstart på en host med midlertidigt filsystem.

Brug HTTPS i produktion. Når NODE_ENV=production, sættes session-cookien til Secure.

Stripe secret key og webhook secret må aldrig lægges i HTML eller deles offentligt. Gem dem kun som server-side miljøvariabler.


V8.1 ændring: Economy kundepris er rettet til 299 kr. pr. kort (Bulk forbliver 279 kr.).

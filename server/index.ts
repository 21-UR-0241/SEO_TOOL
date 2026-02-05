
// import "dotenv/config";
// import express, { Request, Response, NextFunction } from "express";
// import session from "express-session";
// import pgSession from "connect-pg-simple";
// import { Pool } from "pg";
// import helmet from "helmet";
// import rateLimit from "express-rate-limit";
// import { createServer } from "http";
// import { schedulerService } from "./services/scheduler-service.ts";
// // Import billing routes (single file)
// import billingRoutes from "./routes/billing";
// import { startSubscriptionCleanupJob } from "./jobs/subscription-cleanup";
// // Import Stripe services for webhook handling
// import { stripeService } from "./services/stripe-service";
// import { WebhookHandler } from "./services/webhook-handler";
// import Stripe from "stripe";

// // =============================================================================
// // TYPE DECLARATIONS
// // =============================================================================

// declare global {
//   namespace Express {
//     interface Request {
//       user?: {
//         id: string;
//         username: string;
//         email?: string;
//         name?: string;
//         isAdmin?: boolean;
//         stripeCustomerId?: string;
//       };
//     }
//   }
// }

// declare module "express-session" {
//   interface SessionData {
//     userId: string;
//     username?: string;
//   }
// }

// // =============================================================================
// // UTILITY FUNCTIONS
// // =============================================================================

// function log(message: string) {
//   console.log(message);
// }

// // =============================================================================
// // CORS CONFIGURATION
// // =============================================================================

// const ALLOWED_ORIGINS = [
//   "https://final-seo-tool.vercel.app",
//   "http://localhost:5173",
//   "http://localhost:3000",
//   "http://localhost:5000",
// ];

// // Helper function to check if origin is allowed
// const isAllowedOrigin = (origin: string | undefined): boolean => {
//   if (!origin) return false;

//   // In production (Render), allow all vercel.app domains if enabled via env variable
//   if (
//     process.env.ALLOW_VERCEL_PREVIEWS === "true" &&
//     origin.includes(".vercel.app")
//   ) {
//     return true;
//   }

//   // Check against explicit allowed origins
//   return ALLOWED_ORIGINS.some((allowed) => origin.startsWith(allowed));
// };

// // =============================================================================
// // SESSION STORE CONFIGURATION
// // =============================================================================

// const PgSession = pgSession(session);

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl:
//     process.env.NODE_ENV === "production"
//       ? { rejectUnauthorized: false }
//       : (false as any),
// });

// // Test database connection
// pool.query("SELECT NOW()", (err, res) => {
//   if (err) {
//     console.error("❌ Database connection failed:", err);
//   } else {
//     console.log("✅ Database connected:", res.rows[0].now);
//   }
// });

// const sessionStore = new PgSession({
//   pool,
//   tableName: "sessions",
//   createTableIfMissing: false,
// });

// // Export pool for use in billing routes
// export { pool };

// // =============================================================================
// // EXPRESS APP SETUP
// // =============================================================================

// const app = express();

// // =============================================================================
// // 1. TRUST PROXY - MUST BE FIRST
// // =============================================================================

// app.set("trust proxy", 1);

// // =============================================================================
// // 2. NUCLEAR OPTIONS HANDLER - HANDLES ALL PREFLIGHT REQUESTS
// // =============================================================================

// app.use((req: Request, res: Response, next: NextFunction) => {
//   // Handle OPTIONS IMMEDIATELY before anything else can interfere
//   if (req.method === "OPTIONS") {
//     const origin = req.headers.origin;

//     console.log(`⚡ OPTIONS ${req.path} from ${origin || "unknown"}`);

//     // Check if origin is allowed
//     if (origin && isAllowedOrigin(origin)) {
//       res.setHeader("Access-Control-Allow-Origin", origin);
//       res.setHeader("Access-Control-Allow-Credentials", "true");
//     } else {
//       // For development or non-browser requests
//       res.setHeader("Access-Control-Allow-Origin", "*");
//     }

//     res.setHeader(
//       "Access-Control-Allow-Methods",
//       "GET, POST, PUT, DELETE, OPTIONS, PATCH",
//     );
//     res.setHeader(
//       "Access-Control-Allow-Headers",
//       "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cookie, X-CSRF-Token",
//     );
//     res.setHeader("Access-Control-Expose-Headers", "Set-Cookie, Content-Type, Content-Disposition, Content-Length");
//     res.setHeader("Access-Control-Max-Age", "86400");
//     res.setHeader("Vary", "Origin");

//     // Send 200 immediately - don't let anything else process this
//     return res.status(200).end();
//   }

//   // Not an OPTIONS request, continue to next middleware
//   next();
// });

// // =============================================================================
// // 3. CORS FOR ALL OTHER REQUESTS
// // =============================================================================

// app.use((req: Request, res: Response, next: NextFunction) => {
//   const origin = req.headers.origin;

//   // Set CORS headers based on origin
//   if (origin && isAllowedOrigin(origin)) {
//     res.setHeader("Access-Control-Allow-Origin", origin);
//     res.setHeader("Access-Control-Allow-Credentials", "true");
//     console.log(`✅ CORS allowed for: ${origin}`);
//   } else if (!origin) {
//     // For non-browser requests (like server-to-server)
//     res.setHeader("Access-Control-Allow-Origin", "*");
//   } else {
//     // Origin not in allowed list
//     console.log(`⚠️ CORS blocked for: ${origin}`);
//     res.setHeader("Access-Control-Allow-Origin", "*");
//   }

//   res.setHeader(
//     "Access-Control-Allow-Methods",
//     "GET, POST, PUT, DELETE, OPTIONS, PATCH",
//   );
//   res.setHeader(
//     "Access-Control-Allow-Headers",
//     "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cookie, X-CSRF-Token",
//   );
//   res.setHeader("Access-Control-Expose-Headers", "Set-Cookie, Content-Type, Content-Disposition, Content-Length");
//   res.setHeader("Vary", "Origin");

//   next();
// });

// // =============================================================================
// // 4. STRIPE WEBHOOK - MUST BE BEFORE BODY PARSERS
// // =============================================================================

// // Handle Stripe webhook with raw body BEFORE express.json() processes it
// app.post(
//   "/api/billing/webhooks/stripe",
//   express.raw({ type: "application/json" }),
//   async (req: Request, res: Response) => {
//     try {
//       const sig = req.headers["stripe-signature"] as string;

//       console.log("\n🔔 ============================================");
//       console.log("🔔 STRIPE WEBHOOK RECEIVED");
//       console.log("🔔 Time:", new Date().toISOString());
//       console.log("🔔 Signature present:", !!sig);
//       console.log("🔔 Body type:", typeof req.body);
//       console.log("🔔 Body is Buffer:", Buffer.isBuffer(req.body));
//       console.log("🔔 Body length:", req.body?.length || 0);

//       const event = stripeService.constructWebhookEvent(req.body, sig);

//       console.log("🔔 Event Type:", event.type);
//       console.log("🔔 Event ID:", event.id);
//       console.log("🔔 Created:", new Date(event.created * 1000).toISOString());

//       // Handle different event types using WebhookHandler
//       switch (event.type) {
//         case "checkout.session.completed": {
//           console.log("🎯 Handling checkout.session.completed");
//           await WebhookHandler.handleCheckoutCompleted(
//             event.data.object as Stripe.Checkout.Session
//           );
//           break;
//         }

//         case "customer.subscription.created": {
//           console.log("🎯 Handling customer.subscription.created");
//           await WebhookHandler.handleSubscriptionCreated(
//             event.data.object as Stripe.Subscription
//           );
//           break;
//         }

//         case "customer.subscription.updated": {
//           console.log("🎯 Handling customer.subscription.updated");
//           const sub = event.data.object as Stripe.Subscription;
//           console.log("📝 Subscription ID:", sub.id, "Status:", sub.status);
//           await WebhookHandler.handleSubscriptionUpdated(sub);
//           break;
//         }

//         case "customer.subscription.deleted": {
//           console.log("🎯 Handling customer.subscription.deleted");
//           await WebhookHandler.handleSubscriptionDeleted(
//             event.data.object as Stripe.Subscription
//           );
//           break;
//         }

//         case "invoice.paid": {
//           console.log("🎯 Handling invoice.paid");
//           await WebhookHandler.handleInvoicePaid(
//             event.data.object as Stripe.Invoice
//           );
//           break;
//         }

//         case "invoice.payment_failed": {
//           console.log("🎯 Handling invoice.payment_failed");
//           await WebhookHandler.handleInvoicePaymentFailed(
//             event.data.object as Stripe.Invoice
//           );
//           break;
//         }

//         case "payment_intent.succeeded": {
//           console.log("🎯 Handling payment_intent.succeeded");
//           await WebhookHandler.handlePaymentSucceeded(
//             event.data.object as Stripe.PaymentIntent
//           );
//           break;
//         }

//         case "payment_intent.payment_failed": {
//           console.log("🎯 Handling payment_intent.payment_failed");
//           await WebhookHandler.handlePaymentFailed(
//             event.data.object as Stripe.PaymentIntent
//           );
//           break;
//         }

//         default:
//           console.log("ℹ️ Unhandled event type:", event.type);
//       }

//       console.log("✅ Webhook processed successfully");
//       console.log("🔔 ============================================\n");

//       res.json({ received: true });
//     } catch (err: any) {
//       console.error("\n❌ ============================================");
//       console.error("❌ STRIPE WEBHOOK ERROR");
//       console.error("❌ Error:", err.message);
//       console.error("❌ Stack:", err.stack);
//       console.error("❌ ============================================\n");
//       return res.status(400).send(`Webhook Error: ${err.message}`);
//     }
//   }
// );

// // =============================================================================
// // 5. BODY PARSERS (NOW AFTER WEBHOOK)
// // =============================================================================

// app.use(express.json({ limit: "10mb" }));
// app.use(express.urlencoded({ extended: false }));

// // =============================================================================
// // 6. CORS TEST ENDPOINTS (Before rate limiting)
// // =============================================================================

// app.get("/api/cors-test", (req: Request, res: Response) => {
//   console.log("🧪 CORS Test GET Hit");
//   res.json({
//     success: true,
//     message: "CORS is working!",
//     origin: req.headers.origin,
//     isAllowed: isAllowedOrigin(req.headers.origin),
//     allowedOrigins: ALLOWED_ORIGINS,
//     allowVercelPreviews: process.env.ALLOW_VERCEL_PREVIEWS === "true",
//     timestamp: new Date().toISOString(),
//   });
// });

// app.post("/api/cors-test", (req: Request, res: Response) => {
//   console.log("🧪 CORS Test POST Hit");
//   res.json({
//     success: true,
//     message: "CORS POST is working!",
//     origin: req.headers.origin,
//     isAllowed: isAllowedOrigin(req.headers.origin),
//     body: req.body,
//     timestamp: new Date().toISOString(),
//   });
// });

// // =============================================================================
// // 7. RATE LIMITING (Skip OPTIONS)
// // =============================================================================

// const rateLimitHandler = (req: Request, res: Response) => {
//   const origin = req.headers.origin;
//   if (origin && isAllowedOrigin(origin)) {
//     res.setHeader("Access-Control-Allow-Origin", origin);
//     res.setHeader("Access-Control-Allow-Credentials", "true");
//   }
//   res.status(429).json({
//     success: false,
//     message: "Too many requests, please try again later.",
//   });
// };

// const generalLimiter = rateLimit({
//   windowMs: 1 * 60 * 1000,
//   max: 500,
//   handler: rateLimitHandler,
//   standardHeaders: true,
//   legacyHeaders: false,
//   validate: false,
//   skip: (req) => req.method === "OPTIONS",
// });

// const authLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 100,
//   handler: rateLimitHandler,
//   skipSuccessfulRequests: true,
//   standardHeaders: true,
//   legacyHeaders: false,
//   validate: false,
//   skip: (req) => req.method === "OPTIONS",
// });

// // Rate limit for billing/payment endpoints (more restrictive)
// const billingLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 50,
//   handler: rateLimitHandler,
//   standardHeaders: true,
//   legacyHeaders: false,
//   validate: false,
//   skip: (req) => req.method === "OPTIONS" || req.path === "/api/billing/webhooks/stripe", // Skip rate limiting for webhooks
// });

// app.use("/api/", generalLimiter);
// app.use("/api/auth/", authLimiter);
// app.use("/api/gsc/auth", authLimiter);
// app.use("/api/gsc/auth-url", authLimiter);
// app.use("/api/gsc/oauth-callback", authLimiter);
// app.use("/api/billing/", billingLimiter);

// // =============================================================================
// // 8. SECURITY HEADERS
// // =============================================================================

// app.use((req: Request, res: Response, next: NextFunction) => {
//   res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
//   res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");

//   if (
//     req.path === "/api/gsc/oauth-callback" ||
//     req.path === "/api/auth/google/callback"
//   ) {
//     res.setHeader("X-Frame-Options", "SAMEORIGIN");
//   }

//   next();
// });

// app.use(
//   helmet({
//     crossOriginOpenerPolicy: false,
//     crossOriginEmbedderPolicy: false,
//     contentSecurityPolicy: {
//       directives: {
//         defaultSrc: ["'self'"],
//         connectSrc: [
//           "'self'",
//           // Allow localhost in development
//           ...(process.env.NODE_ENV !== "production"
//             ? [
//                 "http://localhost:3000",
//                 "http://localhost:5000",
//                 "http://localhost:5173",
//                 "ws://localhost:*",
//                 "wss://localhost:*",
//               ]
//             : []),
//           "https://www.googleapis.com",
//           "https://accounts.google.com",
//           "https://oauth2.googleapis.com",
//           "https://api.stripe.com",
//         ],
//         scriptSrc: [
//           "'self'",
//           "'unsafe-inline'",
//           "'unsafe-eval'",
//           "https://js.stripe.com",
//         ],
//         styleSrc: [
//           "'self'",
//           "'unsafe-inline'",
//           "https://fonts.googleapis.com",
//           "https://fonts.gstatic.com",
//         ],
//         fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
//         imgSrc: ["'self'", "data:", "https:", "*.googleusercontent.com"],
//         frameAncestors: ["'self'"],
//         frameSrc: ["'self'", "https://js.stripe.com", "https://hooks.stripe.com"],
//       },
//     },
//     hsts: {
//       maxAge: 31536000,
//       includeSubDomains: true,
//       preload: true,
//     },
//   }),
// );

// // =============================================================================
// // 9. INPUT SANITIZATION
// // =============================================================================

// app.use((req: Request, res: Response, next: NextFunction) => {
//   const sanitizeString = (str: any): any => {
//     if (typeof str !== "string") return str;
//     return str
//       .replace(
//         /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
//         "",
//       )
//       .replace(/on\w+\s*=/gi, "")
//       .trim();
//   };

//   if (req.body && typeof req.body === "object") {
//     Object.keys(req.body).forEach((key) => {
//       if (
//         ![
//           "password",
//           "token",
//           "refreshToken",
//           "accessToken",
//           "url",
//           "redirectUri",
//           "clientSecret",
//         ].includes(key)
//       ) {
//         req.body[key] = sanitizeString(req.body[key]);
//       }
//     });
//   }

//   if (req.query && typeof req.query === "object") {
//     Object.keys(req.query).forEach((key) => {
//       if (typeof req.query[key] === "string") {
//         req.query[key] = sanitizeString(req.query[key] as string);
//       }
//     });
//   }

//   next();
// });

// // =============================================================================
// // 10. SESSION CONFIGURATION
// // =============================================================================

// app.use(
//   session({
//     store: sessionStore,
//     secret:
//       process.env.SESSION_SECRET ||
//       "your-super-secret-key-change-in-production",
//     resave: false,
//     saveUninitialized: false,
//     name: "ai-seo-session",
//     proxy: true,
//     cookie: {
//       secure: process.env.NODE_ENV === "production",
//       httpOnly: true,
//       maxAge: 24 * 60 * 60 * 1000,
//       sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
//       domain: undefined,
//       path: "/",
//     },
//     rolling: true,
//   }),
// );

// // =============================================================================
// // 11. AUTHENTICATION MIDDLEWARE
// // =============================================================================

// // Attach user to request if session exists
// app.use((req: Request, _res: Response, next: NextFunction) => {
//   if (req.session?.userId) {
//     // Set user on request object for billing routes
//     req.user = {
//       id: req.session.userId,
//       username: req.session.username || req.session.userId,
//       email: undefined, // Fetch from database if needed
//       name: undefined, // Fetch from database if needed
//     };
//   }
//   next();
// });

// // =============================================================================
// // 12. REQUEST LOGGER
// // =============================================================================

// app.use((req: Request, res: Response, next: NextFunction) => {
//   if (req.path.startsWith("/api") && !req.path.includes("cors-test")) {
//     console.log(`📥 ${req.method} ${req.path}`, {
//       origin: req.headers.origin || "none",
//       allowed: req.headers.origin
//         ? isAllowedOrigin(req.headers.origin)
//         : "N/A",
//       cookie: req.headers.cookie ? "present" : "missing",
//       sessionID: req.sessionID?.substring(0, 8) + "..." || "none",
//       userId: req.session?.userId || "none",
//       hasUser: !!req.user,
//     });
//   }
//   next();
// });

// // =============================================================================
// // 13. SESSION DEBUG ENDPOINT
// // =============================================================================

// app.get("/api/session-debug", (req: Request, res: Response) => {
//   console.log("🔍 Session Debug Full:", {
//     sessionID: req.sessionID,
//     session: req.session,
//     cookies: req.headers.cookie,
//     origin: req.headers.origin,
//     secure: req.secure,
//     protocol: req.protocol,
//   });

//   res.json({
//     success: true,
//     hasSession: !!req.session,
//     sessionID: req.sessionID,
//     userId: req.session?.userId || null,
//     username: req.session?.username || null,
//     cookies: req.headers.cookie || "none",
//     origin: req.headers.origin || "none",
//     originAllowed: isAllowedOrigin(req.headers.origin),
//     allowedOrigins: ALLOWED_ORIGINS,
//     allowVercelPreviews: process.env.ALLOW_VERCEL_PREVIEWS === "true",
//     secure: req.secure,
//     protocol: req.protocol,
//     environment: process.env.NODE_ENV || "development",
//   });
// });

// // =============================================================================
// // 14. LOGGING MIDDLEWARE
// // =============================================================================

// app.use((req: Request, res: Response, next: NextFunction) => {
//   const start = Date.now();
//   const path = req.path;

//   let capturedJsonResponse: Record<string, any> | undefined = undefined;
//   const originalResJson = res.json;

//   res.json = function (bodyJson: any, ...args: any[]) {
//     capturedJsonResponse = bodyJson;
//     return originalResJson.apply(res, [bodyJson, ...args]);
//   };

//   res.on("finish", () => {
//     const duration = Date.now() - start;
//     if (path.startsWith("/api")) {
//       let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
//       if (capturedJsonResponse) {
//         const preview = JSON.stringify(capturedJsonResponse).substring(0, 100);
//         logLine += ` :: ${preview}${preview.length >= 100 ? "..." : ""}`;
//       }
//       log(logLine);
//     }
//   });

//   next();
// });

// // =============================================================================
// // SERVER STARTUP & ROUTES
// // =============================================================================

// (async () => {
//   try {
//     // ✅ STEP 1: REGISTER API ROUTES FIRST (BEFORE VITE)
//     console.log("📋 Registering API routes...");
    
//     const { registerRoutes } = await import("./routes.ts").catch(() => ({
//       registerRoutes: async (app: any) => app,
//     }));

//     await registerRoutes(app);
//     console.log("✅ API routes registered");

//     // Billing routes (with authentication already handled)
//     // Note: Webhook is already handled above, this will handle other billing routes
//     app.use("/api/billing", billingRoutes);
//     console.log("✅ Billing routes registered");

//     // Health check endpoint
//     app.get("/health", (_req: Request, res: Response) => {
//       res.json({
//         status: "healthy",
//         timestamp: new Date().toISOString(),
//         environment: process.env.NODE_ENV || "development",
//         uptime: process.uptime(),
//         port: process.env.PORT || "5000",
//         database: "connected",
//         allowedOrigins: ALLOWED_ORIGINS,
//         allowVercelPreviews: process.env.ALLOW_VERCEL_PREVIEWS === "true",
//         billing: {
//           stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
//           webhookConfigured: !!process.env.STRIPE_WEBHOOK_SECRET,
//         },
//       });
//     });

//     // API info endpoint (moved from "/" to "/api")
//     app.get("/api", (req: Request, res: Response) => {
//       res.json({
//         message: "SEO Tool API Server",
//         version: "1.0.0",
//         status: "running",
//         endpoints: {
//           health: "/health",
//           api: "/api/*",
//           corsTest: "/api/cors-test",
//           sessionDebug: "/api/session-debug",
//           billing: "/api/billing/*",
//         },
//       });
//     });

//     // ✅ STEP 2: SETUP VITE LAST (AS CATCH-ALL FOR FRONTEND ROUTES)
//     if (process.env.NODE_ENV !== "production") {
//       try {
//         console.log("🛠️ Development mode: Attempting to load Vite...");
//         const { setupVite } = await import("./vite.ts").catch(() => ({
//           setupVite: null,
//         }));
//         if (setupVite) {
//           const httpServer = createServer(app);
//           await setupVite(app, httpServer);
//           console.log("✅ Vite dev server initialized (as frontend catch-all)");
//         } else {
//           console.log("⚠️ Vite module not found, continuing without it");
//         }
//       } catch (e: any) {
//         console.log("⚠️ Vite setup failed:", e.message);
//       }
//     } else {
//       console.log("✅ Production mode: Skipping Vite (as expected)");
//     }

//     // =============================================================================
//     // GLOBAL ERROR HANDLER
//     // =============================================================================

//     app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
//       const origin = req.headers.origin;

//       console.error("❌ Global Error Handler:", {
//         message: err.message,
//         stack:
//           process.env.NODE_ENV === "development" ? err.stack : undefined,
//         path: req.path,
//         method: req.method,
//         origin: origin,
//         userId: req.session?.userId || "none",
//       });

//       // CRITICAL: Force CORS headers on ALL errors
//       if (origin && isAllowedOrigin(origin)) {
//         res.setHeader("Access-Control-Allow-Origin", origin);
//         res.setHeader("Access-Control-Allow-Credentials", "true");
//       } else {
//         res.setHeader("Access-Control-Allow-Origin", "*");
//       }
//       res.setHeader(
//         "Access-Control-Allow-Methods",
//         "GET, POST, PUT, DELETE, OPTIONS, PATCH",
//       );
//       res.setHeader(
//         "Access-Control-Allow-Headers",
//         "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cookie, X-CSRF-Token",
//       );
//       res.setHeader("Vary", "Origin");

//       const status = err.status || err.statusCode || 500;
//       const message = err.message || "Internal Server Error";

//       const responseMessage =
//         process.env.NODE_ENV === "production"
//           ? status >= 500
//             ? "Internal Server Error"
//             : message
//           : message;

//       res.status(status).json({
//         success: false,
//         message: responseMessage,
//         ...(process.env.NODE_ENV === "development" && {
//           stack: err.stack,
//           path: req.path,
//           method: req.method,
//         }),
//       });
//     });

//     // =============================================================================
//     // 404 HANDLER (Only for API routes - let Vite handle frontend routes)
//     // =============================================================================

//     app.use("/api/*", (req: Request, res: Response) => {
//       const origin = req.headers.origin;

//       console.log(`❌ 404: ${req.method} ${req.path}`);
//       console.log(`   Origin: ${origin || "none"}`);

//       // Ensure CORS headers on 404
//       if (origin && isAllowedOrigin(origin)) {
//         res.setHeader("Access-Control-Allow-Origin", origin);
//         res.setHeader("Access-Control-Allow-Credentials", "true");
//       } else {
//         res.setHeader("Access-Control-Allow-Origin", "*");
//       }
//       res.setHeader(
//         "Access-Control-Allow-Methods",
//         "GET, POST, PUT, DELETE, OPTIONS, PATCH",
//       );
//       res.setHeader(
//         "Access-Control-Allow-Headers",
//         "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cookie",
//       );
//       res.setHeader("Vary", "Origin");

//       res.status(404).json({
//         success: false,
//         message: "API route not found",
//         path: req.path,
//         method: req.method,
//       });
//     });

//     // =============================================================================
//     // START HTTP SERVER - CRITICAL FOR RENDER
//     // =============================================================================

//     const port = parseInt(process.env.PORT || "5000", 10);
//     const host = "0.0.0.0";

//     // Create HTTP server explicitly
//     const httpServer = createServer(app);

//     httpServer.listen(port, host, () => {
//       log(`\n${"=".repeat(60)}`);
//       log(`🚀 Server running on http://${host}:${port}`);
//       log(`🎨 Frontend: http://localhost:${port}`);
//       log(`📊 Environment: ${process.env.NODE_ENV || "development"}`);
//       log(`🔐 Session store: PostgreSQL`);
//       log(`🛡️ Security: Helmet + Rate Limiting enabled`);
//       log(`📡 API available at: http://${host}:${port}/api`);
//       log(
//         `💳 Billing API: http://${host}:${port}/api/billing/subscription`,
//       );
//       log(
//         `🔔 Stripe webhooks: http://${host}:${port}/api/billing/webhooks/stripe`,
//       );
//       log(`🌐 CORS: Whitelist mode`);
//       log(`   Allowed origins:`);
//       ALLOWED_ORIGINS.forEach((origin) => log(`   - ${origin}`));
//       if (process.env.ALLOW_VERCEL_PREVIEWS === "true") {
//         log(`   ✅ Vercel preview deployments: ENABLED`);
//         log(`   - All *.vercel.app domains allowed`);
//       } else {
//         log(`   ⚠️ Vercel preview deployments: DISABLED`);
//         log(`   - Set ALLOW_VERCEL_PREVIEWS=true to enable`);
//       }
//       log(`🧪 Test endpoints:`);
//       log(`   - CORS Test: http://${host}:${port}/api/cors-test`);
//       log(`   - Session Debug: http://${host}:${port}/api/session-debug`);
//       log(`   - Health Check: http://${host}:${port}/health`);

//       // Start scheduler after server is listening
//       schedulerService.startScheduler(1);
//       log(`⏰ Content scheduler started`);

//       startSubscriptionCleanupJob(60); // Run every 60 minutes
//       log(`💳 Subscription cleanup job started`);

//       if (process.env.NODE_ENV === "development") {
//         log(
//           `🛠️  Development mode: Vite dev server + verbose logging enabled`,
//         );
//         log(`🔧 Route order: Webhook (raw) → API routes → Vite (frontend catch-all)`);
//       }

//       if (
//         !process.env.SESSION_SECRET ||
//         process.env.SESSION_SECRET ===
//           "your-super-secret-key-change-in-production"
//       ) {
//         log(
//           `⚠️  WARNING: Using default SESSION_SECRET - change this in production!`,
//         );
//       }

//       log(`${"=".repeat(60)}\n`);
//     });

//     // Handle server errors
//     httpServer.on("error", (error: any) => {
//       if (error.code === "EADDRINUSE") {
//         console.error(`❌ Port ${port} is already in use`);
//         process.exit(1);
//       } else {
//         console.error("❌ Server error:", error);
//         process.exit(1);
//       }
//     });
//   } catch (error) {
//     console.error("❌ Failed to start server:", error);
//     process.exit(1);
//   }
// })();

// // =============================================================================
// // GRACEFUL SHUTDOWN
// // =============================================================================

// process.on("SIGTERM", () => {
//   log("🔴 SIGTERM received, shutting down gracefully");
//   pool.end(() => {
//     log("🔌 Database pool closed");
//     process.exit(0);
    
//   });
// });

// process.on("SIGINT", () => {
//   log("🔴 SIGINT received, shutting down gracefully");
//   pool.end(() => {
//     log("🔌 Database pool closed");
//     process.exit(0);
//   });
// });

// process.on("uncaughtException", (error) => {
//   console.error("❌ Uncaught Exception:", error);
//   process.exit(1);
// });

// process.on("unhandledRejection", (reason, promise) => {
//   console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
//   process.exit(1);
// });




import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import session from "express-session";
import pgSession from "connect-pg-simple";
import { Pool } from "pg";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import { schedulerService } from "./services/scheduler-service.ts";

// =============================================================================
// TYPE DECLARATIONS
// =============================================================================

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        username: string;
        email?: string;
        name?: string;
        isAdmin?: boolean;
      };
    }
  }
}

declare module "express-session" {
  interface SessionData {
    userId: string;
    username?: string;
  }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function log(message: string) {
  console.log(message);
}

// =============================================================================
// CORS CONFIGURATION
// =============================================================================

const ALLOWED_ORIGINS = [
  "https://final-seo-tool.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:5000",
];

// Helper function to check if origin is allowed
const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (!origin) return false;

  // In production (Render), allow all vercel.app domains if enabled via env variable
  if (
    process.env.ALLOW_VERCEL_PREVIEWS === "true" &&
    origin.includes(".vercel.app")
  ) {
    return true;
  }

  // Check against explicit allowed origins
  return ALLOWED_ORIGINS.some((allowed) => origin.startsWith(allowed));
};

// =============================================================================
// SESSION STORE CONFIGURATION
// =============================================================================

const PgSession = pgSession(session);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : (false as any),
});

// Test database connection
pool.query("SELECT NOW()", (err, res) => {
  if (err) {
    console.error("❌ Database connection failed:", err);
  } else {
    console.log("✅ Database connected:", res.rows[0].now);
  }
});

const sessionStore = new PgSession({
  pool,
  tableName: "sessions",
  createTableIfMissing: false,
});

// Export pool for use in other routes
export { pool };

// =============================================================================
// EXPRESS APP SETUP
// =============================================================================

const app = express();

// =============================================================================
// 1. TRUST PROXY - MUST BE FIRST
// =============================================================================

app.set("trust proxy", 1);

// =============================================================================
// 2. NUCLEAR OPTIONS HANDLER - HANDLES ALL PREFLIGHT REQUESTS
// =============================================================================

app.use((req: Request, res: Response, next: NextFunction) => {
  // Handle OPTIONS IMMEDIATELY before anything else can interfere
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin;

    console.log(`⚡ OPTIONS ${req.path} from ${origin || "unknown"}`);

    // Check if origin is allowed
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    } else {
      // For development or non-browser requests
      res.setHeader("Access-Control-Allow-Origin", "*");
    }

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cookie, X-CSRF-Token",
    );
    res.setHeader("Access-Control-Expose-Headers", "Set-Cookie, Content-Type, Content-Disposition, Content-Length");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.setHeader("Vary", "Origin");

    // Send 200 immediately - don't let anything else process this
    return res.status(200).end();
  }

  // Not an OPTIONS request, continue to next middleware
  next();
});

// =============================================================================
// 3. CORS FOR ALL OTHER REQUESTS
// =============================================================================

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;

  // Set CORS headers based on origin
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    console.log(`✅ CORS allowed for: ${origin}`);
  } else if (!origin) {
    // For non-browser requests (like server-to-server)
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    // Origin not in allowed list
    console.log(`⚠️ CORS blocked for: ${origin}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS, PATCH",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cookie, X-CSRF-Token",
  );
  res.setHeader("Access-Control-Expose-Headers", "Set-Cookie, Content-Type, Content-Disposition, Content-Length");
  res.setHeader("Vary", "Origin");

  next();
});

// =============================================================================
// 4. BODY PARSERS
// =============================================================================

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false }));

// =============================================================================
// 5. CORS TEST ENDPOINTS (Before rate limiting)
// =============================================================================

app.get("/api/cors-test", (req: Request, res: Response) => {
  console.log("🧪 CORS Test GET Hit");
  res.json({
    success: true,
    message: "CORS is working!",
    origin: req.headers.origin,
    isAllowed: isAllowedOrigin(req.headers.origin),
    allowedOrigins: ALLOWED_ORIGINS,
    allowVercelPreviews: process.env.ALLOW_VERCEL_PREVIEWS === "true",
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/cors-test", (req: Request, res: Response) => {
  console.log("🧪 CORS Test POST Hit");
  res.json({
    success: true,
    message: "CORS POST is working!",
    origin: req.headers.origin,
    isAllowed: isAllowedOrigin(req.headers.origin),
    body: req.body,
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
// 6. RATE LIMITING (Skip OPTIONS)
// =============================================================================

const rateLimitHandler = (req: Request, res: Response) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.status(429).json({
    success: false,
    message: "Too many requests, please try again later.",
  });
};

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 500,
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  skip: (req) => req.method === "OPTIONS",
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  handler: rateLimitHandler,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  skip: (req) => req.method === "OPTIONS",
});

app.use("/api/", generalLimiter);
app.use("/api/auth/", authLimiter);
app.use("/api/gsc/auth", authLimiter);
app.use("/api/gsc/auth-url", authLimiter);
app.use("/api/gsc/oauth-callback", authLimiter);

// =============================================================================
// 7. SECURITY HEADERS
// =============================================================================

app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");

  if (
    req.path === "/api/gsc/oauth-callback" ||
    req.path === "/api/auth/google/callback"
  ) {
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
  }

  next();
});

app.use(
  helmet({
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: [
          "'self'",
          // Allow localhost in development
          ...(process.env.NODE_ENV !== "production"
            ? [
                "http://localhost:3000",
                "http://localhost:5000",
                "http://localhost:5173",
                "ws://localhost:*",
                "wss://localhost:*",
              ]
            : []),
          "https://www.googleapis.com",
          "https://accounts.google.com",
          "https://oauth2.googleapis.com",
        ],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'",
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com",
          "https://fonts.gstatic.com",
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "https:", "*.googleusercontent.com"],
        frameAncestors: ["'self'"],
        frameSrc: ["'self'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  }),
);

// =============================================================================
// 8. INPUT SANITIZATION
// =============================================================================

app.use((req: Request, res: Response, next: NextFunction) => {
  const sanitizeString = (str: any): any => {
    if (typeof str !== "string") return str;
    return str
      .replace(
        /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
        "",
      )
      .replace(/on\w+\s*=/gi, "")
      .trim();
  };

  if (req.body && typeof req.body === "object") {
    Object.keys(req.body).forEach((key) => {
      if (
        ![
          "password",
          "token",
          "refreshToken",
          "accessToken",
          "url",
          "redirectUri",
          "clientSecret",
        ].includes(key)
      ) {
        req.body[key] = sanitizeString(req.body[key]);
      }
    });
  }

  if (req.query && typeof req.query === "object") {
    Object.keys(req.query).forEach((key) => {
      if (typeof req.query[key] === "string") {
        req.query[key] = sanitizeString(req.query[key] as string);
      }
    });
  }

  next();
});

// =============================================================================
// 9. SESSION CONFIGURATION
// =============================================================================

app.use(
  session({
    store: sessionStore,
    secret:
      process.env.SESSION_SECRET ||
      "your-super-secret-key-change-in-production",
    resave: false,
    saveUninitialized: false,
    name: "ai-seo-session",
    proxy: true,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      domain: undefined,
      path: "/",
    },
    rolling: true,
  }),
);

// =============================================================================
// 10. AUTHENTICATION MIDDLEWARE
// =============================================================================

// Attach user to request if session exists
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.session?.userId) {
    req.user = {
      id: req.session.userId,
      username: req.session.username || req.session.userId,
      email: undefined,
      name: undefined,
    };
  }
  next();
});

// =============================================================================
// 11. REQUEST LOGGER
// =============================================================================

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith("/api") && !req.path.includes("cors-test")) {
    console.log(`📥 ${req.method} ${req.path}`, {
      origin: req.headers.origin || "none",
      allowed: req.headers.origin
        ? isAllowedOrigin(req.headers.origin)
        : "N/A",
      cookie: req.headers.cookie ? "present" : "missing",
      sessionID: req.sessionID?.substring(0, 8) + "..." || "none",
      userId: req.session?.userId || "none",
      hasUser: !!req.user,
    });
  }
  next();
});

// =============================================================================
// 12. SESSION DEBUG ENDPOINT
// =============================================================================

app.get("/api/session-debug", (req: Request, res: Response) => {
  console.log("🔍 Session Debug Full:", {
    sessionID: req.sessionID,
    session: req.session,
    cookies: req.headers.cookie,
    origin: req.headers.origin,
    secure: req.secure,
    protocol: req.protocol,
  });

  res.json({
    success: true,
    hasSession: !!req.session,
    sessionID: req.sessionID,
    userId: req.session?.userId || null,
    username: req.session?.username || null,
    cookies: req.headers.cookie || "none",
    origin: req.headers.origin || "none",
    originAllowed: isAllowedOrigin(req.headers.origin),
    allowedOrigins: ALLOWED_ORIGINS,
    allowVercelPreviews: process.env.ALLOW_VERCEL_PREVIEWS === "true",
    secure: req.secure,
    protocol: req.protocol,
    environment: process.env.NODE_ENV || "development",
  });
});

// =============================================================================
// 13. LOGGING MIDDLEWARE
// =============================================================================

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const path = req.path;

  let capturedJsonResponse: Record<string, any> | undefined = undefined;
  const originalResJson = res.json;

  res.json = function (bodyJson: any, ...args: any[]) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        const preview = JSON.stringify(capturedJsonResponse).substring(0, 100);
        logLine += ` :: ${preview}${preview.length >= 100 ? "..." : ""}`;
      }
      log(logLine);
    }
  });

  next();
});

// =============================================================================
// SERVER STARTUP & ROUTES
// =============================================================================

(async () => {
  try {
    // ✅ STEP 1: REGISTER API ROUTES FIRST (BEFORE VITE)
    console.log("📋 Attempting to import routes.ts...");
    
    let routesModule;
    try {
      routesModule = await import("./routes.ts");
      console.log("✅ routes.ts imported successfully");
    } catch (importError: any) {
      console.error("❌ CRITICAL: Failed to import routes.ts:", importError.message);
      console.error("Stack:", importError.stack);
      throw new Error(`Routes import failed: ${importError.message}`);
    }
    
    if (!routesModule || typeof routesModule.registerRoutes !== 'function') {
      throw new Error("registerRoutes function not found in routes.ts");
    }
    
    console.log("📋 Registering API routes...");
    await routesModule.registerRoutes(app);
    console.log("✅ API routes registered successfully");

    // Health check endpoint
    app.get("/health", (_req: Request, res: Response) => {
      res.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || "development",
        uptime: process.uptime(),
        port: process.env.PORT || "5000",
        database: "connected",
        allowedOrigins: ALLOWED_ORIGINS,
        allowVercelPreviews: process.env.ALLOW_VERCEL_PREVIEWS === "true",
      });
    });

    // API info endpoint (moved from "/" to "/api")
    app.get("/api", (req: Request, res: Response) => {
      res.json({
        message: "SEO Tool API Server",
        version: "1.0.0",
        status: "running",
        endpoints: {
          health: "/health",
          api: "/api/*",
          corsTest: "/api/cors-test",
          sessionDebug: "/api/session-debug",
        },
      });
    });

    // ✅ STEP 2: SETUP VITE LAST (AS CATCH-ALL FOR FRONTEND ROUTES)
    if (process.env.NODE_ENV !== "production") {
      try {
        console.log("🛠️ Development mode: Attempting to load Vite...");
        const { setupVite } = await import("./vite.ts").catch(() => ({
          setupVite: null,
        }));
        if (setupVite) {
          const httpServer = createServer(app);
          await setupVite(app, httpServer);
          console.log("✅ Vite dev server initialized (as frontend catch-all)");
        } else {
          console.log("⚠️ Vite module not found, continuing without it");
        }
      } catch (e: any) {
        console.log("⚠️ Vite setup failed:", e.message);
      }
    } else {
      console.log("✅ Production mode: Skipping Vite (as expected)");
    }

    // =============================================================================
    // GLOBAL ERROR HANDLER
    // =============================================================================

    app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
      const origin = req.headers.origin;

      console.error("❌ Global Error Handler:", {
        message: err.message,
        stack:
          process.env.NODE_ENV === "development" ? err.stack : undefined,
        path: req.path,
        method: req.method,
        origin: origin,
        userId: req.session?.userId || "none",
      });

      // CRITICAL: Force CORS headers on ALL errors
      if (origin && isAllowedOrigin(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
      } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
      }
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS, PATCH",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cookie, X-CSRF-Token",
      );
      res.setHeader("Vary", "Origin");

      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";

      const responseMessage =
        process.env.NODE_ENV === "production"
          ? status >= 500
            ? "Internal Server Error"
            : message
          : message;

      res.status(status).json({
        success: false,
        message: responseMessage,
        ...(process.env.NODE_ENV === "development" && {
          stack: err.stack,
          path: req.path,
          method: req.method,
        }),
      });
    });

    // =============================================================================
    // 404 HANDLER (Only for API routes - let Vite handle frontend routes)
    // =============================================================================

    app.use("/api/*", (req: Request, res: Response) => {
      const origin = req.headers.origin;

      console.log(`❌ 404: ${req.method} ${req.path}`);
      console.log(`   Origin: ${origin || "none"}`);

      // Ensure CORS headers on 404
      if (origin && isAllowedOrigin(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
      } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
      }
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS, PATCH",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cookie",
      );
      res.setHeader("Vary", "Origin");

      res.status(404).json({
        success: false,
        message: "API route not found",
        path: req.path,
        method: req.method,
      });
    });

    // =============================================================================
    // START HTTP SERVER - CRITICAL FOR RENDER
    // =============================================================================

    const port = parseInt(process.env.PORT || "5000", 10);
    const host = "0.0.0.0";

    // Create HTTP server explicitly
    const httpServer = createServer(app);

    httpServer.listen(port, host, () => {
      log(`\n${"=".repeat(60)}`);
      log(`🚀 Server running on http://${host}:${port}`);
      log(`🎨 Frontend: http://localhost:${port}`);
      log(`📊 Environment: ${process.env.NODE_ENV || "development"}`);
      log(`🔐 Session store: PostgreSQL`);
      log(`🛡️ Security: Helmet + Rate Limiting enabled`);
      log(`📡 API available at: http://${host}:${port}/api`);
      log(`🌐 CORS: Whitelist mode`);
      log(`   Allowed origins:`);
      ALLOWED_ORIGINS.forEach((origin) => log(`   - ${origin}`));
      if (process.env.ALLOW_VERCEL_PREVIEWS === "true") {
        log(`   ✅ Vercel preview deployments: ENABLED`);
        log(`   - All *.vercel.app domains allowed`);
      } else {
        log(`   ⚠️ Vercel preview deployments: DISABLED`);
        log(`   - Set ALLOW_VERCEL_PREVIEWS=true to enable`);
      }
      log(`🧪 Test endpoints:`);
      log(`   - CORS Test: http://${host}:${port}/api/cors-test`);
      log(`   - Session Debug: http://${host}:${port}/api/session-debug`);
      log(`   - Health Check: http://${host}:${port}/health`);

      // Start scheduler after server is listening
      schedulerService.startScheduler(1);
      log(`⏰ Content scheduler started`);

      if (process.env.NODE_ENV === "development") {
        log(
          `🛠️  Development mode: Vite dev server + verbose logging enabled`,
        );
        log(`🔧 Route order: API routes → Vite (frontend catch-all)`);
      }

      if (
        !process.env.SESSION_SECRET ||
        process.env.SESSION_SECRET ===
          "your-super-secret-key-change-in-production"
      ) {
        log(
          `⚠️  WARNING: Using default SESSION_SECRET - change this in production!`,
        );
      }

      log(`${"=".repeat(60)}\n`);
    });

    // Handle server errors
    httpServer.on("error", (error: any) => {
      if (error.code === "EADDRINUSE") {
        console.error(`❌ Port ${port} is already in use`);
        process.exit(1);
      } else {
        console.error("❌ Server error:", error);
        process.exit(1);
      }
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
})();

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

process.on("SIGTERM", () => {
  log("🔴 SIGTERM received, shutting down gracefully");
  pool.end(() => {
    log("🔌 Database pool closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  log("🔴 SIGINT received, shutting down gracefully");
  pool.end(() => {
    log("🔌 Database pool closed");
    process.exit(0);
  });
});

process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});
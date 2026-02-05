// // server/services/stripe-service.ts
// import Stripe from 'stripe';
// import { db } from '../db';
// import { users, userSubscriptions, subscriptionPlans } from '../../shared/schema';
// import { eq, sql } from 'drizzle-orm';

// if (!process.env.STRIPE_SECRET_KEY) {
//   throw new Error('STRIPE_SECRET_KEY is not set in environment variables');
// }

// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
//   apiVersion: '2024-11-20.acacia',
// });

// export const stripeService = {
//   /**
//    * Create or retrieve a Stripe customer for a user
//    */
//   async getOrCreateCustomer(userId: string): Promise<string> {
//     console.log("🔍 Getting or creating customer for userId:", userId);
    
//     try {
//       // Use raw SQL to avoid ORM issues
//       const result = await db.execute(
//         sql`SELECT id, email, name, stripe_customer_id FROM users WHERE id = ${userId} LIMIT 1`
//       );

//       if (!result.rows || result.rows.length === 0) {
//         throw new Error('User not found');
//       }

//       const user = result.rows[0] as any;
//       console.log("✅ User found:", user.id, "Email:", user.email);

//       // If user already has a Stripe customer ID, return it
//       if (user.stripe_customer_id) {
//         console.log("✅ User already has Stripe customer ID:", user.stripe_customer_id);
//         return user.stripe_customer_id;
//       }

//       console.log("📝 Creating new Stripe customer for:", user.email);

//       // Create new Stripe customer
//       const customer = await stripe.customers.create({
//         email: user.email,
//         name: user.name || undefined,
//         metadata: {
//           userId: user.id,
//         },
//       });

//       console.log("✅ Stripe customer created:", customer.id);

//       // Save Stripe customer ID to database using raw SQL
//       await db.execute(
//         sql`UPDATE users SET stripe_customer_id = ${customer.id} WHERE id = ${userId}`
//       );

//       console.log("✅ Saved Stripe customer ID to database");

//       return customer.id;
//     } catch (error: any) {
//       console.error("❌ Error in getOrCreateCustomer:", error);
//       throw error;
//     }
//   },

//   /**
//    * Create a checkout session for subscription
//    */
//   async createCheckoutSession(params: {
//     userId: string;
//     planId: string;
//     interval: 'month' | 'year';
//     successUrl: string;
//     cancelUrl: string;
//     promoCode?: string;
//   }): Promise<Stripe.Checkout.Session> {
//     const { userId, planId, interval, successUrl, cancelUrl, promoCode } = params;

//     console.log("💳 Creating checkout session:", {
//       userId,
//       planId,
//       interval,
//     });

//     try {
//       // Get plan details using raw SQL to avoid ORM issues
//       const planResult = await db.execute(
//         sql`SELECT * FROM subscription_plans WHERE id = ${planId} LIMIT 1`
//       );

//       if (!planResult.rows || planResult.rows.length === 0) {
//         throw new Error('Plan not found');
//       }

//       const plan = planResult.rows[0] as any;
//       console.log("✅ Plan found:", plan.name);

//       // Get or create Stripe customer
//       const customerId = await this.getOrCreateCustomer(userId);
//       console.log("✅ Customer ID:", customerId);

//       // Calculate price
//       const price = interval === 'year' 
//         ? parseFloat(plan.yearly_price) 
//         : parseFloat(plan.monthly_price);

//       console.log("💰 Price:", price, "Interval:", interval);

//       // Create checkout session
//       const sessionParams: Stripe.Checkout.SessionCreateParams = {
//         customer: customerId,
//         mode: 'subscription',
//         payment_method_types: ['card'],
//         line_items: [
//           {
//             price_data: {
//               currency: 'usd',
//               product_data: {
//                 name: plan.name,
//                 description: plan.description || undefined,
//               },
//               unit_amount: Math.round(price * 100), // Convert to cents
//               recurring: {
//                 interval: interval,
//               },
//             },
//             quantity: 1,
//           },
//         ],
//         success_url: successUrl,
//         cancel_url: cancelUrl,
//         metadata: {
//           userId,
//           planId,
//           interval,
//         },
//         subscription_data: {
//           metadata: {
//             userId,
//             planId,
//             interval,
//           },
//         },
//       };

//       // Add promo code if provided
//       if (promoCode) {
//         console.log("🎟️ Looking for promo code:", promoCode);
//         const promoCodes = await stripe.promotionCodes.list({
//           code: promoCode,
//           active: true,
//           limit: 1,
//         });

//         if (promoCodes.data.length > 0) {
//           sessionParams.discounts = [{ promotion_code: promoCodes.data[0].id }];
//           console.log("✅ Promo code applied:", promoCodes.data[0].id);
//         } else {
//           console.log("⚠️ Promo code not found in Stripe");
//         }
//       }

//       const session = await stripe.checkout.sessions.create(sessionParams);

//       console.log("✅ Checkout session created:", session.id);
//       console.log("🔗 Checkout URL:", session.url);

//       return session;
//     } catch (error: any) {
//       console.error("❌ Error creating checkout session:", error);
//       throw error;
//     }
//   },

//   /**
//    * Create a billing portal session for managing subscription
//    */
//   async createBillingPortalSession(params: {
//     userId: string;
//     returnUrl: string;
//   }): Promise<Stripe.BillingPortal.Session> {
//     const { userId, returnUrl } = params;

//     console.log("🏪 Creating billing portal session for user:", userId);

//     try {
//       const customerId = await this.getOrCreateCustomer(userId);

//       const session = await stripe.billingPortal.sessions.create({
//         customer: customerId,
//         return_url: returnUrl,
//       });

//       console.log("✅ Billing portal session created:", session.id);

//       return session;
//     } catch (error: any) {
//       console.error("❌ Error creating billing portal session:", error);
//       throw error;
//     }
//   },

//   /**
//    * Cancel a subscription
//    */
//   async cancelSubscription(subscriptionId: string, immediate: boolean = false): Promise<Stripe.Subscription> {
//     console.log("🚫 Cancelling subscription:", subscriptionId, "Immediate:", immediate);

//     try {
//       if (immediate) {
//         // Cancel immediately
//         const cancelled = await stripe.subscriptions.cancel(subscriptionId);
//         console.log("✅ Subscription cancelled immediately");
//         return cancelled;
//       } else {
//         // Cancel at period end
//         const updated = await stripe.subscriptions.update(subscriptionId, {
//           cancel_at_period_end: true,
//         });
//         console.log("✅ Subscription set to cancel at period end");
//         return updated;
//       }
//     } catch (error: any) {
//       console.error("❌ Error cancelling subscription:", error);
//       throw error;
//     }
//   },

//   /**
//    * Resume a cancelled subscription
//    */
//   async resumeSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
//     console.log("🔄 Resuming subscription:", subscriptionId);

//     try {
//       const resumed = await stripe.subscriptions.update(subscriptionId, {
//         cancel_at_period_end: false,
//       });
//       console.log("✅ Subscription resumed");
//       return resumed;
//     } catch (error: any) {
//       console.error("❌ Error resuming subscription:", error);
//       throw error;
//     }
//   },

//   /**
//    * Update subscription plan
//    */
//   async updateSubscription(params: {
//     subscriptionId: string;
//     newPlanId: string;
//     interval: 'month' | 'year';
//   }): Promise<Stripe.Subscription> {
//     const { subscriptionId, newPlanId, interval } = params;

//     console.log("🔄 Updating subscription:", subscriptionId, "to plan:", newPlanId);

//     try {
//       // Get plan details using raw SQL
//       const planResult = await db.execute(
//         sql`SELECT * FROM subscription_plans WHERE id = ${newPlanId} LIMIT 1`
//       );

//       if (!planResult.rows || planResult.rows.length === 0) {
//         throw new Error('Plan not found');
//       }

//       const plan = planResult.rows[0] as any;

//       // Get current subscription
//       const subscription = await stripe.subscriptions.retrieve(subscriptionId);

//       // Calculate new price
//       const price = interval === 'year' 
//         ? parseFloat(plan.yearly_price) 
//         : parseFloat(plan.monthly_price);

//       // Update subscription
//       const updated = await stripe.subscriptions.update(subscriptionId, {
//         items: [
//           {
//             id: subscription.items.data[0].id,
//             price_data: {
//               currency: 'usd',
//               product_data: {
//                 name: plan.name,
//                 description: plan.description || undefined,
//               },
//               unit_amount: Math.round(price * 100),
//               recurring: {
//                 interval: interval,
//               },
//             },
//           },
//         ],
//         proration_behavior: 'always_invoice',
//       });

//       console.log("✅ Subscription updated");
//       return updated;
//     } catch (error: any) {
//       console.error("❌ Error updating subscription:", error);
//       throw error;
//     }
//   },

//   /**
//    * Detach a payment method
//    */
//   async detachPaymentMethod(paymentMethodId: string): Promise<Stripe.PaymentMethod> {
//     console.log("🔓 Detaching payment method:", paymentMethodId);

//     try {
//       const detached = await stripe.paymentMethods.detach(paymentMethodId);
//       console.log("✅ Payment method detached");
//       return detached;
//     } catch (error: any) {
//       console.error("❌ Error detaching payment method:", error);
//       throw error;
//     }
//   },

//   /**
//    * Construct webhook event
//    */
//   constructWebhookEvent(payload: string | Buffer, signature: string): Stripe.Event {
//     const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

//     if (!webhookSecret) {
//       throw new Error('STRIPE_WEBHOOK_SECRET is not set');
//     }

//     try {
//       return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
//     } catch (error: any) {
//       console.error("❌ Webhook signature verification failed:", error.message);
//       throw error;
//     }
//   },

//   // Raw Stripe instance for custom operations
//   stripe,
// };

// export default stripeService;
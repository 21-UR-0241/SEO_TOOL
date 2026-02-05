// // server/services/webhook-handler.ts
// import { db } from "../db";
// import { eq, and } from "drizzle-orm";
// import {
//   userSubscriptions,
//   invoices,
//   transactions,
//   users,
// } from "../../shared/schema";
// import Stripe from "stripe";

// export class WebhookHandler {

//   static async handleCheckoutCompleted(session: Stripe.Checkout.Session) {
//     console.log("🎯 Processing checkout.session.completed");

//     const userId = session.metadata?.userId;
//     const planId = session.metadata?.planId;
//     const interval = session.metadata?.interval as "month" | "year";

//     if (!userId || !planId || !interval) {
//       console.error("❌ Missing metadata in checkout session");
//       return;
//     }

//     const stripeSubscriptionId = session.subscription as string;

//     if (!stripeSubscriptionId) {
//       console.error("❌ No subscription in checkout session");
//       return;
//     }
//     await db
//       .update(userSubscriptions)
//       .set({
//         stripeSubscriptionId,
//         stripeCustomerId: session.customer as string,
//         updatedAt: new Date(),
//       })
//       .where(
//         and(
//           eq(userSubscriptions.userId, userId),
//           eq(userSubscriptions.planId, planId)
//         )
//       );

//     console.log("✅ Updated subscription with Stripe IDs");
//   }

//   static async handleSubscriptionCreated(
//     subscription: Stripe.Subscription
//   ) {
//     console.log("🎯 Processing customer.subscription.created");

//     const userId = subscription.metadata?.userId;
    
//     if (!userId) {
//       console.error("❌ No userId in subscription metadata");
//       return;
//     }

//     const [existingSub] = await db
//       .select()
//       .from(userSubscriptions)
//       .where(eq(userSubscriptions.userId, userId))
//       .limit(1);

//     if (existingSub && !existingSub.stripeSubscriptionId) {
//       await db
//         .update(userSubscriptions)
//         .set({
//           stripeSubscriptionId: subscription.id,
//           stripeCustomerId: subscription.customer as string,
//           currentPeriodEnd: new Date(subscription.current_period_end * 1000),
//           updatedAt: new Date(),
//         })
//         .where(eq(userSubscriptions.id, existingSub.id));

//       console.log("✅ Linked Stripe subscription to database");
//     }
//   }

//   static async handleSubscriptionUpdated(
//     subscription: Stripe.Subscription
//   ) {
//     console.log("🎯 Processing customer.subscription.updated");

//     const [dbSubscription] = await db
//       .select()
//       .from(userSubscriptions)
//       .where(eq(userSubscriptions.stripeSubscriptionId, subscription.id))
//       .limit(1);

//     if (!dbSubscription) {
//       console.error("❌ Subscription not found in database");
//       return;
//     }

//     const statusMap: Record<string, string> = {
//       active: "active",
//       trialing: "trial",
//       past_due: "past_due",
//       canceled: "cancelled",
//       unpaid: "cancelled",
//       incomplete: "incomplete",
//       incomplete_expired: "cancelled",
//     };

//     const newStatus = statusMap[subscription.status] || "active";

//     const currentPeriodEnd = new Date(subscription.current_period_end * 1000);

//     // If Stripe says cancel_at_period_end and the period already ended,
//     // force status to cancelled (prevents stale "active" rows)
//     const isExpired =
//       subscription.cancel_at_period_end && currentPeriodEnd < new Date();

//     const finalStatus = isExpired ? "cancelled" : newStatus;

//     // Safely handle canceled_at timestamp
//     let cancelledAt: Date | null = null;
//     if (isExpired) {
//       cancelledAt = new Date();
//     } else if (subscription.canceled_at && typeof subscription.canceled_at === 'number') {
//       cancelledAt = new Date(subscription.canceled_at * 1000);
//     }

//     console.log("📝 Updating subscription:", {
//       id: dbSubscription.id,
//       oldStatus: dbSubscription.status,
//       newStatus: finalStatus,
//       cancelAtPeriodEnd: subscription.cancel_at_period_end,
//       isExpired,
//       cancelledAt: cancelledAt?.toISOString() || null,
//     });

//     await db
//       .update(userSubscriptions)
//       .set({
//         status: finalStatus,
//         currentPeriodStart: new Date(subscription.current_period_start * 1000),
//         currentPeriodEnd,
//         cancelAtPeriodEnd: subscription.cancel_at_period_end,
//         cancelledAt,
//         updatedAt: new Date(),
//       })
//       .where(eq(userSubscriptions.id, dbSubscription.id));

//     console.log(`✅ Updated subscription status to: ${finalStatus}`);
//   }

//   static async handleSubscriptionDeleted(
//     subscription: Stripe.Subscription
//   ) {
//     console.log("🎯 Processing customer.subscription.deleted");

//     const [dbSubscription] = await db
//       .select()
//       .from(userSubscriptions)
//       .where(eq(userSubscriptions.stripeSubscriptionId, subscription.id))
//       .limit(1);

//     if (!dbSubscription) {
//       console.error("❌ Subscription not found in database");
//       return;
//     }

//     await db
//       .update(userSubscriptions)
//       .set({
//         status: "cancelled",
//         cancelledAt: new Date(),
//         cancelAtPeriodEnd: false,
//         updatedAt: new Date(),
//       })
//       .where(eq(userSubscriptions.id, dbSubscription.id));

//     console.log("✅ Marked subscription as cancelled");
//   }

//   static async handleInvoicePaid(invoice: Stripe.Invoice) {
//     console.log("🎯 Processing invoice.paid");

//     const subscriptionId = invoice.subscription as string;

//     if (!subscriptionId) {
//       console.log("ℹ️ No subscription on invoice, skipping");
//       return;
//     }

//     const [dbSubscription] = await db
//       .select()
//       .from(userSubscriptions)
//       .where(eq(userSubscriptions.stripeSubscriptionId, subscriptionId))
//       .limit(1);

//     if (!dbSubscription) {
//       console.error("❌ Subscription not found in database");
//       return;
//     }
    
//     const [transaction] = await db
//       .insert(transactions)
//       .values({
//         userId: dbSubscription.userId,
//         subscriptionId: dbSubscription.id,
//         transactionType: "payment",
//         amount: (invoice.amount_paid / 100).toFixed(2),
//         status: "succeeded",
//         stripeInvoiceId: invoice.id,
//         stripePaymentIntentId: invoice.payment_intent as string | null,
//         description: `Subscription renewal payment`,
//         processedAt: new Date(invoice.status_transitions.paid_at! * 1000),
//       })
//       .returning();
    
//     const [existingInvoice] = await db
//       .select()
//       .from(invoices)
//       .where(eq(invoices.stripeInvoiceId, invoice.id))
//       .limit(1);

//     if (existingInvoice) {
//       await db
//         .update(invoices)
//         .set({
//           status: "paid",
//           amountPaid: (invoice.amount_paid / 100).toFixed(2),
//           paidAt: new Date(invoice.status_transitions.paid_at! * 1000),
//           updatedAt: new Date(),
//         })
//         .where(eq(invoices.id, existingInvoice.id));
//     } else {
//       await db.insert(invoices).values({
//         userId: dbSubscription.userId,
//         subscriptionId: dbSubscription.id,
//         invoiceNumber: invoice.number || `STRIPE-${invoice.id}`,
//         subtotal: (invoice.subtotal / 100).toFixed(2),
//         taxRate: "0.00",
//         taxAmount: ((invoice.tax || 0) / 100).toFixed(2),
//         totalAmount: (invoice.total / 100).toFixed(2),
//         amountDue: (invoice.amount_due / 100).toFixed(2),
//         amountPaid: (invoice.amount_paid / 100).toFixed(2),
//         status: "paid",
//         invoiceDate: new Date(invoice.created * 1000),
//         dueDate: invoice.due_date ? new Date(invoice.due_date * 1000) : new Date(),
//         paidAt: new Date(invoice.status_transitions.paid_at! * 1000),
//         stripeInvoiceId: invoice.id,
//         lineItems: invoice.lines.data.map((line) => ({
//           description: line.description || "",
//           quantity: line.quantity || 1,
//           unitPrice: (line.price?.unit_amount || 0) / 100,
//           amount: line.amount / 100,
//         })),
//       });
//     }

//     console.log("✅ Recorded payment transaction");
//   }

//   static async handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
//     console.log("🎯 Processing invoice.payment_failed");

//     const subscriptionId = invoice.subscription as string;

//     if (!subscriptionId) {
//       console.log("ℹ️ No subscription on invoice, skipping");
//       return;
//     }

//     const [dbSubscription] = await db
//       .select()
//       .from(userSubscriptions)
//       .where(eq(userSubscriptions.stripeSubscriptionId, subscriptionId))
//       .limit(1);

//     if (!dbSubscription) {
//       console.error("❌ Subscription not found in database");
//       return;
//     }
    
//     await db.insert(transactions).values({
//       userId: dbSubscription.userId,
//       subscriptionId: dbSubscription.id,
//       transactionType: "payment",
//       amount: (invoice.amount_due / 100).toFixed(2),
//       status: "failed",
//       stripeInvoiceId: invoice.id,
//       stripePaymentIntentId: invoice.payment_intent as string | null,
//       description: `Failed subscription payment`,
//       failureReason: invoice.last_finalization_error?.message || "Payment failed",
//       processedAt: new Date(),
//     });

//     // Update subscription status if needed
//     if (invoice.attempt_count >= 3) {
//       await db
//         .update(userSubscriptions)
//         .set({
//           status: "past_due",
//           updatedAt: new Date(),
//         })
//         .where(eq(userSubscriptions.id, dbSubscription.id));
//     }

//     console.log("✅ Recorded failed payment");
//   }

//   static async handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent) {
//     console.log("🎯 Processing payment_intent.succeeded");

//     const invoiceId = paymentIntent.invoice as string;

//     if (!invoiceId) {
//       console.log("ℹ️ No invoice on payment intent, skipping");
//       return;
//     }

//     console.log("✅ Payment successful");
//   }

//   static async handlePaymentFailed(paymentIntent: Stripe.PaymentIntent) {
//     console.log("🎯 Processing payment_intent.payment_failed");
//     console.log("❌ Payment failed:", paymentIntent.last_payment_error?.message);
//   }
// }

// export default WebhookHandler;
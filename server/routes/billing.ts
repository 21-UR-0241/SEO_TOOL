
// // server/routes/billing.ts
// import express, { Router, Request, Response } from "express";
// import { db } from "../db";
// import { eq, and, desc, sql } from "drizzle-orm";
// import {
//   subscriptionPlans,
//   userSubscriptions,
//   billingAddresses,
//   paymentMethods,
//   invoices,
//   transactions,
//   subscriptionUsage,
//   promoCodes,
//   promoCodeRedemptions,
// } from "../../shared/schema";
// import { stripeService } from "../services/stripe-service";
// import { WebhookHandler } from "../services/webhook-handler";
// import Stripe from "stripe";

// const router = Router();

// // ============================================================================
// // AUTHENTICATION MIDDLEWARE
// // ============================================================================

// const requireAuth = (req: Request, res: Response, next: Function) => {
//   if (!req.user?.id) {
//     return res.status(401).json({
//       success: false,
//       error: { code: "UNAUTHORIZED", message: "Authentication required" },
//     });
//   }
//   next();
// };

// // Debug logging
// router.use((req, _res, next) => {
//   console.log('🔵 Billing router hit:', req.method, req.path);
//   next();
// });

// // ============================================================================
// // SUBSCRIPTION PLANS
// // ============================================================================

// /**
//  * GET /api/billing/plans
//  * Get all available subscription plans
//  */
// router.get("/plans", async (_req: Request, res: Response) => {
//   try {
//     const plans = await db
//       .select()
//       .from(subscriptionPlans)
//       .where(eq(subscriptionPlans.isActive, true))
//       .orderBy(subscriptionPlans.monthlyPrice);

//     res.json({ success: true, data: plans });
//   } catch (error: any) {
//     console.error("Error fetching plans:", error);
//     res.status(500).json({
//       success: false,
//       error: { code: "FETCH_FAILED", message: error.message },
//     });
//   }
// });

// /**
//  * GET /api/billing/plans/:planId
//  * Get a specific subscription plan
//  */
// router.get("/plans/:planId", async (req: Request, res: Response) => {
//   try {
//     const [plan] = await db
//       .select()
//       .from(subscriptionPlans)
//       .where(
//         and(
//           eq(subscriptionPlans.id, req.params.planId),
//           eq(subscriptionPlans.isActive, true),
//         ),
//       )
//       .limit(1);

//     if (!plan) {
//       return res.status(404).json({
//         success: false,
//         error: { code: "PLAN_NOT_FOUND", message: "Plan not found" },
//       });
//     }

//     res.json({ success: true, data: plan });
//   } catch (error: any) {
//     console.error("Error fetching plan:", error);
//     res.status(500).json({
//       success: false,
//       error: { code: "FETCH_FAILED", message: error.message },
//     });
//   }
// });

// // ============================================================================
// // SUBSCRIPTIONS
// // ============================================================================

// /**
//  * GET /api/billing/subscription
//  * Get user's current subscription
//  * Returns flat object matching frontend expectations
//  */
// router.get("/subscription", requireAuth, async (req: Request, res: Response) => {
//   try {
//     const userId = req.user!.id;

//     console.log("📊 Fetching subscription for user:", userId);

//     const [result] = await db
//       .select({
//         subscriptionId: userSubscriptions.id,
//         planId: userSubscriptions.planId,
//         planName: subscriptionPlans.name,
//         status: userSubscriptions.status,
//         billingInterval: userSubscriptions.billingInterval,
//         currentPeriodEnd: userSubscriptions.currentPeriodEnd,
//         cancelAtPeriodEnd: userSubscriptions.cancelAtPeriodEnd,
//         monthlyPrice: subscriptionPlans.monthlyPrice,
//         yearlyPrice: subscriptionPlans.yearlyPrice,
//       })
//       .from(userSubscriptions)
//       .innerJoin(
//         subscriptionPlans,
//         eq(userSubscriptions.planId, subscriptionPlans.id),
//       )
//       .where(
//         and(
//           eq(userSubscriptions.userId, userId),
//           sql`${userSubscriptions.status} IN ('active', 'trial')`,
//         ),
//       )
//       .orderBy(desc(userSubscriptions.createdAt))
//       .limit(1);

//     if (!result) {
//       console.log("❌ No subscription found for user:", userId);
//       return res.status(404).json({
//         success: false,
//         message: "No subscription found",
//       });
//     }

//     // 👇 ADD THIS CHECK
//     const now = new Date();
//     const periodEnd = new Date(result.currentPeriodEnd);
    
//     // If subscription is marked for cancellation and period has ended, update status
//     if (result.cancelAtPeriodEnd && periodEnd < now) {
//       await db
//         .update(userSubscriptions)
//         .set({
//           status: "cancelled",
//           updatedAt: new Date(),
//         })
//         .where(eq(userSubscriptions.id, result.subscriptionId));
      
//       console.log("✅ Subscription expired, status updated to cancelled");
      
//       return res.status(404).json({
//         success: false,
//         message: "Subscription has expired",
//       });
//     }

//     console.log("✅ Subscription found:", {
//       id: result.subscriptionId,
//       plan: result.planName,
//       interval: result.billingInterval,
//     });

//     const amount =
//       result.billingInterval === "year"
//         ? Number(result.yearlyPrice)
//         : Number(result.monthlyPrice);

//     return res.json({
//       success: true,
//       id: result.subscriptionId,
//       planId: result.planId,
//       planName: result.planName,
//       status: result.status,
//       interval: result.billingInterval,
//       currentPeriodEnd: result.currentPeriodEnd.toISOString(),
//       cancelAtPeriodEnd: result.cancelAtPeriodEnd || false,
//       amount,
//     });
//   } catch (error: any) {
//     console.error("❌ Error fetching subscription:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Failed to fetch subscription",
//       error: error.message,
//     });
//   }
// });

// /**
//  * POST /api/billing/subscription
//  * Create a new subscription
//  */
// router.post("/subscription", requireAuth, async (req: Request, res: Response) => {
//   try {
//     const userId = req.user!.id;
//     const { planId, interval, paymentDetails, promoCode } = req.body;

//     if (!planId || !interval) {
//       return res.status(400).json({
//         success: false,
//         error: { code: "INVALID_REQUEST", message: "Missing required fields" },
//       });
//     }

//     // Check if user already has an active/trial subscription
//     const [existingSubscription] = await db
//       .select()
//       .from(userSubscriptions)
//       .where(
//         and(
//           eq(userSubscriptions.userId, userId),
//           sql`${userSubscriptions.status} IN ('active', 'trial')`,
//         ),
//       )
//       .limit(1);

//     if (existingSubscription) {
//       return res.status(400).json({
//         success: false,
//         error: {
//           code: "SUBSCRIPTION_EXISTS",
//           message: "User already has active subscription",
//         },
//       });
//     }

//     // Get plan details
//     const [plan] = await db
//       .select()
//       .from(subscriptionPlans)
//       .where(eq(subscriptionPlans.id, planId))
//       .limit(1);

//     if (!plan) {
//       return res.status(404).json({
//         success: false,
//         error: { code: "PLAN_NOT_FOUND", message: "Plan not found" },
//       });
//     }

//     // Pricing
//     const subtotal =
//       interval === "year"
//         ? Number(plan.yearlyPrice)
//         : Number(plan.monthlyPrice);

//     const taxRate = 0.08;
//     let discountAmount = 0;
//     let promoCodeData: typeof promoCodes.$inferSelect | null = null;

//     // Promo code validation (if provided)
//     if (promoCode) {
//       const [promo] = await db
//         .select()
//         .from(promoCodes)
//         .where(
//           and(
//             eq(promoCodes.code, promoCode),
//             eq(promoCodes.isActive, true),
//           ),
//         )
//         .limit(1);

//       if (promo) {
//         const now = new Date();

//         // Validate promo code
//         if (promo.validFrom && new Date(promo.validFrom) > now) {
//           return res.status(400).json({
//             success: false,
//             error: {
//               code: "INVALID_PROMO",
//               message: "Promo code not yet valid",
//             },
//           });
//         }
//         if (promo.validUntil && new Date(promo.validUntil) < now) {
//           return res.status(400).json({
//             success: false,
//             error: { code: "INVALID_PROMO", message: "Promo code expired" },
//           });
//         }

//         if (
//           promo.maxRedemptions &&
//           promo.redemptionsCount >= promo.maxRedemptions
//         ) {
//           return res.status(400).json({
//             success: false,
//             error: {
//               code: "INVALID_PROMO",
//               message: "Promo code has reached max redemptions",
//             },
//           });
//         }

//         // Check if user already used this promo
//         const [redemption] = await db
//           .select()
//           .from(promoCodeRedemptions)
//           .where(
//             and(
//               eq(promoCodeRedemptions.promoCodeId, promo.id),
//               eq(promoCodeRedemptions.userId, userId),
//             ),
//           )
//           .limit(1);

//         if (redemption) {
//           return res.status(400).json({
//             success: false,
//             error: {
//               code: "INVALID_PROMO",
//               message: "Promo code already used",
//             },
//           });
//         }

//         // Check plan applicability
//         if (
//           promo.applicablePlans &&
//           promo.applicablePlans.length > 0 &&
//           !promo.applicablePlans.includes(planId)
//         ) {
//           return res.status(400).json({
//             success: false,
//             error: {
//               code: "INVALID_PROMO",
//               message: "Promo code not applicable to this plan",
//             },
//           });
//         }

//         promoCodeData = promo;

//         if (promo.discountType === "percentage") {
//           discountAmount = subtotal * (Number(promo.discountValue) / 100);
//         } else {
//           discountAmount = Number(promo.discountValue);
//         }
//       }
//     }

//     const finalSubtotal = Math.max(0, subtotal - discountAmount);
//     const taxAmount = finalSubtotal * taxRate;
//     const totalAmount = finalSubtotal + taxAmount;

//     // Use Drizzle transaction
//     const result = await db.transaction(async (tx) => {
//       // 1. Billing address
//       let addressId: string | null = null;
//       if (paymentDetails?.billingAddress) {
//         const [address] = await tx
//           .insert(billingAddresses)
//           .values({
//             userId,
//             streetAddress: paymentDetails.billingAddress.address,
//             city: paymentDetails.billingAddress.city,
//             stateProvince: paymentDetails.billingAddress.state,
//             postalCode: paymentDetails.billingAddress.zip,
//             country: paymentDetails.billingAddress.country || "US",
//             isDefault: true,
//           })
//           .returning();
//         addressId = address.id;
//       }

//       // 2. Payment method (only for paid plans)
//       let paymentMethodId: string | null = null;
//       if (planId !== "free" && paymentDetails) {
//         const [payment] = await tx
//           .insert(paymentMethods)
//           .values({
//             userId,
//             type: "card",
//             cardBrand: "visa",
//             cardLast4: paymentDetails.cardLast4,
//             cardExpMonth: "12",
//             cardExpYear: "2025",
//             cardholderName: paymentDetails.cardName,
//             billingAddressId: addressId,
//             isDefault: true,
//           })
//           .returning();
//         paymentMethodId = payment.id;
//       }

//       // 3. Calculate period dates
//       const now = new Date();
//       const periodEnd = new Date(now);

//       if (interval === "month") {
//         periodEnd.setMonth(periodEnd.getMonth() + 1);
//       } else {
//         periodEnd.setFullYear(periodEnd.getFullYear() + 1);
//       }

//       // 4. Create subscription
//       const [subscription] = await tx
//         .insert(userSubscriptions)
//         .values({
//           userId,
//           planId,
//           billingInterval: interval,
//           status: "active",
//           currentPeriodStart: now,
//           currentPeriodEnd: periodEnd,
//         })
//         .returning();

//       // 5. Create invoice
//       const invoiceNumber = `INV-${Date.now()}-${userId.substring(0, 8)}`;

//       const [invoice] = await tx
//         .insert(invoices)
//         .values({
//           userId,
//           subscriptionId: subscription.id,
//           invoiceNumber,
//           subtotal: finalSubtotal.toFixed(2),
//           taxRate: taxRate.toFixed(4),
//           taxAmount: taxAmount.toFixed(2),
//           totalAmount: totalAmount.toFixed(2),
//           amountDue: totalAmount.toFixed(2),
//           status: "open",
//           invoiceDate: now,
//           dueDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
//           billingAddressId: addressId,
//           lineItems: [
//             {
//               description: `${plan.name} - ${
//                 interval === "year" ? "Annual" : "Monthly"
//               } Subscription`,
//               quantity: 1,
//               unitPrice: subtotal,
//               amount: subtotal,
//             },
//             ...(discountAmount > 0
//               ? [
//                   {
//                     description: `Promo Code: ${promoCode}`,
//                     quantity: 1,
//                     unitPrice: -discountAmount,
//                     amount: -discountAmount,
//                   },
//                 ]
//               : []),
//           ],
//         })
//         .returning();

//       // 6. Create transaction
//       const [transaction] = await tx
//         .insert(transactions)
//         .values({
//           userId,
//           invoiceId: invoice.id,
//           subscriptionId: subscription.id,
//           paymentMethodId,
//           transactionType: "payment",
//           amount: totalAmount.toFixed(2),
//           status: "succeeded",
//           description: `Initial ${plan.name} subscription payment`,
//           processedAt: new Date(),
//         })
//         .returning();

//       // 7. Mark invoice as paid
//       await tx
//         .update(invoices)
//         .set({
//           status: "paid",
//           amountPaid: totalAmount.toFixed(2),
//           paidAt: new Date(),
//         })
//         .where(eq(invoices.id, invoice.id));

//       // 8. Handle promo code redemption
//       if (promoCodeData) {
//         await tx.insert(promoCodeRedemptions).values({
//           promoCodeId: promoCodeData.id,
//           userId,
//           subscriptionId: subscription.id,
//           discountAmount: discountAmount.toFixed(2),
//         });

//         await tx
//           .update(promoCodes)
//           .set({
//             redemptionsCount: sql`${promoCodes.redemptionsCount} + 1`,
//           })
//           .where(eq(promoCodes.id, promoCodeData.id));
//       }

//       // 9. Initialize usage tracking
//       await tx.insert(subscriptionUsage).values({
//         userId,
//         subscriptionId: subscription.id,
//         websitesCreated: 0,
//         articlesGenerated: 0,
//         periodStart: now,
//         periodEnd: periodEnd,
//       });

//       return { subscription, invoice, transaction };
//     });

//     console.log("✅ Subscription created successfully");

//     return res.json({
//       success: true,
//       data: result,
//     });
//   } catch (error: any) {
//     console.error("❌ Error creating subscription:", error);

//     // Avoid sending multiple responses
//     if (!res.headersSent) {
//       return res.status(500).json({
//         success: false,
//         error: { code: "SUBSCRIPTION_FAILED", message: error.message },
//       });
//     }
//   }
// });

// /**
//  * POST /api/billing/subscription/upgrade
//  * Upgrade or downgrade subscription plan
//  */
// router.post(
//   "/subscription/upgrade",
//   requireAuth,
//   async (req: Request, res: Response) => {
//     try {
//       const userId = req.user!.id;
//       const { newPlanId } = req.body;

//       if (!newPlanId) {
//         return res.status(400).json({
//           success: false,
//           error: {
//             code: "INVALID_REQUEST",
//             message: "newPlanId is required",
//           },
//         });
//       }

//       const [subscription] = await db
//         .select()
//         .from(userSubscriptions)
//         .where(
//           and(
//             eq(userSubscriptions.userId, userId),
//             sql`${userSubscriptions.status} IN ('active', 'trial')`,
//           ),
//         )
//         .limit(1);

//       if (!subscription) {
//         return res.status(404).json({
//           success: false,
//           error: {
//             code: "SUBSCRIPTION_NOT_FOUND",
//             message: "No active subscription found",
//           },
//         });
//       }

//       const [newPlan] = await db
//         .select()
//         .from(subscriptionPlans)
//         .where(eq(subscriptionPlans.id, newPlanId))
//         .limit(1);

//       if (!newPlan) {
//         return res.status(404).json({
//           success: false,
//           error: { code: "PLAN_NOT_FOUND", message: "New plan not found" },
//         });
//       }

//       await db
//         .update(userSubscriptions)
//         .set({
//           planId: newPlanId,
//           updatedAt: new Date(),
//         })
//         .where(eq(userSubscriptions.id, subscription.id));

//       res.json({
//         success: true,
//         data: {
//           message: `Plan updated to ${newPlan.name}`,
//           subscription: { ...subscription, planId: newPlanId },
//         },
//       });
//     } catch (error: any) {
//       console.error("Error upgrading subscription:", error);
//       res.status(500).json({
//         success: false,
//         error: {
//           code: "UPGRADE_FAILED",
//           message: error.message,
//         },
//       });
//     }
//   },
// );

// /**
//  * POST /api/billing/subscription/cancel
//  * Cancel subscription
//  */
// router.post(
//   "/subscription/cancel",
//   requireAuth,
//   async (req: Request, res: Response) => {
//     try {
//       const userId = req.user!.id;
//       const { immediate } = req.body;

//       console.log("🚫 Cancelling subscription for user:", userId);

//       const [subscription] = await db
//         .select()
//         .from(userSubscriptions)
//         .where(
//           and(
//             eq(userSubscriptions.userId, userId),
//             sql`${userSubscriptions.status} IN ('active', 'trial')`,
//           ),
//         )
//         .limit(1);

//       if (!subscription) {
//         return res.status(404).json({
//           success: false,
//           error: {
//             code: "SUBSCRIPTION_NOT_FOUND",
//             message: "No active subscription found",
//           },
//         });
//       }

//       if (subscription.stripeSubscriptionId) {
//         await stripeService.cancelSubscription(
//           subscription.stripeSubscriptionId,
//           !!immediate,
//         );
//       }

//       if (immediate) {
//         await db
//           .update(userSubscriptions)
//           .set({
//             status: "cancelled",
//             cancelledAt: new Date(),
//             cancelAtPeriodEnd: false,
//             updatedAt: new Date(),
//           })
//           .where(eq(userSubscriptions.id, subscription.id));
//       } else {
//         await db
//           .update(userSubscriptions)
//           .set({
//             cancelAtPeriodEnd: true,
//             cancelledAt: new Date(),
//             updatedAt: new Date(),
//           })
//           .where(eq(userSubscriptions.id, subscription.id));
//       }

//       console.log("✅ Subscription cancelled");

//       res.json({
//         success: true,
//         data: {
//           message: immediate
//             ? "Subscription cancelled immediately"
//             : "Subscription will cancel at end of billing period",
//         },
//       });
//     } catch (error: any) {
//       console.error("Error cancelling subscription:", error);
//       res.status(500).json({
//         success: false,
//         error: { code: "CANCEL_FAILED", message: error.message },
//       });
//     }
//   },
// );

// /**
//  * POST /api/billing/subscription/resume
//  * Resume a cancelled subscription
//  */
// router.post(
//   "/subscription/resume",
//   requireAuth,
//   async (req: Request, res: Response) => {
//     try {
//       const userId = req.user!.id;

//       console.log("🔄 Resuming subscription for user:", userId);

//       const [subscription] = await db
//         .select()
//         .from(userSubscriptions)
//         .where(
//           and(
//             eq(userSubscriptions.userId, userId),
//             eq(userSubscriptions.status, "active"),
//             eq(userSubscriptions.cancelAtPeriodEnd, true),
//           ),
//         )
//         .limit(1);

//       if (!subscription) {
//         return res.status(404).json({
//           success: false,
//           error: {
//             code: "SUBSCRIPTION_NOT_FOUND",
//             message: "No cancelled subscription found",
//           },
//         });
//       }

//       if (subscription.stripeSubscriptionId) {
//         await stripeService.resumeSubscription(
//           subscription.stripeSubscriptionId,
//         );
//       }

//       await db
//         .update(userSubscriptions)
//         .set({
//           cancelAtPeriodEnd: false,
//           cancelledAt: null,
//           updatedAt: new Date(),
//         })
//         .where(eq(userSubscriptions.id, subscription.id));

//       console.log("✅ Subscription resumed");

//       res.json({
//         success: true,
//         data: { message: "Subscription reactivated successfully" },
//       });
//     } catch (error: any) {
//       console.error("Error resuming subscription:", error);
//       res.status(500).json({
//         success: false,
//         error: { code: "REACTIVATE_FAILED", message: error.message },
//       });
//     }
//   },
// );

// /**
//  * POST /api/billing/subscription/reactivate
//  * Legacy endpoint - redirects to /resume
//  */
// router.post(
//   "/subscription/reactivate",
//   requireAuth,
//   async (req: Request, res: Response) => {
//     // Forward to resume endpoint
//     req.url = "/subscription/resume";
//     return router.handle(req, res);
//   },
// );

// // ============================================================================
// // PAYMENT METHODS
// // ============================================================================

// /**
//  * GET /api/billing/payment-method
//  * Get user's default payment method
//  */
// router.get("/payment-method", requireAuth, async (req: Request, res: Response) => {
//   try {
//     const userId = req.user!.id;

//     console.log("💳 Fetching payment method for user:", userId);

//     // Get the default payment method
//     const [paymentMethod] = await db
//       .select()
//       .from(paymentMethods)
//       .where(
//         and(
//           eq(paymentMethods.userId, userId),
//           eq(paymentMethods.isDefault, true)
//         )
//       )
//       .orderBy(desc(paymentMethods.createdAt))
//       .limit(1);

//     if (!paymentMethod) {
//       console.log("❌ No payment method found for user:", userId);
//       return res.status(404).json({
//         success: false,
//         message: "No payment method found",
//       });
//     }

//     console.log("✅ Payment method found:", {
//       id: paymentMethod.id,
//       brand: paymentMethod.cardBrand,
//       last4: paymentMethod.cardLast4,
//     });

//     return res.json({
//       id: paymentMethod.id,
//       brand: paymentMethod.cardBrand || "unknown",
//       last4: paymentMethod.cardLast4 || "****",
//       expMonth: parseInt(paymentMethod.cardExpMonth || "1"),
//       expYear: parseInt(paymentMethod.cardExpYear || "2025"),
//       isDefault: paymentMethod.isDefault || false,
//     });
//   } catch (error: any) {
//     console.error("❌ Error fetching payment method:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Failed to fetch payment method",
//       error: error.message,
//     });
//   }
// });

// /**
//  * DELETE /api/billing/payment-method
//  * Remove user's default payment method (only if no active/trial subscription)
//  */
// router.delete("/payment-method", requireAuth, async (req: Request, res: Response) => {
//   try {
//     const userId = req.user!.id;

//     // 1) Block deletion if subscription is active/trialing
//     const [subscription] = await db
//       .select()
//       .from(userSubscriptions)
//       .where(
//         and(
//           eq(userSubscriptions.userId, userId),
//           sql`${userSubscriptions.status} IN ('active', 'trial')`,
//         ),
//       )
//       .limit(1);

//     if (subscription) {
//       return res.status(400).json({
//         success: false,
//         error: {
//           code: "SUBSCRIPTION_ACTIVE",
//           message:
//             "Cannot remove payment method while subscription is active. Cancel subscription first.",
//         },
//       });
//     }

//     // 2) Find default payment method
//     const [paymentMethod] = await db
//       .select()
//       .from(paymentMethods)
//       .where(
//         and(eq(paymentMethods.userId, userId), eq(paymentMethods.isDefault, true)),
//       )
//       .orderBy(desc(paymentMethods.createdAt))
//       .limit(1);

//     if (!paymentMethod) {
//       return res.status(404).json({
//         success: false,
//         error: { code: "NOT_FOUND", message: "No payment method found" },
//       });
//     }

//     // 3) Detach in Stripe (if you store Stripe PM id)
//     if (paymentMethod.stripePaymentMethodId) {
//       await stripeService.detachPaymentMethod(paymentMethod.stripePaymentMethodId);
//     }

//     // 4) Remove from DB
//     await db
//       .delete(paymentMethods)
//       .where(eq(paymentMethods.id, paymentMethod.id));

//     return res.json({ success: true });
//   } catch (error: any) {
//     console.error("❌ Error deleting payment method:", error);
//     return res.status(500).json({
//       success: false,
//       error: { code: "DELETE_FAILED", message: error.message },
//     });
//   }
// });

// /**
//  * PUT /api/billing/payment-method
//  * Update user's payment method
//  */
// router.put("/payment-method", requireAuth, async (req: Request, res: Response) => {
//   try {
//     const userId = req.user!.id;
//     const { cardNumber, expMonth, expYear, cvc } = req.body;

//     console.log("💳 Updating payment method for user:", userId);

//     if (!cardNumber || !expMonth || !expYear || !cvc) {
//       return res.status(400).json({
//         success: false,
//         error: {
//           code: "INVALID_REQUEST",
//           message: "Missing required fields",
//         },
//       });
//     }

//     // Basic validation
//     const cleanCardNumber = cardNumber.replace(/\s/g, "");
//     if (cleanCardNumber.length < 13 || cleanCardNumber.length > 19) {
//       return res.status(400).json({
//         success: false,
//         error: {
//           code: "INVALID_CARD",
//           message: "Invalid card number",
//         },
//       });
//     }

//     const monthNum = parseInt(expMonth);
//     const yearNum = parseInt(expYear);

//     if (monthNum < 1 || monthNum > 12) {
//       return res.status(400).json({
//         success: false,
//         error: {
//           code: "INVALID_EXPIRY",
//           message: "Invalid expiration month",
//         },
//       });
//     }

//     if (cvc.length < 3 || cvc.length > 4) {
//       return res.status(400).json({
//         success: false,
//         error: {
//           code: "INVALID_CVC",
//           message: "Invalid CVC",
//         },
//       });
//     }

//     // Determine card brand from card number
//     const cardBrand = getCardBrand(cleanCardNumber);
//     const last4 = cleanCardNumber.slice(-4);
    
//     // Get current year (2-digit)
//     const currentYear = parseInt(new Date().getFullYear().toString().slice(-2));
//     const fullYear = yearNum < 100 ? (yearNum < currentYear ? 2100 + yearNum : 2000 + yearNum) : yearNum;

//     // In production, you would:
//     // 1. Create/update payment method in Stripe
//     // 2. Store the Stripe payment method ID
//     // For now, we'll update the database directly

//     const result = await db.transaction(async (tx) => {
//       // Set all existing payment methods to non-default
//       await tx
//         .update(paymentMethods)
//         .set({ isDefault: false })
//         .where(eq(paymentMethods.userId, userId));

//       // Insert new payment method
//       const [newPaymentMethod] = await tx
//         .insert(paymentMethods)
//         .values({
//           userId,
//           type: "card",
//           cardBrand,
//           cardLast4: last4,
//           cardExpMonth: expMonth.padStart(2, "0"),
//           cardExpYear: fullYear.toString(),
//           isDefault: true,
//         })
//         .returning();

//       return newPaymentMethod;
//     });

//     console.log("✅ Payment method updated successfully");

//     return res.json({
//       success: true,
//       data: {
//         id: result.id,
//         brand: result.cardBrand,
//         last4: result.cardLast4,
//         expMonth: parseInt(result.cardExpMonth || "1"),
//         expYear: parseInt(result.cardExpYear || "2025"),
//         isDefault: result.isDefault,
//       },
//     });
//   } catch (error: any) {
//     console.error("❌ Error updating payment method:", error);
//     return res.status(500).json({
//       success: false,
//       error: {
//         code: "UPDATE_FAILED",
//         message: error.message,
//       },
//     });
//   }
// });

// /**
//  * Helper function to determine card brand from card number
//  */
// function getCardBrand(cardNumber: string): string {
//   const patterns = {
//     visa: /^4/,
//     mastercard: /^(5[1-5]|2[2-7])/,
//     amex: /^3[47]/,
//     discover: /^6(?:011|5)/,
//     diners: /^3(?:0[0-5]|[68])/,
//     jcb: /^(?:2131|1800|35)/,
//   };

//   for (const [brand, pattern] of Object.entries(patterns)) {
//     if (pattern.test(cardNumber)) {
//       return brand;
//     }
//   }

//   return "unknown";
// }

// // ============================================================================
// // PROMO CODES
// // ============================================================================

// /**
//  * POST /api/billing/promo/validate
//  * Validate a promo code
//  */
// router.post("/promo/validate", requireAuth, async (req: Request, res: Response) => {
//   try {
//     const userId = req.user!.id;
//     const { code, planId } = req.body;

//     if (!code || !planId) {
//       return res.status(400).json({
//         success: false,
//         error: {
//           code: "INVALID_REQUEST",
//           message: "code and planId are required",
//         },
//       });
//     }

//     const [promo] = await db
//       .select()
//       .from(promoCodes)
//       .where(and(eq(promoCodes.code, code), eq(promoCodes.isActive, true)))
//       .limit(1);

//     if (!promo) {
//       return res.status(400).json({
//         success: false,
//         error: { code: "INVALID_PROMO", message: "Invalid promo code" },
//       });
//     }

//     const now = new Date();

//     if (promo.validFrom && new Date(promo.validFrom) > now) {
//       return res.status(400).json({
//         success: false,
//         error: {
//           code: "INVALID_PROMO",
//           message: "Promo code not yet valid",
//         },
//       });
//     }
//     if (promo.validUntil && new Date(promo.validUntil) < now) {
//       return res.status(400).json({
//         success: false,
//         error: { code: "INVALID_PROMO", message: "Promo code expired" },
//       });
//     }

//     if (
//       promo.maxRedemptions &&
//       promo.redemptionsCount >= promo.maxRedemptions
//     ) {
//       return res.status(400).json({
//         success: false,
//         error: {
//           code: "INVALID_PROMO",
//           message: "Promo code has reached max redemptions",
//         },
//       });
//     }

//     const [redemption] = await db
//       .select()
//       .from(promoCodeRedemptions)
//       .where(
//         and(
//           eq(promoCodeRedemptions.promoCodeId, promo.id),
//           eq(promoCodeRedemptions.userId, userId),
//         ),
//       )
//       .limit(1);

//     if (redemption) {
//       return res.status(400).json({
//         success: false,
//         error: { code: "INVALID_PROMO", message: "Promo code already used" },
//       });
//     }

//     if (
//       promo.applicablePlans &&
//       promo.applicablePlans.length > 0 &&
//       !promo.applicablePlans.includes(planId)
//     ) {
//       return res.status(400).json({
//         success: false,
//         error: {
//           code: "INVALID_PROMO",
//           message: "Promo code not applicable to this plan",
//         },
//       });
//     }

//     const [plan] = await db
//       .select()
//       .from(subscriptionPlans)
//       .where(eq(subscriptionPlans.id, planId))
//       .limit(1);

//     if (!plan) {
//       return res.status(404).json({
//         success: false,
//         error: { code: "PLAN_NOT_FOUND", message: "Plan not found" },
//       });
//     }

//     let discountAmount = 0;
//     if (promo.discountType === "percentage") {
//       discountAmount =
//         Number(plan.monthlyPrice) * (Number(promo.discountValue) / 100);
//     } else {
//       discountAmount = Number(promo.discountValue);
//     }

//     res.json({
//       success: true,
//       data: {
//         valid: true,
//         discountAmount,
//         discountType: promo.discountType,
//         discountValue: promo.discountValue,
//       },
//     });
//   } catch (error: any) {
//     console.error("Error validating promo code:", error);
//     res.status(500).json({
//       success: false,
//       error: { code: "VALIDATION_FAILED", message: error.message },
//     });
//   }
// });

// // ============================================================================
// // INVOICES & TRANSACTIONS
// // ============================================================================

// /**
//  * GET /api/billing/invoices
//  * Get user's invoices
//  */
// router.get("/invoices", requireAuth, async (req: Request, res: Response) => {
//   try {
//     const userId = req.user!.id;
//     const limit = parseInt(req.query.limit as string, 10) || 10;

//     const userInvoices = await db
//       .select()
//       .from(invoices)
//       .where(eq(invoices.userId, userId))
//       .orderBy(desc(invoices.createdAt))
//       .limit(limit);

//     res.json({
//       success: true,
//       data: userInvoices,
//     });
//   } catch (error: any) {
//     console.error("Error fetching invoices:", error);
//     res.status(500).json({
//       success: false,
//       error: { code: "FETCH_FAILED", message: error.message },
//     });
//   }
// });

// /**
//  * GET /api/billing/transactions
//  * Get user's transactions
//  */
// router.get("/transactions", requireAuth, async (req: Request, res: Response) => {
//   try {
//     const userId = req.user!.id;
//     const limit = parseInt(req.query.limit as string, 10) || 10;

//     const userTransactions = await db
//       .select()
//       .from(transactions)
//       .where(eq(transactions.userId, userId))
//       .orderBy(desc(transactions.createdAt))
//       .limit(limit);

//     res.json({
//       success: true,
//       data: userTransactions,
//     });
//   } catch (error: any) {
//     console.error("Error fetching transactions:", error);
//     res.status(500).json({
//       success: false,
//       error: { code: "FETCH_FAILED", message: error.message },
//     });
//   }
// });

// /**
//  * GET /api/billing/usage
//  * Get current subscription usage
//  */
// router.get("/usage", requireAuth, async (req: Request, res: Response) => {
//   try {
//     const userId = req.user!.id;
//     const now = new Date();

//     const [usage] = await db
//       .select({
//         usage: subscriptionUsage,
//         subscription: userSubscriptions,
//         plan: subscriptionPlans,
//       })
//       .from(subscriptionUsage)
//       .innerJoin(
//         userSubscriptions,
//         eq(subscriptionUsage.subscriptionId, userSubscriptions.id),
//       )
//       .innerJoin(
//         subscriptionPlans,
//         eq(userSubscriptions.planId, subscriptionPlans.id),
//       )
//       .where(
//         and(
//           eq(subscriptionUsage.userId, userId),
//           sql`${subscriptionUsage.periodStart} <= ${now}`,
//           sql`${subscriptionUsage.periodEnd} >= ${now}`,
//         ),
//       )
//       .limit(1);

//     if (!usage) {
//       return res.json({
//         success: true,
//         data: null,
//       });
//     }

//     res.json({
//       success: true,
//       data: {
//         websitesCreated: usage.usage.websitesCreated,
//         articlesGenerated: usage.usage.articlesGenerated,
//         maxWebsites: usage.plan.maxWebsites,
//         maxArticles: usage.plan.maxArticlesPerMonth,
//         periodStart: usage.usage.periodStart,
//         periodEnd: usage.usage.periodEnd,
//       },
//     });
//   } catch (error: any) {
//     console.error("Error fetching usage:", error);
//     res.status(500).json({
//       success: false,
//       error: { code: "FETCH_FAILED", message: error.message },
//     });
//   }
// });

// // ============================================================================
// // STRIPE CHECKOUT / PORTAL
// // ============================================================================

// /**
//  * POST /api/billing/create-checkout-session
//  * Create a Stripe checkout session for subscription
//  */
// router.post(
//   "/create-checkout-session",
//   requireAuth,
//   async (req: Request, res: Response) => {
//     try {
//       const userId = req.user!.id;
//       const { planId, interval, promoCode } = req.body;

//       if (!planId || !interval) {
//         return res.status(400).json({
//           success: false,
//           error: {
//             code: "INVALID_REQUEST",
//             message: "planId and interval are required",
//           },
//         });
//       }

//       const [plan] = await db
//         .select()
//         .from(subscriptionPlans)
//         .where(eq(subscriptionPlans.id, planId))
//         .limit(1);

//       if (!plan) {
//         return res.status(404).json({
//           success: false,
//           error: { code: "PLAN_NOT_FOUND", message: "Plan not found" },
//         });
//       }

//       const frontendUrl =
//         process.env.FRONTEND_URL || "http://localhost:5173";

//       const session = await stripeService.createCheckoutSession({
//         userId,
//         planId,
//         interval,
//         successUrl: `${frontendUrl}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
//         cancelUrl: `${frontendUrl}/subscription?canceled=true`,
//         promoCode,
//       });

//       res.json({
//         success: true,
//         data: {
//           sessionId: session.id,
//           url: session.url,
//         },
//       });
//     } catch (error: any) {
//       console.error("Error creating checkout session:", error);
//       res.status(500).json({
//         success: false,
//         error: { code: "CHECKOUT_FAILED", message: error.message },
//       });
//     }
//   },
// );

// /**
//  * POST /api/billing/create-portal-session
//  * Create a Stripe billing portal session
//  */
// router.post(
//   "/create-portal-session",
//   requireAuth,
//   async (req: Request, res: Response) => {
//     try {
//       const userId = req.user!.id;
//       const frontendUrl =
//         process.env.FRONTEND_URL || "http://localhost:5173";

//       const session = await stripeService.createBillingPortalSession({
//         userId,
//         returnUrl: `${frontendUrl}/settings?tab=subscription`,
//       });

//       res.json({
//         success: true,
//         data: {
//           url: session.url,
//         },
//       });
//     } catch (error: any) {
//       console.error("Error creating portal session:", error);
//       res.status(500).json({
//         success: false,
//         error: { code: "PORTAL_FAILED", message: error.message },
//       });
//     }
//   },
// );

// // ============================================================================
// // STRIPE WEBHOOK
// // ============================================================================

// /**
//  * POST /api/billing/webhooks/stripe
//  * Handle Stripe webhook events
//  */
// router.post(
//   "/webhooks/stripe",
//   express.raw({ type: "application/json" }),
//   async (req: Request, res: Response) => {
//     try {
//       const sig = req.headers["stripe-signature"] as string;
//       const event = stripeService.constructWebhookEvent(req.body, sig);

//       console.log("🔔 Stripe webhook received:", event.type);

//       // Handle different event types using WebhookHandler
//       switch (event.type) {
//         case "checkout.session.completed": {
//           await WebhookHandler.handleCheckoutCompleted(
//             event.data.object as Stripe.Checkout.Session
//           );
//           break;
//         }

//         case "customer.subscription.created": {
//           await WebhookHandler.handleSubscriptionCreated(
//             event.data.object as Stripe.Subscription
//           );
//           break;
//         }

//         case "customer.subscription.updated": {
//           await WebhookHandler.handleSubscriptionUpdated(
//             event.data.object as Stripe.Subscription
//           );
//           break;
//         }

//         case "customer.subscription.deleted": {
//           await WebhookHandler.handleSubscriptionDeleted(
//             event.data.object as Stripe.Subscription
//           );
//           break;
//         }

//         case "invoice.paid": {
//           await WebhookHandler.handleInvoicePaid(
//             event.data.object as Stripe.Invoice
//           );
//           break;
//         }

//         case "invoice.payment_failed": {
//           await WebhookHandler.handleInvoicePaymentFailed(
//             event.data.object as Stripe.Invoice
//           );
//           break;
//         }

//         case "payment_intent.succeeded": {
//           await WebhookHandler.handlePaymentSucceeded(
//             event.data.object as Stripe.PaymentIntent
//           );
//           break;
//         }

//         case "payment_intent.payment_failed": {
//           await WebhookHandler.handlePaymentFailed(
//             event.data.object as Stripe.PaymentIntent
//           );
//           break;
//         }

//         default:
//           console.log("ℹ️ Unhandled event type:", event.type);
//       }

//       res.json({ received: true });
//     } catch (err: any) {
//       console.error("❌ Stripe webhook error:", err.message);
//       return res.status(400).send(`Webhook Error: ${err.message}`);
//     }
//   },
// );

// // Add this after your existing GET /subscription route

// /**
//  * GET /api/billing/subscription/current
//  * Legacy alias for GET /api/billing/subscription
//  */
// router.get("/subscription/current", requireAuth, async (req: Request, res: Response) => {
//   console.log("⚠️ Legacy endpoint called: /subscription/current");
  
//   try {
//     const userId = req.user!.id;

//     console.log("📊 Fetching subscription for user:", userId);

//     const [result] = await db
//       .select({
//         subscriptionId: userSubscriptions.id,
//         planId: userSubscriptions.planId,
//         planName: subscriptionPlans.name,
//         status: userSubscriptions.status,
//         billingInterval: userSubscriptions.billingInterval,
//         currentPeriodEnd: userSubscriptions.currentPeriodEnd,
//         cancelAtPeriodEnd: userSubscriptions.cancelAtPeriodEnd,
//         monthlyPrice: subscriptionPlans.monthlyPrice,
//         yearlyPrice: subscriptionPlans.yearlyPrice,
//       })
//       .from(userSubscriptions)
//       .innerJoin(
//         subscriptionPlans,
//         eq(userSubscriptions.planId, subscriptionPlans.id),
//       )
//       .where(
//         and(
//           eq(userSubscriptions.userId, userId),
//           sql`${userSubscriptions.status} IN ('active', 'trial')`,
//         ),
//       )
//       .orderBy(desc(userSubscriptions.createdAt))
//       .limit(1);

//     if (!result) {
//       console.log("❌ No subscription found for user:", userId);
//       return res.status(404).json({
//         success: false,
//         message: "No subscription found",
//       });
//     }

//     // Check if subscription has expired
//     const now = new Date();
//     const periodEnd = new Date(result.currentPeriodEnd);
    
//     if (result.cancelAtPeriodEnd && periodEnd < now) {
//       await db
//         .update(userSubscriptions)
//         .set({
//           status: "cancelled",
//           updatedAt: now,
//         })
//         .where(eq(userSubscriptions.id, result.subscriptionId));
      
//       console.log("✅ Subscription expired, status updated to cancelled");
      
//       return res.status(404).json({
//         success: false,
//         message: "Subscription has expired",
//       });
//     }

//     const amount =
//       result.billingInterval === "year"
//         ? Number(result.yearlyPrice)
//         : Number(result.monthlyPrice);

//     return res.json({
//       success: true,
//       id: result.subscriptionId,
//       planId: result.planId,
//       planName: result.planName,
//       status: result.status,
//       interval: result.billingInterval,
//       currentPeriodEnd: result.currentPeriodEnd.toISOString(),
//       cancelAtPeriodEnd: result.cancelAtPeriodEnd || false,
//       amount,
//     });
//   } catch (error: any) {
//     console.error("❌ Error fetching subscription:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Failed to fetch subscription",
//       error: error.message,
//     });
//   }
// });

// export default router;
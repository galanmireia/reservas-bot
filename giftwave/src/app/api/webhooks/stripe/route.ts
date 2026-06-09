import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { handleFirstGiftReferralBonuses, handleVolumeReferralBonus } from "@/lib/referrals";
import Stripe from "stripe";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature")!;

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object as Stripe.PaymentIntent;
    const { transactionId } = pi.metadata;

    if (!transactionId) return NextResponse.json({ ok: true });

    const transaction = await prisma.transaction.update({
      where: { id: transactionId },
      data: {
        status: "COMPLETED",
        stripeChargeId: pi.latest_charge as string,
      },
    });

    // Update creator balance and totals
    await prisma.user.update({
      where: { id: transaction.recipientId },
      data: {
        balance: { increment: transaction.creatorReceives },
        totalReceived: { increment: transaction.creatorReceives },
      },
    });

    // Referral bonuses
    await handleFirstGiftReferralBonuses(transaction.recipientId, transaction.id);
    await handleVolumeReferralBonus(transaction.recipientId, transaction.id, transaction.creatorReceives);
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription & { current_period_end: number };
    const isActive = sub.status === "active";
    const periodEnd = new Date(sub.current_period_end * 1000);

    await prisma.subscription.updateMany({
      where: { stripeSubscriptionId: sub.id },
      data: { status: sub.status, currentPeriodEnd: periodEnd },
    });

    const dbSub = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: sub.id } });
    if (dbSub) {
      await prisma.user.update({
        where: { id: dbSub.userId },
        data: {
          plan: isActive ? "PRO" : "FREE",
          planExpiresAt: isActive ? periodEnd : null,
        },
      });
    }
  }

  return NextResponse.json({ ok: true });
}

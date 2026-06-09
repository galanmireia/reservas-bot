import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { stripe, fanTotal, calculateFee } from "@/lib/stripe";
import { z } from "zod";

const schema = z.object({
  wishlistItemId: z.string(),
  fanName: z.string().optional(),
  fanEmail: z.string().email().optional(),
  isAnonymous: z.boolean().default(false),
  message: z.string().max(300).optional(),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { wishlistItemId, fanName, fanEmail, isAnonymous, message } = parsed.data;

  const item = await prisma.wishlistItem.findUnique({
    where: { id: wishlistItemId },
    include: { wishlist: { include: { user: true } } },
  });

  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  if (item.isReceived) return NextResponse.json({ error: "Item already received" }, { status: 400 });

  const creatorReceives = item.price;
  const platformFee = calculateFee(creatorReceives);
  const total = fanTotal(creatorReceives);

  // Create transaction record first
  const transaction = await prisma.transaction.create({
    data: {
      type: item.type === "CASH" ? "GIFT_CASH" : item.type === "DIGITAL" ? "DIGITAL_PURCHASE" : "GIFT_PHYSICAL",
      status: "PENDING",
      recipientId: item.wishlist.userId,
      wishlistItemId: item.id,
      fanName: isAnonymous ? null : fanName,
      fanEmail: fanEmail,
      isAnonymous,
      message,
      amount: total,
      platformFee,
      creatorReceives,
      currency: item.currency,
    },
  });

  // Create Stripe PaymentIntent — fan pays total (includes fee)
  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(total * 100),
    currency: item.currency.toLowerCase(),
    metadata: { transactionId: transaction.id },
    receipt_email: fanEmail ?? undefined,
  });

  // Store paymentIntentId
  await prisma.transaction.update({
    where: { id: transaction.id },
    data: { stripePaymentIntentId: paymentIntent.id },
  });

  return NextResponse.json({ clientSecret: paymentIntent.client_secret, transactionId: transaction.id });
}

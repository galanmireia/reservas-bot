import { prisma } from "./prisma";

const WELCOME_BONUS = parseFloat(process.env.REFERRAL_WELCOME_BONUS_USD ?? "5");
const FIXED_BONUS = parseFloat(process.env.REFERRAL_FIXED_BONUS_USD ?? "10");
const VOLUME_PCT = parseFloat(process.env.REFERRAL_VOLUME_PERCENTAGE ?? "1") / 100;
const VOLUME_MONTHS = parseInt(process.env.REFERRAL_VOLUME_MONTHS ?? "12");

// Called when a creator receives their first gift.
// Triggers: welcome bonus for the new creator + fixed bonus for referrer.
export async function handleFirstGiftReferralBonuses(
  recipientId: string,
  transactionId: string
) {
  const recipient = await prisma.user.findUnique({
    where: { id: recipientId },
    select: { hasReceivedFirstGift: true, referredById: true, welcomeBonusPaid: true },
  });

  if (!recipient || recipient.hasReceivedFirstGift) return;

  await prisma.user.update({
    where: { id: recipientId },
    data: { hasReceivedFirstGift: true },
  });

  const bonuses = [];

  // Welcome bonus for the new creator
  if (!recipient.welcomeBonusPaid) {
    bonuses.push(
      prisma.referralEarning.create({
        data: {
          referrerId: recipientId,
          referredUserId: recipientId,
          transactionId,
          type: "WELCOME_BONUS",
          amount: WELCOME_BONUS,
          status: "PENDING",
        },
      }),
      prisma.user.update({
        where: { id: recipientId },
        data: {
          balance: { increment: WELCOME_BONUS },
          welcomeBonusPaid: true,
        },
      })
    );
  }

  // Fixed bonus for the referrer
  if (recipient.referredById) {
    bonuses.push(
      prisma.referralEarning.create({
        data: {
          referrerId: recipient.referredById,
          referredUserId: recipientId,
          transactionId,
          type: "FIXED_BONUS",
          amount: FIXED_BONUS,
          status: "PENDING",
        },
      }),
      prisma.user.update({
        where: { id: recipient.referredById },
        data: { balance: { increment: FIXED_BONUS } },
      })
    );
  }

  await prisma.$transaction(bonuses);
}

// Called on every completed transaction to pay volume % to referrer.
// Only applies during first VOLUME_MONTHS months of the referred creator's account.
export async function handleVolumeReferralBonus(
  recipientId: string,
  transactionId: string,
  amount: number
) {
  const recipient = await prisma.user.findUnique({
    where: { id: recipientId },
    select: { referredById: true, createdAt: true },
  });

  if (!recipient?.referredById) return;

  const monthsOld =
    (Date.now() - recipient.createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30);

  if (monthsOld > VOLUME_MONTHS) return;

  const earning = parseFloat((amount * VOLUME_PCT).toFixed(2));
  if (earning < 0.01) return;

  await prisma.$transaction([
    prisma.referralEarning.create({
      data: {
        referrerId: recipient.referredById,
        referredUserId: recipientId,
        transactionId,
        type: "VOLUME_PERCENTAGE",
        amount: earning,
        status: "PENDING",
      },
    }),
    prisma.user.update({
      where: { id: recipient.referredById },
      data: { balance: { increment: earning } },
    }),
  ]);
}

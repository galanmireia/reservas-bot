import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-05-27.dahlia",
  typescript: true,
});

// Stripe fee: 2.9% + $0.30 — charged to fan, not creator
export function calculateFee(amountUsd: number): number {
  return parseFloat((amountUsd * 0.029 + 0.30).toFixed(2));
}

// What the fan pays = amount + Stripe fee
export function fanTotal(creatorAmount: number): number {
  return parseFloat((creatorAmount + calculateFee(creatorAmount)).toFixed(2));
}

"use client";

import { useState } from "react";
import { WishlistItem } from "@prisma/client";
import { formatCurrency } from "@/lib/utils";
import { fanTotal } from "@/lib/stripe";

interface Props {
  item: WishlistItem;
  creatorName: string;
}

export default function GiftButton({ item, creatorName }: Props) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"form" | "paying" | "done">("form");
  const [fanName, setFanName] = useState("");
  const [fanEmail, setFanEmail] = useState("");
  const [message, setMessage] = useState("");
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const total = fanTotal(item.price);

  async function handleGift() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wishlistItemId: item.id,
          fanName: isAnonymous ? undefined : fanName,
          fanEmail: fanEmail || undefined,
          isAnonymous,
          message: message || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");

      // In production: use Stripe.js to confirm payment with data.clientSecret
      // For now, we show success (Stripe integration requires client-side Stripe.js)
      setStep("done");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="bg-violet-600 text-white text-sm font-semibold px-4 py-2 rounded-full hover:bg-violet-700 transition-colors flex-shrink-0"
      >
        Gift
      </button>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md p-6">
        {step === "done" ? (
          <div className="text-center py-8">
            <div className="text-5xl mb-4">🎁</div>
            <h3 className="text-xl font-bold mb-2">Gift sent!</h3>
            <p className="text-gray-500">
              {creatorName} will receive your gift soon. Thank you!
            </p>
            <button
              onClick={() => { setOpen(false); setStep("form"); }}
              className="mt-6 bg-violet-600 text-white px-6 py-2 rounded-full hover:bg-violet-700 transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-lg">Send a gift</h3>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 text-2xl">×</button>
            </div>
            <div className="bg-gray-50 rounded-xl p-3 mb-4">
              <p className="font-medium">{item.title}</p>
              <p className="text-violet-600 font-bold">
                {formatCurrency(item.price, item.currency)}
              </p>
            </div>

            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={isAnonymous}
                  onChange={(e) => setIsAnonymous(e.target.checked)}
                  className="rounded"
                />
                Send anonymously
              </label>

              {!isAnonymous && (
                <input
                  type="text"
                  placeholder="Your name (optional)"
                  value={fanName}
                  onChange={(e) => setFanName(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
                />
              )}

              <input
                type="email"
                placeholder="Your email (for receipt)"
                value={fanEmail}
                onChange={(e) => setFanEmail(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
              />

              <textarea
                placeholder="Leave a message... (optional)"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={300}
                rows={3}
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-violet-400"
              />
            </div>

            {error && <p className="text-red-500 text-sm mt-2">{error}</p>}

            <div className="mt-4 border-t pt-4">
              <div className="flex justify-between text-sm text-gray-500 mb-1">
                <span>Gift amount</span>
                <span>{formatCurrency(item.price, item.currency)}</span>
              </div>
              <div className="flex justify-between text-sm text-gray-500 mb-3">
                <span>Processing fee</span>
                <span>{formatCurrency(total - item.price, item.currency)}</span>
              </div>
              <div className="flex justify-between font-bold text-gray-900">
                <span>Total</span>
                <span>{formatCurrency(total, item.currency)}</span>
              </div>
            </div>

            <button
              onClick={handleGift}
              disabled={loading}
              className="mt-4 w-full bg-violet-600 text-white py-3 rounded-full font-semibold hover:bg-violet-700 transition-colors disabled:opacity-50"
            >
              {loading ? "Processing..." : `Pay ${formatCurrency(total, item.currency)}`}
            </button>
            <p className="text-xs text-center text-gray-400 mt-2">
              {creatorName} receives 100% — no commission
            </p>
          </>
        )}
      </div>
    </div>
  );
}
